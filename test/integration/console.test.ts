import { afterEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ConsoleCellError,
  ConsoleProcess,
  EVENT_SCHEMA_VERSION,
  MAX_WORKING_JSON_BYTES,
  Supervisor,
  jsonBytes,
  projectEvents,
  serializeScratch,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
const originalSecret = process.env.AGENCITY_RPC_TEST_SECRET;
afterEach(async () => {
  if (originalSecret === undefined) delete process.env.AGENCITY_RPC_TEST_SECRET;
  else process.env.AGENCITY_RPC_TEST_SECRET = originalSecret;
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function open(restartConsoleAfterCell = true): Promise<{
  temp: TempRuntime;
  supervisor: Supervisor;
  sessionId: string;
  branchId: string;
}> {
  const temp = await makeTempRuntime("agencity-console-");
  temps.push(temp);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    restartConsoleAfterCell,
    recover: false,
  });
  const { sessionId, branchId } = await supervisor.createSession({ workspaceId: "console-workspace" });
  return { temp, supervisor, sessionId, branchId };
}

async function filesBelow(path: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files.push(child);
    }
  };
  await visit(path);
  return files;
}

describe("disposable TypeScript console process", () => {
  test("stages oversized result JSON in bounded RPC chunks before terminal IPC", async () => {
    const console = new ConsoleProcess();
    let declared = 0;
    let received = 0;
    const chunkSizes: number[] = [];
    try {
      const execution = await console.execute(
        `return { data: "🧪".repeat(80_000) };`,
        { id: "session", branchId: "branch" },
        {},
        async (method, args) => {
          if (method === "observation.stage.begin") {
            declared = Number(args[0]);
            return { accepted: true };
          }
          if (method === "observation.stage.chunk") {
            const size = Buffer.from(String(args[0]), "base64").byteLength;
            chunkSizes.push(size);
            received += size;
            return { received };
          }
          if (method === "observation.stage.finish") {
            return {
              protocol: "agencity.bounded-output.v1",
              completeness: "spilled",
              byteLength: received,
              preview: args[0] as any,
              artifact: {
                artifactId: `sha256:${"a".repeat(64)}`,
                digest: "a".repeat(64),
                mediaType: "application/json",
                size: received,
              },
              guidance: "fixture",
            };
          }
          throw new Error(`Unexpected RPC method ${method}`);
        },
      );
      expect(declared).toBeGreaterThan(128 * 1024);
      expect(received).toBe(declared);
      expect(chunkSizes.length).toBeGreaterThan(1);
      expect(chunkSizes.every((size) => size <= 64 * 1024)).toBe(true);
      expect(execution.observation.kind).toBe("staged");
      expect(execution.observation).not.toHaveProperty("json");
    } finally {
      await console.stop();
    }
  });

  test("stages an otherwise-inline result when logs would exceed terminal IPC", async () => {
    const console = new ConsoleProcess();
    let staged = false;
    let received = 0;
    try {
      const execution = await console.execute(
        `console.log("\\\\".repeat(60_000)); return { data: "x".repeat(100_000) };`,
        { id: "session", branchId: "branch" },
        {},
        async (method, args) => {
          if (method === "observation.stage.begin") {
            staged = true;
            return { accepted: true };
          }
          if (method === "observation.stage.chunk") {
            received += Buffer.from(String(args[0]), "base64").byteLength;
            return { received };
          }
          if (method === "observation.stage.finish") {
            return {
              protocol: "agencity.bounded-output.v1",
              completeness: "spilled",
              byteLength: received,
              preview: args[0] as any,
              artifact: {
                artifactId: `sha256:${"b".repeat(64)}`,
                digest: "b".repeat(64),
                mediaType: "application/json",
                size: received,
              },
              guidance: "fixture",
            };
          }
          throw new Error(`Unexpected RPC method ${method}`);
        },
      );
      expect(staged).toBe(true);
      expect(execution.observation.kind).toBe("staged");
      expect(execution.logs).toHaveLength(1);
    } finally {
      await console.stop();
    }
  });

  test("uses real RPC for state, SQL, artifacts, files, and shell across a worker restart after every cell", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const first = await supervisor.executeCell(sessionId, branchId, `
      const counter = await state.set("counter", { value: 41, flags: [true, null] });
      const reference = await artifacts.put("durable artifact body", "text/plain");
      await state.set("artifactId", reference.artifactId);
      const written = await tools.writeFile("notes/result.txt", "file-through-rpc");
      const shellResult = await tools.shell("printf shell-through-rpc");
      const rows = await sql\`SELECT type FROM events WHERE session_id = \${session.id} ORDER BY sequence\`;
      (globalThis as any).__heapOnly = "must disappear";
      console.log("first-cell", counter.kind, rows.length);
      return {
        pid: process.pid,
        artifactId: reference.artifactId,
        written,
        shell: shellResult,
        eventTypes: rows.map((row: any) => row.type),
      };
    `);
    const firstResult = first.result as Record<string, any>;
    expect(firstResult.pid).not.toBe(process.pid);
    expect(first.logs).toEqual([expect.stringMatching(/^first-cell json \d+$/)]);
    expect(firstResult.shell).toMatchObject({
      completeness: "inline",
      value: { exitCode: 0, stdout: "shell-through-rpc" },
    });
    expect(firstResult.eventTypes).toContain("SessionCreated");
    const proposedIndex = firstResult.eventTypes.indexOf("CellProposed");
    expect(proposedIndex).toBeGreaterThanOrEqual(0);
    expect(firstResult.eventTypes[proposedIndex + 1]).toBe("CellStarted");
    expect(firstResult.eventTypes).not.toContain("CellCommitted");

    const second = await supervisor.executeCell(sessionId, branchId, `
      const counter = await state.get("counter");
      const artifactValue = await state.get("artifactId");
      if (!artifactValue || artifactValue.kind !== "json" || typeof artifactValue.value !== "string") {
        throw new Error("artifact id was not restored");
      }
      const bodyRange = await artifacts.readRange(artifactValue.value, 0, 21);
      const body = new TextDecoder().decode(bodyRange.value.bytes);
      const file = await tools.readFile("notes/result.txt");
      const shellResult = await tools.shell("cat notes/result.txt");
      const rows = await sql\`SELECT type, payload_json FROM events WHERE session_id = \${session.id} ORDER BY sequence\`;
      return {
        pid: process.pid,
        heapOnly: (globalThis as any).__heapOnly ?? null,
        restoredDirectly: state.restored.counter,
        counter,
        body,
        file,
        shell: shellResult,
        rowCount: rows.length,
      };
    `);
    const secondResult = second.result as Record<string, any>;
    expect(secondResult.pid).not.toBe(process.pid);
    expect(secondResult.pid).not.toBe(firstResult.pid);
    expect(secondResult.heapOnly).toBeNull();
    expect(secondResult.counter).toEqual({ kind: "json", value: { value: 41, flags: [true, null] } });
    expect(secondResult.restoredDirectly).toEqual(secondResult.counter);
    expect(secondResult.body).toBe("durable artifact body");
    expect(secondResult.file).toMatchObject({
      completeness: "inline",
      value: { content: "file-through-rpc", size: 16, startLine: 1, endLine: 1 },
    });
    expect(secondResult.shell).toMatchObject({
      completeness: "inline",
      value: { exitCode: 0, stdout: "file-through-rpc" },
    });
    expect(secondResult.shell).not.toHaveProperty("outcome");
    expect(secondResult.rowCount).toBeGreaterThan(firstResult.eventTypes.length);

    const state = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    expect(state.cells[first.cellId]?.status).toBe("committed");
    expect(state.cells[second.cellId]?.status).toBe("committed");
    expect(state.workingValues.counter?.version).toBe(1);
    expect(await Bun.file(join((supervisor.artifacts as any).root, "missing-never-read")).exists()).toBe(false);
    await supervisor.close();
  });

  test("defaults omitted artifact media type to text/plain", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const defaulted = await supervisor.executeCell(sessionId, branchId, `
      return await artifacts.put("default media type");
    `);
    expect(defaulted.result).toMatchObject({ mediaType: "text/plain" });
    await supervisor.close();
  });

  test("rejects explicitly invalid Console SDK optional argument types", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const invalidCalls = [
      {
        source: `return await (artifacts as any).put("body", null);`,
        error: /Artifact media type must be a string/,
      },
      {
        source: `return await (cells as any).list(null);`,
        error: /Cell list options must be an object/,
      },
      {
        source: `return await (cells as any).list({ limit: "20" });`,
        error: /Cell list limit must be an integer/,
      },
      {
        source: `return await (sdk.context as any).compact(null);`,
        error: /Context compaction options must be an object/,
      },
      {
        source: `return await (sdk.context as any).compact({ strategy: 42 });`,
        error: /Context compaction strategy must be a string/,
      },
      {
        source: `return await (sdk.schedules as any).wakes("queued");`,
        error: /Schedule wake statuses must be an array/,
      },
      {
        source: `return await (sdk.schedules as any).wakes([42]);`,
        error: /Schedule wake statuses contain an invalid value/,
      },
      {
        source: `return await (sdk.skills as any).propose("proposal", 42);`,
        error: /Skill proposal scope must be local or workspace/,
      },
      {
        source: `return await (sdk.skills as any).list({ includeUnavailable: "yes" });`,
        error: /Skill list include-unavailable must be a boolean/,
      },
      {
        source: `return await (sdk.harness as any).review(null);`,
        error: /Harness review input must be an object/,
      },
      {
        source: `return await (sdk.memory as any).search("query", { scopes: null });`,
        error: /Memory search scopes must be an array of strings/,
      },
      {
        source: `return await (sdk.memory as any).create({ text: "fact", scope: null });`,
        error: /Memory scope must be a string/,
      },
      {
        source: `return await (sdk.heartbeats as any).create({ intervalMs: 1000, nextTickAt: null });`,
        error: /Heartbeat next tick must be a string/,
      },
      {
        source: `return await (sdk.schedules as any).create({ prompt: "later", at: 42 });`,
        error: /Schedule time must be a string/,
      },
      {
        source: `return await (sdk.schedules as any).create({ prompt: "later", goalMode: null });`,
        error: /Schedule goal mode must be a string/,
      },
      {
        source: `return await (sdk.agents as any).get({});`,
        error: /Agent profile target must be a string/,
      },
      {
        source: `return await (sdk.agents as any).messages(null);`,
        error: /Agent message options must be an object/,
      },
      {
        source: `return await (sdk.agents as any).messages({ pendingOnly: "yes" });`,
        error: /Agent message pending-only filter must be a boolean/,
      },
      {
        source: `return await (sdk.agents as any).spawn({ task: "x", idempotencyKey: 42 });`,
        error: /Agent spawn idempotency key must be a string/,
      },
      {
        source: `return await (sdk.skills as any).invoke("missing", {}, { versionId: 42 });`,
        error: /Skill invocation version must be a string/,
      },
      {
        source: `return await (sdk.specs as any).spawn("missing", { task: 42 });`,
        error: /Subagent specification task must be a string/,
      },
      {
        source: `return await (sdk.ai as any).generateText({ prompt: "x", idempotencyKey: 42 });`,
        error: /ai.generateText idempotency key must be a string/,
      },
      {
        source: `return await (tools as any).request("shell", "run", { command: "true" }, null);`,
        error: /Tool request options must be an object/,
      },
      {
        source: `return await (tools as any).request("shell", "run", { command: "true" }, { idempotent: "yes" });`,
        error: /Tool request idempotent must be a boolean/,
      },
      {
        source: `return await (tools as any).writeFile("invalid.txt", "body", 42);`,
        error: /writeFile expectedSha256 must be a string/,
      },
      {
        source: `return await (tools as any).readFile("missing.txt", null);`,
        error: /readFile options must be an object/,
      },
      {
        source: `return await (tools as any).shell("true", { timeoutMs: "forever" });`,
        error: /Shell timeout must be a number/,
      },
      {
        source: `return inspect({ ok: true }, { depth: "deep" } as any);`,
        error: /inspect depth must be a finite number/,
      },
    ];
    for (const { source, error } of invalidCalls) {
      await expect(supervisor.executeCell(sessionId, branchId, source))
        .rejects.toBeInstanceOf(ConsoleCellError);
      const latestFailure = (await supervisor.storage.loadEvents(sessionId, {
        branchId,
      })).filter((event) => event.type === "CellFailed").at(-1);
      expect(String((latestFailure?.payload as { error?: unknown })?.error))
        .toMatch(error);
    }

    const state = projectEvents(
      await supervisor.storage.loadEvents(sessionId, { branchId }),
    );
    expect(Object.values(state.artifacts)).toHaveLength(0);
    expect(Object.values(state.effects)).toHaveLength(1);
    expect(Object.values(state.effects)[0]).toMatchObject({
      executor: "shell",
      operation: "run",
      status: "failed",
    });
    expect(Object.values(state.cells).filter((cell) => cell.status === "failed"))
      .toHaveLength(invalidCalls.length);
    await supervisor.close();
  });


  test("isolates arbitrary stdout from IPC, bounds it as logs, and keeps the worker usable", async () => {
    const { supervisor, sessionId, branchId } = await open(false);
    const protocolShape = JSON.stringify({
      type: "result", executionId: "spoofed", ok: true, value: "forged", logs: [],
    });
    const first = await supervisor.executeCell(sessionId, branchId, `
      process.stdout.write(${JSON.stringify(protocolShape + "\n")});
      process.stderr.write("stderr is a log\\n");
      process.stdout.write("x".repeat(100_000));
      return { pid: process.pid, token: "benign-page-token", auth: { mode: "oauth" } };
    `);
    expect(first.result).toMatchObject({ token: "benign-page-token", auth: { mode: "oauth" } });
    expect(first.logs).toContain(protocolShape);
    expect(first.logs).toContain("stderr is a log");
    expect(first.logs).toContain("[console output truncated]");
    expect(new TextEncoder().encode(first.logs.join("\n")).byteLength).toBeLessThan(70_000);
    const firstCell = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId })).cells[first.cellId];
    expect(firstCell?.logStreams.slice(0, 2)).toEqual(["stdout", "stderr"]);
    expect(firstCell?.logStreams).toHaveLength(first.logs.length);

    const second = await supervisor.executeCell(sessionId, branchId, `return { pid: process.pid, ok: true };`);
    expect(second.result).toMatchObject({ pid: (first.result as any).pid, ok: true });
    expect(projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId })).cells[second.cellId]?.status)
      .toBe("committed");
    await supervisor.close();
  });

  test("round-trips JSON at exactly 128 KiB and converts the first byte over to a deduplicated artifact", async () => {
    const { temp, supervisor, sessionId, branchId } = await open(true);
    const emptyEnvelopeBytes = jsonBytes({ data: "" });
    const exactCharacters = MAX_WORKING_JSON_BYTES - emptyEnvelopeBytes;
    expect(jsonBytes({ data: "x".repeat(exactCharacters) })).toBe(MAX_WORKING_JSON_BYTES);
    expect(jsonBytes({ data: "x".repeat(exactCharacters + 1) })).toBe(MAX_WORKING_JSON_BYTES + 1);

    await supervisor.executeCell(sessionId, branchId, `
      const exact = { data: "x".repeat(${exactCharacters}) };
      const over = { data: "x".repeat(${exactCharacters + 1}) };
      const exactStored = await state.set("exact", exact);
      const overStored = await state.set("overA", over);
      return { exactStoredKind: exactStored.kind, overStored };
    `);
    await supervisor.executeCell(sessionId, branchId, `
      const over = { data: "x".repeat(${exactCharacters + 1}) };
      return await state.set("overB", over);
    `);

    const state = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    expect(state.workingValues.exact?.value).toEqual({
      kind: "json",
      value: { data: "x".repeat(exactCharacters) },
    });
    expect(state.workingValues.overA?.value.kind).toBe("artifact");
    expect(state.workingValues.overB?.value).toEqual(state.workingValues.overA?.value);
    const artifactId = (state.workingValues.overA!.value as { kind: "artifact"; artifactId: string }).artifactId;
    expect(state.artifacts[artifactId]).toMatchObject({
      artifactId,
      mediaType: "application/json",
      size: MAX_WORKING_JSON_BYTES + 1,
    });
    expect(await filesBelow(temp.artifactDirectory)).toHaveLength(1);
    const bytes = await supervisor.artifacts.resolve(state.artifacts[artifactId]!);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ data: "x".repeat(exactCharacters + 1) });
    await supervisor.close();
  });

  test("commits no staged working values or artifact references when the cell fails", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const before = await supervisor.storage.loadEvents(sessionId, { branchId });
    await expect(supervisor.executeCell(sessionId, branchId, `
      await state.set("mustNotCommit", { partial: true });
      await artifacts.put("unreferenced bytes after failure", "text/plain");
      console.log("failure-log");
      throw new Error("intentional cell failure");
    `)).rejects.toBeInstanceOf(ConsoleCellError);

    const events = await supervisor.storage.loadEvents(sessionId, { branchId });
    const appended = events.slice(before.length);
    expect(appended.map((event) => event.type)).toEqual([
      "CellProposed", "CellStarted", "CellFailed",
    ]);
    expect(appended.some((event) => event.type === "WorkingValueSet")).toBe(false);
    expect(appended.some((event) => event.type === "ArtifactRegistered")).toBe(false);
    const state = projectEvents(events);
    expect(state.workingValues.mustNotCommit).toBeUndefined();
    const failed = Object.values(state.cells).find((cell) => cell.status === "failed");
    expect(failed?.logs).toEqual(["failure-log"]);
    expect(failed?.error).toContain("intentional cell failure");
    await supervisor.close();
  });

  test("generated SQL cannot mutate history or inspect private operational state", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const beforeCount = (await supervisor.storage.loadEvents(sessionId)).length;
    await expect(supervisor.executeCell(sessionId, branchId, `
      await sql\`DELETE FROM events\`;
      return "unreachable";
    `)).rejects.toThrow(/read-only/i);
    await expect(supervisor.executeCell(sessionId, branchId, `
      await sql\`SELECT * FROM outbox\`;
      return "unreachable";
    `)).rejects.toThrow(/read-only|private/i);
    const events = await supervisor.storage.loadEvents(sessionId, { branchId });
    expect(events).toHaveLength(beforeCount + 6);
    expect(events.filter((event) => event.type === "CellFailed")).toHaveLength(2);
    expect(events[0]?.type).toBe("SessionCreated");
    await supervisor.close();
  });

  test("worker, shell, durable inputs, logs, and errors never expose a brokered environment secret", async () => {
    const secret = "rpc-broker-secret-a811";
    process.env.AGENCITY_RPC_TEST_SECRET = secret;
    const { supervisor, sessionId, branchId } = await open(true);
    const visibility = await supervisor.executeCell(sessionId, branchId, `
      const shellResult = await tools.shell('if [ -z "$AGENCITY_RPC_TEST_SECRET" ]; then printf absent; else printf present; fi');
      return {
        worker: process.env.AGENCITY_RPC_TEST_SECRET ?? null,
        shell: shellResult,
      };
    `);
    expect(visibility.result).toMatchObject({
      worker: null,
      shell: { completeness: "inline", value: { exitCode: 0, stdout: "absent" } },
    });

    await expect(supervisor.appendMessage(sessionId, branchId, "user", `do not store ${secret}`))
      .rejects.toThrow(/credential|brokered/i);
    const beforeRejectedInputs = (await supervisor.storage.loadEvents(sessionId, { branchId })).length;
    for (const code of [
      `await state.set("bad", { token: "${secret}" }); return null;`,
      `await artifacts.put("${secret}"); return null;`,
      `await tools.request("shell", "run", { command: "printf ${secret}" }); return null;`,
    ]) {
      await expect(supervisor.executeCell(sessionId, branchId, code)).rejects.toThrow(/credential|brokered/i);
    }
    const retained = await supervisor.storage.loadEvents(sessionId, { branchId });
    const durable = JSON.stringify(retained);
    expect(retained).toHaveLength(beforeRejectedInputs);
    expect(durable).not.toContain(secret);
    expect(projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId })).workingValues.bad)
      .toBeUndefined();
    await supervisor.close();
  });

  test("observes the final top-level expression, awaits promises, and preserves explicit returns", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const expression = await supervisor.executeCell(sessionId, branchId, `
      const x = { answer: 42 };
      console.log("separate-log");
      x
    `);
    expect(expression.result).toEqual({ answer: 42 });
    expect(expression.logs).toEqual(["separate-log"]);

    const promised = await supervisor.executeCell(sessionId, branchId, `
      const nested = () => { return 7; };
      Promise.resolve({ awaited: nested() })
    `);
    expect(promised.result).toEqual({ awaited: 7 });

    const explicit = await supervisor.executeCell(sessionId, branchId, `
      if (true) return Promise.resolve({ path: "explicit" });
      ({ path: "final-expression" })
    `);
    expect(explicit.result).toEqual({ path: "explicit" });

    const declaration = await supervisor.executeCell(sessionId, branchId, `const ephemeral = 42;`);
    expect(declaration.result).toBeNull();
    const afterRestart = await supervisor.executeCell(sessionId, branchId, `typeof ephemeral`);
    expect(afterRestart.result).toBe("undefined");
    await supervisor.close();
  });

  test("inspect is byte/line/entry/depth bounded, redacts fields, skips getters, and marks circular values", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const inspected = await supervisor.executeCell(sessionId, branchId, `
      let getterCalls = 0;
      const value: any = { password: "not-for-preview" };
      Object.defineProperty(value, "computed", { enumerable: true, get() { getterCalls++; return "unsafe"; } });
      value.circular = value;
      value.nested = { values: Array.from({ length: 500 }, (_, index) => index) };
      ({ preview: inspect(value, { bytes: 512, lines: 12, entries: 10, depth: 3 }), getterCalls })
    `);
    const result = inspected.result as any;
    expect(result.getterCalls).toBe(0);
    expect(result.preview).toMatchObject({
      kind: "inspect",
      truncated: true,
      redacted: 1,
      omittedGetters: 1,
      limits: { bytes: 512, lines: 12, entries: 10, depth: 3, getters: 0 },
    });
    expect(new TextEncoder().encode(result.preview.preview).byteLength).toBeLessThanOrEqual(512);
    expect(result.preview.preview.split("\n").length).toBeLessThanOrEqual(12);
    expect(result.preview.preview).toContain("[REDACTED]");
    expect(result.preview.preview).toContain("[Getter omitted]");
    expect(result.preview.preview).toContain("[Circular]");
    expect(result.preview.preview).not.toContain("not-for-preview");

    const unsupported = await supervisor.executeCell(sessionId, branchId, `
      class Example { constructor(readonly answer: number) {} }
      new Example(42)
    `);
    expect(unsupported.result).toMatchObject({
      kind: "unsupported",
      reason: expect.stringMatching(/Non-plain object/),
      preview: { kind: "inspect" },
    });
    const circular = await supervisor.executeCell(sessionId, branchId, `
      const value: any = { safe: true };
      value.self = value;
      value
    `);
    expect(circular.result).toMatchObject({
      kind: "unsupported",
      reason: expect.stringMatching(/Circular reference/),
      preview: { preview: expect.stringContaining("[Circular]") },
    });
    await supervisor.close();
  });

  test("moves oversized observations to one deduplicated JSON artifact and commits only a bounded preview", async () => {
    const { temp, supervisor, sessionId, branchId } = await open(true);
    const code = `Array.from({ length: 50_000 }, (_, index) => ({ index, even: index % 2 === 0 }))`;
    const first = await supervisor.executeCell(sessionId, branchId, code);
    const second = await supervisor.executeCell(sessionId, branchId, code);
    const firstResult = first.result as any;
    const secondResult = second.result as any;
    expect(firstResult).toMatchObject({
      protocol: "agencity.bounded-output.v1",
      completeness: "spilled",
      artifact: { mediaType: "application/json" },
      preview: { kind: "inspect", truncated: true },
    });
    expect(firstResult.byteLength).toBeGreaterThan(MAX_WORKING_JSON_BYTES);
    expect(secondResult.artifact.artifactId).toBe(firstResult.artifact.artifactId);
    expect(await filesBelow(temp.artifactDirectory)).toHaveLength(1);
    expect(JSON.stringify(first.result).length).toBeLessThan(20_000);

    const state = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    const reference = state.artifacts[firstResult.artifact.artifactId];
    expect(reference).toMatchObject(firstResult.artifact);
    const complete = JSON.parse(new TextDecoder().decode(await supervisor.artifacts.resolve(reference!)));
    expect(complete).toHaveLength(50_000);
    expect(complete[49_999]).toEqual({ index: 49_999, even: false });
    await supervisor.close();
  });

  test("streams oversized JSON through validation and secret scrubbing before CAS placement", async () => {
    const secret = "rpc-broker-secret-a811";
    process.env.AGENCITY_RPC_TEST_SECRET = secret;
    const { supervisor, sessionId, branchId } = await open(true);
    const cell = await supervisor.executeCell(sessionId, branchId, `
      const reconstructed = ["rpc-broker-", "secret-a811"].join("");
      return {
        values: Array.from({ length: 20_000 }, () => reconstructed),
        keyed: { [reconstructed]: "hidden-key" },
        escaped: { "line\\nkey": "safe\\nvalue" },
      };
    `);
    const output = cell.result as any;
    expect(output).toMatchObject({
      completeness: "spilled",
      artifact: { mediaType: "application/json" },
    });
    const bytes = await supervisor.artifacts.resolve(output.artifact);
    const serialized = new TextDecoder().decode(bytes);
    expect(serialized).not.toContain(secret);
    const complete = JSON.parse(serialized);
    expect(complete.values).toHaveLength(20_000);
    expect(new Set(complete.values)).toEqual(new Set(["[REDACTED]"]));
    expect(complete.keyed).toEqual({ "[REDACTED]": "hidden-key" });
    expect(complete.escaped).toEqual({ "line\nkey": "safe\nvalue" });
    await supervisor.close();
  });

  test("registers a shell spill atomically with its effect outcome", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const append = supervisor.storage.appendEvents.bind(supervisor.storage);
    const batches: string[][] = [];
    Object.defineProperty(supervisor.storage, "appendEvents", {
      configurable: true,
      value: async (events: Parameters<typeof append>[0]) => {
        batches.push(events.map((item) => item.type));
        return append(events);
      },
    });
    try {
      const cell = await supervisor.executeCell(sessionId, branchId, `
        const shell = await tools.shell("bun -e 'process.stdout.write(\\"x\\".repeat(30000))'");
        return {
          completeness: shell.completeness,
          artifactId: shell.completeness === "spilled" ? shell.artifact.artifactId : null,
        };
      `);
      expect(cell.result).toMatchObject({ completeness: "spilled", artifactId: expect.any(String) });
      const atomic = batches.find((batch) =>
        batch.includes("ArtifactRegistered") && batch.includes("EffectOutcomeRecorded"));
      expect(atomic).toEqual(["ArtifactRegistered", "EffectOutcomeRecorded"]);
      const events = await supervisor.storage.loadEvents(sessionId, { branchId });
      const outcome = events.find((item) => item.type === "EffectOutcomeRecorded");
      const artifact = events.find((item) => item.type === "ArtifactRegistered");
      expect((outcome?.payload as any).output.artifact.artifactId)
        .toBe((artifact?.payload as any).artifactId);
    } finally {
      Object.defineProperty(supervisor.storage, "appendEvents", { configurable: true, value: append });
      await supervisor.close();
    }
  });

  test("does not expose a shell spill reference when atomic registration fails", async () => {
    const { temp, supervisor, sessionId, branchId } = await open(true);
    const append = supervisor.storage.appendEvents.bind(supervisor.storage);
    let failed = false;
    Object.defineProperty(supervisor.storage, "appendEvents", {
      configurable: true,
      value: async (events: Parameters<typeof append>[0]) => {
        if (!failed && events.some((item) => item.type === "ArtifactRegistered") &&
            events.some((item) => item.type === "EffectOutcomeRecorded")) {
          failed = true;
          throw new Error("simulated atomic append crash");
        }
        return append(events);
      },
    });
    try {
      await expect(supervisor.executeCell(sessionId, branchId, `
        await tools.shell("bun -e 'process.stdout.write(\\"x\\".repeat(30000))'");
        return "unreachable";
      `)).rejects.toThrow(/atomic append crash/);
      const events = await supervisor.storage.loadEvents(sessionId, { branchId });
      expect(events.some((item) => item.type === "ArtifactRegistered")).toBe(false);
      expect(events.some((item) => item.type === "EffectOutcomeRecorded")).toBe(false);
      expect(events.some((item) => item.type === "CellCommitted")).toBe(false);
      expect(events.some((item) => item.type === "CellFailed")).toBe(true);
      expect((await filesBelow(temp.artifactDirectory)).length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(supervisor.storage, "appendEvents", { configurable: true, value: append });
      await supervisor.close();
    }
  });

  test("keeps an oversized staged cell result atomic when its commit fails", async () => {
    const { temp, supervisor, sessionId, branchId } = await open(true);
    const append = supervisor.storage.appendEvents.bind(supervisor.storage);
    let failed = false;
    Object.defineProperty(supervisor.storage, "appendEvents", {
      configurable: true,
      value: async (events: Parameters<typeof append>[0]) => {
        if (!failed && events.some((item) => item.type === "ArtifactRegistered") &&
            events.some((item) => item.type === "CellCommitted")) {
          failed = true;
          throw new Error("simulated staged-cell commit crash");
        }
        return append(events);
      },
    });
    try {
      await expect(supervisor.executeCell(
        sessionId,
        branchId,
        `return { data: "x".repeat(200000) };`,
      )).rejects.toThrow(/staged-cell commit crash/);
      const events = await supervisor.storage.loadEvents(sessionId, { branchId });
      expect(events.some((item) => item.type === "ArtifactRegistered")).toBe(false);
      expect(events.some((item) => item.type === "CellCommitted")).toBe(false);
      expect(events.some((item) => item.type === "CellFailed")).toBe(true);
      expect((await filesBelow(temp.artifactDirectory)).length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(supervisor.storage, "appendEvents", { configurable: true, value: append });
      await supervisor.close();
    }
  });

  test("cleans incomplete cell staging and commits only failure when placement fails", async () => {
    const { temp, supervisor, sessionId, branchId } = await open(true);
    const putStaged = supervisor.artifacts.putStaged.bind(supervisor.artifacts);
    Object.defineProperty(supervisor.artifacts, "putStaged", {
      configurable: true,
      value: async () => {
        throw new Error("simulated staged placement failure");
      },
    });
    try {
      await expect(supervisor.executeCell(
        sessionId,
        branchId,
        `return { data: "x".repeat(200000) };`,
      )).rejects.toThrow(/staged placement failure/);
      const events = await supervisor.storage.loadEvents(sessionId, { branchId });
      expect(events.some((item) => item.type === "ArtifactRegistered")).toBe(false);
      expect(events.some((item) => item.type === "CellCommitted")).toBe(false);
      expect(events.some((item) => item.type === "CellFailed")).toBe(true);
      expect(await filesBelow(temp.artifactDirectory)).toHaveLength(0);
    } finally {
      Object.defineProperty(supervisor.artifacts, "putStaged", {
        configurable: true,
        value: putStaged,
      });
      await supervisor.close();
    }
  });

  test("lists durable state and prior cells with exact event provenance without replay", async () => {
    const { supervisor, sessionId, branchId } = await open(true);
    const first = await supervisor.executeCell(sessionId, branchId, `
      await state.set("x", 42);
      console.warn("history-log");
      ({ answer: 42 })
    `, ["input-dependency"]);

    const historyRead = await supervisor.executeCell(sessionId, branchId, `
      const values = await state.list();
      const history = await cells.list({ limit: 10 });
      const cell = await cells.get(${JSON.stringify(first.cellId)});
      ({ values, history, cell })
    `);
    const result = historyRead.result as any;
    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toMatchObject({
      name: "x",
      version: 1,
      value: { kind: "json", value: 42 },
      status: "committed",
      provenance: { type: "WorkingValueSet", eventId: expect.any(String), cursor: expect.any(String) },
    });
    expect(result.history.items).toHaveLength(1);
    expect(result.history.nextCursor).toBeNull();
    expect(result.cell).toMatchObject({
      cellId: first.cellId,
      source: expect.stringContaining(`state.set("x", 42)`),
      status: "committed",
      dependencies: ["input-dependency"],
      attempts: 1,
      observation: { answer: 42 },
      logs: ["history-log"],
      durationMs: expect.any(Number),
      provenance: {
        proposed: { type: "CellProposed", eventId: expect.any(String), schemaVersion: EVENT_SCHEMA_VERSION },
        starts: [{ type: "CellStarted", eventId: expect.any(String), schemaVersion: EVENT_SCHEMA_VERSION }],
        terminal: { type: "CellCommitted", eventId: expect.any(String), schemaVersion: EVENT_SCHEMA_VERSION },
      },
    });

    const context = await supervisor.contexts.materialize(sessionId, branchId);
    expect((context.context as any).workingValues).toContainEqual(expect.objectContaining({
      name: "x",
      version: 1,
      value: { kind: "json", value: 42 },
      eventId: result.values[0].provenance.eventId,
    }));
    await supervisor.close();
  });

  test("keeps arbitrary scratch identity on one warm exact session branch", async () => {
    const { supervisor, sessionId, branchId } = await open(false);
    const first = await supervisor.executeCell(sessionId, branchId, `
      scratch.index = { files: ["a.ts"], marker: {} };
      scratch.sameMarker = scratch.index.marker;
      scratch.helper = (value: string) => value.trim().toUpperCase();
      ({ status: await sdk.scratch.status(), pid: process.pid })
    `);
    expect((first.result as any).status).toMatchObject({
      scope: { sessionId, branchId },
      temperature: "cold",
      cache: { available: false, restoreAttempted: false },
    });
    const second = await supervisor.executeCell(sessionId, branchId, `
      scratch.index.files.push("b.ts");
      ({
        files: scratch.index.files,
        identity: scratch.sameMarker === scratch.index.marker,
        helper: scratch.helper(" warm "),
        status: await sdk.scratch.status(),
        pid: process.pid,
      })
    `);
    expect(second.result).toMatchObject({
      files: ["a.ts", "b.ts"],
      identity: true,
      helper: "WARM",
      status: { temperature: "warm" },
      pid: (first.result as any).pid,
    });
    const cleared = await supervisor.executeCell(sessionId, branchId, `
      const status = await sdk.scratch.clear();
      ({
        hasIndex: "index" in scratch,
        propertyNames: status.propertyNames,
        pid: process.pid,
      })
    `);
    expect(cleared.result).toEqual({
      hasIndex: false,
      propertyNames: [],
      pid: (first.result as any).pid,
    });

    const other = await supervisor.createSession({ workspaceId: "console-workspace" });
    const isolated = await supervisor.executeCell(other.sessionId, other.branchId, `
      ({ hasIndex: "index" in scratch, status: await sdk.scratch.status() })
    `);
    expect(isolated.result).toMatchObject({
      hasIndex: false,
      status: { scope: other, temperature: "cold" },
    });

    const parentEvents = await supervisor.storage.loadEvents(sessionId, { branchId });
    const forkBranchId = await supervisor.fork(
      sessionId,
      branchId,
      parentEvents.at(-1)!.cursor,
    );
    const forked = await supervisor.executeCell(sessionId, forkBranchId, `
      ({ hasIndex: "index" in scratch, status: await sdk.scratch.status() })
    `);
    expect(forked.result).toMatchObject({
      hasIndex: false,
      status: {
        scope: { sessionId, branchId: forkBranchId },
        temperature: "cold",
      },
    });
    await supervisor.close();
  });

  test("skips scratch serialization and persistence until scratch may have changed", async () => {
    const temp = await makeTempRuntime("agencity-console-scratch-dirty-");
    temps.push(temp);
    let checkpointCalls = 0;
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      scratchCheckpointHooks: {
        async load() { return { status: "cold" }; },
        async checkpoint() { checkpointCalls++; },
      },
      recover: false,
    });
    const session = await supervisor.createSession({ workspaceId: "scratch-dirty" });

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `({ scratchUntouched: true })`,
    );
    expect(checkpointCalls).toBe(0);

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `scratch.count = 1; null`,
    );
    expect(checkpointCalls).toBe(1);

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `scratch.count`,
    );
    expect(checkpointCalls).toBe(1);

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `scratch.index = { files: ["a.ts"] }; null`,
    );
    expect(checkpointCalls).toBe(2);

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `scratch.index.files.length`,
    );
    expect(checkpointCalls).toBe(3);

    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `await sdk.scratch.clear(); null`,
    );
    expect(checkpointCalls).toBe(4);
    await supervisor.executeCell(
      session.sessionId,
      session.branchId,
      `await sdk.scratch.clear(); null`,
    );
    expect(checkpointCalls).toBe(4);
    await supervisor.close();
  });

  test("evicts failed scratch mutation and promptly rejects stale captured RPC facades", async () => {
    const { supervisor, sessionId, branchId } = await open(false);
    await supervisor.executeCell(sessionId, branchId, `
      scratch.value = { committed: true };
      scratch.staleStateRead = () => state.get("missing");
      ({ ready: true })
    `);
    await expect(supervisor.executeCell(sessionId, branchId, `
      scratch.value.committed = false;
      throw new Error("discard partial scratch");
    `)).rejects.toThrow(/discard partial scratch/);
    const afterFailure = await supervisor.executeCell(sessionId, branchId, `
      ({ hasValue: "value" in scratch, status: await sdk.scratch.status() })
    `);
    expect(afterFailure.result).toMatchObject({
      hasValue: false,
      status: { temperature: "cold" },
    });

    await supervisor.executeCell(sessionId, branchId, `
      scratch.staleStateRead = () => state.get("missing");
      null
    `);
    const started = performance.now();
    await expect(supervisor.executeCell(sessionId, branchId, `
      await scratch.staleStateRead();
      "unreachable"
    `)).rejects.toThrow(/no longer active/i);
    expect(performance.now() - started).toBeLessThan(2_000);
    await supervisor.close();
  });

  test("evicts scratch when canonical cell commit fails", async () => {
    const { supervisor, sessionId, branchId } = await open(false);
    const append = supervisor.storage.appendEvents.bind(supervisor.storage);
    let failed = false;
    Object.defineProperty(supervisor.storage, "appendEvents", {
      configurable: true,
      value: async (events: Parameters<typeof append>[0]) => {
        if (!failed && events.some((event) => event.type === "CellCommitted")) {
          failed = true;
          throw new Error("simulated terminal commit failure");
        }
        return append(events);
      },
    });
    try {
      await expect(supervisor.executeCell(sessionId, branchId, `
        scratch.partial = { visible: false };
        ({ complete: true })
      `)).rejects.toThrow(/terminal commit failure/);
    } finally {
      Object.defineProperty(supervisor.storage, "appendEvents", {
        configurable: true,
        value: append,
      });
    }
    const next = await supervisor.executeCell(sessionId, branchId, `
      ({ hasPartial: "partial" in scratch, status: await sdk.scratch.status() })
    `);
    expect(next.result).toMatchObject({
      hasPartial: false,
      status: { temperature: "cold" },
    });
    const events = await supervisor.storage.loadEvents(sessionId, { branchId });
    expect(events.filter((event) => event.type === "CellFailed")).toHaveLength(1);
    await supervisor.close();
  });

  test("restores only hook-provided JSON checkpoints and reports skipped warm values", async () => {
    const temp = await makeTempRuntime("agencity-console-scratch-hook-");
    temps.push(temp);
    const checkpoints = new Map<string, any>();
    const hooks = {
      async load(scope: { sessionId: string; branchId: string }) {
        const restore = checkpoints.get(`${scope.sessionId}/${scope.branchId}`);
        return restore ? { status: "restored" as const, restore } : { status: "cold" as const };
      },
      async checkpoint(scope: { sessionId: string; branchId: string }, candidate: any, source: { cellId: string }) {
        checkpoints.set(`${scope.sessionId}/${scope.branchId}`, {
          candidate,
          sourceCellId: source.cellId,
          checkpointedAt: "2026-08-11T00:00:00.000Z",
        });
      },
    };
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      restartConsoleAfterCell: true,
      scratchCheckpointHooks: hooks,
      recover: false,
    });
    const { sessionId, branchId } = await supervisor.createSession({ workspaceId: "scratch-hook" });
    const first = await supervisor.executeCell(sessionId, branchId, `
      scratch.rows = [{ id: 1 }];
      scratch.helper = (value: number) => value + 1;
      ({ pid: process.pid })
    `);
    const restored = await supervisor.executeCell(sessionId, branchId, `
      let helperError = "";
      try { scratch.helper(1); } catch (error) { helperError = String(error); }
      ({
        rows: scratch.rows,
        helperError,
        status: await sdk.scratch.status(),
        pid: process.pid,
      })
    `);
    expect(restored.result).toMatchObject({
      rows: [{ id: 1 }],
      helperError: expect.stringContaining("unsupported_type"),
      status: {
        temperature: "restored",
        savedNames: ["rows"],
        skipped: [{ name: "helper", reason: "unsupported_type" }],
      },
    });
    expect((restored.result as any).pid).not.toBe((first.result as any).pid);
    const restoredAgain = await supervisor.executeCell(sessionId, branchId, `
      let helperError = "";
      try { scratch.helper(1); } catch (error) { helperError = String(error); }
      ({
        rows: scratch.rows,
        helperError,
        status: await sdk.scratch.status(),
        pid: process.pid,
      })
    `);
    expect(restoredAgain.result).toMatchObject({
      rows: [{ id: 1 }],
      helperError: expect.stringContaining("unsupported_type"),
      status: {
        temperature: "restored",
        savedNames: ["rows"],
        skipped: [{ name: "helper", reason: "unsupported_type" }],
      },
    });
    expect((restoredAgain.result as any).pid).not.toBe((restored.result as any).pid);
    await supervisor.close();
  });

  test("rejects reconstructed brokered values before invoking checkpoint storage", async () => {
    const secret = "rpc-broker-secret-a811";
    process.env.AGENCITY_RPC_TEST_SECRET = secret;
    const temp = await makeTempRuntime("agencity-console-scratch-secret-");
    temps.push(temp);
    let received: any = null;
    const legacyCheckpoint = serializeScratch({
      legacySafe: true,
      legacyShaped: "sk-test-0987654321",
      [secret]: () => "not checkpointable",
    });
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      scratchCheckpointHooks: {
        async load() {
          return {
            status: "restored",
            restore: {
              candidate: legacyCheckpoint,
              sourceCellId: "legacy-cell",
            },
          };
        },
        async checkpoint(_scope, candidate) { received = candidate; },
      },
      recover: false,
    });
    const session = await supervisor.createSession({ workspaceId: "scratch-secret" });
    const execution = await supervisor.executeCell(session.sessionId, session.branchId, `
      let legacyError = "";
      try { void scratch.legacyShaped; } catch (error) { legacyError = String(error); }
      const legacySafe = scratch.legacySafe;
      delete scratch.legacySafe;
      delete scratch.legacyShaped;
      scratch.safe = { count: 1 };
      scratch.secret = ["rpc-broker-", "secret-a811"].join("");
      scratch.shaped = ["sk-test-", "1234567890"].join("");
      scratch[["rpc-broker-", "secret-a811"].join("")] = () => "not checkpointable";
      ({ complete: true, legacySafe, legacyError })
    `);
    expect(execution.result).toMatchObject({
      complete: true,
      legacySafe: true,
      legacyError: expect.stringContaining("secret_rejected"),
    });
    expect(received.savedNames).toEqual(["safe"]);
    expect(received.skipped).toContainEqual({
      name: "secret",
      reason: "secret_rejected",
    });
    expect(received.skipped).toContainEqual({
      name: "shaped",
      reason: "secret_rejected",
    });
    expect(JSON.stringify(received)).not.toContain(secret);
    expect(JSON.stringify(received)).not.toContain("sk-test-1234567890");
    await supervisor.close();
  });

  test("keeps committed warm scratch when checkpoint persistence fails", async () => {
    const temp = await makeTempRuntime("agencity-console-scratch-store-failure-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      scratchCheckpointHooks: {
        async load() { return { status: "cold" }; },
        async checkpoint() { throw new Error("cache storage unavailable"); },
      },
      recover: false,
    });
    const session = await supervisor.createSession({ workspaceId: "scratch-store-failure" });
    const first = await supervisor.executeCell(session.sessionId, session.branchId, `
      scratch.value = { retained: true };
      ({ pid: process.pid })
    `);
    const second = await supervisor.executeCell(session.sessionId, session.branchId, `
      ({
        value: scratch.value,
        pid: process.pid,
        status: await sdk.scratch.status(),
      })
    `);
    expect(second.result).toMatchObject({
      value: { retained: true },
      pid: (first.result as any).pid,
      status: {
        lastCheckpointAt: null,
        lastCheckpointCellId: null,
        savedNames: [],
        skipped: [],
        cache: { lastWrite: "unavailable" },
      },
    });
    expect(supervisor.console.status()).toEqual({
      running: true,
      lastRecycleReason: null,
    });
    const events = await supervisor.storage.loadEvents(session.sessionId, {
      branchId: session.branchId,
    });
    expect(events.filter((event) => event.type === "CellCommitted")).toHaveLength(2);
    expect(events.filter((event) => event.type === "CellFailed")).toHaveLength(0);
    await supervisor.close();
  });

  test("uses LRU scope eviction and recycles above the RSS soft threshold", async () => {
    const temp = await makeTempRuntime("agencity-console-scratch-lru-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      scratchMaxWarmScopes: 2,
      maxConsoleResidentProcesses: 2,
      consoleRssRecycleThresholdBytes: 1,
      recover: false,
    });
    const first = await supervisor.createSession({ workspaceId: "scratch-lru" });
    const initial = await supervisor.executeCell(first.sessionId, first.branchId, `
      scratch.value = 1;
      ({ pid: process.pid })
    `);
    expect(supervisor.console.status().lastRecycleReason).toBe("rss-soft-threshold");
    const recycled = await supervisor.executeCell(first.sessionId, first.branchId, `
      ({ pid: process.pid, hasValue: "value" in scratch })
    `);
    expect(recycled.result).toMatchObject({ hasValue: false });
    expect((recycled.result as any).pid).not.toBe((initial.result as any).pid);

    // Disable the injected recycle threshold to exercise pool-level LRU.
    Object.defineProperty(supervisor, "consoleRssRecycleThresholdBytes", { value: Number.MAX_SAFE_INTEGER });
    const second = await supervisor.createSession({ workspaceId: "scratch-lru" });
    const third = await supervisor.createSession({ workspaceId: "scratch-lru" });
    await supervisor.executeCell(first.sessionId, first.branchId, `scratch.lru = "first"; null`);
    await Bun.sleep(2);
    await supervisor.executeCell(second.sessionId, second.branchId, `scratch.lru = "second"; null`);
    await Bun.sleep(2);
    await supervisor.executeCell(third.sessionId, third.branchId, `scratch.lru = "third"; null`);
    const evicted = await supervisor.executeCell(first.sessionId, first.branchId, `
      ({ hasLru: "lru" in scratch, status: await sdk.scratch.status() })
    `);
    expect(evicted.result).toMatchObject({
      hasLru: false,
      status: { temperature: "cold" },
    });
    await supervisor.close();
  });

  test("evicts idle scopes without making warm scratch a keep-alive contract", async () => {
    const temp = await makeTempRuntime("agencity-console-scratch-idle-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      scratchIdleScopeMs: 10,
      recover: false,
    });
    const session = await supervisor.createSession({ workspaceId: "scratch-idle" });
    await supervisor.executeCell(session.sessionId, session.branchId, `
      scratch.replaceable = true;
      null
    `);
    await Bun.sleep(20);
    const afterIdle = await supervisor.executeCell(session.sessionId, session.branchId, `
      ({ available: "replaceable" in scratch, status: await sdk.scratch.status() })
    `);
    expect(afterIdle.result).toMatchObject({
      available: false,
      status: { temperature: "cold" },
    });
    await supervisor.close();
  });

  test("keeps branch worker lifecycles independent through checkpoint hooks", async () => {
    const temp = await makeTempRuntime("agencity-console-scratch-queue-");
    temps.push(temp);
    let enterCheckpoint!: () => void;
    const checkpointEntered = new Promise<void>((resolve) => { enterCheckpoint = resolve; });
    let releaseCheckpoint!: () => void;
    const checkpointReleased = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    let held = false;
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      scratchCheckpointHooks: {
        async load() { return { status: "cold" }; },
        async checkpoint() {
          if (held) return;
          held = true;
          enterCheckpoint();
          await checkpointReleased;
        },
      },
      recover: false,
    });
    const first = await supervisor.createSession({ workspaceId: "scratch-queue" });
    const second = await supervisor.createSession({ workspaceId: "scratch-queue" });
    const firstRun = supervisor.executeCell(first.sessionId, first.branchId, `
      scratch.first = true;
      ({ first: true })
    `);
    await checkpointEntered;
    const secondRun = supervisor.executeCell(second.sessionId, second.branchId, `
      scratch.second = true;
      ({ second: true })
    `);
    expect((await secondRun).result).toEqual({ second: true });
    expect((await supervisor.storage.loadEvents(second.sessionId, {
      branchId: second.branchId,
    })).map((event) => event.type)).toContain("CellCommitted");
    releaseCheckpoint();
    expect((await firstRun).result).toEqual({ first: true });
    await supervisor.close();
  });

  test("bounds adversarial checkpoint reflection by recycling after commit", async () => {
    const temp = await makeTempRuntime("agencity-console-scratch-timeout-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      scratchCheckpointTimeoutMs: 50,
      recover: false,
    });
    const session = await supervisor.createSession({ workspaceId: "scratch-timeout" });
    const committed = await supervisor.executeCell(session.sessionId, session.branchId, `
      scratch.adversarial = new Proxy({}, {
        getPrototypeOf() { while (true) {} }
      });
      ({ committed: true, pid: process.pid })
    `);
    expect(committed.result).toMatchObject({ committed: true });
    expect(supervisor.console.status()).toEqual({
      running: false,
      lastRecycleReason: "scratch-checkpoint-timeout",
    });
    const events = await supervisor.storage.loadEvents(session.sessionId, {
      branchId: session.branchId,
    });
    expect(events.filter((event) => event.type === "CellCommitted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "CellFailed")).toHaveLength(0);
    const next = await supervisor.executeCell(session.sessionId, session.branchId, `
      ({ usable: true, pid: process.pid, hasAdversarial: "adversarial" in scratch })
    `);
    expect(next.result).toMatchObject({ usable: true, hasAdversarial: false });
    expect((next.result as any).pid).not.toBe((committed.result as any).pid);
    await supervisor.close();
  });

});
