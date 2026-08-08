import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL, AGENT_ACTION_VERSION, AgentClient, ProtocolServer, ScriptedAgentActionProvider, Supervisor,
  projectEvents, type AgentAction, type JsonValue, type ModelConfiguration, type ModelProvider, type ModelResponse,
} from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });
const action = <T extends Omit<AgentAction, "protocol" | "version">>(value: T): AgentAction => ({ protocol: AGENT_ACTION_PROTOCOL, version: AGENT_ACTION_VERSION, ...value } as unknown as AgentAction);
async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> { const end = Date.now() + timeoutMs; while (Date.now() < end) { const value = await read(); if (value !== undefined) return value; await Bun.sleep(10); } throw new Error("timed out"); }

class SequentialActionProvider implements ModelProvider {
  readonly name = "family-actions"; readonly displayName = "Sequential family action fixture"; readonly capabilities = { streaming: false } as const;
  #index = 0;
  constructor(readonly script: readonly AgentAction[]) {}
  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const selected = this.script[this.#index++] ?? action({ type: "failed", error: "No sequential family action" });
    const text = JSON.stringify(selected);
    return { text, finishReason: "stop", usage: { inputTokens: 1, outputTokens: Math.ceil(text.length / 4), costUsd: 0 } };
  }
}

class GatedActionProvider implements ModelProvider {
  readonly name = "gated-family-actions"; readonly displayName = "Gated family action fixture"; readonly capabilities = { streaming: false } as const;
  readonly contexts: JsonValue[] = [];
  readonly started: Promise<void>; #markStarted!: () => void;
  #release!: () => void; #gate = new Promise<void>((resolve) => { this.#release = resolve; });
  constructor(readonly afterGate: AgentAction = action({ type: "typescript", code: `return "boundary";` }), readonly next: AgentAction = action({ type: "final", content: "steered result" })) {
    this.started = new Promise<void>((resolve) => { this.#markStarted = resolve; });
  }
  release(): void { this.#release(); }
  async complete(context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    const ordinal = this.contexts.push(context);
    if (ordinal === 1) {
      this.#markStarted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        void this.#gate.then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
    }
    const selected = ordinal === 1 ? this.afterGate : this.next;
    const text = JSON.stringify(selected);
    return { text, finishReason: "stop", usage: { inputTokens: 1, outputTokens: Math.ceil(text.length / 4), costUsd: 0 } };
  }
}

async function customFixture(provider: ModelProvider, prefix = "agencity-family-custom-") {
  const temp = await makeTempRuntime(prefix); temps.push(temp);
  const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false, restartConsoleAfterCell: true });
  const root = await supervisor.createSession({ workspaceId: "family-sdk", model: { provider: provider.name, model: "scripted" } });
  return { temp, provider, supervisor, root };
}

async function fixture(script: AgentAction[] = []) {
  const temp = await makeTempRuntime("agencity-family-sdk-"); temps.push(temp);
  const provider = script.length ? new SequentialActionProvider(script) : new ScriptedAgentActionProvider(script, "family-actions");
  const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false, restartConsoleAfterCell: true });
  const root = await supervisor.createSession({ workspaceId: "family-sdk", model: { provider: provider.name, model: "scripted" } });
  return { temp, provider, supervisor, root };
}

