import { afterEach, describe, expect, test } from "bun:test";
import { Supervisor, projectEvents } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

describe("Slice 2 recursive-session foundation", () => {
  test("persists ancestry, tasks, mailboxes, terminal notices, documents, goals, heartbeats, and model handles", async () => {
    const temp = await makeTempRuntime("agencity-recursive-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const root = await supervisor.createSession({ workspaceId: "recursive" });
    const child = await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "Inspect the input" });
    expect(child.depth).toBe(1);
    const childState = projectEvents(await supervisor.storage.loadEvents(child.sessionId, { branchId: child.branchId }));
    expect(childState.parentSessionId).toBe(root.sessionId);
    expect(childState.rootSessionId).toBe(root.sessionId);
    expect(childState.taskId).toBe(child.taskId);

    const sent = await supervisor.agents.sendMessage(root.sessionId, root.branchId, { toSessionId: child.sessionId, content: "extra context", taskId: child.taskId });
    expect((await supervisor.agents.acknowledgeMessage(child.sessionId, child.branchId, sent.mailboxMessageId)).acknowledged).toBe(true);
    expect((await supervisor.agents.completeTask(child.sessionId, child.branchId, { result: { answer: 42 } })).status).toBe("completed");
    const rootState = await supervisor.projections.rebuild(root.sessionId, root.branchId);
    expect(rootState.tasks[child.taskId]?.status).toBe("completed");
    expect(Object.values(rootState.terminalNotices)).toHaveLength(1);

    const document = await supervisor.documents.import(root.sessionId, root.branchId, { content: "a".repeat(600), name: "large.txt", chunkBytes: 256 });
    const chunks = await supervisor.documents.readChunks(document.documentId);
    expect(chunks).toHaveLength(3);
    const inputSet = await supervisor.documents.createInputSet(root.sessionId, root.branchId, { chunkIds: chunks.map((chunk) => chunk.chunkId) });
    expect(inputSet.chunkIds).toEqual(chunks.map((chunk) => chunk.chunkId));

    const goal = await supervisor.goals.create(root.sessionId, root.branchId, { description: "Finish safely" });
    expect((await supervisor.goals.requestCompletion(root.sessionId, root.branchId, goal.goalId)).status).toBe("completed");
    const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 1000 });
    expect((await supervisor.heartbeats.tick(heartbeat.heartbeatId)).tick).toBe(1);
    expect((await supervisor.heartbeats.pause(heartbeat.heartbeatId)).status).toBe("paused");
    expect((await supervisor.heartbeats.cancel(heartbeat.heartbeatId)).status).toBe("cancelled");

    const model = await supervisor.models.start(root.sessionId, root.branchId, { prompt: "Summarize", inputSetId: inputSet.inputSetId, run: false });
    expect((await supervisor.models.get(model.handleId)).status).toBe("pending");
    expect((await supervisor.models.cancel(model.handleId)).status).toBe("cancelled");
    const running = await supervisor.models.start(root.sessionId, root.branchId, "Return a short result");
    await waitFor(async () => (await supervisor.models.get(running.handleId)).status === "completed", "recursive model completion");

    await supervisor.storage.rebuildOperationalProjections?.();
    expect((await supervisor.agents.listTasks(root.sessionId)).map((task) => task.taskId)).toContain(child.taskId);
    expect((await supervisor.models.get(model.handleId)).status).toBe("cancelled");
    await supervisor.close();
  });


  test("resumes a committed pending recursive handle after supervisor restart", async () => {
    const temp = await makeTempRuntime("agencity-recursive-recovery-"); temps.push(temp);
    const first = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const root = await first.createSession({ workspaceId: "recovery" });
    const handle = await first.models.start(root.sessionId, root.branchId, { prompt: "Resume me", run: false });
    await first.close();
    const recovered = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot });
    await waitFor(async () => (await recovered.models.get(handle.handleId)).status === "completed", "recovered recursive model");
    expect((await recovered.models.get(handle.handleId)).status).toBe("completed");
    await recovered.close();
  });
});
