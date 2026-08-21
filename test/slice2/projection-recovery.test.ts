import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { REDUCER_VERSION, Supervisor, TEXT_MODEL_RESPONSE_CONTRACT, projectEvents, type RecursiveResponseAdmission } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function open(temp: TempRuntime, recover = false): Promise<Supervisor> {
  return Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover });
}

describe("Slice 2 projection rebuilds and reducer-versioned snapshots", () => {
  test("a current-cursor snapshot from an old reducer is upgraded by replay, never trusted as current", async () => {
    const temp = await makeTempRuntime("agencity-slice2-snapshot-upgrade-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "snapshot" });
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "project me");
      const mail = await supervisor.agents.sendMessage(root.sessionId, root.branchId, { toSessionId: child.sessionId, content: "snapshot mailbox" });
      const live = await supervisor.projections.getSnapshot(root.sessionId, root.branchId);
      expect(live.state.reducerVersion).toBe(REDUCER_VERSION);

      const staleState = { ...live.state, reducerVersion: 1 } as unknown as Record<string, unknown>;
      delete staleState.tasks;
      delete staleState.documents;
      delete staleState.mailbox;
      const client = createClient({ url: temp.databaseUrl });
      await client.execute({
        sql: "UPDATE snapshots SET reducer_version=?,state_json=? WHERE session_id=? AND branch_id=?",
        args: [1, JSON.stringify(staleState), root.sessionId, root.branchId],
      });
      client.close();

      const upgraded = await supervisor.projections.getSnapshot(root.sessionId, root.branchId);
      expect(upgraded.state.reducerVersion).toBe(REDUCER_VERSION);
      expect(upgraded.state.tasks[child.taskId]?.task).toBe("project me");
      expect(upgraded.state.mailbox[mail.mailboxMessageId]?.content).toBe("snapshot mailbox");
      expect(upgraded.state.documents).toEqual({});
      const verifyClient = createClient({ url: temp.databaseUrl });
      const row = await verifyClient.execute({ sql: "SELECT reducer_version FROM snapshots WHERE session_id=? AND branch_id=?", args: [root.sessionId, root.branchId] });
      expect(Number(row.rows[0]?.reducer_version)).toBe(REDUCER_VERSION);
      verifyClient.close();
    } finally { await supervisor.close(); }
  });

  test("operational projection rebuild exactly restores all Slice 2 handles from canonical events", async () => {
    const temp = await makeTempRuntime("agencity-slice2-operational-rebuild-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "rebuild" });
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "child");
      const mail = await supervisor.agents.sendMessage(root.sessionId, root.branchId, { toSessionId: child.sessionId, content: "mail" });
      await supervisor.agents.acknowledgeMessage(child.sessionId, child.branchId, mail.mailboxMessageId);
      const document = await supervisor.documents.import(root.sessionId, root.branchId, { content: "r".repeat(700), chunkBytes: 256 });
      const chunks = await supervisor.documents.readChunks(document.documentId);
      const input = await supervisor.documents.createInputSet(root.sessionId, root.branchId, { chunkIds: chunks.map((chunk) => chunk.chunkId) });
      const goal = await supervisor.goals.create(root.sessionId, root.branchId, { description: "goal" });
      const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 1_000, goalId: goal.goalId });
      const model = await supervisor.models.start(root.sessionId, root.branchId, { prompt: "pending", inputSetId: input.inputSetId, run: false });
      await supervisor.models.cancel(model.handleId);
      await supervisor.agents.completeTask(child.sessionId, child.branchId, { result: { done: true } });

      const beforeState = projectEvents(await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId }));
      const before = {
        children: await supervisor.agents.listChildren(root.sessionId),
        tasks: await supervisor.agents.listTasks(root.sessionId),
        mailbox: await supervisor.storage.listMailboxMessages?.(root.sessionId, "all"),
        document: await supervisor.storage.getDocument?.(document.documentId),
        chunks: await supervisor.documents.readChunks(document.documentId),
        input: await supervisor.storage.getInputSet?.(input.inputSetId),
        goal: await supervisor.storage.getGoal?.(goal.goalId),
        gates: await supervisor.storage.listGoalGates?.(goal.goalId),
        heartbeat: await supervisor.storage.getHeartbeat?.(heartbeat.heartbeatId),
        model: await supervisor.models.get(model.handleId),
      };
      await supervisor.storage.rebuildOperationalProjections?.();
      const after = {
        children: await supervisor.agents.listChildren(root.sessionId),
        tasks: await supervisor.agents.listTasks(root.sessionId),
        mailbox: await supervisor.storage.listMailboxMessages?.(root.sessionId, "all"),
        document: await supervisor.storage.getDocument?.(document.documentId),
        chunks: await supervisor.documents.readChunks(document.documentId),
        input: await supervisor.storage.getInputSet?.(input.inputSetId),
        goal: await supervisor.storage.getGoal?.(goal.goalId),
        gates: await supervisor.storage.listGoalGates?.(goal.goalId),
        heartbeat: await supervisor.storage.getHeartbeat?.(heartbeat.heartbeatId),
        model: await supervisor.models.get(model.handleId),
      };
      expect(after).toEqual(before);
      expect(await supervisor.projections.rebuild(root.sessionId, root.branchId)).toEqual(beforeState);
    } finally { await supervisor.close(); }
  });

  test("reopen plus repeated canonical rebuild is deterministic and effect-free", async () => {
    const temp = await makeTempRuntime("agencity-slice2-reopen-rebuild-"); temps.push(temp);
    const supervisor = await open(temp);
    const root = await supervisor.createSession({ workspaceId: "deterministic" });
    const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "deterministic child");
    await supervisor.agents.completeTask(child.taskId, { result: [1, 2, 3] });
    const before = await supervisor.projections.rebuild(root.sessionId, root.branchId);
    await supervisor.close();

    const resumed = await open(temp, true);
    try {
      await resumed.storage.rebuildOperationalProjections?.();
      const once = await resumed.projections.rebuild(root.sessionId, root.branchId);
      await resumed.storage.rebuildOperationalProjections?.();
      const twice = await resumed.projections.rebuild(root.sessionId, root.branchId);
      expect(once).toEqual(before);
      expect(twice).toEqual(before);
      expect((await resumed.agents.listTasks(root.sessionId))[0]?.status).toBe("completed");
      const events = await resumed.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(events.filter((event) => event.type === "TaskTerminalNoticeDelivered")).toHaveLength(1);
    } finally { await resumed.close(); }
  });

  test("recursive response admission survives migration, rebuild, and reopen exactly", async () => {
    const temp = await makeTempRuntime("agencity-recursive-response-admission-"); temps.push(temp);
    const bootstrap = await open(temp);
    await bootstrap.close();
    const preMigration = createClient({ url: temp.databaseUrl });
    await preMigration.execute("ALTER TABLE recursive_model_handles DROP COLUMN response_admission_json");
    await preMigration.execute("DELETE FROM schema_migrations WHERE version=15");
    preMigration.close();

    let supervisor = await open(temp);
    const root = await supervisor.createSession({ workspaceId: "recursive-admission" });
    const handle = await supervisor.models.start(root.sessionId, root.branchId, {
      task: "retain text admission",
      idempotencyKey: "response-admission",
      run: false,
    });
    const expected: RecursiveResponseAdmission = {
      responseContract: TEXT_MODEL_RESPONSE_CONTRACT,
      responseCapability: { kind: "text" },
    };
    expect(handle.responseAdmission).toEqual(expected);
    expect((await supervisor.storage.getRecursiveModel?.(handle.handleId))?.responseAdmission).toEqual(expected);
    await supervisor.storage.rebuildOperationalProjections?.();
    expect((await supervisor.storage.getRecursiveModel?.(handle.handleId))?.responseAdmission).toEqual(expected);
    expect((await supervisor.projections.rebuild(root.sessionId, root.branchId)).recursiveModels[handle.handleId]?.responseAdmission).toEqual(expected);
    await supervisor.close();

    supervisor = await open(temp, true);
    try {
      expect((await supervisor.models.get(handle.handleId)).responseAdmission).toEqual(expected);
      const client = createClient({ url: temp.databaseUrl });
      const columns = await client.execute("PRAGMA table_info(recursive_model_handles)");
      expect(columns.rows.some(row => String(row.name) === "response_admission_json")).toBe(true);
      client.close();
    } finally { await supervisor.close(); }
  });
});