describe("FU-012 retained family messaging", () => {
  test("sdk.agents exposes spawn/list/send/messages/acknowledge with derived identity and stable cell intents", async () => {
    const value = await fixture();
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "wait", name: "researcher", run: false });`, [], "family-spawn-cell");
      const handle = spawned.result as any;
      expect(handle.name).toBe("researcher");
      const roster = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.list();`);
      expect((roster.result as any).items).toEqual([expect.objectContaining({
        sessionId: handle.sessionId,
        name: "researcher",
        relationship: "child",
        task: "wait",
        cancellationRequested: false,
        activity: "idle",
        activityReason: null,
      })]);

      const childSend = await value.supervisor.executeCell(handle.sessionId, handle.branchId, `return sdk.agents.send({ target: "parent", content: "child reply", taskId: "${handle.taskId}" });`, [], "family-child-send");
      expect(childSend.result).toMatchObject({ fromSessionId: handle.sessionId, toSessionId: value.root.sessionId });
      const rootMessages = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.messages({ direction: "inbound" });`);
      const message = (rootMessages.result as any).items[0];
      expect(message).toMatchObject({ content: "child reply", relationship: "child", taskId: handle.taskId, receiptStatus: "delivered_to_context" });
      await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.acknowledge("${message.mailboxMessageId}");`);
      expect((await value.supervisor.storage.getMailboxMessage?.(message.mailboxMessageId))?.receiptStatus).toBe("acknowledged");

      const retry = await value.supervisor.agents.sendMessage(handle.sessionId, handle.branchId, { target: "parent", content: "stable", intentKey: "same" });
      const duplicate = await value.supervisor.agents.sendMessage(handle.sessionId, handle.branchId, { target: "parent", content: "stable", intentKey: "same" });
      expect(duplicate).toMatchObject({ mailboxMessageId: retry.mailboxMessageId, existing: true });
      await expect(value.supervisor.agents.sendMessage(handle.sessionId, handle.branchId, { target: "parent", content: "changed", intentKey: "same" })).rejects.toThrow(/different durable meaning/i);
    } finally { await value.supervisor.close(); }
  });

  test("family projection follows exact branch task edges and retains missing children as unavailable", async () => {
    const value = await fixture();
    try {
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, {
        task: "visible only from the admitting branch",
        name: "exact child",
        run: false,
      });
      const rootEvents = await value.supervisor.storage.loadEvents(value.root.sessionId, { branchId: value.root.branchId });
      const fork = await value.supervisor.fork(
        value.root.sessionId,
        value.root.branchId,
        rootEvents.at(-1)!.cursor,
        "other branch",
      );
      expect((await value.supervisor.agents.listFamily(value.root.sessionId, fork)).items).toEqual([]);

      await value.supervisor.storage.appendEvents([{
        sessionId: value.root.sessionId,
        branchId: value.root.branchId,
        type: "TaskCreated",
        producer: "supervisor",
        idempotencyKey: "family-missing-child-task",
        payload: {
          taskId: "family-missing-task",
          parentSessionId: value.root.sessionId,
          parentBranchId: value.root.branchId,
          childSessionId: "family-missing-session",
          childBranchId: "family-missing-branch",
          task: "State is intentionally missing",
          model: { provider: "family-actions", model: "scripted", reasoningEffort: "provider-default" },
          budget: {},
        },
      }]);
      const family = await value.supervisor.agents.listFamily(value.root.sessionId, value.root.branchId);
      expect(family.items.find(item => item.sessionId === child.sessionId)).toMatchObject({
        branchId: child.branchId,
        activity: "idle",
      });
      expect((await value.supervisor.agents.listFamily(child.sessionId, child.branchId)).items
        .find(item => item.relationship === "parent")).toMatchObject({
          sessionId: value.root.sessionId,
          taskId: child.taskId,
          taskStatus: "admitted",
          activity: "idle",
          activityReason: null,
        });
      expect(family.items.find(item => item.sessionId === "family-missing-session")).toEqual({
        sessionId: "family-missing-session",
        branchId: "family-missing-branch",
        name: null,
        relationship: "child",
        depth: 1,
        status: "unavailable",
        taskId: "family-missing-task",
        taskStatus: "pending",
        task: "State is intentionally missing",
        model: { provider: "family-actions", model: "scripted", reasoningEffort: "provider-default" },
        cancellationRequested: false,
        activity: "unavailable",
        activityReason: "missing_state",
      });
    } finally { await value.supervisor.close(); }
  });

  test("parent receives automatic initial and retained same-session follow-up replies", async () => {
    const value = await fixture([action({ type: "final", content: "initial result" }), action({ type: "final", content: "follow-up result" })]);
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "do initial", name: "worker" });`);
      const handle = spawned.result as any;
      await waitFor(async () => (await value.supervisor.agents.listTasks(value.root.sessionId)).find(task => task.taskId === handle.taskId)?.status === "completed" ? true : undefined);
      const firstReply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.taskId === handle.taskId && message.content === "initial result"));
      expect(firstReply.fromSessionId).toBe(handle.sessionId);
      expect(projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId })).status).toBe("stopped");

      const receipt = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.followUp("worker", "do more", { taskId: "${handle.taskId}" });`);
      expect(receipt.result).toMatchObject({ toSessionId: handle.sessionId });
      const secondReply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === (receipt.result as any).mailboxMessageId));
      expect(secondReply).toMatchObject({ fromSessionId: handle.sessionId, content: "follow-up result" });
      const childRuns = Object.values(projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId })).agentRuns);
      expect(childRuns).toHaveLength(2);
      expect(new Set(childRuns.map(run => run.requestKey))).toEqual(new Set([`agent-spawn:${handle.taskId}`, `agent-follow-up:${(receipt.result as any).mailboxMessageId}`]));
    } finally { await value.supervisor.close(); }
  });

  test("names reject ambiguity and nuclear reach rejects grandchildren and unrelated roots", async () => {
    const value = await fixture();
    try {
      const left = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "left", name: "same" });
      await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "right", name: "same" });
      const grandchild = await value.supervisor.agents.spawn(left.sessionId, left.branchId, { task: "deep", name: "deep" });
      const unrelated = await value.supervisor.createSession({ workspaceId: "family-sdk" });
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "same", content: "ambiguous" })).rejects.toThrow(/ambiguous/i);
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: grandchild.sessionId, content: "too deep" })).rejects.toMatchObject({ code: "FAMILY_REACH_DENIED" });
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: unrelated.sessionId, content: "other" })).rejects.toMatchObject({ code: "FAMILY_REACH_DENIED" });
    } finally { await value.supervisor.close(); }
  });

  test("protocol/client exposes roster, send/follow-up/cancel, acknowledgement, and paginated receipts", async () => {
    const value = await fixture([action({ type: "final", content: "wire follow-up result" })]); const server = new ProtocolServer(value.supervisor); const listener = server.listen(0); const client = new AgentClient(`http://127.0.0.1:${listener.port}`);
    try {
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "child", name: "wire agent" });
      await value.supervisor.agents.sendMessage(child.sessionId, child.branchId, { target: "parent", content: "one", intentKey: "wire-1" });
      await value.supervisor.agents.sendMessage(child.sessionId, child.branchId, { target: "parent", content: "two", intentKey: "wire-2" });
      expect((await client.agents(value.root.sessionId, value.root.branchId)).items[0]).toMatchObject({ name: "wire agent", relationship: "child" });
      const first = await client.mailbox(value.root.sessionId, value.root.branchId, { direction: "inbound", limit: 1 });
      expect(first.items).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
      await client.acknowledgeMailbox(value.root.sessionId, value.root.branchId, first.items[0]!.mailboxMessageId);
      expect((await value.supervisor.storage.getMailboxMessage?.(first.items[0]!.mailboxMessageId))?.receiptStatus).toBe("acknowledged");
      const second = await client.mailbox(value.root.sessionId, value.root.branchId, { direction: "inbound", limit: 1, before: first.nextCursor! });
      expect(second.items).toHaveLength(1); expect(second.items[0]!.mailboxMessageId).not.toBe(first.items[0]!.mailboxMessageId);
      const sent = await client.sendMailbox(value.root.sessionId, value.root.branchId, { target: "wire agent", content: "wire send", intentKey: "wire-client-send" });
      expect(sent.toSessionId).toBe(child.sessionId);
      const followUp = await client.followUpAgent(value.root.sessionId, value.root.branchId, "wire agent", "continue on wire", { taskId: child.taskId, intentKey: "wire-follow-up" });
      const reply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === followUp.mailboxMessageId));
      expect(reply.content).toBe("wire follow-up result");
      expect(await client.cancelAgent(value.root.sessionId, value.root.branchId, "wire agent", "wire done")).toMatchObject({ status: "cancelled" });
    } finally { server.stop(); await value.supervisor.close(); }
  });


  test("busy follow-up queues, crosses one durable boundary, and replies from the existing run", async () => {
    const provider = new GatedActionProvider(); const value = await customFixture(provider);
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "busy work", name: "busy" });`);
      const handle = spawned.result as any;
      await provider.started;
      (value.supervisor.agents as any).maxPendingMessages = 1;
      const queued = await value.supervisor.agents.followUp(value.root.sessionId, value.root.branchId, "busy", "steer now", { taskId: handle.taskId, intentKey: "busy-steer" });
      expect(queued).toMatchObject({ queued: true, receiptStatus: "queued", delivered: true });
      await expect(value.supervisor.agents.acknowledgeMessage(handle.sessionId, handle.branchId, queued.mailboxMessageId)).rejects.toThrow(/before context delivery/i);
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "busy", content: "queue overflow", intentKey: "busy-overflow" })).rejects.toThrow(/pending queue limit/i);
      provider.release();
      const reply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === queued.mailboxMessageId));
      expect(reply.content).toBe("steered result");
      const delivered = await value.supervisor.storage.getMailboxMessage?.(queued.mailboxMessageId);
      expect(delivered).toMatchObject({ receiptStatus: "delivered_to_context", deliveredToContext: true });
      const context = JSON.stringify(provider.contexts[1]);
      expect(context).toContain("steer now"); expect(context).toContain(queued.mailboxMessageId);
      const state = projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId }));
      expect(Object.values(state.agentRuns)).toHaveLength(1);
      expect(state.messages.filter(message => message.mailbox?.mailboxMessageId === queued.mailboxMessageId)).toHaveLength(1);
    } finally { provider.release(); await value.supervisor.close(); }
  });

  test("UTF-8 byte, rate, pending, and pagination bounds reject deterministically", async () => {
    const value = await fixture();
    try {
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "bounds", name: "bounds" });
      const exact = "😀".repeat(8_192);
      expect((await value.supervisor.agents.sendMessage(child.sessionId, child.branchId, { target: "parent", content: exact, intentKey: "exact-utf8" })).receiptStatus).toBe("delivered_to_context");
      await expect(value.supervisor.agents.sendMessage(child.sessionId, child.branchId, { target: "parent", content: `${exact}x`, intentKey: "too-large" })).rejects.toThrow(/32768 UTF-8 bytes/i);
      (value.supervisor.agents as any).maxMessagesPerMinute = 2;
      await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: child.sessionId, content: "rate one", intentKey: "rate-1" });
      await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: child.sessionId, content: "rate two", intentKey: "rate-2" });
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: child.sessionId, content: "rate three", intentKey: "rate-3" })).rejects.toThrow(/rate limit/i);
      await expect(value.supervisor.agents.messages(value.root.sessionId, value.root.branchId, { limit: 0 })).rejects.toThrow(/1 to 100/i);
      await expect(value.supervisor.agents.messages(value.root.sessionId, value.root.branchId, { before: "not-a-cursor" })).rejects.toThrow(/pagination cursor/i);
    } finally { await value.supervisor.close(); }
  });

  test("task and artifact references are authorized, materialized, and usable after worker restart", async () => {
    const value = await fixture();
    try {
      const artifactCell = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return artifacts.put("linked family evidence", "text/plain");`, [], "family-artifact-cell");
      const artifact = artifactCell.result as { artifactId: string };
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "consume evidence", name: "consumer" });
      const receipt = await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "consumer", content: "use the evidence", taskId: child.taskId, artifactIds: [artifact.artifactId], intentKey: "artifact-link" });
      expect(receipt.receiptStatus).toBe("delivered_to_context");
      const childState = projectEvents(await value.supervisor.storage.loadEvents(child.sessionId, { branchId: child.branchId }));
      expect(childState.artifacts[artifact.artifactId]).toBeDefined();
      expect(childState.messages.find(message => message.mailbox?.mailboxMessageId === receipt.mailboxMessageId)?.mailbox).toMatchObject({ relationship: "parent", taskId: child.taskId, artifactIds: [artifact.artifactId] });
      const resolved = await value.supervisor.executeCell(child.sessionId, child.branchId, `return artifacts.get("${artifact.artifactId}");`, [], "fresh-worker-artifact-read");
      expect(resolved.result).toBe("linked family evidence");
      const other = await value.supervisor.createSession({ workspaceId: "family-sdk" });
      const unrelated = await value.supervisor.agents.spawn(other.sessionId, other.branchId, "other task");
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: child.sessionId, content: "spoof task", taskId: unrelated.taskId })).rejects.toThrow(/task|family/i);
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: child.sessionId, content: "spoof artifact", artifactIds: ["missing-artifact"] })).rejects.toThrow(/artifact/i);
    } finally { await value.supervisor.close(); }
  });

  test("generated sends cannot spoof identity or conflicting aliases, while sibling name and ID routing stay nuclear", async () => {
    const value = await fixture();
    try {
      const left = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "left", name: "left" });
      const right = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "right", name: "right" });
      const spoof = await value.supervisor.executeCell(left.sessionId, left.branchId, `return sdk.agents.send({ target: "right", content: "derived sender", fromSessionId: "${value.root.sessionId}", fromBranchId: "${value.root.branchId}" });`);
      expect(spoof.result).toMatchObject({ fromSessionId: left.sessionId, toSessionId: right.sessionId });
      expect((await value.supervisor.agents.sendMessage(right.sessionId, right.branchId, { target: left.sessionId, content: "by id", intentKey: "sibling-id" })).toSessionId).toBe(left.sessionId);
      await expect(value.supervisor.agents.sendMessage(left.sessionId, left.branchId, { target: "right", toSessionId: value.root.sessionId, content: "confused target" })).rejects.toThrow(/aliases disagree/i);
      await expect(value.supervisor.agents.sendMessage(left.sessionId, left.branchId, { target: "right", content: "one", message: "two" })).rejects.toThrow(/content aliases disagree/i);
    } finally { await value.supervisor.close(); }
  });

  test("cancelling a busy child cancels its retained run and durable task", async () => {
    const provider = new GatedActionProvider(); const value = await customFixture(provider, "agencity-family-cancel-");
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "never finish", name: "cancellable" });`);
      const handle = spawned.result as any;
      await provider.started;
      const cancelled = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.cancel("cancellable", "user stop");`);
      expect(cancelled.result).toMatchObject({ taskId: handle.taskId, status: "cancelled", reason: "user stop" });
      const state = projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId }));
      expect(Object.values(state.agentRuns)[0]).toMatchObject({ status: "cancelled", cancellationRequested: true });
      expect(state.status).toBe("stopped");
    } finally { provider.release(); await value.supervisor.close(); }
  });

  test("recovery completes a send-only crash prefix once and preserves acknowledgement through rebuild", async () => {
    const value = await fixture(); let resumed: Supervisor | undefined;
    const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "recover", name: "recover" });
    const mailboxMessageId = "mailbox-crash-prefix"; const sentEventId = "mailbox-crash-prefix-sent";
    await value.supervisor.storage.appendEvents([{
      id: sentEventId, sessionId: value.root.sessionId, branchId: value.root.branchId, type: "MailboxMessageSent", producer: "client", idempotencyKey: "mailbox-crash-prefix-sent",
      payload: { mailboxMessageId, fromSessionId: value.root.sessionId, fromBranchId: value.root.branchId, toSessionId: child.sessionId, toBranchId: child.branchId, kind: "message", content: "recover exactly once", intentKey: "crash-prefix" },
    }]);
    await value.supervisor.close();
    try {
      resumed = await Supervisor.open({ databaseUrl: value.temp.databaseUrl, artifactDirectory: value.temp.artifactDirectory, workspaceRoot: value.temp.workspaceRoot, recover: true, restartConsoleAfterCell: true });
      expect(await resumed.storage.getMailboxMessage?.(mailboxMessageId)).toMatchObject({ receiptStatus: "delivered_to_context", delivered: true, deliveredToContext: true });
      await resumed.agents.acknowledgeMessage(child.sessionId, child.branchId, mailboxMessageId);
      await resumed.storage.rebuildOperationalProjections?.();
      expect(await resumed.storage.getMailboxMessage?.(mailboxMessageId)).toMatchObject({ receiptStatus: "acknowledged", acknowledged: true });
      expect((await resumed.storage.loadEvents(child.sessionId, { branchId: child.branchId })).filter(event => event.type === "MailboxMessageDelivered" && (event.payload as any).mailboxMessageId === mailboxMessageId)).toHaveLength(1);
      expect(projectEvents(await resumed.storage.loadEvents(child.sessionId, { branchId: child.branchId })).messages.filter(message => message.mailbox?.mailboxMessageId === mailboxMessageId)).toHaveLength(1);
    } finally { if (resumed) await resumed.close(); }
  });

  test("an unknown follow-up run recovers without replay and returns a typed unknown reply", async () => {
    const value = await fixture(); let resumed: Supervisor | undefined;
    const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "unknown child", name: "unknown" });
    const mailboxMessageId = "mailbox-unknown-follow-up"; const sentEventId = "mailbox-unknown-sent"; const runId = "family-unknown-run";
    const common = { mailboxMessageId, fromSessionId: value.root.sessionId, fromBranchId: value.root.branchId, toSessionId: child.sessionId, toBranchId: child.branchId, kind: "message" as const, content: "ambiguous work", taskId: child.taskId, intentKey: "unknown-follow-up", followUp: true };
    await value.supervisor.storage.appendEvents([{
      id: sentEventId, sessionId: value.root.sessionId, branchId: value.root.branchId, type: "MailboxMessageSent", producer: "client", idempotencyKey: "mailbox-unknown-sent", payload: common,
    }, {
      sessionId: child.sessionId, branchId: child.branchId, type: "MailboxMessageDelivered", producer: "supervisor", idempotencyKey: "mailbox-unknown-delivered", payload: { ...common, sentEventId, senderRelationship: "parent" },
    }]);
    await value.supervisor.agents.deliverQueuedAtBoundary(child.sessionId, child.branchId, runId);
    await value.supervisor.storage.appendEvents([{
      sessionId: child.sessionId, branchId: child.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "ambiguous work", requestKey: "family-unknown-request" },
    }]);
    const effectId = await value.supervisor.outbox.request({ sessionId: child.sessionId, branchId: child.branchId, executor: "shell", operation: "run", input: { command: "printf ambiguous" }, idempotencyKey: "family-ambiguous-effect", idempotent: false });
    expect(await value.supervisor.storage.claimEffect(effectId, "dead-family-owner")).not.toBeNull();
    await value.supervisor.close();
    try {
      resumed = await Supervisor.open({ databaseUrl: value.temp.databaseUrl, artifactDirectory: value.temp.artifactDirectory, workspaceRoot: value.temp.workspaceRoot, recover: true, restartConsoleAfterCell: true });
      expect(await resumed.runs.get(child.sessionId, child.branchId, runId)).toMatchObject({ status: "unknown" });
      const reply = (await resumed.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === mailboxMessageId);
      expect(reply?.content).toMatch(/^Follow-up unknown:/);
      expect((await resumed.storage.loadEvents(child.sessionId, { branchId: child.branchId })).filter(event => event.type === "AgentRunRequested" && (event.payload as any).runId === runId)).toHaveLength(1);
    } finally { if (resumed) await resumed.close(); }
  });

  test("unavailable targets return a stable failed receipt without fabricating context delivery", async () => {
    const value = await fixture();
    try {
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "unavailable", name: "unavailable" });
      await value.supervisor.storage.appendEvents([{
        sessionId: child.sessionId, branchId: child.branchId, type: "SessionStatusChanged", producer: "supervisor", idempotencyKey: "family-target-unavailable",
        payload: { status: "failed", reason: "provider unavailable" },
      }]);
      const failed = await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "unavailable", content: "cannot deliver", intentKey: "unavailable-send" });
      expect(failed).toMatchObject({ receiptStatus: "failed", delivered: false, existing: false, error: expect.stringContaining("unavailable") });
      expect(await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "unavailable", content: "cannot deliver", intentKey: "unavailable-send" })).toMatchObject({ mailboxMessageId: failed.mailboxMessageId, receiptStatus: "failed", existing: true });
      expect(projectEvents(await value.supervisor.storage.loadEvents(child.sessionId, { branchId: child.branchId })).messages.some(message => message.mailbox?.mailboxMessageId === failed.mailboxMessageId)).toBe(false);
    } finally { await value.supervisor.close(); }
  });


  test("old mailbox event shapes migrate, acknowledge, and rebuild deterministically", async () => {
    const value = await fixture();
    try {
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, "legacy child");
      const sentEventId = "legacy-family-sent-event"; const mailboxMessageId = "legacy-family-message";
      const legacy = { mailboxMessageId, fromSessionId: value.root.sessionId, fromBranchId: value.root.branchId, toSessionId: child.sessionId, toBranchId: child.branchId, kind: "message" as const, content: "old retained shape" };
      await value.supervisor.storage.appendEvents([{
        id: sentEventId, sessionId: value.root.sessionId, branchId: value.root.branchId, type: "MailboxMessageSent", producer: "client", idempotencyKey: "legacy-family-sent", payload: legacy,
      }, {
        sessionId: child.sessionId, branchId: child.branchId, type: "MailboxMessageDelivered", producer: "supervisor", idempotencyKey: "legacy-family-delivered", payload: { ...legacy, sentEventId },
      }]);
      expect(await value.supervisor.storage.getMailboxMessage?.(mailboxMessageId)).toMatchObject({ intentKey: null, artifactIds: [], receiptStatus: "delivered_to_context", deliveredToContext: true });
      await value.supervisor.agents.acknowledgeMessage(child.sessionId, child.branchId, mailboxMessageId);
      const before = await value.supervisor.storage.getMailboxMessage?.(mailboxMessageId);
      await value.supervisor.storage.rebuildOperationalProjections?.();
      expect(await value.supervisor.storage.getMailboxMessage?.(mailboxMessageId)).toEqual(before);
    } finally { await value.supervisor.close(); }
  });


  test("restart finishes a terminal child result whose task/reply observer crashed", async () => {
    const value = await fixture([action({ type: "final", content: "terminal before crash" })]); let resumed: Supervisor | undefined;
    try {
      (value.supervisor.agents as any).onRunTerminal = async () => {};
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "observer crash", name: "observer" });`);
      const handle = spawned.result as any;
      await waitFor(async () => {
        const runs = Object.values(projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId })).agentRuns);
        return runs[0]?.status === "succeeded" ? true : undefined;
      });
      expect((await value.supervisor.agents.listTasks(value.root.sessionId)).find(task => task.taskId === handle.taskId)?.status).toBe("admitted");
      await value.supervisor.close();
      resumed = await Supervisor.open({ databaseUrl: value.temp.databaseUrl, artifactDirectory: value.temp.artifactDirectory, workspaceRoot: value.temp.workspaceRoot, recover: true });
      expect((await resumed.agents.listTasks(value.root.sessionId)).find(task => task.taskId === handle.taskId)?.status).toBe("completed");
      const replies = (await resumed.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.filter(message => message.taskId === handle.taskId && message.content === "terminal before crash");
      expect(replies).toHaveLength(1);
    } finally { if (resumed) await resumed.close(); else await value.supervisor.close(); }
  });

});
