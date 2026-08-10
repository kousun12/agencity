import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  ConflictError,
  OutboxRunner,
  projectEvents,
  result,
  type EffectExecutionContext,
  type EffectExecutor,
  type ExecutionResult,
  type JsonValue,
  type OutboxRecord,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  openTempStorage,
  removeTempRuntime,
  seedSession,
  type TempRuntime,
} from "../helpers.ts";

class DeterministicExecutor implements EffectExecutor {
  readonly name = "deterministic";
  readonly calls: Array<{ effectId: string; attempt: number; input: JsonValue }> = [];
  constructor(
    readonly response: (request: OutboxRecord) => ExecutionResult = (request) =>
      result("succeeded", { effectId: request.effectId, attempt: request.attempt }),
    readonly delayMs = 0,
  ) {}
  async execute(request: OutboxRecord, context: EffectExecutionContext): Promise<ExecutionResult> {
    this.calls.push({ effectId: request.effectId, attempt: request.attempt, input: request.input });
    if (this.delayMs) await Bun.sleep(this.delayMs);
    if (context.signal.aborted) return result("cancelled");
    return this.response(request);
  }
}

const temps: TempRuntime[] = [];
const originalSecret = process.env.AGENCITY_OUTBOX_TEST_TOKEN;
afterEach(async () => {
  if (originalSecret === undefined) delete process.env.AGENCITY_OUTBOX_TEST_TOKEN;
  else process.env.AGENCITY_OUTBOX_TEST_TOKEN = originalSecret;
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function setup(): Promise<{
  temp: TempRuntime;
  storage: Awaited<ReturnType<typeof openTempStorage>>;
  sessionId: string;
  branchId: string;
}> {
  const temp = await makeTempRuntime("agencity-outbox-");
  temps.push(temp);
  const storage = await openTempStorage(temp);
  const { sessionId, branchId } = await seedSession(storage);
  return { temp, storage, sessionId, branchId };
}

function requestInput(sessionId: string, branchId: string, key: string, idempotent = true) {
  return {
    sessionId,
    branchId,
    executor: "deterministic",
    operation: "run",
    input: { task: "one" },
    origin: { kind: "runtime", requestId: key },
    idempotencyKey: key,
    idempotent,
  } as const;
}

describe("durable outbox idempotency", () => {
  test("a duplicate logical request returns the original effect and never creates a second row", async () => {
    const { storage, sessionId, branchId } = await setup();
    const runner = new OutboxRunner(storage, [new DeterministicExecutor()]);
    const request = requestInput(sessionId, branchId, "logical-command-1");
    const first = await runner.request(request);
    const duplicate = await runner.request(request);
    expect(duplicate).toBe(first);
    expect(await storage.listOutbox()).toHaveLength(1);
    expect((await storage.loadEvents(sessionId)).filter((event) => event.type === "EffectRequested"))
      .toHaveLength(1);
    await expect(runner.request({ ...request, input: { task: "changed" } }))
      .rejects.toBeInstanceOf(ConflictError);
    storage.close();
  });

  test("requires a valid explicit origin before execution and retains valid cell ownership after terminalization", async () => {
    const { storage, sessionId, branchId } = await setup();
    const runner = new OutboxRunner(storage, [new DeterministicExecutor()]);
    await expect(runner.request({
      ...requestInput(sessionId, branchId, "missing-origin"),
      origin: undefined,
    } as any)).rejects.toThrow("not JSON serializable");
    await expect(runner.request({
      ...requestInput(sessionId, branchId, "wrong-runtime-origin"),
      origin: { kind: "runtime", requestId: "different-intent" },
    })).rejects.toThrow("Runtime effect origin must bind the exact durable request intent");

    await storage.appendEvents([{
      sessionId, branchId, type: "CellProposed", producer: "console",
      idempotencyKey: "cell-proposed:origin-cell",
      payload: { cellId: "origin-cell", code: "await tools.request()", dependencies: [] },
    }]);
    await expect(runner.request({
      ...requestInput(sessionId, branchId, "proposed-cell-effect"),
      origin: { kind: "cell", cellId: "origin-cell" },
    })).rejects.toThrow("currently running cell");
    await storage.appendEvents([{
      sessionId, branchId, type: "CellStarted", producer: "console",
      idempotencyKey: "cell-started:origin-cell:1",
      payload: { cellId: "origin-cell", attempt: 1 },
    }]);
    const effectId = await runner.request({
      ...requestInput(sessionId, branchId, "terminalized-cell-effect"),
      origin: { kind: "cell", cellId: "origin-cell" },
    });
    await storage.appendEvents([{
      sessionId, branchId, type: "CellCommitted", producer: "console",
      idempotencyKey: "cell-committed:origin-cell",
      payload: { cellId: "origin-cell", result: null, logs: [], durationMs: 1, exports: [] },
    }]);
    expect(await runner.run(effectId)).toMatchObject({ outcome: "succeeded" });
    expect((await storage.getOutbox(effectId))?.origin).toEqual({
      kind: "cell",
      cellId: "origin-cell",
    });
    storage.close();
  });

  test("migration 019 retains required outbox origins across idempotent reopen", async () => {
    const { temp, storage, sessionId, branchId } = await setup();
    const runner = new OutboxRunner(storage, [new DeterministicExecutor()]);
    const effectId = await runner.request(requestInput(sessionId, branchId, "migration-origin"));
    expect((await storage.getOutbox(effectId))?.origin).toEqual({
      kind: "runtime",
      requestId: "migration-origin",
    });
    storage.close();

    const reopened = await openTempStorage(temp);
    await reopened.migrate();
    expect((await reopened.getOutbox(effectId))?.origin).toEqual({
      kind: "runtime",
      requestId: "migration-origin",
    });
    reopened.close();

    const client = createClient({ url: temp.databaseUrl });
    const columns = await client.execute("PRAGMA table_info(outbox)");
    expect(columns.rows.find((row) => row.name === "origin_json")).toMatchObject({
      notnull: 1,
    });
    const migration = await client.execute(
      "SELECT count(*) AS count FROM schema_migrations WHERE version=19",
    );
    expect(Number(migration.rows[0]?.count)).toBe(1);
    await client.execute({
      sql: "UPDATE outbox SET origin_json='null' WHERE effect_id=?",
      args: [effectId],
    });
    client.close();
    const malformed = await openTempStorage(temp);
    await expect(malformed.getOutbox(effectId)).rejects.toThrow(
      "Invalid projected effect origin",
    );
    malformed.close();
  });

  test("coalesces concurrent execution and terminal re-reads without invoking the executor twice", async () => {
    const { storage, sessionId, branchId } = await setup();
    const executor = new DeterministicExecutor(undefined, 30);
    const runner = new OutboxRunner(storage, [executor]);
    const effectId = await runner.request(requestInput(sessionId, branchId, "concurrent"));
    const results = await Promise.all(Array.from({ length: 12 }, () => runner.run(effectId)));
    expect(results.every((execution) => execution.outcome === "succeeded")).toBe(true);
    expect(new Set(results.map((execution) => JSON.stringify(execution.output))).size).toBe(1);
    expect(executor.calls).toHaveLength(1);
    expect((await storage.loadEvents(sessionId)).filter((event) =>
      event.type === "EffectAttemptStarted" &&
      (event.payload as { effectId: string }).effectId === effectId)).toHaveLength(1);
    expect((await storage.loadEvents(sessionId)).filter((event) =>
      event.type === "EffectOutcomeRecorded" &&
      (event.payload as { effectId: string }).effectId === effectId)).toHaveLength(1);

    const restartedRunner = new OutboxRunner(storage, [executor]);
    expect(await restartedRunner.run(effectId)).toEqual(results[0]!);
    expect(executor.calls).toHaveLength(1);
    storage.close();
  });


  test("waits for a competing local claim instead of returning a transient unknown", async () => {
    const { storage, sessionId, branchId } = await setup();
    const executor = new DeterministicExecutor(undefined, 60);
    const first = new OutboxRunner(storage, [executor]);
    const second = new OutboxRunner(storage, [executor]);
    const effectId = await first.request(requestInput(sessionId, branchId, "two-runners"));
    const [left, right] = await Promise.all([first.run(effectId), second.run(effectId)]);
    expect(left.outcome).toBe("succeeded");
    expect(right).toEqual(left);
    expect(executor.calls).toHaveLength(1);
    storage.close();
  });

  test("does not leak brokered secrets returned or thrown by an executor", async () => {
    const { storage, sessionId, branchId } = await setup();
    const secret = "outbox-super-secret-9e91";
    process.env.AGENCITY_OUTBOX_TEST_TOKEN = secret;
    const executor = new DeterministicExecutor(() => result(
      "failed",
      { nested: { authorization: secret }, token: "pagination-token", auth: "oauth-mode", text: `echo:${secret}` },
      `provider exposed ${secret}`,
    ));
    const runner = new OutboxRunner(storage, [executor]);
    const effectId = await runner.request(requestInput(sessionId, branchId, "secret-result"));
    const execution = await runner.run(effectId);
    expect(JSON.stringify(execution)).not.toContain(secret);
    expect(execution).toEqual({
      outcome: "failed",
      output: { nested: { authorization: "[REDACTED]" }, token: "pagination-token", auth: "oauth-mode", text: "echo:[REDACTED]" },
      error: "provider exposed [REDACTED]",
    });
    expect(JSON.stringify(await storage.loadEvents(sessionId))).not.toContain(secret);
    storage.close();
  });
});

describe("outbox crash recovery boundaries", () => {
  test("requeues a claimed idempotent effect, retains its attempt, and executes the next attempt once", async () => {
    const { storage, sessionId, branchId } = await setup();
    const executor = new DeterministicExecutor();
    const beforeCrash = new OutboxRunner(storage, [executor]);
    const effectId = await beforeCrash.request(requestInput(sessionId, branchId, "retry-after-crash", true));
    expect(await storage.claimEffect(effectId, "dead-owner")).toMatchObject({ status: "running", attempt: 0 });
    await storage.appendEvents([{
      sessionId,
      branchId,
      type: "EffectAttemptStarted",
      producer: "executor",
      idempotencyKey: `effect-attempt:${effectId}:1`,
      payload: { effectId, attempt: 1 },
    }]);

    const recovered = new OutboxRunner(storage, [executor]);
    expect(await recovered.recover()).toEqual({
      abandonedCellIds: [],
      unknownEffectIds: [],
      retriedEffectIds: [effectId],
    });
    expect(await storage.getOutbox(effectId)).toMatchObject({ status: "pending", attempt: 1, owner: null });
    expect(await recovered.drain()).toBe(1);
    expect(executor.calls).toEqual([{ effectId, attempt: 2, input: { task: "one" } }]);
    expect(await storage.getOutbox(effectId)).toMatchObject({ status: "succeeded", attempt: 2 });
    expect((await recovered.recover()).retriedEffectIds).toEqual([]);
    storage.close();
  });

  test("marks a lost non-idempotent effect unknown and never retries it automatically", async () => {
    const { storage, sessionId, branchId } = await setup();
    const executor = new DeterministicExecutor();
    const runner = new OutboxRunner(storage, [executor]);
    const effectId = await runner.request(requestInput(sessionId, branchId, "unsafe-after-crash", false));
    await storage.claimEffect(effectId, "dead-owner");

    const firstRecovery = await runner.recover();
    expect(firstRecovery.unknownEffectIds).toEqual([effectId]);
    expect(firstRecovery.retriedEffectIds).toEqual([]);
    expect(await storage.getOutbox(effectId)).toMatchObject({ status: "unknown", attempt: 1, owner: null });
    expect(await runner.run(effectId)).toMatchObject({ outcome: "unknown" });
    expect(await runner.drain()).toBe(0);
    expect(executor.calls).toHaveLength(0);
    expect((await runner.recover()).unknownEffectIds).toEqual([]);
    expect((await storage.loadEvents(sessionId)).filter((event) =>
      event.type === "EffectOutcomeRecorded" &&
      (event.payload as { effectId: string }).effectId === effectId)).toHaveLength(1);
    storage.close();
  });


  test("marks an anomalous pending non-idempotent prior attempt unknown", async () => {
    const { storage, sessionId, branchId } = await setup();
    const executor = new DeterministicExecutor();
    const runner = new OutboxRunner(storage, [executor]);
    const effectId = await runner.request(requestInput(sessionId, branchId, "pending-ambiguous", false));
    await storage.claimEffect(effectId, "dead-owner");
    await storage.appendEvents([{
      sessionId, branchId, type: "EffectAttemptStarted", producer: "executor",
      idempotencyKey: `effect-attempt:${effectId}:1`, payload: { effectId, attempt: 1 },
    }]);
    await storage.resetOutbox(effectId);
    expect(await storage.getOutbox(effectId)).toMatchObject({ status: "pending", attempt: 1 });
    expect((await runner.recover()).unknownEffectIds).toEqual([effectId]);
    expect(await storage.getOutbox(effectId)).toMatchObject({ status: "unknown", attempt: 1 });
    expect(executor.calls).toHaveLength(0);
    storage.close();
  });

  test("abandons an inherited incomplete cell independently on every fork projection", async () => {
    const { temp, storage, sessionId, branchId } = await setup();
    const [, started] = await storage.appendEvents([{
      sessionId, branchId, type: "CellProposed", producer: "console",
      idempotencyKey: "cell-proposed:fork-orphan",
      payload: { cellId: "fork-orphan", code: "await never", dependencies: [] },
    }, {
      sessionId, branchId, type: "CellStarted", producer: "console",
      idempotencyKey: "cell-started:fork-orphan:1",
      payload: { cellId: "fork-orphan", attempt: 1 },
    }]);
    await storage.appendEvents([{
      sessionId, branchId: "child", type: "BranchCreated", producer: "client",
      idempotencyKey: "branch:incomplete-child",
      payload: { branchId: "child", parentBranchId: branchId, forkCursor: started!.cursor },
    }]);
    storage.close();

    const reopened = await openTempStorage(temp);
    const runner = new OutboxRunner(reopened, []);
    expect((await runner.recover()).abandonedCellIds).toEqual(["fork-orphan"]);
    expect(projectEvents(await reopened.loadEvents(sessionId, { branchId })).cells["fork-orphan"]?.status)
      .toBe("abandoned");
    expect(projectEvents(await reopened.loadEvents(sessionId, { branchId: "child" })).cells["fork-orphan"]?.status)
      .toBe("abandoned");
    const abandoned = (await reopened.loadEvents(sessionId)).filter((event) =>
      event.type === "CellAbandoned" && (event.payload as { cellId: string }).cellId === "fork-orphan");
    expect(abandoned.map((event) => event.branchId).sort()).toEqual(["child", branchId].sort());
    expect(new Set(abandoned.map((event) => event.idempotencyKey)).size).toBe(2);
    expect((await runner.recover()).abandonedCellIds).toEqual([]);
    reopened.close();
  });

  test("an outcome committed before caller death is authoritative on restart", async () => {
    const { storage, sessionId, branchId } = await setup();
    const executor = new DeterministicExecutor();
    const firstRunner = new OutboxRunner(storage, [executor]);
    const effectId = await firstRunner.request(requestInput(sessionId, branchId, "outcome-won"));
    const first = await firstRunner.run(effectId);
    expect(first.outcome).toBe("succeeded");

    const restarted = new OutboxRunner(storage, [executor]);
    expect(await restarted.recover()).toEqual({
      abandonedCellIds: [], unknownEffectIds: [], retriedEffectIds: [],
    });
    expect(await restarted.run(effectId)).toEqual(first);
    expect(executor.calls).toHaveLength(1);
    storage.close();
  });

  test("abandons proposed/running cells once without fabricating a commit", async () => {
    const { storage, sessionId, branchId } = await setup();
    await storage.appendEvents([{
      sessionId,
      branchId,
      type: "CellProposed",
      producer: "console",
      idempotencyKey: "cell-proposed:orphan",
      payload: { cellId: "orphan", code: "await never", dependencies: [] },
    }, {
      sessionId,
      branchId,
      type: "CellStarted",
      producer: "console",
      idempotencyKey: "cell-started:orphan:1",
      payload: { cellId: "orphan", attempt: 1 },
    }]);
    const runner = new OutboxRunner(storage, []);
    expect((await runner.recover()).abandonedCellIds).toEqual(["orphan"]);
    expect(projectEvents(await storage.loadEvents(sessionId, { branchId })).cells.orphan?.status)
      .toBe("abandoned");
    expect((await runner.recover()).abandonedCellIds).toEqual([]);
    const cellEvents = (await storage.loadEvents(sessionId)).filter((event) =>
      (event.payload as { cellId?: string }).cellId === "orphan");
    expect(cellEvents.map((event) => event.type)).toEqual([
      "CellProposed", "CellStarted", "CellAbandoned",
    ]);
    storage.close();
  });
});
