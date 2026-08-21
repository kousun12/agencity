import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL, AGENT_ACTION_VERSION, AgentClient, ProtocolServer, ScriptedAgentActionProvider, Supervisor,
  agentProfilePin, projectEvents, registerBrokeredSecret, type AgentAction, type AgentRunResult, type ConsoleMailboxMessageResult, type JsonValue, type ModelConfiguration, type ModelDispatch, type ModelEffectOutputV2, type ModelProvider, type TextModelResponse,
} from "../../src/index.ts";
import { formalOutputFromAgentAction } from "../../src/executors/model-response.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });
const action = <T extends Omit<AgentAction, "protocol" | "version">>(value: T): AgentAction => ({ protocol: AGENT_ACTION_PROTOCOL, version: AGENT_ACTION_VERSION, ...value } as unknown as AgentAction);
async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> { const end = Date.now() + timeoutMs; while (Date.now() < end) { const value = await read(); if (value !== undefined) return value; await Bun.sleep(10); } throw new Error("timed out"); }

class SequentialActionProvider implements ModelProvider {
  readonly name = "family-actions"; readonly displayName = "Sequential family action fixture";
  readonly capabilities = { streaming: false, requiredToolSet: { status: "provider-strict", requiredChoice: "provider-enforced", parallelCalls: "provider-disabled", streaming: true, adapter: "agencity.family-sequential.formal.v1" } } as const;
  #index = 0;
  constructor(readonly script: readonly AgentAction[]) {}
  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const selected = this.script[this.#index++] ?? action({ type: "failed", error: "No sequential family action" });
    const text = JSON.stringify(selected);
    return { text, finishReason: "stop", usage: { inputTokens: 1, outputTokens: Math.ceil(text.length / 4), costUsd: 0 } };
  }
  async streamResponse(_context: JsonValue, dispatch: ModelDispatch, signal: AbortSignal): Promise<ModelEffectOutputV2> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const selected = this.script[this.#index++] ?? action({ type: "failed", error: "No sequential family action" });
    return formalOutputFromAgentAction({ action: selected, dispatch, providerToolCallId: `family-${this.#index}`, provider: this.name, adapter: this.capabilities.requiredToolSet.adapter, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
  }
}

class GatedActionProvider implements ModelProvider {
  readonly name = "gated-family-actions"; readonly displayName = "Gated family action fixture";
  readonly capabilities = { streaming: false, requiredToolSet: { status: "provider-strict", requiredChoice: "provider-enforced", parallelCalls: "provider-disabled", streaming: true, adapter: "agencity.family-gated.formal.v1" } } as const;
  readonly contexts: JsonValue[] = [];
  readonly started: Promise<void>; #markStarted!: () => void;
  #release!: () => void; #gate = new Promise<void>((resolve) => { this.#release = resolve; });
  constructor(readonly afterGate: AgentAction = action({ type: "typescript", code: `return "boundary";` }), readonly next: AgentAction = action({ type: "final", content: "steered result" })) {
    this.started = new Promise<void>((resolve) => { this.#markStarted = resolve; });
  }
  release(): void { this.#release(); }
  async complete(context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    const selected = await this.#select(context, signal);
    const text = JSON.stringify(selected);
    return { text, finishReason: "stop", usage: { inputTokens: 1, outputTokens: Math.ceil(text.length / 4), costUsd: 0 } };
  }
  async streamResponse(context: JsonValue, dispatch: ModelDispatch, signal: AbortSignal): Promise<ModelEffectOutputV2> {
    const selected = await this.#select(context, signal);
    return formalOutputFromAgentAction({ action: selected, dispatch, providerToolCallId: `gated-${this.contexts.length}`, provider: this.name, adapter: this.capabilities.requiredToolSet.adapter, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
  }
  async #select(context: JsonValue, signal: AbortSignal): Promise<AgentAction> {
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
    return ordinal === 1 ? this.afterGate : this.next;
  }
}

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;
type ConsoleAdmittedMailboxResult = Extract<ConsoleMailboxMessageResult, {
  readonly admitted: true;
}>;
type RuntimeAdmittedMailboxResult = AgentRunResult & {
  readonly mailboxMessageId: string;
  readonly admitted: true;
};
type _RuntimeMailboxResultFitsConsole = Assert<Assignable<
  RuntimeAdmittedMailboxResult,
  ConsoleAdmittedMailboxResult
>>;
type _ConsoleMailboxResultFitsRuntime = Assert<Assignable<
  ConsoleAdmittedMailboxResult,
  RuntimeAdmittedMailboxResult
>>;

async function customFixture(
  provider: ModelProvider,
  prefix = "agencity-family-custom-",
  options: {
    readonly maxResident?: number;
    readonly maxActive?: number;
  } = {},
) {
  const temp = await makeTempRuntime(prefix); temps.push(temp);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    modelProviders: [provider],
    recover: false,
    restartConsoleAfterCell: true,
    ...(options.maxResident === undefined
      ? {}
      : { maxConsoleResidentProcesses: options.maxResident }),
    ...(options.maxActive === undefined
      ? {}
      : { maxConsoleActiveExecutions: options.maxActive }),
  });
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
  test("queued message handles expose deterministic observable run results across FIFO delivery and restart", async () => {
    const provider = new GatedActionProvider(
      action({ type: "typescript", code: `return "initial boundary";` }),
      action({ type: "final", content: "queued terminal result" }),
    );
    const value = await customFixture(provider, "agencity-mailbox-result-");
    let active = value.supervisor;
    try {
      const child = await active.agents.spawnRunnable(
        value.root.sessionId,
        value.root.branchId,
        { task: "hold initial run", name: "queued worker" },
      );
      await provider.started;
      const first = await active.agents.sendMessage(
        value.root.sessionId,
        value.root.branchId,
        {
          target: child.sessionId,
          content: "first queued task",
          intentKey: "queued-result-first",
        },
      );
      const duplicate = await active.agents.sendMessage(
        value.root.sessionId,
        value.root.branchId,
        {
          target: child.sessionId,
          content: "first queued task",
          intentKey: "queued-result-first",
        },
      );
      const second = await active.agents.sendMessage(
        value.root.sessionId,
        value.root.branchId,
        {
          target: child.sessionId,
          content: "second queued task",
          intentKey: "queued-result-second",
        },
      );
      expect(first.runId).toMatch(/^agent-queue-run-/);
      expect(duplicate).toMatchObject({
        mailboxMessageId: first.mailboxMessageId,
        runId: first.runId,
        existing: true,
      });
      expect(second.runId).not.toBe(first.runId);
      expect(await active.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        first.mailboxMessageId,
        { wait: false },
      )).toMatchObject({
        runId: first.runId,
        status: "queued",
        steps: 0,
        admitted: false,
      });
      const beforeRelease = projectEvents(await active.storage.loadEvents(
        child.sessionId,
        { branchId: child.branchId },
      ));
      expect(beforeRelease.agentRuns[first.runId!]).toBeUndefined();
      expect(beforeRelease.agentRuns[second.runId!]).toBeUndefined();

      const steer = await active.agents.sendMessage(
        value.root.sessionId,
        value.root.branchId,
        {
          target: child.sessionId,
          content: "steer only",
          mode: "steer",
          intentKey: "steer-has-no-result",
        },
      );
      expect(steer.runId).toBeUndefined();
      await expect(active.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        steer.mailboxMessageId,
      )).rejects.toThrow(/non-legacy queued/i);

      provider.release();
      const firstResult = await active.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        first.mailboxMessageId,
        { wait: true, timeoutMs: 3_000 },
      );
      const secondResult = await active.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        second.mailboxMessageId,
        { wait: true, timeoutMs: 3_000 },
      );
      expect(firstResult).toMatchObject({
        runId: first.runId,
        status: "succeeded",
        admitted: true,
        final: "queued terminal result",
      });
      expect(secondResult).toMatchObject({
        runId: second.runId,
        status: "succeeded",
        admitted: true,
      });
      const requestedOrder = (await active.storage.loadEvents(
        child.sessionId,
        { branchId: child.branchId },
      )).filter((event) => event.type === "AgentRunRequested")
        .map((event) => (event.payload as { runId: string }).runId);
      expect(requestedOrder.slice(-2)).toEqual([first.runId!, second.runId!]);
      await expect(active.agents.messageResult(
        child.sessionId,
        child.branchId,
        first.mailboxMessageId,
      )).rejects.toThrow(/not found/i);

      await active.storage.appendEvents([{
        sessionId: child.sessionId,
        branchId: child.branchId,
        type: "SessionStatusChanged",
        producer: "supervisor",
        idempotencyKey: "mailbox-result-archive-target",
        payload: { status: "archived" },
      }]);
      const failed = await active.agents.sendMessage(
        value.root.sessionId,
        value.root.branchId,
        {
          target: child.sessionId,
          content: "cannot deliver",
          intentKey: "queued-result-failed",
        },
      );
      expect(failed.runId).toMatch(/^agent-queue-run-/);
      expect(await active.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        failed.mailboxMessageId,
      )).toMatchObject({
        runId: failed.runId,
        status: "failed",
        steps: 0,
        admitted: false,
      });

      const legacyMessageId = "legacy-follow-up-result";
      await active.storage.appendEvents([{
        sessionId: value.root.sessionId,
        branchId: value.root.branchId,
        type: "MailboxMessageSent",
        producer: "client",
        idempotencyKey: "legacy-follow-up-result",
        payload: {
          mailboxMessageId: legacyMessageId,
          fromSessionId: value.root.sessionId,
          fromBranchId: value.root.branchId,
          toSessionId: child.sessionId,
          toBranchId: child.branchId,
          kind: "message",
          content: "retained legacy follow-up",
          followUp: true,
        },
      }]);
      await expect(active.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        legacyMessageId,
      )).rejects.toThrow(/non-legacy queued/i);

      await active.close();
      active = await Supervisor.open({
        databaseUrl: value.temp.databaseUrl,
        artifactDirectory: value.temp.artifactDirectory,
        workspaceRoot: value.temp.workspaceRoot,
        modelProviders: [provider],
        recover: true,
      });
      expect(await active.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        first.mailboxMessageId,
      )).toMatchObject({
        runId: first.runId,
        status: "succeeded",
        admitted: true,
      });
    } finally {
      await active.close();
    }
  });

  test("console mailbox result wait fails before blocking when recipient capacity is unavailable", async () => {
    const provider = new GatedActionProvider(
      action({ type: "typescript", code: `return "queued cell";` }),
      action({ type: "final", content: "queued capacity result" }),
    );
    const value = await customFixture(
      provider,
      "agencity-mailbox-result-no-capacity-",
      { maxResident: 1, maxActive: 1 },
    );
    try {
      const child = await value.supervisor.agents.spawn(
        value.root.sessionId,
        value.root.branchId,
        { task: "retained recipient", name: "capacity recipient" },
      );
      const message = await value.supervisor.agents.sendMessage(
        value.root.sessionId,
        value.root.branchId,
        {
          target: child.sessionId,
          content: "run queued work",
          intentKey: "mailbox-no-capacity",
        },
      );
      await provider.started;

      const observed = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `try {
          await sdk.agents.messageResult(${JSON.stringify(message)}, {
            wait: true,
            timeoutMs: 3000,
          });
          return { unexpected: true };
        } catch (error) {
          return { code: error.code, details: error.details };
        }`,
      );
      expect(observed.result).toMatchObject({
        code: "CONSOLE_CAPACITY_EXCEEDED",
        details: {
          requestedResidentProcesses: 1,
          availableResidentProcesses: 0,
          maxResidentProcesses: 1,
        },
      });
      expect(value.supervisor.console.capacityStatus().reservedProcesses).toBe(0);
      const current = await value.supervisor.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        message.mailboxMessageId,
        { wait: false },
      );
      expect(current).toMatchObject({
        mailboxMessageId: message.mailboxMessageId,
        admitted: true,
        status: "running",
      });
      expect("taskId" in current).toBe(false);

      provider.release();
      expect(await value.supervisor.agents.messageResult(
        value.root.sessionId,
        value.root.branchId,
        message.mailboxMessageId,
        { wait: true, timeoutMs: 3_000 },
      )).toMatchObject({ status: "succeeded", admitted: true });
    } finally {
      provider.release();
      await value.supervisor.close();
    }
  });

  test("console mailbox result wait reserves the recipient branch and releases on timeout", async () => {
    const provider = new GatedActionProvider(
      action({ type: "typescript", code: `return "reserved queued cell";` }),
      action({ type: "final", content: "reserved queued result" }),
    );
    const value = await customFixture(
      provider,
      "agencity-mailbox-result-reservation-",
      { maxResident: 2, maxActive: 1 },
    );
    try {
      const child = await value.supervisor.agents.spawn(
        value.root.sessionId,
        value.root.branchId,
        { task: "retained recipient", name: "reserved recipient" },
      );
      const message = await value.supervisor.agents.sendMessage(
        value.root.sessionId,
        value.root.branchId,
        {
          target: child.sessionId,
          content: "run reserved queued work",
          intentKey: "mailbox-reserved-capacity",
        },
      );
      await provider.started;

      const timedOut = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.messageResult(${JSON.stringify(message)}, {
          wait: true,
          timeoutMs: 25,
        });`,
      );
      expect(timedOut.result).toMatchObject({
        mailboxMessageId: message.mailboxMessageId,
        runId: message.runId,
        sessionId: child.sessionId,
        branchId: child.branchId,
        status: "running",
        admitted: true,
      });
      expect("taskId" in (timedOut.result as Record<string, unknown>)).toBe(false);
      expect(value.supervisor.console.capacityStatus().reservedProcesses).toBe(0);

      const waiting = value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.messageResult(${JSON.stringify(message)}, {
          wait: true,
          timeoutMs: 3000,
        });`,
      );
      await waitFor(async () =>
        value.supervisor.console.capacityStatus().reservedProcesses === 1
          ? true
          : undefined
      );
      provider.release();
      const terminal = await waiting;
      expect(terminal.result).toMatchObject({
        mailboxMessageId: message.mailboxMessageId,
        runId: message.runId,
        sessionId: child.sessionId,
        branchId: child.branchId,
        status: "succeeded",
        admitted: true,
        final: "reserved queued result",
        finalMessageId: expect.any(String),
        output: {
          kind: "text",
          text: "reserved queued result",
        },
        resultReference: {
          kind: "text",
        },
        steps: expect.any(Number),
      });
      expect("taskId" in (terminal.result as Record<string, unknown>)).toBe(false);
      expect(value.supervisor.console.capacityStatus()).toMatchObject({
        activeExecutions: 0,
        reservedProcesses: 0,
      });
    } finally {
      provider.release();
      await value.supervisor.close();
    }
  });

  test("sdk.agents exposes spawn/list/send/messages/acknowledge with derived identity and stable cell intents", async () => {
    const value = await fixture([action({ type: "final", content: "child completed" })]);
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "wait", name: "researcher" });`, [], "family-spawn-cell");
      const handle = spawned.result as any;
      expect(handle.name).toBe("researcher");
      const completed = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.result("${handle.taskId}", { wait: true, timeoutMs: 3000 });`);
      expect(completed.result).toMatchObject({
        status: "succeeded",
        final: "child completed",
        output: { kind: "text", text: "child completed" },
      });
      const roster = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.list();`);
      expect((roster.result as any).items).toEqual([expect.objectContaining({
        sessionId: handle.sessionId,
        name: "researcher",
        sessionTitle: {
          text: "researcher",
          source: "explicit",
          verb: null,
          subject: null,
          intentSummary: null,
          sourceMessageCursor: null,
        },
        relationship: "child",
        task: "wait",
        cancellationRequested: false,
        activity: "idle",
        activityReason: null,
      })]);

      const childSend = await value.supervisor.executeCell(handle.sessionId, handle.branchId, `return sdk.agents.send({ target: "parent", content: "child reply", taskId: "${handle.taskId}", mode: "steer" });`, [], "family-child-send");
      expect(childSend.result).toMatchObject({ fromSessionId: handle.sessionId, toSessionId: value.root.sessionId, mode: "steer" });
      const rootMessages = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.messages({ direction: "inbound" });`);
      const message = (rootMessages.result as any).items[0];
      expect(message).toMatchObject({ content: "child reply", relationship: "child", taskId: handle.taskId, mode: "steer", receiptStatus: "delivered_to_context" });
      expect(Object.values(projectEvents(await value.supervisor.storage.loadEvents(value.root.sessionId, { branchId: value.root.branchId })).agentRuns)).toHaveLength(0);
      await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.acknowledge("${message.mailboxMessageId}");`);
      expect((await value.supervisor.storage.getMailboxMessage?.(message.mailboxMessageId))?.receiptStatus).toBe("acknowledged");

      const retry = await value.supervisor.agents.sendMessage(handle.sessionId, handle.branchId, { target: "parent", content: "stable", mode: "steer", intentKey: "same" });
      const duplicate = await value.supervisor.agents.sendMessage(handle.sessionId, handle.branchId, { target: "parent", content: "stable", mode: "steer", intentKey: "same" });
      expect(duplicate).toMatchObject({ mailboxMessageId: retry.mailboxMessageId, existing: true });
      await expect(value.supervisor.agents.sendMessage(handle.sessionId, handle.branchId, { target: "parent", content: "changed", mode: "steer", intentKey: "same" })).rejects.toThrow(/different durable meaning/i);
      await expect(value.supervisor.agents.sendMessage(handle.sessionId, handle.branchId, { target: "parent", content: "stable", mode: "queue", intentKey: "same" })).rejects.toThrow(/different durable meaning/i);
      await expect(value.supervisor.agents.sendMessage(handle.sessionId, handle.branchId, { target: "parent", content: "legacy", followUp: true } as any)).rejects.toThrow(/use mode/i);
    } finally { await value.supervisor.close(); }
  });

  test("sdk.agents run, runMany, spawn, and result retain task result references and notices", async () => {
    const value = await fixture([
      action({ type: "final", content: "single result" }),
      action({ type: "final", content: "batch result one" }),
      action({ type: "final", content: "batch result two" }),
      action({ type: "final", content: "detached result" }),
    ]);
    try {
      const single = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.run({ task: "single child", idempotencyKey: "single-child" });`,
      );
      expect(single.result).toMatchObject({
        status: "succeeded",
        output: { kind: "text", text: "single result" },
        resultReference: { kind: "text" },
      });

      const batch = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.runMany([
          { task: "batch child one", idempotencyKey: "batch-child-one" },
          { task: "batch child two", idempotencyKey: "batch-child-two" },
        ]);`,
      );
      expect((batch.result as any[]).every(item =>
        item.status === "succeeded" && item.output?.kind === "text"
      )).toBe(true);
      expect(new Set((batch.result as any[]).map(item => item.output.text))).toEqual(
        new Set(["batch result one", "batch result two"]),
      );

      const detached = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.spawn({ task: "detached child", idempotencyKey: "detached-child" });`,
      );
      const detachedHandle = detached.result as any;
      expect(detachedHandle.runId).toBeString();
      const retained = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.result(${JSON.stringify(detachedHandle)}, { wait: true, timeoutMs: 3000 });`,
      );
      expect(retained.result).toMatchObject({
        status: "succeeded",
        output: { kind: "text", text: "detached result" },
      });

      const tasks = await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      );
      expect(tasks).toHaveLength(4);
      expect(tasks.every(task =>
        task.status === "completed" &&
        task.result &&
        typeof task.result === "object" &&
        !Array.isArray(task.result) &&
        task.result.protocol === "agencity.agent-run-result-reference"
      )).toBe(true);
      const parentEvents = await value.supervisor.storage.loadEvents(
        value.root.sessionId,
        { branchId: value.root.branchId },
      );
      expect(parentEvents.filter(event =>
        event.type === "TaskTerminalNoticeDelivered"
      )).toHaveLength(4);
      const completedStatus = parentEvents.find(event =>
        event.type === "TaskStatusChanged" &&
        (event.payload as any).result?.protocol ===
          "agencity.agent-run-result-reference"
      )!;
      expect(() => projectEvents(parentEvents.map(event =>
        event.id === completedStatus.id
          ? {
              ...event,
              payload: { ...(event.payload as any), status: "failed" },
            } as any
          : event
      ))).toThrow(/result references may only complete tasks/i);
    } finally {
      await value.supervisor.close();
    }
  });

  test("agent invocation admission fails closed and keeps mixed idempotent batches atomic", async () => {
    const value = await fixture([
      action({ type: "final", content: "existing invocation result" }),
    ]);
    try {
      const before = await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      );
      expect(before).toHaveLength(0);
      await expect(value.supervisor.agents.spawnRunnable(
        value.root.sessionId,
        value.root.branchId,
        {
          task: "unknown output field",
          output: {
            schema: { type: "object", additionalProperties: false },
            tools: ["shell"],
          },
        } as any,
      )).rejects.toThrow(/only the declared schema/i);
      await expect(value.supervisor.agents.spawnRunnable(
        value.root.sessionId,
        value.root.branchId,
        {
          task: "obsolete run toggle",
          run: false,
        } as any,
      )).rejects.toThrow(/spawn is always detached-running/i);
      const releaseSchemaSecret = registerBrokeredSecret("sk-proj-1234567890secret");
      try {
        await expect(value.supervisor.agents.spawnRunnable(
          value.root.sessionId,
          value.root.branchId,
          {
            task: "secret schema",
            output: {
              schema: {
                type: "object",
                description: "Use sk-proj-1234567890secret",
                additionalProperties: false,
              },
            },
          },
        )).rejects.toThrow(/registered credential value/i);
      } finally {
        releaseSchemaSecret();
      }
      await expect(value.supervisor.agents.spawnManyRunnable(
        value.root.sessionId,
        value.root.branchId,
        [],
      )).rejects.toThrow(/requires 1-16 inputs/i);
      await expect(value.supervisor.agents.spawnManyRunnable(
        value.root.sessionId,
        value.root.branchId,
        Array.from({ length: 17 }, (_, index) => `child ${index}`),
      )).rejects.toThrow(/requires 1-16 inputs/i);
      expect(await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      )).toHaveLength(0);

      const existing = await value.supervisor.agents.spawnRunnable(
        value.root.sessionId,
        value.root.branchId,
        {
          task: "existing invocation",
          idempotencyKey: "existing-invocation",
        },
      );
      await expect(value.supervisor.agents.result(
        value.root.sessionId,
        value.root.branchId,
        existing.taskId,
        { wait: true, timeoutMs: -1 },
      )).rejects.toThrow(/timeout must be from 0/i);
      await expect(value.supervisor.agents.spawnManyRunnable(
        value.root.sessionId,
        value.root.branchId,
        [{
          task: "must not be admitted",
          idempotencyKey: "novel-before-conflict",
        }, {
          task: "existing invocation",
          idempotencyKey: "existing-invocation",
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["changed"],
              properties: { changed: { type: "boolean" } },
            },
          },
        }],
      )).rejects.toThrow(/different invocation contract/i);
      const tasks = await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      );
      expect(tasks.map(task => task.taskId)).toEqual([existing.taskId]);
    } finally {
      await value.supervisor.close();
    }
  });

  test("family projection follows exact branch task edges and retains missing children as unavailable", async () => {
    const value = await fixture();
    try {
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, {
        task: "visible only from the admitting branch",
        name: "exact child",
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
        sessionTitle: null,
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

  test("parent receives automatic initial and retained same-session queued replies", async () => {
    const value = await fixture([action({ type: "final", content: "initial result" }), action({ type: "final", content: "queued result" })]);
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "do initial", name: "worker" });`);
      const handle = spawned.result as any;
      await waitFor(async () => (await value.supervisor.agents.listTasks(value.root.sessionId)).find(task => task.taskId === handle.taskId)?.status === "completed" ? true : undefined);
      const firstReply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.taskId === handle.taskId && message.content === "initial result"));
      expect(firstReply.fromSessionId).toBe(handle.sessionId);
      expect(projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId })).status).toBe("stopped");

      const receipt = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.send("worker", "do more", { taskId: "${handle.taskId}" });`);
      expect(receipt.result).toMatchObject({
        toSessionId: handle.sessionId,
        mode: "queue",
        runId: expect.stringMatching(/^agent-queue-run-/),
      });
      const secondReply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === (receipt.result as any).mailboxMessageId));
      expect(secondReply).toMatchObject({ fromSessionId: handle.sessionId, content: "queued result" });
      const observed = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.messageResult(${JSON.stringify(receipt.result)}, { wait: true, timeoutMs: 3000 });`,
      );
      expect(observed.result).toMatchObject({
        mailboxMessageId: (receipt.result as any).mailboxMessageId,
        runId: (receipt.result as any).runId,
        status: "succeeded",
        admitted: true,
      });
      const childRuns = Object.values(projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId })).agentRuns);
      expect(childRuns).toHaveLength(2);
      expect(new Set(childRuns.map(run => run.requestKey))).toEqual(new Set([`agent-spawn:${handle.taskId}`, `agent-queue:${(receipt.result as any).mailboxMessageId}`]));
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

  test("protocol/client exposes roster, send modes, cancel, acknowledgement, and paginated receipts", async () => {
    const value = await fixture([action({ type: "final", content: "wire queued result" })]); const server = new ProtocolServer(value.supervisor); const listener = server.listen(0); const client = new AgentClient(`http://127.0.0.1:${listener.port}`);
    try {
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "child", name: "wire agent" });
      await value.supervisor.agents.sendMessage(child.sessionId, child.branchId, { target: "parent", content: "one", mode: "steer", intentKey: "wire-1" });
      await value.supervisor.agents.sendMessage(child.sessionId, child.branchId, { target: "parent", content: "two", mode: "steer", intentKey: "wire-2" });
      expect((await client.agents(value.root.sessionId, value.root.branchId)).items[0]).toMatchObject({ name: "wire agent", relationship: "child" });
      const first = await client.mailbox(value.root.sessionId, value.root.branchId, { direction: "inbound", limit: 1 });
      expect(first.items).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
      await client.acknowledgeMailbox(value.root.sessionId, value.root.branchId, first.items[0]!.mailboxMessageId);
      expect((await value.supervisor.storage.getMailboxMessage?.(first.items[0]!.mailboxMessageId))?.receiptStatus).toBe("acknowledged");
      const second = await client.mailbox(value.root.sessionId, value.root.branchId, { direction: "inbound", limit: 1, before: first.nextCursor! });
      expect(second.items).toHaveLength(1); expect(second.items[0]!.mailboxMessageId).not.toBe(first.items[0]!.mailboxMessageId);
      const sent = await client.sendMailbox(value.root.sessionId, value.root.branchId, { target: "wire agent", content: "wire send", mode: "steer", intentKey: "wire-client-send" });
      expect(sent).toMatchObject({ toSessionId: child.sessionId, mode: "steer" });
      const queued = await client.sendMailbox(value.root.sessionId, value.root.branchId, { target: "wire agent", content: "continue on wire", taskId: child.taskId, intentKey: "wire-queue" });
      expect(queued.runId).toMatch(/^agent-queue-run-/);
      const reply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === queued.mailboxMessageId));
      expect(reply.content).toBe("wire queued result");
      expect(await client.mailboxResult(
        value.root.sessionId,
        value.root.branchId,
        queued.mailboxMessageId,
      )).toMatchObject({
        runId: queued.runId,
        status: "succeeded",
        admitted: true,
      });
      expect(await client.cancelAgent(value.root.sessionId, value.root.branchId, "wire agent", "wire done")).toMatchObject({ status: "cancelled" });
    } finally { server.stop(); await value.supervisor.close(); }
  });

  test("protocol/client exposes retained agent invocation lifecycle lookup", async () => {
    const value = await fixture([
      action({ type: "final", content: "wire invocation result" }),
    ]);
    const server = new ProtocolServer(value.supervisor);
    const listener = server.listen(0);
    const client = new AgentClient(`http://127.0.0.1:${listener.port}`);
    try {
      const input = {
        task: "wire invocation",
        idempotencyKey: "wire-invocation",
      };
      const first = await client.spawn(
        value.root.sessionId,
        value.root.branchId,
        input,
      );
      const duplicate = await client.spawn(
        value.root.sessionId,
        value.root.branchId,
        input,
      );
      expect(duplicate).toMatchObject({
        taskId: first.taskId,
        runId: first.runId,
        sessionId: first.sessionId,
        branchId: first.branchId,
      });
      expect(await client.findAgentInvocation(
        value.root.sessionId,
        value.root.branchId,
        input.idempotencyKey,
      )).toMatchObject({ taskId: first.taskId, runId: first.runId });
      expect(await client.agentInvocationContract(
        value.root.sessionId,
        value.root.branchId,
        first.taskId,
      )).toMatchObject({
        runId: first.runId,
        output: { kind: "text" },
      });
      const result = await waitFor(async () => {
        const current = await client.agentInvocationResult(
          value.root.sessionId,
          value.root.branchId,
          first.taskId,
        );
        return current.status === "succeeded" ? current : undefined;
      });
      expect(result).toMatchObject({
        output: { kind: "text", text: "wire invocation result" },
        resultReference: { kind: "text" },
      });
    } finally {
      server.stop();
      await value.supervisor.close();
    }
  });


  test("busy steer reaches the active run at its next durable boundary", async () => {
    const provider = new GatedActionProvider();
    const value = await customFixture(provider);
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "busy work", name: "steerable" });`);
      const handle = spawned.result as any;
      await provider.started;
      const steered = await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, {
        target: "steerable",
        content: "change the active work",
        taskId: handle.taskId,
        mode: "steer",
        intentKey: "busy-steer",
      });
      expect(steered).toMatchObject({ queued: true, receiptStatus: "queued", mode: "steer" });
      provider.release();
      await waitFor(async () => (await value.supervisor.storage.getMailboxMessage?.(steered.mailboxMessageId))?.deliveredToContext && provider.contexts.length > 1 ? true : undefined);
      const context = JSON.stringify(provider.contexts[1]);
      expect(context).toContain("change the active work");
      expect(context).toContain(steered.mailboxMessageId);
      const state = projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId }));
      expect(Object.values(state.agentRuns)).toHaveLength(1);
      expect(state.mailbox[steered.mailboxMessageId]?.contextRunId).toBe(Object.values(state.agentRuns)[0]!.id);
    } finally { provider.release(); await value.supervisor.close(); }
  });

  test("retained followUp events keep legacy busy-run delivery after the mode cutover", async () => {
    const provider = new GatedActionProvider();
    const value = await customFixture(provider);
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "legacy busy work", name: "legacy-busy" });`);
      const handle = spawned.result as any;
      await provider.started;
      const mailboxMessageId = "legacy-busy-follow-up";
      const sentEventId = "legacy-busy-follow-up-sent";
      const common = {
        mailboxMessageId,
        fromSessionId: value.root.sessionId,
        fromBranchId: value.root.branchId,
        toSessionId: handle.sessionId,
        toBranchId: handle.branchId,
        kind: "message" as const,
        content: "legacy follow-up content",
        taskId: handle.taskId,
        intentKey: "legacy-busy-follow-up",
        followUp: true,
      };
      await value.supervisor.storage.appendEvents([{
        id: sentEventId,
        sessionId: value.root.sessionId,
        branchId: value.root.branchId,
        type: "MailboxMessageSent",
        producer: "client",
        idempotencyKey: "legacy-busy-follow-up-sent",
        payload: common,
      }, {
        sessionId: handle.sessionId,
        branchId: handle.branchId,
        type: "MailboxMessageDelivered",
        producer: "supervisor",
        idempotencyKey: "legacy-busy-follow-up-delivered",
        payload: { ...common, sentEventId, senderRelationship: "parent" },
      }]);
      expect(await value.supervisor.storage.getMailboxMessage?.(mailboxMessageId)).toMatchObject({ mode: "queue", legacyFollowUp: true, receiptStatus: "queued" });
      provider.release();
      await waitFor(async () => provider.contexts.length > 1 ? true : undefined);
      expect(JSON.stringify(provider.contexts[1])).toContain("legacy follow-up content");
      const state = projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId }));
      expect(Object.values(state.agentRuns)).toHaveLength(1);
      expect(state.mailbox[mailboxMessageId]?.contextRunId).toBe(Object.values(state.agentRuns)[0]!.id);
    } finally { provider.release(); await value.supervisor.close(); }
  });

  test("busy default queue starts separate FIFO runs after the active run", async () => {
    const provider = new GatedActionProvider(
      action({ type: "typescript", code: `return "initial boundary";` }),
      action({ type: "final", content: "queued result" }),
    );
    const value = await customFixture(provider);
    try {
      const spawned = await value.supervisor.executeCell(value.root.sessionId, value.root.branchId, `return sdk.agents.spawn({ task: "busy work", name: "busy" });`);
      const handle = spawned.result as any;
      await provider.started;
      (value.supervisor.agents as any).maxPendingMessages = 2;
      const first = await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "busy", content: "first queued work", taskId: handle.taskId, intentKey: "busy-queue-1" });
      const second = await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "busy", content: "second queued work", taskId: handle.taskId, intentKey: "busy-queue-2" });
      expect(first).toMatchObject({ queued: true, receiptStatus: "queued", delivered: true, mode: "queue" });
      expect(second).toMatchObject({ queued: true, receiptStatus: "queued", delivered: true, mode: "queue" });
      await expect(value.supervisor.agents.acknowledgeMessage(handle.sessionId, handle.branchId, first.mailboxMessageId)).rejects.toThrow(/before context delivery/i);
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "busy", content: "queue overflow", intentKey: "busy-overflow" })).rejects.toThrow(/pending queue limit/i);
      provider.release();
      const firstReply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === first.mailboxMessageId));
      const secondReply = await waitFor(async () => (await value.supervisor.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === second.mailboxMessageId));
      expect(firstReply.content).toBe("queued result");
      expect(secondReply.content).toBe("queued result");
      expect(await value.supervisor.storage.getMailboxMessage?.(first.mailboxMessageId)).toMatchObject({ receiptStatus: "delivered_to_context", deliveredToContext: true });
      expect(await value.supervisor.storage.getMailboxMessage?.(second.mailboxMessageId)).toMatchObject({ receiptStatus: "delivered_to_context", deliveredToContext: true });
      const activeRunContext = JSON.stringify(provider.contexts[1]);
      const firstQueueContext = JSON.stringify(provider.contexts[2]);
      const secondQueueContext = JSON.stringify(provider.contexts[3]);
      expect(activeRunContext).not.toContain("first queued work");
      expect(activeRunContext).not.toContain("second queued work");
      expect(firstQueueContext).toContain("first queued work");
      expect(firstQueueContext).not.toContain("second queued work");
      expect(secondQueueContext).toContain("second queued work");
      const state = projectEvents(await value.supervisor.storage.loadEvents(handle.sessionId, { branchId: handle.branchId }));
      expect(Object.values(state.agentRuns)).toHaveLength(3);
      expect(state.messages.filter(message => message.mailbox?.mailboxMessageId === first.mailboxMessageId)).toHaveLength(1);
      expect(state.messages.filter(message => message.mailbox?.mailboxMessageId === second.mailboxMessageId)).toHaveLength(1);
      expect(state.mailbox[first.mailboxMessageId]?.contextRunId).not.toBe(state.mailbox[second.mailboxMessageId]?.contextRunId);
    } finally { provider.release(); await value.supervisor.close(); }
  });

  test("durably accepted queue send survives an ordinary-run admission race", async () => {
    const value = await fixture([
      action({ type: "final", content: "ordinary result" }),
      action({ type: "final", content: "queued race result" }),
    ]);
    const child = await value.supervisor.agents.spawn(
      value.root.sessionId,
      value.root.branchId,
      { task: "race target", name: "race-target" },
    );
    const originalAdmitMethod = value.supervisor.runs.admit;
    const originalAdmit = originalAdmitMethod.bind(value.supervisor.runs);
    let releaseQueuedAdmit!: () => void;
    const queuedAdmitGate = new Promise<void>((resolve) => { releaseQueuedAdmit = resolve; });
    let markQueuedAdmitReached!: () => void;
    const queuedAdmitReached = new Promise<void>((resolve) => { markQueuedAdmitReached = resolve; });
    (value.supervisor.runs as any).admit = async (
      sessionId: string,
      branchId: string,
      input: any,
    ) => {
      if (input?.requestKey?.startsWith("agent-queue:")) {
        markQueuedAdmitReached();
        await queuedAdmitGate;
      }
      return originalAdmit(sessionId, branchId, input);
    };
    try {
      const sending = value.supervisor.agents.sendMessage(
        value.root.sessionId,
        value.root.branchId,
        {
          target: child.sessionId,
          content: "queued work accepted before the race",
          intentKey: "ordinary-queue-race",
        },
      );
      await queuedAdmitReached;
      const ordinary = await originalAdmit(child.sessionId, child.branchId, {
        task: "ordinary work wins admission",
        requestKey: "ordinary-run-queue-race",
        requestedRunId: "ordinary-run-queue-race",
      });
      releaseQueuedAdmit();

      const receipt = await sending;
      expect(receipt).toMatchObject({
        delivered: true,
        receiptStatus: "queued",
        queued: true,
        mode: "queue",
      });
      expect(Object.values(projectEvents(
        await value.supervisor.storage.loadEvents(child.sessionId, {
          branchId: child.branchId,
        }),
      ).agentRuns)).toHaveLength(1);

      await value.supervisor.runs.advance(
        child.sessionId,
        child.branchId,
        ordinary.runId,
      );
      const reply = await waitFor(async () =>
        (await value.supervisor.storage.listMailboxMessages?.(
          value.root.sessionId,
          "inbound",
        ))?.find(message => message.replyToMessageId === receipt.mailboxMessageId)
      );
      expect(reply.content).toBe("queued race result");
      const finalState = projectEvents(await value.supervisor.storage.loadEvents(
        child.sessionId,
        { branchId: child.branchId },
      ));
      expect(Object.values(finalState.agentRuns)).toHaveLength(2);
      expect(finalState.mailbox[receipt.mailboxMessageId]).toMatchObject({
        deliveredToContext: true,
        receiptStatus: "delivered_to_context",
      });
    } finally {
      releaseQueuedAdmit();
      (value.supervisor.runs as any).admit = originalAdmitMethod;
      await value.supervisor.close();
    }
  });

  test("concurrent senders cannot exceed one target pending slot", async () => {
    const value = await fixture();
    const firstSender = await value.supervisor.agents.spawn(
      value.root.sessionId,
      value.root.branchId,
      { task: "first sender", name: "first-sender" },
    );
    const secondSender = await value.supervisor.agents.spawn(
      value.root.sessionId,
      value.root.branchId,
      { task: "second sender", name: "second-sender" },
    );
    const ordinary = await value.supervisor.runs.admit(
      value.root.sessionId,
      value.root.branchId,
      {
        task: "keep the target busy",
        requestKey: "pending-limit-target-run",
        requestedRunId: "pending-limit-target-run",
      },
    );
    expect(ordinary.status).toBe("queued");
    (value.supervisor.agents as any).maxPendingMessages = 1;

    const originalListMethod = value.supervisor.storage.listMailboxMessages!;
    const originalList = originalListMethod.bind(value.supervisor.storage);
    let releaseSnapshots!: () => void;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshots = resolve; });
    let markFirstSnapshot!: () => void;
    let markSecondSnapshot!: () => void;
    const firstSnapshot = new Promise<void>((resolve) => { markFirstSnapshot = resolve; });
    const secondSnapshot = new Promise<void>((resolve) => { markSecondSnapshot = resolve; });
    let targetSnapshotCalls = 0;
    (value.supervisor.storage as any).listMailboxMessages = async (
      sessionId: string,
      direction: "inbound" | "outbound" | "all",
    ) => {
      const snapshot = await originalList(sessionId, direction);
      if (sessionId === value.root.sessionId && direction === "inbound") {
        targetSnapshotCalls++;
        if (targetSnapshotCalls === 1) markFirstSnapshot();
        if (targetSnapshotCalls === 2) markSecondSnapshot();
        await snapshotGate;
      }
      return snapshot;
    };
    try {
      const first = value.supervisor.agents.sendMessage(
        firstSender.sessionId,
        firstSender.branchId,
        { target: "parent", content: "first pending message", intentKey: "pending-slot-first" },
      );
      await firstSnapshot;
      const second = value.supervisor.agents.sendMessage(
        secondSender.sessionId,
        secondSender.branchId,
        { target: "parent", content: "second pending message", intentKey: "pending-slot-second" },
      );
      await Promise.race([secondSnapshot, Bun.sleep(100)]);
      releaseSnapshots();

      const results = await Promise.allSettled([first, second]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result =>
        result.status === "rejected" &&
        result.reason instanceof Error &&
        /pending queue limit/i.test(result.reason.message)
      )).toHaveLength(1);
      const pending = (await originalList(
        value.root.sessionId,
        "inbound",
      )).filter(message =>
        message.toBranchId === value.root.branchId &&
        message.receiptStatus === "queued"
      );
      expect(pending).toHaveLength(1);
    } finally {
      releaseSnapshots();
      (value.supervisor.storage as any).listMailboxMessages = originalListMethod;
      await value.supervisor.close();
    }
  });

  test("UTF-8 byte, rate, pending, and pagination bounds reject deterministically", async () => {
    const value = await fixture();
    try {
      const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "bounds", name: "bounds" });
      const exact = "😀".repeat(8_192);
      expect((await value.supervisor.agents.sendMessage(child.sessionId, child.branchId, { target: "parent", content: exact, mode: "steer", intentKey: "exact-utf8" })).receiptStatus).toBe("delivered_to_context");
      await expect(value.supervisor.agents.sendMessage(child.sessionId, child.branchId, { target: "parent", content: `${exact}x`, intentKey: "too-large" })).rejects.toThrow(/32768 UTF-8 bytes/i);
      (value.supervisor.agents as any).maxMessagesPerMinute = 2;
      await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: child.sessionId, content: "rate one", mode: "steer", intentKey: "rate-1" });
      await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: child.sessionId, content: "rate two", mode: "steer", intentKey: "rate-2" });
      await expect(value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: child.sessionId, content: "rate three", mode: "steer", intentKey: "rate-3" })).rejects.toThrow(/rate limit/i);
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
      const receipt = await value.supervisor.agents.sendMessage(value.root.sessionId, value.root.branchId, { target: "consumer", content: "use the evidence", taskId: child.taskId, artifactIds: [artifact.artifactId], mode: "steer", intentKey: "artifact-link" });
      expect(receipt.receiptStatus).toBe("delivered_to_context");
      const childState = projectEvents(await value.supervisor.storage.loadEvents(child.sessionId, { branchId: child.branchId }));
      expect(childState.artifacts[artifact.artifactId]).toBeDefined();
      expect(childState.messages.find(message => message.mailbox?.mailboxMessageId === receipt.mailboxMessageId)?.mailbox).toMatchObject({ relationship: "parent", taskId: child.taskId, artifactIds: [artifact.artifactId] });
      const resolved = await value.supervisor.executeCell(child.sessionId, child.branchId, `
        const range = await artifacts.readRange("${artifact.artifactId}", 0, 22);
        return new TextDecoder().decode(range.value.bytes);
      `, [], "fresh-worker-artifact-read");
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
      const spoof = await value.supervisor.executeCell(left.sessionId, left.branchId, `return sdk.agents.send({ target: "right", content: "derived sender", mode: "steer", fromSessionId: "${value.root.sessionId}", fromBranchId: "${value.root.branchId}" });`);
      expect(spoof.result).toMatchObject({ fromSessionId: left.sessionId, toSessionId: right.sessionId });
      expect((await value.supervisor.agents.sendMessage(right.sessionId, right.branchId, { target: left.sessionId, content: "by id", mode: "steer", intentKey: "sibling-id" })).toSessionId).toBe(left.sessionId);
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

  test("stranded queue recovery survives an ordinary-run admission race", async () => {
    const value = await fixture([
      action({ type: "final", content: "ordinary recovery result" }),
      action({ type: "final", content: "recovered queued result" }),
    ]);
    const child = await value.supervisor.agents.spawn(
      value.root.sessionId,
      value.root.branchId,
      { task: "stranded recovery target", name: "stranded-recovery" },
    );
    const mailboxMessageId = "mailbox-stranded-recovery-race";
    const sentEventId = "mailbox-stranded-recovery-race-sent";
    const queueRunId = "stranded-recovery-queue-run";
    const common = {
      mailboxMessageId,
      fromSessionId: value.root.sessionId,
      fromBranchId: value.root.branchId,
      toSessionId: child.sessionId,
      toBranchId: child.branchId,
      kind: "message" as const,
      content: "recover this stranded queued work",
      taskId: child.taskId,
      intentKey: "stranded-recovery-race",
      mode: "queue" as const,
    };
    await value.supervisor.storage.appendEvents([{
      id: sentEventId,
      sessionId: value.root.sessionId,
      branchId: value.root.branchId,
      type: "MailboxMessageSent",
      producer: "client",
      idempotencyKey: "mailbox-stranded-recovery-race-sent",
      payload: common,
    }, {
      sessionId: child.sessionId,
      branchId: child.branchId,
      type: "MailboxMessageDelivered",
      producer: "supervisor",
      idempotencyKey: "mailbox-stranded-recovery-race-delivered",
      payload: { ...common, sentEventId, senderRelationship: "parent" },
    }, {
      id: "mailbox-stranded-recovery-race-context-message",
      sessionId: child.sessionId,
      branchId: child.branchId,
      type: "MessageAppended",
      producer: "supervisor",
      idempotencyKey: "mailbox-stranded-recovery-race-context-message",
      payload: {
        messageId: "family-mailbox-stranded-recovery-race",
        role: "user",
        content: common.content,
        mailbox: {
          mailboxMessageId,
          fromSessionId: value.root.sessionId,
          relationship: "parent",
          taskId: child.taskId,
          receiptEventId: "mailbox-stranded-recovery-race-context-target",
        },
      },
    }, {
      id: "mailbox-stranded-recovery-race-context-target",
      sessionId: child.sessionId,
      branchId: child.branchId,
      type: "MailboxMessageContextDelivered",
      producer: "supervisor",
      idempotencyKey: "mailbox-stranded-recovery-race-context-target",
      payload: {
        mailboxMessageId,
        messageEventId: "mailbox-stranded-recovery-race-context-message",
        deliveredAt: new Date().toISOString(),
        relationship: "parent",
        runId: queueRunId,
      },
    }, {
      sessionId: value.root.sessionId,
      branchId: value.root.branchId,
      type: "MailboxMessageContextDelivered",
      producer: "supervisor",
      idempotencyKey: "mailbox-stranded-recovery-race-context-sender",
      payload: {
        mailboxMessageId,
        messageEventId: "mailbox-stranded-recovery-race-context-message",
        deliveredAt: new Date().toISOString(),
        relationship: "parent",
        runId: queueRunId,
      },
    }]);

    const originalAdmitMethod = value.supervisor.runs.admit;
    const originalAdmit = originalAdmitMethod.bind(value.supervisor.runs);
    let releaseQueueAdmission!: () => void;
    const queueAdmissionGate = new Promise<void>((resolve) => {
      releaseQueueAdmission = resolve;
    });
    let markQueueAdmissionReached!: () => void;
    const queueAdmissionReached = new Promise<void>((resolve) => {
      markQueueAdmissionReached = resolve;
    });
    (value.supervisor.runs as any).admit = async (
      sessionId: string,
      branchId: string,
      input: any,
    ) => {
      if (input?.requestedRunId === queueRunId) {
        markQueueAdmissionReached();
        await queueAdmissionGate;
      }
      return originalAdmit(sessionId, branchId, input);
    };
    try {
      const recovering = value.supervisor.agents.recoverDeliveries();
      await queueAdmissionReached;
      const ordinary = await originalAdmit(child.sessionId, child.branchId, {
        task: "ordinary run wins stranded recovery admission",
        requestKey: "ordinary-stranded-recovery-race",
        requestedRunId: "ordinary-stranded-recovery-race",
      });
      releaseQueueAdmission();

      expect(await recovering).toBe(1);
      const racedState = projectEvents(await value.supervisor.storage.loadEvents(
        child.sessionId,
        { branchId: child.branchId },
      ));
      expect(Object.keys(racedState.agentRuns)).toEqual([ordinary.runId]);
      expect(racedState.mailbox[mailboxMessageId]).toMatchObject({
        receiptStatus: "delivered_to_context",
        deliveredToContext: true,
        contextRunId: queueRunId,
      });

      await value.supervisor.runs.advance(
        child.sessionId,
        child.branchId,
        ordinary.runId,
      );
      const reply = await waitFor(async () =>
        (await value.supervisor.storage.listMailboxMessages?.(
          value.root.sessionId,
          "inbound",
        ))?.find(message => message.replyToMessageId === mailboxMessageId)
      );
      expect(reply.content).toBe("recovered queued result");

      const events = await value.supervisor.storage.loadEvents(
        child.sessionId,
        { branchId: child.branchId },
      );
      expect(events.filter(event =>
        event.type === "AgentRunRequested" &&
        (event.payload as any).runId === queueRunId
      )).toHaveLength(1);
      const finalState = projectEvents(events);
      expect(Object.values(finalState.agentRuns)).toHaveLength(2);
      expect(finalState.agentRuns[queueRunId]).toMatchObject({
        id: queueRunId,
        requestKey: `agent-queue:${mailboxMessageId}`,
        status: "succeeded",
      });
    } finally {
      releaseQueueAdmission();
      (value.supervisor.runs as any).admit = originalAdmitMethod;
      await value.supervisor.close();
    }
  });

  test("an unknown queued run recovers without replay and returns a typed unknown reply", async () => {
    const value = await fixture(); let resumed: Supervisor | undefined;
    const child = await value.supervisor.agents.spawn(value.root.sessionId, value.root.branchId, { task: "unknown child", name: "unknown" });
    const mailboxMessageId = "mailbox-unknown-queue"; const sentEventId = "mailbox-unknown-sent"; const runId = "family-unknown-run";
    const common = { mailboxMessageId, fromSessionId: value.root.sessionId, fromBranchId: value.root.branchId, toSessionId: child.sessionId, toBranchId: child.branchId, kind: "message" as const, content: "ambiguous work", taskId: child.taskId, intentKey: "unknown-queue", followUp: true };
    await value.supervisor.storage.appendEvents([{
      id: sentEventId, sessionId: value.root.sessionId, branchId: value.root.branchId, type: "MailboxMessageSent", producer: "client", idempotencyKey: "mailbox-unknown-sent", payload: common,
    }, {
      sessionId: child.sessionId, branchId: child.branchId, type: "MailboxMessageDelivered", producer: "supervisor", idempotencyKey: "mailbox-unknown-delivered", payload: { ...common, sentEventId, senderRelationship: "parent" },
    }]);
    await value.supervisor.storage.appendEvents([{
      id: "mailbox-unknown-context-message",
      sessionId: child.sessionId,
      branchId: child.branchId,
      type: "MessageAppended",
      producer: "supervisor",
      idempotencyKey: "mailbox-unknown-context-message",
      payload: {
        messageId: "family-mailbox-unknown-queue",
        role: "user",
        content: "ambiguous work",
        mailbox: { mailboxMessageId, fromSessionId: value.root.sessionId, relationship: "parent", taskId: child.taskId, receiptEventId: "mailbox-unknown-context-target" },
      },
    }, {
      id: "mailbox-unknown-context-target",
      sessionId: child.sessionId,
      branchId: child.branchId,
      type: "MailboxMessageContextDelivered",
      producer: "supervisor",
      idempotencyKey: "mailbox-unknown-context-target",
      payload: { mailboxMessageId, messageEventId: "mailbox-unknown-context-message", deliveredAt: new Date().toISOString(), relationship: "parent", runId },
    }, {
      sessionId: value.root.sessionId,
      branchId: value.root.branchId,
      type: "MailboxMessageContextDelivered",
      producer: "supervisor",
      idempotencyKey: "mailbox-unknown-context-sender",
      payload: { mailboxMessageId, messageEventId: "mailbox-unknown-context-message", deliveredAt: new Date().toISOString(), relationship: "parent", runId },
    }]);
    await value.supervisor.storage.appendEvents([{
      sessionId: child.sessionId, branchId: child.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "ambiguous work", requestKey: "family-unknown-request", profilePin: agentProfilePin(await value.supervisor.agentProfiles.active(child.sessionId)) },
    }]);
    const effectId = await value.supervisor.outbox.request({ sessionId: child.sessionId, branchId: child.branchId, executor: "shell", operation: "run", input: { command: "printf ambiguous" }, origin: { kind: "runtime", requestId: "family-ambiguous-effect" }, idempotencyKey: "family-ambiguous-effect", idempotent: false });
    expect(await value.supervisor.storage.claimEffect(effectId, "dead-family-owner")).not.toBeNull();
    await value.supervisor.close();
    try {
      resumed = await Supervisor.open({ databaseUrl: value.temp.databaseUrl, artifactDirectory: value.temp.artifactDirectory, workspaceRoot: value.temp.workspaceRoot, recover: true, restartConsoleAfterCell: true });
      expect(await resumed.runs.get(child.sessionId, child.branchId, runId)).toMatchObject({ status: "unknown" });
      const reply = await waitFor(async () => (await resumed!.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.find(message => message.replyToMessageId === mailboxMessageId));
      expect(reply?.content).toMatch(/^Queued message unknown:/);
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
      const recoveredTask = (await resumed.agents.listTasks(value.root.sessionId))
        .find(task => task.taskId === handle.taskId);
      expect(recoveredTask).toMatchObject({
        status: "completed",
        result: {
          protocol: "agencity.agent-run-result-reference",
          kind: "text",
        },
      });
      const replies = (await resumed.storage.listMailboxMessages?.(value.root.sessionId, "inbound"))?.filter(message => message.taskId === handle.taskId && message.content === "terminal before crash");
      expect(replies).toHaveLength(1);
      const parentEvents = await resumed.storage.loadEvents(value.root.sessionId, {
        branchId: value.root.branchId,
      });
      expect(parentEvents.filter(event =>
        event.type === "TaskTerminalNoticeDelivered" &&
        (event.payload as any).taskId === handle.taskId
      )).toHaveLength(1);
    } finally { if (resumed) await resumed.close(); else await value.supervisor.close(); }
  });

  test("recovery completes a retained terminal prefix missing usage without duplicate notices", async () => {
    const value = await fixture([
      action({ type: "final", content: "terminal prefix result" }),
    ]);
    let resumed: Supervisor | undefined;
    try {
      (value.supervisor.agents as any).onRunTerminal = async () => {};
      const handle = await value.supervisor.agents.spawnRunnable(
        value.root.sessionId,
        value.root.branchId,
        {
          task: "recover terminal prefix",
          idempotencyKey: "recover-terminal-prefix",
        },
      );
      const result = await waitFor(async () => {
        const current = await value.supervisor.agents.result(
          value.root.sessionId,
          value.root.branchId,
          handle.taskId,
          { wait: false },
        );
        return current.status === "succeeded" ? current : undefined;
      });
      expect(result.resultReference).toBeDefined();
      const noticeId = `notice-${handle.taskId}`;
      const sentEventId = `terminal-sent-${handle.taskId}`;
      const terminal = {
        noticeId,
        taskId: handle.taskId,
        parentSessionId: value.root.sessionId,
        childSessionId: handle.sessionId,
        status: "completed" as const,
        result: result.resultReference!,
      };
      await value.supervisor.storage.appendEvents([{
        id: sentEventId,
        sessionId: handle.sessionId,
        branchId: handle.branchId,
        type: "TaskTerminalNoticeSent",
        producer: "supervisor",
        idempotencyKey: `task-terminal-sent:${handle.taskId}`,
        payload: terminal,
      }, {
        sessionId: value.root.sessionId,
        branchId: value.root.branchId,
        type: "TaskStatusChanged",
        producer: "supervisor",
        idempotencyKey: `task-terminal-status:${handle.taskId}`,
        payload: {
          taskId: handle.taskId,
          status: "completed",
          result: result.resultReference!,
        } as any,
      }, {
        sessionId: value.root.sessionId,
        branchId: value.root.branchId,
        type: "TaskTerminalNoticeDelivered",
        producer: "supervisor",
        idempotencyKey: `task-terminal-delivered:${handle.taskId}`,
        payload: { ...terminal, sentEventId },
      }, {
        sessionId: handle.sessionId,
        branchId: handle.branchId,
        type: "SessionStatusChanged",
        producer: "supervisor",
        idempotencyKey: `task-terminal-session:${handle.taskId}`,
        payload: { status: "stopped", reason: "Task completed" },
      }]);
      expect((await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      )).find(task => task.taskId === handle.taskId)?.status).toBe("completed");
      await value.supervisor.close();

      resumed = await Supervisor.open({
        databaseUrl: value.temp.databaseUrl,
        artifactDirectory: value.temp.artifactDirectory,
        workspaceRoot: value.temp.workspaceRoot,
        recover: true,
      });
      const parentEvents = await resumed.storage.loadEvents(
        value.root.sessionId,
        { branchId: value.root.branchId },
      );
      const childEvents = await resumed.storage.loadEvents(handle.sessionId, {
        branchId: handle.branchId,
      });
      expect(parentEvents.filter(event =>
        event.type === "TaskStatusChanged" &&
        (event.payload as any).taskId === handle.taskId
      )).toHaveLength(1);
      expect(parentEvents.filter(event =>
        event.type === "TaskTerminalNoticeDelivered" &&
        (event.payload as any).taskId === handle.taskId
      )).toHaveLength(1);
      expect(parentEvents.filter(event =>
        event.type === "TaskUsageAttributed" &&
        (event.payload as any).taskId === handle.taskId
      )).toHaveLength(1);
      const usage = parentEvents.find(event =>
        event.type === "TaskUsageAttributed" &&
        (event.payload as any).taskId === handle.taskId
      )!;
      expect(() => projectEvents([...parentEvents, {
        ...usage,
        id: "sync-injected-duplicate-task-usage",
        idempotencyKey: "sync-injected-duplicate-task-usage",
      }])).toThrow(/taskUsageAttribution/i);
      expect(childEvents.filter(event =>
        event.type === "TaskTerminalNoticeSent" &&
        (event.payload as any).taskId === handle.taskId
      )).toHaveLength(1);
      await resumed.agents.recoverDeliveries();
      const after = await resumed.storage.loadEvents(value.root.sessionId, {
        branchId: value.root.branchId,
      });
      expect(after.filter(event =>
        event.type === "TaskTerminalNoticeDelivered" &&
        (event.payload as any).taskId === handle.taskId
      )).toHaveLength(1);
      expect(after.filter(event =>
        event.type === "TaskUsageAttributed" &&
        (event.payload as any).taskId === handle.taskId
      )).toHaveLength(1);
    } finally {
      if (resumed) await resumed.close();
      else await value.supervisor.close();
    }
  });

  test("delivery recovery preserves terminal usage after later child runs", async () => {
    const value = await fixture([
      action({ type: "final", content: "initial child result" }),
      action({ type: "final", content: "later child result" }),
    ]);
    try {
      const handle = await value.supervisor.agents.spawnRunnable(
        value.root.sessionId,
        value.root.branchId,
        {
          task: "complete before later child work",
          idempotencyKey: "terminal-usage-before-later-work",
        },
      );
      await waitFor(async () => {
        const task = (await value.supervisor.agents.listTasks(
          value.root.sessionId,
          value.root.branchId,
        )).find(candidate => candidate.taskId === handle.taskId);
        return task?.status === "completed" ? task : undefined;
      });
      const before = (await value.supervisor.storage.loadEvents(
        value.root.sessionId,
        { branchId: value.root.branchId },
      )).find(event =>
        event.type === "TaskUsageAttributed" &&
        (event.payload as any).taskId === handle.taskId
      );
      expect(before).toBeDefined();

      const later = await value.supervisor.runs.start(
        handle.sessionId,
        handle.branchId,
        { task: "perform later unrelated child work", goalMode: "none" },
      );
      expect(later.status).toBe("succeeded");
      const currentBranches =
        await value.supervisor.projections.currentBranches();
      const storage = value.supervisor.storage as typeof value.supervisor.storage & {
        loadEvents: typeof value.supervisor.storage.loadEvents;
      };
      const originalLoadEvents = storage.loadEvents.bind(storage);
      let historyLoads = 0;
      storage.loadEvents = async (...args) => {
        historyLoads++;
        return originalLoadEvents(...args);
      };
      try {
        await value.supervisor.agents.recoverDeliveries(currentBranches);
      } finally {
        storage.loadEvents = originalLoadEvents;
      }
      expect(historyLoads).toBe(0);

      const after = (await value.supervisor.storage.loadEvents(
        value.root.sessionId,
        { branchId: value.root.branchId },
      )).filter(event =>
        event.type === "TaskUsageAttributed" &&
        (event.payload as any).taskId === handle.taskId
      );
      expect(after).toHaveLength(1);
      expect(after[0]!.payload).toEqual(before!.payload);
    } finally {
      await value.supervisor.close();
    }
  });

});
