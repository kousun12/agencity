import { afterEach, describe, expect, test } from "bun:test";
import {
  Supervisor,
  projectEvents,
  type JsonValue,
  type ModelConfiguration,
  type ModelProvider,
  type ModelResponse,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

class PlanningProvider implements ModelProvider {
  readonly name = "coding-planner";
  calls = 0;
  async complete(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    expect(configuration.model).toBe("deterministic-plan-v1");
    expect(JSON.stringify(context)).toContain("slugify");
    return {
      text: "Plan: checkpoint the task, reproduce the failing test, edit with a digest precondition, and run the gate.",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 18, costUsd: 0 },
    };
  }
}

const STUB = `export function slugify(_input: string): string {\n  return "";\n}\n`;
const IMPLEMENTATION = `export function slugify(input: string): string {\n  return input\n    .trim()\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n`;
const SPEC = `import { expect, test } from "bun:test";\nimport { slugify } from "../src/slug.ts";\n\ntest("slugifies representative titles", () => {\n  expect(slugify("  Durable Agent: Hello, World!  ")).toBe("durable-agent-hello-world");\n  expect(slugify("already---spaced")).toBe("already-spaced");\n  expect(slugify("***")).toBe("");\n});\n`;

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

describe("representative recoverable coding task", () => {
  test("plans, reproduces, fixes, and verifies code with a fresh worker after every committed cell", async () => {
    const temp = await makeTempRuntime("agencity-coding-task-");
    temps.push(temp);
    const provider = new PlanningProvider();
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      restartConsoleAfterCell: true,
      modelProviders: [provider],
      recover: false,
    });
    const { sessionId, branchId } = await supervisor.createSession({
      workspaceId: "coding-workspace",
      model: { provider: provider.name, model: "deterministic-plan-v1", temperature: 0 },
      budget: { tokenLimit: 1_000, turnLimit: 5 },
    });
    await supervisor.appendMessage(
      sessionId,
      branchId,
      "user",
      "Implement slugify in src/slug.ts and make test/slug.test.ts pass. Preserve durable evidence.",
    );
    expect(await supervisor.modelLoop.turn(sessionId, branchId)).toEqual({
      outcome: "succeeded",
      message: "Plan: checkpoint the task, reproduce the failing test, edit with a digest precondition, and run the gate.",
    });

    const workerPids: number[] = [];
    const assertRebuildStable = async (): Promise<void> => {
      const projected = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
      expect(await supervisor.projections.rebuild(sessionId, branchId)).toEqual(projected);
      expect((await supervisor.projections.getSnapshot(sessionId, branchId)).state).toEqual(projected);
    };

    const initialized = await supervisor.executeCell(sessionId, branchId, `
      await tools.writeFile("src/slug.ts", ${JSON.stringify(STUB)});
      await tools.writeFile("test/slug.test.ts", ${JSON.stringify(SPEC)});
      await state.set("codingTask", {
        requirement: "implement slugify",
        gate: "bun test ./test/slug.test.ts",
        phase: "initialized"
      });
      (globalThis as any).__codingHeap = "not durable";
      return { pid: process.pid };
    `);
    workerPids.push((initialized.result as { pid: number }).pid);
    await assertRebuildStable();

    const reproduced = await supervisor.executeCell(sessionId, branchId, `
      const task = await state.get("codingTask");
      const baseline = await tools.request(
        "shell",
        "run",
        { command: "bun test ./test/slug.test.ts" },
        { idempotencyKey: "coding-task:baseline-test", idempotent: true },
      );
      if (baseline.outcome !== "failed") throw new Error("expected the baseline test to fail");
      await state.set("baselineEvidence", {
        outcome: baseline.outcome,
        error: baseline.error ?? null,
        output: baseline.output ?? null,
      });
      return {
        pid: process.pid,
        heap: (globalThis as any).__codingHeap ?? null,
        task,
        baseline,
      };
    `);
    const reproducedResult = reproduced.result as Record<string, any>;
    workerPids.push(reproducedResult.pid);
    expect(reproducedResult.heap).toBeNull();
    expect(reproducedResult.baseline).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(reproducedResult.baseline)).toContain("expected");
    await assertRebuildStable();

    const edited = await supervisor.executeCell(sessionId, branchId, `
      const current = await tools.readFile("src/slug.ts");
      if (typeof current.sha256 !== "string") throw new Error("missing source digest");
      const write = await tools.writeFile("src/slug.ts", ${JSON.stringify(IMPLEMENTATION)}, current.sha256);
      await state.set("codingTask", {
        requirement: "implement slugify",
        gate: "bun test ./test/slug.test.ts",
        phase: "implemented",
        sourceSha256: write.sha256,
      });
      return { pid: process.pid, write };
    `);
    workerPids.push((edited.result as { pid: number }).pid);
    expect(await Bun.file(`${temp.workspaceRoot}/src/slug.ts`).text()).toBe(IMPLEMENTATION);
    await assertRebuildStable();

    const verified = await supervisor.executeCell(sessionId, branchId, `
      const gate = await tools.shell("bun test ./test/slug.test.ts");
      await state.set("completion", {
        status: "complete",
        gate: "bun test ./test/slug.test.ts",
        exitCode: gate.exitCode,
        stdout: gate.stdout,
        stderr: gate.stderr,
      });
      return { pid: process.pid, gate };
    `);
    const verifiedResult = verified.result as Record<string, any>;
    workerPids.push(verifiedResult.pid);
    expect(verifiedResult.gate).toMatchObject({ exitCode: 0 });
    expect(`${verifiedResult.gate.stdout}\n${verifiedResult.gate.stderr}`).toMatch(/1 pass/);
    expect(new Set(workerPids).size).toBe(workerPids.length);
    expect(workerPids.every((pid) => pid !== process.pid)).toBe(true);
    await assertRebuildStable();

    const beforeRestart = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    expect(beforeRestart.workingValues.codingTask).toMatchObject({
      version: 2,
      value: { kind: "json", value: { phase: "implemented" } },
    });
    expect(beforeRestart.workingValues.baselineEvidence?.value.kind).toBe("json");
    expect(beforeRestart.workingValues.completion).toMatchObject({
      value: { kind: "json", value: { status: "complete", exitCode: 0 } },
    });
    expect(Object.values(beforeRestart.cells).every((cell) => cell.status === "committed")).toBe(true);
    await supervisor.close();

    const restarted = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      restartConsoleAfterCell: true,
      modelProviders: [provider],
      recover: true,
    });
    const afterRestart = await restarted.projections.rebuild(sessionId, branchId);
    expect(afterRestart).toEqual(beforeRestart);
    expect(provider.calls).toBe(1);
    expect(await Bun.file(`${temp.workspaceRoot}/src/slug.ts`).text()).toBe(IMPLEMENTATION);
    await restarted.close();
  }, 20_000);
});
