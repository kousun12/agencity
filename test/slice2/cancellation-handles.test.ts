import { afterEach, describe, expect, test } from "bun:test";
import { Supervisor, projectEvents } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function open(temp: TempRuntime, recover: boolean): Promise<Supervisor> {
  return Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover });
}

describe("Slice 2 cancellation trees and durable handles", () => {
  test("cancelling a task cascades through every admitted descendant", async () => {
    const temp = await makeTempRuntime("agencity-slice2-cascade-"); temps.push(temp);
    const supervisor = await open(temp, false);
    try {
      const root = await supervisor.createSession({ workspaceId: "cascade" });
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "child");
      const grandchild = await supervisor.agents.spawn(child.sessionId, child.branchId, "grandchild");
      const greatGrandchild = await supervisor.agents.spawn(grandchild.sessionId, grandchild.branchId, "great-grandchild");

      expect((await supervisor.agents.cancel(root.sessionId, root.branchId, child.taskId, "stop tree")).status).toBe("cancelled");
      expect((await supervisor.storage.getTask?.(grandchild.taskId))?.status).toBe("cancelled");
      expect((await supervisor.storage.getTask?.(greatGrandchild.taskId))?.status).toBe("cancelled");

      for (const descendant of [child, grandchild, greatGrandchild]) {
        const state = projectEvents(await supervisor.storage.loadEvents(descendant.sessionId, { branchId: descendant.branchId }));
        expect(state.status).toBe("stopped");
      }
      const childState = projectEvents(await supervisor.storage.loadEvents(child.sessionId, { branchId: child.branchId }));
      const grandchildState = projectEvents(await supervisor.storage.loadEvents(grandchild.sessionId, { branchId: grandchild.branchId }));
      expect(Object.values(childState.terminalNotices).some((notice) => notice.taskId === grandchild.taskId && notice.direction === "inbound")).toBe(true);
      expect(Object.values(grandchildState.terminalNotices).some((notice) => notice.taskId === greatGrandchild.taskId && notice.direction === "inbound")).toBe(true);
    } finally { await supervisor.close(); }
  });

  test("JSON-only service handles remain usable after close and reopen", async () => {
    const temp = await makeTempRuntime("agencity-slice2-handles-"); temps.push(temp);
    const supervisor = await open(temp, false);
    const root = await supervisor.createSession({ workspaceId: "handles" });
    const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "persistent child");
    const goal = await supervisor.goals.create(root.sessionId, root.branchId, { description: "persistent goal" });
    const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 1_000, goalId: goal.goalId });
    const model = await supervisor.models.start(root.sessionId, root.branchId, { prompt: "persistent model", run: false });
    const serialized = JSON.parse(JSON.stringify({ root, child, goal, heartbeat, model })) as {
      child: typeof child; goal: typeof goal; heartbeat: typeof heartbeat; model: typeof model;
    };
    await supervisor.close();

    const resumed = await open(temp, true);
    try {
      expect((await resumed.models.get(serialized.model.handleId)).childSessionId).toBe(serialized.model.childSessionId);
      expect((await resumed.storage.getHeartbeat?.(serialized.heartbeat.heartbeatId))?.status).toBe("active");
      expect((await resumed.goals.requestCompletion(root.sessionId, root.branchId, serialized.goal.goalId)).status).toBe("completed");
      expect((await resumed.agents.completeTask(serialized.child.sessionId, serialized.child.branchId, { result: "after restart" })).status).toBe("completed");
      expect((await resumed.models.cancel(serialized.model.handleId)).status).toBe("cancelled");
    } finally { await Bun.sleep(50); await resumed.close(); }
  });
});
