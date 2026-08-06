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
      return { exactStored, overStored };
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
});
