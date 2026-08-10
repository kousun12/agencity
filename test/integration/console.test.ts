import { afterEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ConsoleCellError,
  MAX_WORKING_JSON_BYTES,
  Supervisor,
  jsonBytes,
  projectEvents,
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
    expect(firstResult.shell).toMatchObject({ exitCode: 0, stdout: "shell-through-rpc" });
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
      const body = await artifacts.get(artifactValue.value);
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
    expect(secondResult.file).toMatchObject({ content: "file-through-rpc", size: 16 });
    expect(secondResult.shell).toMatchObject({ exitCode: 0, stdout: "file-through-rpc" });
    expect(secondResult.shell).not.toHaveProperty("outcome");
    expect(secondResult.rowCount).toBeGreaterThan(firstResult.eventTypes.length);

    const state = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    expect(state.cells[first.cellId]?.status).toBe("committed");
    expect(state.cells[second.cellId]?.status).toBe("committed");
    expect(state.workingValues.counter?.version).toBe(1);
    expect(await Bun.file(join((supervisor.artifacts as any).root, "missing-never-read")).exists()).toBe(false);
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
      shell: { exitCode: 0, stdout: "absent" },
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
      kind: "oversized-json",
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
        proposed: { type: "CellProposed", eventId: expect.any(String), schemaVersion: 4 },
        starts: [{ type: "CellStarted", eventId: expect.any(String), schemaVersion: 4 }],
        terminal: { type: "CellCommitted", eventId: expect.any(String), schemaVersion: 4 },
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

});
