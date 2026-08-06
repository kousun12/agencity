import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  AgentClient,
  ProtocolServer,
  ScriptedAgentActionProvider,
  Supervisor,
  newId,
  projectEvents,
  stableEffectId,
  type AgentAction,
  type JsonValue,
  type ModelConfiguration,
  type ModelProvider,
  type ModelResponse,
} from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

const action = <T extends Omit<AgentAction, "protocol" | "version">>(value: T): AgentAction => ({
  protocol: AGENT_ACTION_PROTOCOL,
  version: AGENT_ACTION_VERSION,
  ...value,
} as unknown as AgentAction);

class RecordingActions extends ScriptedAgentActionProvider {
  readonly contexts: JsonValue[] = [];
  calls = 0;
  override async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    this.contexts.push(context);
    this.calls++;
    return super.complete(context, configuration, signal);
  }
}

class SlowActions extends ScriptedAgentActionProvider {
  readonly delayMs: number;
  calls = 0;
  constructor(script: readonly (AgentAction | string)[], delayMs = 20) {
    super(script, "slow-actions");
    this.delayMs = delayMs;
  }
  override async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    this.calls++;
    await Bun.sleep(this.delayMs);
    return super.complete(context, configuration, signal);
  }
}

class HoldingActions implements ModelProvider {
  readonly name = "holding-actions";
  readonly displayName = "holding-actions (cancellation fixture)";
  calls = 0;
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  constructor() { this.entered = new Promise(resolve => { this.#markEntered = resolve; }); }
  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    this.calls++;
    this.#markEntered();
    return new Promise<ModelResponse>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

async function fixture(script: readonly (AgentAction | string)[], budget: Record<string, number> = {}) {
  const temp = await makeTempRuntime("agencity-agent-run-"); temps.push(temp);
  const provider = new RecordingActions(script, "run-fixture");
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot, restartConsoleAfterCell: true,
    modelProviders: [provider], recover: false,
  });
  const session = await supervisor.createSession({
    workspaceId: "agent-run", model: { provider: provider.name, model: "scripted-v1" }, budget,
  });
  return { temp, provider, supervisor, ...session };
}

function providerObservations(context: JsonValue): Array<{ eventId: string; type: string; payload: JsonValue }> {
  if (!context || typeof context !== "object" || Array.isArray(context) ||
      !context.run || typeof context.run !== "object" || Array.isArray(context.run) ||
      !Array.isArray(context.run.observations)) return [];
  return context.run.observations as Array<{ eventId: string; type: string; payload: JsonValue }>;
}

function crashAfterNextActionCommit(supervisor: Supervisor): () => void {
  const appendEvents = supervisor.storage.appendEvents.bind(supervisor.storage);
  let crashed = false;
  Object.defineProperty(supervisor.storage, "appendEvents", {
    configurable: true,
    value: async (events: Parameters<typeof appendEvents>[0]) => {
      const appended = await appendEvents(events);
      if (!crashed && events.some(event => event.type === "AgentRunActionCommitted")) {
        crashed = true;
        throw new Error("simulated crash after AgentRunActionCommitted");
      }
      return appended;
    },
  });
  return () => Object.defineProperty(supervisor.storage, "appendEvents", { configurable: true, value: appendEvents });
}

describe("autonomous durable agent runs", () => {
  test("executes typed TypeScript actions and delivers every cell observation once to the dependent context", async () => {
    const value = await fixture([
      action({ type: "typescript", code: `
        const write = await tools.writeFile("answer.txt", "durable-agent-run");
        const gate = await tools.shell("test -f answer.txt && cat answer.txt");
        await state.set("verified", { exitCode: gate.exitCode, sha256: write.sha256 });
        console.log("verified", gate.stdout);
        return { gate, write, workerPid: process.pid };
      ` }),
      action({ type: "final", content: "Created answer.txt and verified its contents." }),
    ]);
    try {
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Create answer.txt and verify it.", requestKey: "typed-run",
      });
      expect(result).toMatchObject({ status: "succeeded", steps: 2, final: "Created answer.txt and verified its contents." });
      expect(await Bun.file(`${value.temp.workspaceRoot}/answer.txt`).text()).toBe("durable-agent-run");
      expect(value.provider.calls).toBe(2);

      const observations = value.provider.contexts.flatMap(providerObservations);
      const cells = observations.filter(item => item.type === "CellCommitted");
      expect(cells).toHaveLength(1);
      expect(cells[0]!.payload).toMatchObject({ logs: ["verified durable-agent-run"], exports: ["verified"] });
      expect(observations.filter(item => item.eventId === cells[0]!.eventId)).toHaveLength(1);
      expect(providerObservations(value.provider.contexts[0]!)).toEqual([]);
      expect(providerObservations(value.provider.contexts[1]!).some(item => item.type === "EffectOutcomeRecorded")).toBe(true);

      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(Object.values(state.cells)).toHaveLength(1);
      expect(Object.values(state.cells)[0]).toMatchObject({ status: "committed" });
      expect(state.workingValues.verified?.version).toBe(1);
      expect(state.agentRuns[result.runId]?.steps[1]?.observationEventIds).toContain(cells[0]!.eventId);
      expect(state.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: "Create answer.txt and verify it." },
        { role: "assistant", content: "Created answer.txt and verified its contents." },
      ]);
      expect(Object.values(state.modelCalls).every(call => call.responseMessageId === undefined)).toBe(true);
      const history = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      const contexts = history.filter(event => event.type === "ContextMaterialized");
      expect((contexts[1]!.payload as any).records.some((record: any) => record.eventId === cells[0]!.eventId)).toBe(true);
      const rawActions = history.filter(event => event.type === "AgentRunActionCommitted").map(event => (event.payload as any).raw);
      expect(rawActions).toHaveLength(2);
      expect(rawActions.every(raw => typeof raw === "string" && raw.includes('"protocol":"agencity.agent-action"'))).toBe(true);
      expect(state.messages.some(message => rawActions.includes(message.content))).toBe(false);
    } finally { await value.supervisor.close(); }
  });

  test("strictly rejects malformed actions without executing their code-like text", async () => {
    const value = await fixture(["```json\n{\"type\":\"typescript\",\"code\":\"await tools.writeFile('owned','bad')\"}\n```"]);
    try {
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, "Do not execute malformed output");
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("Rejected model action");
      expect(await Bun.file(`${value.temp.workspaceRoot}/owned`).exists()).toBe(false);
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(Object.values(state.cells)).toEqual([]);
      expect(state.agentRuns[result.runId]?.steps[0]?.rejection).toContain("exactly one JSON object");
    } finally { await value.supervisor.close(); }
  });

  test("deduplicates stable run requests and rejects changed intent", async () => {
    const value = await fixture([action({ type: "final", content: "Exactly once." })]);
    try {
      const first = await value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Stable task", requestKey: "stable-run-request",
      });
      const retried = await value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Stable task", requestKey: "stable-run-request",
      });
      expect(retried).toEqual(first);
      expect(value.provider.calls).toBe(1);
      await expect(value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Changed task", requestKey: "stable-run-request",
      })).rejects.toThrow("different durable meaning");
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(Object.values(state.agentRuns)).toHaveLength(1);
      expect(state.messages.map(message => message.content)).toEqual(["Stable task", "Exactly once."]);
    } finally { await value.supervisor.close(); }
  });

  test("pauses for clarification and permission, then continues from exact durable responses", async () => {
    const value = await fixture([
      action({ type: "clarification", question: "Which filename should I create?" }),
      action({ type: "permission", permission: "write workspace file", question: "May I create chosen.txt?" }),
      action({ type: "typescript", code: `return await tools.writeFile("chosen.txt", "approved");` }),
      action({ type: "final", content: "Created chosen.txt after approval." }),
    ]);
    try {
      const waiting = await value.supervisor.runs.start(value.sessionId, value.branchId, "Create the requested file");
      expect(waiting).toMatchObject({ status: "waiting_for_user", pendingInput: { kind: "clarification" } });
      const permission = await value.supervisor.runs.respond(value.sessionId, value.branchId, waiting.runId, waiting.pendingInput!.id, "chosen.txt");
      expect(permission).toMatchObject({ status: "waiting_for_user", pendingInput: { kind: "permission" } });
      await expect(value.supervisor.runs.respond(value.sessionId, value.branchId, waiting.runId, permission.pendingInput!.id, { response: "yes" }))
        .rejects.toThrow("approved=true or approved=false");
      const completed = await value.supervisor.runs.respond(value.sessionId, value.branchId, waiting.runId, permission.pendingInput!.id, { response: "yes", approved: true });
      expect(completed).toMatchObject({ status: "succeeded", steps: 4 });
      expect(await value.supervisor.runs.respond(value.sessionId, value.branchId, waiting.runId, permission.pendingInput!.id, { response: "yes", approved: true })).toEqual(completed);
      await expect(value.supervisor.runs.respond(value.sessionId, value.branchId, waiting.runId, permission.pendingInput!.id, { response: "no", approved: false }))
        .rejects.toThrow("already answered differently");
      expect(value.provider.calls).toBe(4);
      expect(await Bun.file(`${value.temp.workspaceRoot}/chosen.txt`).text()).toBe("approved");
      const received = value.provider.contexts.flatMap(providerObservations).filter(item => item.type === "AgentRunUserInputReceived");
      expect(received).toHaveLength(2);
      expect(new Set(received.map(item => item.eventId)).size).toBe(2);
      expect(received.map(item => item.payload)).toEqual([
        expect.objectContaining({ response: "chosen.txt" }),
        expect.objectContaining({ response: "yes", approved: true }),
      ]);
    } finally { await value.supervisor.close(); }
  });

  test("stops new effect admission at the durable turn-budget boundary but accepts an already-generated final", async () => {
    const blocked = await fixture([
      action({ type: "typescript", code: `return await tools.writeFile("over-budget", "bad");` }),
    ], { turnLimit: 1 });
    try {
      const result = await blocked.supervisor.runs.start(blocked.sessionId, blocked.branchId, "Respect budget");
      expect(result.status).toBe("budget_exceeded");
      expect(await Bun.file(`${blocked.temp.workspaceRoot}/over-budget`).exists()).toBe(false);
      expect(blocked.provider.calls).toBe(1);
    } finally { await blocked.supervisor.close(); }

    const final = await fixture([action({ type: "final", content: "No execution needed." })], { turnLimit: 1 });
    try {
      expect(await final.supervisor.runs.start(final.sessionId, final.branchId, "Answer only"))
        .toMatchObject({ status: "succeeded", final: "No execution needed." });
    } finally { await final.supervisor.close(); }
  });

  test("accounts durable model wall time and blocks an effectful action at that exact budget boundary", async () => {
    const temp = await makeTempRuntime("agencity-agent-wall-budget-"); temps.push(temp);
    const provider = new SlowActions([
      action({ type: "typescript", code: `return await tools.writeFile("wall-over-budget", "bad");` }),
    ]);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "wall-budget", model: { provider: provider.name, model: "v1" },
      budget: { wallTimeLimitMs: 1 },
    });
    try {
      const result = await supervisor.runs.start(session.sessionId, session.branchId, "Respect wall time");
      expect(result.status).toBe("budget_exceeded");
      expect(provider.calls).toBe(1);
      expect(await Bun.file(`${temp.workspaceRoot}/wall-over-budget`).exists()).toBe(false);
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(state.budget.wallTimeMs).toBeGreaterThanOrEqual(1);
      expect(state.budget.exceeded).toBe(true);
    } finally { await supervisor.close(); }
  });

  test("commits cancellation intent, aborts the in-flight run call, and leaves unrelated effects alone", async () => {
    const temp = await makeTempRuntime("agencity-agent-cancel-"); temps.push(temp);
    const provider = new HoldingActions();
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "cancel", model: { provider: provider.name, model: "v1" },
    });
    const unrelatedId = await supervisor.outbox.request({
      sessionId: session.sessionId, branchId: session.branchId,
      executor: "shell", operation: "run", input: { command: "printf unrelated" },
      idempotencyKey: "unrelated-before-run", idempotent: true,
    });
    try {
      const started = supervisor.runs.start(session.sessionId, session.branchId, {
        task: "Wait until cancelled", requestKey: "cancel-run",
      });
      await provider.entered;
      const cancelled = await supervisor.runs.cancel(session.sessionId, session.branchId, (await (async () => {
        while (true) {
          const snapshot = await supervisor.projections.getSnapshot(session.sessionId, session.branchId);
          const active = Object.values(snapshot.state.agentRuns)[0];
          if (active) return active.id;
          await Bun.sleep(1);
        }
      })()), "stop now");
      expect(cancelled).toMatchObject({ status: "cancelled", reason: "stop now" });
      expect(await started).toMatchObject({ status: "cancelled", reason: "stop now" });
      expect(provider.calls).toBe(1);
      expect(await supervisor.outbox.run(unrelatedId)).toMatchObject({ outcome: "succeeded" });
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      const run = state.agentRuns[cancelled.runId]!;
      expect(run.cancellationRequested).toBe(true);
      expect(run.cancellationReason).toBe("stop now");
      expect(state.messages.map(message => message.role)).toEqual(["user"]);
      expect(Object.values(state.modelCalls)).toHaveLength(1);
      expect(Object.values(state.modelCalls)[0]?.status).toBe("cancelled");
    } finally { await supervisor.close(); }
  });

  test("does not accept a final response while a required completion gate fails", async () => {
    const value = await fixture([action({ type: "final", content: "Claimed complete" })]);
    try {
      const goal = await value.supervisor.goals.create(value.sessionId, value.branchId, {
        description: "Pass the required gate",
        gates: [{ name: "always fails", executor: "shell", operation: "run", input: { command: "exit 7" }, idempotent: true, required: true }],
      });
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, { task: "Finish safely", goalId: goal.goalId });
      expect(result.status).toBe("blocked");
      expect(result.final).toBeUndefined();
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(state.goals[goal.goalId]?.status).toBe("blocked");
      expect(state.agentRuns[result.runId]?.finalMessageId).toBeUndefined();
    } finally { await value.supervisor.close(); }
  });

  test("reconciles an unapplied TypeScript action committed before a crash without dropping or duplicating its stable cell", async () => {
    const temp = await makeTempRuntime("agencity-agent-action-recovery-"); temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "typescript", code: `return await tools.writeFile("recovered-action.txt", "applied-once");` }),
      action({ type: "final", content: "Recovered the retained action." }),
    ], "action-recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "action-recovery", model: { provider: provider.name, model: "v1" } });
    const restore = crashAfterNextActionCommit(supervisor);
    try {
      await expect(supervisor.runs.start(session.sessionId, session.branchId, {
        task: "Apply the retained TypeScript action", requestKey: "recover-retained-typescript",
      })).rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      expect(provider.calls).toBe(1);
      const crashed = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(Object.values(crashed.cells)).toHaveLength(0);
      expect(Object.values(crashed.agentRuns)[0]?.steps[0]?.action?.type).toBe("typescript");
      await supervisor.close();

      supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      const recovered = Object.values((await supervisor.projections.getSnapshot(session.sessionId, session.branchId)).state.agentRuns)[0]!;
      expect(await supervisor.runs.get(session.sessionId, session.branchId, recovered.id))
        .toMatchObject({ status: "succeeded", steps: 2, final: "Recovered the retained action." });
      expect(provider.calls).toBe(2);
      expect(await Bun.file(`${temp.workspaceRoot}/recovered-action.txt`).text()).toBe("applied-once");
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(history.filter(event => event.type === "CellProposed")).toHaveLength(1);
      expect(history.filter(event => event.type === "CellCommitted")).toHaveLength(1);
      expect(projectEvents(history).cells[Object.keys(projectEvents(history).cells)[0]!]!.attempts).toBe(1);
    } finally { restore(); await supervisor.close(); }
  });

  test("applies a retained final action whose step consumed a prior CellCommitted observation without another provider call", async () => {
    const temp = await makeTempRuntime("agencity-agent-observed-action-recovery-"); temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "final", content: "Used the committed observation." }),
    ], "observed-action-recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "observed-action-recovery", model: { provider: provider.name, model: "v1" } });
    const runId = newId();
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "client", idempotencyKey: `agent-run-task-message:${runId}`,
      payload: { messageId: `agent-run-task-${runId}`, role: "user", content: "Use the prior observation" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "Use the prior observation", requestKey: "observed-action-recovery" },
    }]);
    const priorCell = await supervisor.executeCell(session.sessionId, session.branchId, `return { retained: true };`, [], "prior-observation-cell");
    const before = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const observation = before.find(event => event.type === "CellCommitted" && (event.payload as { cellId: string }).cellId === priorCell.cellId)!;
    const restore = crashAfterNextActionCommit(supervisor);
    try {
      await expect(supervisor.runs.advance(session.sessionId, session.branchId, runId))
        .rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      expect(provider.calls).toBe(1);
      const crashed = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(crashed.agentRuns[runId]?.steps).toHaveLength(1);
      expect(crashed.agentRuns[runId]?.steps[0]?.observationEventIds).toContain(observation.id);
      expect(crashed.agentRuns[runId]?.steps[0]?.action).toMatchObject({ type: "final", content: "Used the committed observation." });
      expect(crashed.agentRuns[runId]?.status).toBe("running");
      await supervisor.close();

      supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId))
        .toMatchObject({ status: "succeeded", steps: 1, final: "Used the committed observation." });
      expect(provider.calls).toBe(1);
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(history.filter(event => event.type === "AgentRunActionCommitted")).toHaveLength(1);
      expect(history.filter(event => event.type === "MessageAppended" && event.producer === "supervisor")).toHaveLength(1);
    } finally { restore(); await supervisor.close(); }
  });

  test("recovers a committed clarification action by its deterministic input request without another provider call", async () => {
    const temp = await makeTempRuntime("agencity-agent-input-action-recovery-"); temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "clarification", question: "Which retained choice?" }),
    ], "input-action-recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "input-action-recovery", model: { provider: provider.name, model: "v1" } });
    const restore = crashAfterNextActionCommit(supervisor);
    let runId = "";
    try {
      await expect(supervisor.runs.start(session.sessionId, session.branchId, "Ask the retained question"))
        .rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      const crashed = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      runId = Object.values(crashed.agentRuns)[0]!.id;
      expect(Object.values(crashed.agentRuns[runId]!.inputRequests)).toHaveLength(0);
      expect(provider.calls).toBe(1);
      await supervisor.close();

      supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId))
        .toMatchObject({ status: "waiting_for_user", steps: 1, pendingInput: { kind: "clarification", question: "Which retained choice?" } });
      expect(provider.calls).toBe(1);
      const recovered = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId })).agentRuns[runId]!;
      expect(Object.values(recovered.inputRequests)).toHaveLength(1);
    } finally { restore(); await supervisor.close(); }
  });

  test("marks a stable cell interrupted after action commit as unknown and never replays it or calls the provider", async () => {
    const temp = await makeTempRuntime("agencity-agent-cell-interruption-"); temps.push(temp);
    const code = `return await tools.writeFile("must-not-replay.txt", "unsafe");`;
    const provider = new RecordingActions([
      action({ type: "typescript", code }),
      action({ type: "final", content: "must not be requested" }),
    ], "cell-interruption-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "cell-interruption", model: { provider: provider.name, model: "v1" } });
    const restore = crashAfterNextActionCommit(supervisor);
    let runId = "";
    let cellId = "";
    try {
      await expect(supervisor.runs.start(session.sessionId, session.branchId, "Do not replay an interrupted action"))
        .rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      const crashed = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      const run = Object.values(crashed.agentRuns)[0]!;
      runId = run.id;
      cellId = `agent-run-cell-${run.steps[0]!.actionId}`;
      await supervisor.storage.appendEvents([{
        sessionId: session.sessionId, branchId: session.branchId, type: "CellProposed", producer: "console",
        idempotencyKey: `cell-proposed:${cellId}`, payload: { cellId, code, dependencies: [] },
      }, {
        sessionId: session.sessionId, branchId: session.branchId, type: "CellStarted", producer: "console",
        idempotencyKey: `cell-started:${cellId}:1`, payload: { cellId, attempt: 1 },
      }]);
      expect(provider.calls).toBe(1);
      await supervisor.close();

      supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId))
        .toMatchObject({ status: "unknown", steps: 1, reason: expect.stringContaining("did not reach a committed terminal boundary") });
      expect(provider.calls).toBe(1);
      expect(await Bun.file(`${temp.workspaceRoot}/must-not-replay.txt`).exists()).toBe(false);
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(history.filter(event => event.type === "CellProposed" && (event.payload as { cellId: string }).cellId === cellId)).toHaveLength(1);
      expect(history.filter(event => event.type === "CellStarted" && (event.payload as { cellId: string }).cellId === cellId)).toHaveLength(1);
      expect(history.filter(event => event.type === "CellAbandoned" && (event.payload as { cellId: string }).cellId === cellId)).toHaveLength(1);
      expect(history.some(event => ["CellCommitted", "CellFailed"].includes(event.type) && (event.payload as { cellId: string }).cellId === cellId)).toBe(false);
    } finally { restore(); await supervisor.close(); }
  });

  test("recovers a succeeded stable model effect without calling the provider twice", async () => {
    const temp = await makeTempRuntime("agencity-agent-recovery-"); temps.push(temp);
    const provider = new RecordingActions([action({ type: "final", content: "Recovered exactly once." })], "recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "recovery", model: { provider: provider.name, model: "v1" } });
    const runId = newId(); const stepId = `agent-run-${runId}-step-1`; const contextId = `${stepId}-context`; const callId = `${stepId}-call`; const actionId = `${stepId}-action`;
    const effectKey = `agent-run-model:${runId}:1`; const effectId = stableEffectId(session.sessionId, effectKey);
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "client", idempotencyKey: `agent-run-task-message:${runId}`,
      payload: { messageId: `agent-run-task-${runId}`, role: "user", content: "Recover this run" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "Recover this run", requestKey: "recover-request" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunStepStarted", producer: "supervisor", idempotencyKey: `agent-run-step:${runId}:1`,
      payload: { runId, stepId, ordinal: 1, contextId, callId, effectId, actionId, observationEventIds: [] },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ContextMaterialized", producer: "supervisor", idempotencyKey: `agent-run-context:${runId}:1`,
      payload: { contextId, records: [], contentHash: "a".repeat(64), context: { run: { stepOrdinal: 1 }, messages: [] } },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ModelCallRequested", producer: "supervisor", idempotencyKey: `agent-run-model-call:${callId}`,
      payload: { callId, contextId, effectId, provider: provider.name, model: "v1" },
    }]);
    await supervisor.outbox.request({ sessionId: session.sessionId, branchId: session.branchId, executor: "model", operation: "complete", input: { callId, context: { run: { stepOrdinal: 1 }, messages: [] }, configuration: { provider: provider.name, model: "v1" } }, idempotencyKey: effectKey, idempotent: false });
    expect((await supervisor.outbox.run(effectId)).outcome).toBe("succeeded");
    expect(provider.calls).toBe(1);
    const rawAction = JSON.stringify(action({ type: "final", content: "Recovered exactly once." }));
    await expect(supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "model",
      idempotencyKey: `forbidden-agent-run-message:${callId}`,
      payload: { messageId: `forbidden-${callId}`, role: "assistant", content: rawAction, modelCallId: callId },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ModelCallCompleted", producer: "supervisor",
      idempotencyKey: `forbidden-agent-run-complete:${callId}`,
      payload: { callId, responseMessageId: `forbidden-${callId}`, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } },
    }])).rejects.toThrow();
    expect(projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId })).messages.map(message => message.content))
      .toEqual(["Recover this run"]);
    await supervisor.close();

    supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
    try {
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId)).toMatchObject({ status: "succeeded", final: "Recovered exactly once." });
      expect(provider.calls).toBe(1);
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      const state = projectEvents(history);
      expect(Object.values(state.modelCalls)).toHaveLength(1);
      expect(Object.values(state.agentRuns[runId]!.steps)).toHaveLength(1);
      expect(state.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: "Recover this run" },
        { role: "assistant", content: "Recovered exactly once." },
      ]);
      expect(Object.values(state.modelCalls)[0]?.responseMessageId).toBeUndefined();
      expect(history.filter(event => event.type === "MessageAppended")).toHaveLength(2);
      expect(history.filter(event => event.type === "AgentRunActionCommitted")).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("recovery drains an unclaimed stable model request exactly once", async () => {
    const temp = await makeTempRuntime("agencity-agent-pending-recovery-"); temps.push(temp);
    const provider = new RecordingActions([action({ type: "final", content: "Pending recovered once." })], "pending-recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "pending-recovery", model: { provider: provider.name, model: "v1" } });
    const runId = newId(); const stepId = `agent-run-${runId}-step-1`; const contextId = `${stepId}-context`; const callId = `${stepId}-call`; const actionId = `${stepId}-action`;
    const effectKey = `agent-run-model:${runId}:1`; const effectId = stableEffectId(session.sessionId, effectKey);
    const context = { run: { stepOrdinal: 1 }, messages: [] };
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "client", idempotencyKey: `agent-run-task-message:${runId}`,
      payload: { messageId: `agent-run-task-${runId}`, role: "user", content: "Recover pending request" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "Recover pending request", requestKey: "pending-recover-request" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunStepStarted", producer: "supervisor", idempotencyKey: `agent-run-step:${runId}:1`,
      payload: { runId, stepId, ordinal: 1, contextId, callId, effectId, actionId, observationEventIds: [] },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ContextMaterialized", producer: "supervisor", idempotencyKey: `agent-run-context:${runId}:1`,
      payload: { contextId, records: [], contentHash: "b".repeat(64), context },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ModelCallRequested", producer: "supervisor", idempotencyKey: `agent-run-model-call:${callId}`,
      payload: { callId, contextId, effectId, provider: provider.name, model: "v1" },
    }]);
    await supervisor.outbox.request({ sessionId: session.sessionId, branchId: session.branchId, executor: "model", operation: "complete", input: { callId, context, configuration: { provider: provider.name, model: "v1" } }, idempotencyKey: effectKey, idempotent: false });
    expect(provider.calls).toBe(0);
    await supervisor.close();

    supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
    try {
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId)).toMatchObject({ status: "succeeded", final: "Pending recovered once." });
      expect(provider.calls).toBe(1);
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(state.effects[effectId]?.attempts).toBe(1);
      expect(state.messages.map(message => message.content)).toEqual(["Recover pending request", "Pending recovered once."]);
    } finally { await supervisor.close(); }
  });

  test("recovery makes a lost non-idempotent effect an unknown run terminal without a model call", async () => {
    const temp = await makeTempRuntime("agencity-agent-unknown-"); temps.push(temp);
    const provider = new RecordingActions([action({ type: "final", content: "must not run" })], "unknown-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "unknown", model: { provider: provider.name, model: "v1" } });
    const runId = newId();
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "client", idempotencyKey: `agent-run-task-message:${runId}`,
      payload: { messageId: `agent-run-task-${runId}`, role: "user", content: "Unknown must block" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "Unknown must block", requestKey: "unknown-request" },
    }]);
    const effectId = await supervisor.outbox.request({ sessionId: session.sessionId, branchId: session.branchId, executor: "shell", operation: "run", input: { command: "printf ambiguous" }, idempotencyKey: "ambiguous-side-effect", idempotent: false });
    expect(await supervisor.storage.claimEffect(effectId, "dead-owner")).not.toBeNull();
    await supervisor.close();

    supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
    try {
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId)).toMatchObject({ status: "unknown" });
      expect(provider.calls).toBe(0);
    } finally { await supervisor.close(); }
  });

  test("exposes start, inspect, clarification response, and legacy diagnostic turns through the protocol client", async () => {
    const value = await fixture([
      action({ type: "clarification", question: "Say continue" }),
      action({ type: "final", content: "Protocol continued." }),
    ]);
    const protocol = new ProtocolServer(value.supervisor); const server = protocol.listen(0);
    const client = new AgentClient(`http://${server.hostname}:${server.port}`);
    try {
      const waiting = await client.startRun(value.sessionId, value.branchId, "Protocol task");
      expect(await client.run(value.sessionId, value.branchId, waiting.runId)).toMatchObject({ status: "waiting_for_user" });
      const completed = await client.respondToRun(value.sessionId, value.branchId, waiting.runId, waiting.pendingInput!.id, "continue");
      expect(completed).toMatchObject({ status: "succeeded", final: "Protocol continued." });
      // This remains callable as a separate diagnostic surface.
      const legacy = await client.turn(value.sessionId, value.branchId) as { outcome: string };
      expect(legacy.outcome).toBe("succeeded");
    } finally { protocol.stop(); await value.supervisor.close(); }
  });
});
