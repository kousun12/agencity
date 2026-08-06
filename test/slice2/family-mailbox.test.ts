import { afterEach, describe, expect, test } from "bun:test";
import { Supervisor, projectEvents } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function fresh(prefix = "agencity-slice2-family-"): Promise<{ temp: TempRuntime; supervisor: Supervisor }> {
  const temp = await makeTempRuntime(prefix); temps.push(temp);
  const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
  return { temp, supervisor };
}

async function reopen(temp: TempRuntime): Promise<Supervisor> {
  return Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: true });
}

describe("Slice 2 family mailboxes and durable terminal delivery", () => {
  test("mailboxes reject communication between unrelated session trees", async () => {
    const { supervisor } = await fresh();
    try {
      const first = await supervisor.createSession({ workspaceId: "same-workspace" });
      const second = await supervisor.createSession({ workspaceId: "same-workspace" });
      await expect(supervisor.agents.sendMessage(first.sessionId, first.branchId, {
        toSessionId: second.sessionId,
        content: "cross-family leak",
      })).rejects.toThrow(/family|related|root|mailbox/i);
      expect(await supervisor.storage.listMailboxMessages?.(first.sessionId, "all")).toEqual([]);
      expect(await supervisor.storage.listMailboxMessages?.(second.sessionId, "all")).toEqual([]);
    } finally { await supervisor.close(); }
  });

  test("siblings in one tree can communicate, but cannot spoof an unrelated task id", async () => {
    const { supervisor } = await fresh();
    try {
      const root = await supervisor.createSession({ workspaceId: "family" });
      const left = await supervisor.agents.spawn(root.sessionId, root.branchId, "left");
      const right = await supervisor.agents.spawn(root.sessionId, root.branchId, "right");
      const otherRoot = await supervisor.createSession({ workspaceId: "family" });
      const unrelated = await supervisor.agents.spawn(otherRoot.sessionId, otherRoot.branchId, "unrelated");

      const valid = await supervisor.agents.sendMessage(left.sessionId, left.branchId, {
        toSessionId: right.sessionId, content: "sibling update", taskId: right.taskId,
      });
      expect(valid.delivered).toBe(true);
      await expect(supervisor.agents.sendMessage(left.sessionId, left.branchId, {
        toSessionId: right.sessionId, content: "spoof", taskId: unrelated.taskId,
      })).rejects.toThrow(/task|family|related|spoof/i);
      const inbox = await supervisor.storage.listMailboxMessages?.(right.sessionId, "inbound");
      expect(inbox?.map((message) => message.content)).toEqual(["sibling update"]);
    } finally { await supervisor.close(); }
  });

  test("only the exact durable recipient branch can acknowledge a delivery", async () => {
    const { supervisor } = await fresh();
    try {
      const root = await supervisor.createSession({ workspaceId: "ack" });
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "child");
      const sent = await supervisor.agents.sendMessage(root.sessionId, root.branchId, {
        toSessionId: child.sessionId, toBranchId: child.branchId, content: "ack me",
      });
      await expect(supervisor.agents.acknowledgeMessage(root.sessionId, root.branchId, sent.mailboxMessageId))
        .rejects.toThrow(/recipient/i);
      expect((await supervisor.agents.acknowledgeMessage(child.sessionId, child.branchId, sent.mailboxMessageId)).acknowledged).toBe(true);
    } finally { await supervisor.close(); }
  });

  test("an offline recipient receives and acknowledges the same message after restart", async () => {
    const { temp, supervisor } = await fresh();
    const root = await supervisor.createSession({ workspaceId: "offline" });
    const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "offline child");
    const sent = await supervisor.agents.sendMessage(root.sessionId, root.branchId, {
      toSessionId: child.sessionId, content: "durable while detached", taskId: child.taskId,
    });
    await supervisor.close();

    const resumed = await reopen(temp);
    try {
      const inbound = await resumed.storage.listMailboxMessages?.(child.sessionId, "inbound");
      expect(inbound).toHaveLength(1);
      expect(inbound?.[0]).toMatchObject({ mailboxMessageId: sent.mailboxMessageId, delivered: true, acknowledged: false });
      expect((await resumed.agents.acknowledgeMessage(child.sessionId, child.branchId, sent.mailboxMessageId)).acknowledged).toBe(true);
    } finally { await resumed.close(); }
  });

  test("terminal task notice is delivered exactly once and remains visible through restart and rebuild", async () => {
    const { temp, supervisor } = await fresh();
    const root = await supervisor.createSession({ workspaceId: "terminal" });
    const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "finish once");
    const completed = await supervisor.agents.completeTask(child.sessionId, child.branchId, { result: { ok: true } });
    expect(completed.status).toBe("completed");
    expect((await supervisor.agents.completeTask(child.sessionId, child.branchId, { result: { ok: true } })).taskId).toBe(child.taskId);
    await supervisor.close();

    const resumed = await reopen(temp);
    try {
      await resumed.storage.rebuildOperationalProjections?.();
      const rootState = projectEvents(await resumed.storage.loadEvents(root.sessionId, { branchId: root.branchId }));
      const childState = projectEvents(await resumed.storage.loadEvents(child.sessionId, { branchId: child.branchId }));
      const inbound = Object.values(rootState.terminalNotices).filter((notice) => notice.taskId === child.taskId && notice.direction === "inbound");
      const outbound = Object.values(childState.terminalNotices).filter((notice) => notice.taskId === child.taskId && notice.direction === "outbound");
      expect(inbound).toHaveLength(1);
      expect(outbound).toHaveLength(1);
      expect(inbound[0]).toMatchObject({ status: "completed", delivered: true, result: { ok: true } });
      expect((await resumed.agents.listTasks(root.sessionId))[0]?.status).toBe("completed");
    } finally { await resumed.close(); }
  });
});
