import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  REPOSITORY_INSTRUCTION_LIMITS,
  REPOSITORY_INSTRUCTIONS_PROTOCOL,
  RepositoryInstructionService,
  Supervisor,
  agentProviderContext,
  deriveAgentProviderObservations,
  registerBrokeredSecret,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

let current: { temp: TempRuntime; supervisor: Supervisor } | null = null;

afterEach(async () => {
  if (!current) return;
  await current.supervisor.close();
  await removeTempRuntime(current.temp);
  current = null;
});

async function open(prefix = "agencity-repository-instructions-") {
  const temp = await makeTempRuntime(prefix);
  await mkdir(temp.workspaceRoot, { recursive: true });
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    recover: false,
  });
  current = { temp, supervisor };
  return current;
}

describe("repository AGENTS.md instructions", () => {
  test("materializes root instructions with exact source provenance and reloads changes", async () => {
    const { temp, supervisor } = await open();
    await Bun.write(join(temp.workspaceRoot, "AGENTS.md"), "# Root\nUse focused tests.\n");
    const session = await supervisor.createSession({ workspaceId: "workspace" });

    const first = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((first.context as any).repositoryInstructions).toMatchObject({
      protocol: REPOSITORY_INSTRUCTIONS_PROTOCOL,
      precedence: "root-to-nearest-directory",
      root: {
        path: "AGENTS.md",
        directory: ".",
        scope: "workspace",
        precedence: 0,
        completeness: "inline",
        content: "# Root\nUse focused tests.\n",
      },
      discovered: [],
    });
    const firstDigest = (first.context as any).repositoryInstructions.root.sha256;
    const sealed = await supervisor.contexts.materialize(session.sessionId, session.branchId, {
      includeRepositoryInstructions: false,
    });
    expect((sealed.context as any).repositoryInstructions).toBeUndefined();

    await Bun.write(join(temp.workspaceRoot, "AGENTS.md"), "# Root\nRun narrow tests first.\n");
    const second = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((second.context as any).repositoryInstructions.root).toMatchObject({
      content: "# Root\nRun narrow tests first.\n",
    });
    expect((second.context as any).repositoryInstructions.root.sha256).not.toBe(firstDigest);

    await Bun.write(
      join(temp.workspaceRoot, "AGENTS.md"),
      "r".repeat(REPOSITORY_INSTRUCTION_LIMITS.nestedFileBytes + 1),
    );
    const largerRoot = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((largerRoot.context as any).repositoryInstructions.root).toMatchObject({
      completeness: "inline",
      size: REPOSITORY_INSTRUCTION_LIMITS.nestedFileBytes + 1,
    });

    await Bun.write(
      join(temp.workspaceRoot, "AGENTS.md"),
      "r".repeat(REPOSITORY_INSTRUCTION_LIMITS.rootFileBytes + 1),
    );
    const oversizedRoot = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((oversizedRoot.context as any).repositoryInstructions.root).toMatchObject({
      completeness: "reference",
      reason: "file-size-limit",
      size: REPOSITORY_INSTRUCTION_LIMITS.rootFileBytes + 1,
    });

    await Bun.write(
      join(temp.workspaceRoot, "AGENTS.md"),
      "r".repeat(REPOSITORY_INSTRUCTION_LIMITS.digestFileBytes + 1),
    );
    const refusedDigest = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((refusedDigest.context as any).repositoryInstructions.root).toMatchObject({
      completeness: "unavailable",
      reason: "digest-size-limit",
      size: REPOSITORY_INSTRUCTION_LIMITS.digestFileBytes + 1,
    });
  });

  test("discovers nested instructions in root-to-nearest order and retains them across restart", async () => {
    const { temp, supervisor } = await open();
    await mkdir(join(temp.workspaceRoot, "src/deep"), { recursive: true });
    await Bun.write(join(temp.workspaceRoot, "AGENTS.md"), "root guidance");
    await Bun.write(join(temp.workspaceRoot, "src/AGENTS.md"), "src guidance");
    await Bun.write(join(temp.workspaceRoot, "src/deep/AGENTS.md"), "deep guidance");
    await Bun.write(join(temp.workspaceRoot, "src/deep/file.ts"), "export const value = 1;\n");
    const session = await supervisor.createSession({ workspaceId: "workspace" });

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `const file = await tools.readFile("src/deep/file.ts"); return file.value.content;`,
      [],
      "instruction-read-1",
    );
    let events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const committed = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "instruction-read-1")!;
    expect((committed.payload as any).repositoryInstructions[0]).toMatchObject({
      targetPath: "src/deep/file.ts",
      instructions: [
        { path: "src/AGENTS.md", precedence: 1, content: "src guidance" },
        { path: "src/deep/AGENTS.md", precedence: 2, content: "deep guidance" },
      ],
    });

    const context = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((context.context as any).repositoryInstructions.discovered).toEqual([
      expect.objectContaining({ path: "src/AGENTS.md", content: "src guidance" }),
      expect.objectContaining({ path: "src/deep/AGENTS.md", content: "deep guidance" }),
    ]);
    const providerContext = agentProviderContext(
      context.context,
      { id: "run", task: "edit the file", status: "running" } as any,
      2,
      [],
      {
        responseContract: {
          kind: "required-tool-set",
          contractId: "test",
          version: 1,
          contractDigest: "a".repeat(64),
          schemaEnforcement: "runtime-validated",
          selection: "required",
        },
      } as any,
      "system",
    ) as any;
    expect(providerContext.messages[1].content).toContain("WORKSPACE ROOT INSTRUCTIONS");
    expect(providerContext.messages[1].content).toContain("root guidance");
    expect(providerContext.messages[2].content).toContain("DISCOVERED DIRECTORY INSTRUCTIONS");
    expect(providerContext.messages[2].content).toContain("deep guidance");
    const providerObservations = deriveAgentProviderObservations(events, [committed.id]);
    expect((providerObservations[0]!.payload as any).repositoryInstructions).toBeUndefined();

    await supervisor.close();
    const reopened = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    current = { temp, supervisor: reopened };
    await reopened.executeCell(
      session.sessionId,
      session.branchId,
      `const file = await tools.readFile("src/deep/file.ts"); return file.value.sha256;`,
      [],
      "instruction-read-2",
    );
    events = await reopened.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const unchanged = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "instruction-read-2")!;
    expect((unchanged.payload as any).repositoryInstructions).toBeUndefined();

    await Bun.write(join(temp.workspaceRoot, "src/deep/AGENTS.md"), "changed deep guidance");
    await reopened.executeCell(
      session.sessionId,
      session.branchId,
      `const file = await tools.readFile("src/deep/file.ts"); return file.value.sha256;`,
      [],
      "instruction-read-3",
    );
    events = await reopened.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const changed = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "instruction-read-3")!;
    expect((changed.payload as any).repositoryInstructions[0].instructions).toEqual([
      expect.objectContaining({ path: "src/deep/AGENTS.md", content: "changed deep guidance" }),
    ]);
    const changedContext = await reopened.contexts.materialize(session.sessionId, session.branchId);
    expect((changedContext.context as any).repositoryInstructions.discovered).toContainEqual(
      expect.objectContaining({ path: "src/deep/AGENTS.md", content: "changed deep guidance" }),
    );

    await rm(join(temp.workspaceRoot, "src/deep/AGENTS.md"));
    await reopened.executeCell(
      session.sessionId,
      session.branchId,
      `const file = await tools.readFile("src/deep/file.ts"); return file.value.sha256;`,
      [],
      "instruction-read-4",
    );
    events = await reopened.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const removed = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "instruction-read-4")!;
    expect((removed.payload as any).repositoryInstructions[0].instructions).toEqual([
      expect.objectContaining({
        path: "src/deep/AGENTS.md",
        completeness: "unavailable",
        reason: "removed",
      }),
    ]);
    const removedContext = await reopened.contexts.materialize(session.sessionId, session.branchId);
    expect((removedContext.context as any).repositoryInstructions.discovered).toContainEqual(
      expect.objectContaining({ path: "src/deep/AGENTS.md", reason: "removed" }),
    );

    await Bun.write(join(temp.workspaceRoot, "src/deep/AGENTS.md"), "changed deep guidance");
    await reopened.executeCell(
      session.sessionId,
      session.branchId,
      `const file = await tools.readFile("src/deep/file.ts"); return file.value.sha256;`,
      [],
      "instruction-read-5",
    );
    events = await reopened.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const restored = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "instruction-read-5")!;
    expect((restored.payload as any).repositoryInstructions[0].instructions).toEqual([
      expect.objectContaining({ path: "src/deep/AGENTS.md", content: "changed deep guidance" }),
    ]);
  });

  test("deduplicates one instruction digest across concurrent reads in the same directory", async () => {
    const { temp, supervisor } = await open();
    await mkdir(join(temp.workspaceRoot, "shared"), { recursive: true });
    await Bun.write(join(temp.workspaceRoot, "shared/AGENTS.md"), "shared guidance");
    await Bun.write(join(temp.workspaceRoot, "shared/one.ts"), "export const one = 1;\n");
    await Bun.write(join(temp.workspaceRoot, "shared/two.ts"), "export const two = 2;\n");
    const session = await supervisor.createSession({ workspaceId: "workspace" });

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `return await Promise.all([
        tools.readFile("shared/one.ts"),
        tools.readFile("shared/two.ts"),
      ]);`,
      [],
      "concurrent-instruction-reads",
    );
    const events = await supervisor.storage.loadEvents(session.sessionId, {
      branchId: session.branchId,
    });
    const committed = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "concurrent-instruction-reads")!;
    const delivered = (committed.payload as any).repositoryInstructions.flatMap(
      (discovery: any) => discovery.instructions,
    );
    expect(delivered).toEqual([
      expect.objectContaining({
        path: "shared/AGENTS.md",
        content: "shared guidance",
      }),
    ]);
  });

  test("limits nested discovery to nearest files and references oversized instructions", async () => {
    const { temp } = await open();
    let directory = temp.workspaceRoot;
    for (let depth = 1; depth <= 5; depth++) {
      directory = join(directory, `d${depth}`);
      await mkdir(directory, { recursive: true });
      await Bun.write(
        join(directory, "AGENTS.md"),
        depth === 5
          ? "x".repeat(REPOSITORY_INSTRUCTION_LIMITS.nestedFileBytes + 1)
          : `depth ${depth}`,
      );
    }
    const target = join(directory, "file.ts");
    await Bun.write(target, "export {};\n");
    const service = new RepositoryInstructionService(temp.workspaceRoot);
    const discovery = await service.discoverForRead(
      "d1/d2/d3/d4/d5/file.ts",
      new Map(),
    );
    expect(discovery?.instructions.map((item) => item.path)).toEqual([
      "d1/d2/AGENTS.md",
      "d1/d2/d3/AGENTS.md",
      "d1/d2/d3/d4/AGENTS.md",
      "d1/d2/d3/d4/d5/AGENTS.md",
    ]);
    expect(discovery?.omittedInstructionPaths).toEqual(["d1/AGENTS.md"]);
    expect(discovery?.instructions.at(-1)).toMatchObject({
      completeness: "reference",
      reason: "file-size-limit",
      size: REPOSITORY_INSTRUCTION_LIMITS.nestedFileBytes + 1,
    });

    const external = join(temp.directory, "outside-instructions.md");
    await Bun.write(external, "outside guidance");
    await rm(join(directory, "AGENTS.md"));
    await symlink(external, join(directory, "AGENTS.md"));
    const symlinked = await service.discoverForRead(
      "d1/d2/d3/d4/d5/file.ts",
      new Map(),
    );
    expect(symlinked?.instructions.at(-1)).toMatchObject({
      path: "d1/d2/d3/d4/d5/AGENTS.md",
      completeness: "unavailable",
      reason: "symbolic-link",
    });
    expect(symlinked?.instructions.at(-1)).not.toHaveProperty("content");

    await mkdir(join(temp.workspaceRoot, "redacted"), { recursive: true });
    await Bun.write(join(temp.workspaceRoot, "redacted/file.ts"), "export {};\n");
    const release = registerBrokeredSecret("abcd");
    try {
      await Bun.write(
        join(temp.workspaceRoot, "redacted/AGENTS.md"),
        "abcd".repeat(REPOSITORY_INSTRUCTION_LIMITS.nestedFileBytes / 4),
      );
      const redacted = await service.discoverForRead("redacted/file.ts", new Map());
      expect(redacted?.instructions).toEqual([
        expect.objectContaining({
          path: "redacted/AGENTS.md",
          completeness: "reference",
          reason: "redacted-content-limit",
        }),
      ]);
    } finally {
      release();
    }

    let deeplyNested = join(temp.workspaceRoot, "long");
    for (let depth = 1; depth <= REPOSITORY_INSTRUCTION_LIMITS.ancestorScanFiles + 2; depth++) {
      deeplyNested = join(deeplyNested, `d${depth}`);
    }
    await mkdir(deeplyNested, { recursive: true });
    await Bun.write(join(deeplyNested, "file.ts"), "export {};\n");
    const bounded = await service.discoverForRead(
      `${join(
        "long",
        ...Array.from(
          { length: REPOSITORY_INSTRUCTION_LIMITS.ancestorScanFiles + 2 },
          (_, index) => `d${index + 1}`,
        ),
      )}/file.ts`,
      new Map(),
    );
    expect(bounded).toMatchObject({
      unscannedAncestorDirectoryCount: 3,
      unscannedAncestorDirectoryPaths: [
        "long",
        "long/d1",
        "long/d1/d2",
      ],
    });
  });

  test("marks an omitted older ancestor pending until its changed content is delivered", async () => {
    const { temp, supervisor } = await open();
    const directories = ["d1", "d2", "d3", "d4", "d5"];
    const targetDirectory = join(temp.workspaceRoot, ...directories);
    await mkdir(targetDirectory, { recursive: true });
    await Bun.write(join(temp.workspaceRoot, "d1/AGENTS.md"), "old d1");
    await Bun.write(join(targetDirectory, "file.ts"), "export {};\n");
    const session = await supervisor.createSession({ workspaceId: "workspace" });

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `return await tools.readFile("d1/d2/d3/d4/d5/file.ts");`,
      [],
      "older-instruction-1",
    );
    await Bun.write(join(temp.workspaceRoot, "d1/AGENTS.md"), "changed d1");
    for (let depth = 2; depth <= 5; depth++) {
      await Bun.write(
        join(temp.workspaceRoot, ...directories.slice(0, depth), "AGENTS.md"),
        `depth ${depth}`,
      );
    }
    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `return await tools.readFile("d1/d2/d3/d4/d5/file.ts");`,
      [],
      "older-instruction-2",
    );
    let events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const second = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "older-instruction-2")!;
    expect((second.payload as any).repositoryInstructions[0]).toMatchObject({
      instructions: [
        { path: "d1/d2/AGENTS.md" },
        { path: "d1/d2/d3/AGENTS.md" },
        { path: "d1/d2/d3/d4/AGENTS.md" },
        { path: "d1/d2/d3/d4/d5/AGENTS.md" },
      ],
      omittedInstructionPaths: ["d1/AGENTS.md"],
      omittedInstructionCount: 1,
    });
    const pending = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((pending.context as any).repositoryInstructions).toMatchObject({
      pendingInstructionPaths: ["d1/AGENTS.md"],
      pendingInstructionCount: 1,
    });
    expect((pending.context as any).repositoryInstructions.discovered).toContainEqual(
      expect.objectContaining({
        path: "d1/AGENTS.md",
        completeness: "reference",
        reason: "pending-rediscovery",
      }),
    );
    expect((pending.context as any).repositoryInstructions.discovered).toContainEqual(
      expect.objectContaining({ path: "d1/d2/AGENTS.md", precedence: 2 }),
    );

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `return await tools.readFile("d1/d2/d3/d4/d5/file.ts");`,
      [],
      "older-instruction-3",
    );
    events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const third = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "older-instruction-3")!;
    expect((third.payload as any).repositoryInstructions[0].instructions).toEqual([
      expect.objectContaining({ path: "d1/AGENTS.md", content: "changed d1" }),
    ]);
    const resolved = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((resolved.context as any).repositoryInstructions.pendingInstructionCount).toBeUndefined();
    expect((resolved.context as any).repositoryInstructions.discovered.map(
      (item: any) => item.precedence,
    )).toEqual([1, 2, 3, 4, 5]);
  });

  test("records bounded explicit paths and honest unidentified omission occurrences", async () => {
    const { temp, supervisor } = await open();
    for (let index = 1; index <= 82; index++) {
      const directory = join(temp.workspaceRoot, `scope-${index}`);
      await mkdir(directory, { recursive: true });
      await Bun.write(join(directory, "AGENTS.md"), `scope ${index}`);
      await Bun.write(join(directory, "file.ts"), `export const value = ${index};\n`);
    }
    const session = await supervisor.createSession({ workspaceId: "workspace" });
    const paths = Array.from({ length: 82 }, (_, index) => `scope-${index + 1}/file.ts`);
    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `return await Promise.all(${JSON.stringify(paths)}.map((path) => tools.readFile(path)));`,
      [],
      "many-instruction-scopes",
    );
    let events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const committed = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "many-instruction-scopes")!;
    expect((committed.payload as any).repositoryInstructions).toHaveLength(16);
    expect((committed.payload as any).repositoryInstructionOmission).toMatchObject({
      omittedInstructionCount: 66,
      omittedReadTargetCount: 66,
      unidentifiedInstructionOmissionOccurrences: 2,
      unidentifiedReadTargetOmissionOccurrences: 2,
    });
    expect((committed.payload as any).repositoryInstructionOmission.instructionPaths).toHaveLength(64);
    expect((committed.payload as any).repositoryInstructionOmission.targetPaths).toHaveLength(64);
    const omittedPath = (committed.payload as any).repositoryInstructionOmission.instructionPaths[0];
    const omittedTarget = (committed.payload as any).repositoryInstructionOmission.targetPaths[0];
    const pending = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((pending.context as any).repositoryInstructions.pendingInstructionPaths).toContain(omittedPath);
    expect((pending.context as any).repositoryInstructions.omittedReadTargetPaths).toContain(omittedTarget);

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `return await tools.readFile(${JSON.stringify(omittedTarget)});`,
      [],
      "omitted-instruction-retry",
    );
    events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const retried = events.find((event) =>
      event.type === "CellCommitted" &&
      (event.payload as { cellId: string }).cellId === "omitted-instruction-retry")!;
    expect((retried.payload as any).repositoryInstructions[0].instructions).toEqual([
      expect.objectContaining({ path: omittedPath }),
    ]);
    const resolved = await supervisor.contexts.materialize(session.sessionId, session.branchId);
    expect((resolved.context as any).repositoryInstructions.pendingInstructionPaths ?? [])
      .not.toContain(omittedPath);
    expect((resolved.context as any).repositoryInstructions.omittedReadTargetPaths ?? [])
      .not.toContain(omittedTarget);
    expect((resolved.context as any).repositoryInstructions).toMatchObject({
      unidentifiedInstructionOmissionOccurrences: 2,
      unidentifiedReadTargetOmissionOccurrences: 2,
    });
  });
});
