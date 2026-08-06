import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  AgentService,
  Supervisor,
  projectEvents,
  type AgentAction,
  type JsonValue,
  type ModelConfiguration,
  type ModelProvider,
  type ModelResponse,
} from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

class CountingFinalProvider implements ModelProvider {
  readonly name = "fu012-crash-provider";
  readonly displayName = "FU-012 crash recovery fixture";
  readonly capabilities = { streaming: false } as const;
  calls = 0;

  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    const action: AgentAction = {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "final",
      content: "recovered child reply",
    };
    const text = JSON.stringify(action);
    return { text, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  }
}

describe("FU-012 review blockers", () => {
  test("renders retained same-root root-to-grandchild mailbox rows without widening nuclear authority", async () => {
    const temp = await makeTempRuntime("agencity-fu012-legacy-reach-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    try {
      const root = await supervisor.createSession({ workspaceId: "fu012-legacy" });
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "child", name: "child" });
      const grandchild = await supervisor.agents.spawn(child.sessionId, child.branchId, { task: "grandchild", name: "grandchild" });
      const mailboxMessageId = "pre-fu012-root-to-grandchild";
      const sentEventId = "pre-fu012-root-to-grandchild-sent";
      const legacy = {
        mailboxMessageId,
        fromSessionId: root.sessionId,
        fromBranchId: root.branchId,
        toSessionId: grandchild.sessionId,
        toBranchId: grandchild.branchId,
        kind: "message" as const,
        content: "retained deep-family message",
      };
      await supervisor.storage.appendEvents([{
        id: sentEventId,
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "MailboxMessageSent",
        producer: "client",
        idempotencyKey: "pre-fu012-root-to-grandchild-sent",
        payload: legacy,
      }, {
        sessionId: grandchild.sessionId,
        branchId: grandchild.branchId,
        type: "MailboxMessageDelivered",
        producer: "supervisor",
        idempotencyKey: "pre-fu012-root-to-grandchild-delivered",
        payload: { ...legacy, sentEventId },
      }]);

      const rootView = await supervisor.agents.messages(root.sessionId, root.branchId, { direction: "outbound" });
      const grandchildView = await supervisor.agents.messages(grandchild.sessionId, grandchild.branchId, { direction: "inbound" });
      expect(rootView.items.find((message) => message.mailboxMessageId === mailboxMessageId)).toMatchObject({
        relationship: "legacy",
        intentKey: null,
        fromSessionId: root.sessionId,
        toSessionId: grandchild.sessionId,
      });
      expect(grandchildView.items.find((message) => message.mailboxMessageId === mailboxMessageId)).toMatchObject({
        relationship: "legacy",
        intentKey: null,
        fromSessionId: root.sessionId,
        toSessionId: grandchild.sessionId,
      });

      await expect(supervisor.agents.sendMessage(root.sessionId, root.branchId, {
        target: grandchild.sessionId,
        content: "new sends stay nuclear",
      })).rejects.toMatchObject({ code: "FAMILY_REACH_DENIED" });
      await expect(supervisor.agents.followUp(root.sessionId, root.branchId, grandchild.sessionId, "no deep follow-up", {
        replyToMessageId: mailboxMessageId,
      })).rejects.toMatchObject({ code: "FAMILY_REACH_DENIED" });
      await expect(supervisor.agents.cancelFamilyTarget(root.sessionId, root.branchId, grandchild.sessionId, "no deep cancel"))
        .rejects.toMatchObject({ code: "FAMILY_REACH_DENIED" });
    } finally {
      await supervisor.close();
    }
  });

  test("atomically admits a runnable child that recovery advances after the queue optimization is lost", async () => {
    const temp = await makeTempRuntime("agencity-fu012-spawn-crash-"); temps.push(temp);
    const provider = new CountingFinalProvider();
    let initial: Supervisor | undefined;
    let resumed: Supervisor | undefined;
    try {
      initial = await Supervisor.open({
        databaseUrl: temp.databaseUrl,
        artifactDirectory: temp.artifactDirectory,
        workspaceRoot: temp.workspaceRoot,
        modelProviders: [provider],
        recover: false,
      });
      const root = await initial.createSession({
        workspaceId: "fu012-spawn-crash",
        model: { provider: provider.name, model: "scripted" },
      });

      // This service intentionally has no AgentRunService attached. It models a
      // process dying after the atomic append but before the optional advance
      // microtask can be queued or executed.
      const admissionOnly = new AgentService(initial.storage, initial.outbox);
      const child = await admissionOnly.spawnRunnable(root.sessionId, root.branchId, {
        task: "finish after restart",
        name: "recoverable-child",
        idempotencyKey: "recoverable-child",
      });
      const runId = `agent-spawn-run-${new Bun.CryptoHasher("sha256").update(child.taskId).digest("hex").slice(0, 32)}`;
      const admittedEvents = await initial.storage.loadEvents(child.sessionId, { branchId: child.branchId });
      expect(admittedEvents.filter((event) => event.type === "AgentRunRequested")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ runId, task: "finish after restart", requestKey: `agent-spawn:${child.taskId}` }),
        }),
      ]);
      expect(admittedEvents.filter((event) => event.type === "MessageAppended")).toHaveLength(1);
      expect(projectEvents(admittedEvents).agentRuns[runId]).toMatchObject({ status: "queued", requestKey: `agent-spawn:${child.taskId}` });
      expect(provider.calls).toBe(0);

      await initial.close(); initial = undefined;
      resumed = await Supervisor.open({
        databaseUrl: temp.databaseUrl,
        artifactDirectory: temp.artifactDirectory,
        workspaceRoot: temp.workspaceRoot,
        modelProviders: [provider],
        recover: true,
      });

      const recoveredEvents = await resumed.storage.loadEvents(child.sessionId, { branchId: child.branchId });
      const recoveredState = projectEvents(recoveredEvents);
      expect(Object.values(recoveredState.agentRuns)).toHaveLength(1);
      expect(recoveredState.agentRuns[runId]).toMatchObject({ status: "succeeded" });
      expect(recoveredEvents.filter((event) => event.type === "AgentRunRequested")).toHaveLength(1);
      expect(recoveredEvents.filter((event) => event.type === "ModelCallRequested")).toHaveLength(1);
      expect(provider.calls).toBe(1);
      expect((await resumed.agents.listTasks(root.sessionId)).find((task) => task.taskId === child.taskId)).toMatchObject({ status: "completed" });
      const replies = (await resumed.storage.listMailboxMessages?.(root.sessionId, "inbound"))
        ?.filter((message) => message.taskId === child.taskId && message.content === "recovered child reply");
      expect(replies).toHaveLength(1);
    } finally {
      if (resumed) await resumed.close();
      if (initial) await initial.close();
    }
  });
});
