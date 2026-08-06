import {
  AGENT_ACTION_JSON_SCHEMA,
  AGENT_ACTION_POLICY,
  parseAgentAction,
  newId,
  CapabilityUnavailableError,
  NotFoundError,
  projectEvents,
  ValidationError,
  type AgentAction,
  type AgentEvent,
  type AgentRunInputRequestState,
  type AgentRunState,
  type AgentRunStatus,
  type AgentState,
  type BudgetLimits,
  type EventPayloads,
  type JsonValue,
  type Usage,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { ContextMaterializer } from "./context.ts";
import { stableEffectId, type OutboxRunner } from "./outbox.ts";
import type { GoalService } from "./goals.ts";

interface ModelOutput { readonly text: string; readonly finishReason: string; readonly usage: Usage }

export interface StartAgentRunInput {
  readonly task: string;
  /** Stable caller intent. Reusing it returns the same durable run. */
  readonly requestKey?: string;
  readonly goalId?: string;
}

export interface AgentRunResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly status: AgentRunStatus;
  readonly steps: number;
  readonly reason?: string;
  readonly final?: string;
  readonly finalMessageId?: string;
  readonly pendingInput?: AgentRunInputRequestState;
}

export interface AgentRunUserResponse {
  readonly response: string;
  /** Required for permission requests and ignored for clarification requests. */
  readonly approved?: boolean;
}

type ExecuteCell = (
  sessionId: string,
  branchId: string,
  code: string,
  dependencies?: string[],
  stableCellId?: string,
) => Promise<{ cellId: string; result: JsonValue; logs: string[] }>;

const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = [
  "succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown",
];

/**
 * Events produced by execution that are delivered through the exact-once run
 * observation ledger. Persistent state and conversation remain available in
 * the ordinary bounded durable context, but these event payloads occur in the
 * provider-facing `run.observations` array only on the dependent step.
 */
const OBSERVATION_TYPES = new Set([
  "CellCommitted", "CellFailed", "CellAbandoned", "EffectOutcomeRecorded",
  "WorkingValueSet", "ArtifactRegistered", "TaskCreated", "SubagentAdmitted",
  "TaskStatusChanged", "MailboxMessageSent", "MailboxMessageDelivered",
  "MailboxMessageAcknowledged", "TaskTerminalNoticeSent", "TaskTerminalNoticeDelivered",
  "RecursiveModelRequested", "RecursiveModelStatusChanged", "SkillInvocationRecorded",
  "SubagentSpecInvoked", "AgentRunUserInputReceived", "GoalGateStatusChanged",
  "GoalStatusChanged", "RefinementObservationRecorded", "RefinementDecided",
]);

const SDK_GUIDE = [
  "The only executable action is a TypeScript cell. Do not request parallel provider tools.",
  "Cell globals: sdk, sql, session, console, state, artifacts, tools, inspect, cells, rlm.",
  "Use tools.readFile(path), tools.writeFile(path, content, expectedSha256?), and tools.shell(command, options?) for repository work.",
  "Use sql`SELECT ... ${value}` only for read-only relational queries; use state.get/set/list for durable JSON and artifacts.put/get for larger content.",
  "Use cells.list/get for retained notebook history; sdk.memory, sdk.harness, sdk.skills, sdk.specs, and rlm.start/startMany/get/result/cancel for durable adaptation and delegation.",
  "A cell's final expression or explicit return is its bounded observation. Values in lexical bindings or globalThis disappear after the committed cell boundary.",
  "Inspect first, make focused changes, run verification, and return a final action only when the task is actually complete.",
].join("\n");

class RunQueue {
  readonly #tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    await prior.catch(() => {});
    try { return await operation(); }
    finally { release(); if (this.#tails.get(key) === tail) this.#tails.delete(key); }
  }
}

/** Autonomous typed model-to-TypeScript loop over canonical run events. */
export class AgentRunService {
  readonly #runs = new RunQueue();

  constructor(
    readonly storage: AgentStorage,
    readonly contexts: ContextMaterializer,
    readonly outbox: OutboxRunner,
    readonly goals: GoalService,
    readonly executeCell: ExecuteCell,
    readonly maxSteps = 128,
  ) {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new ValidationError("Agent run maxSteps must be positive");
  }

  async start(sessionId: string, branchId: string, input: StartAgentRunInput | string): Promise<AgentRunResult> {
    if (typeof input !== "string" && (!input || typeof input !== "object" || Array.isArray(input))) {
      throw new ValidationError("Agent run input must be a task string or object");
    }
    const normalized = typeof input === "string" ? { task: input } : input;
    if (typeof normalized.task !== "string") throw new ValidationError("Agent run task must be a string");
    const task = normalized.task.trim();
    if (!task) throw new ValidationError("Agent run task cannot be empty");
    if (normalized.requestKey !== undefined && (typeof normalized.requestKey !== "string" || !normalized.requestKey.trim())) {
      throw new ValidationError("Agent run requestKey must be a non-empty string");
    }
    if (normalized.goalId !== undefined && (typeof normalized.goalId !== "string" || !normalized.goalId.trim())) {
      throw new ValidationError("Agent run goalId must be a non-empty string");
    }
    const requestKey = normalized.requestKey ?? `agent-run-request:${newId()}`;
    return this.#runs.run(`${sessionId}/${branchId}`, async () => {
      let state = await this.#state(sessionId, branchId);
      const existing = Object.values(state.agentRuns).find((run) => run.requestKey === requestKey);
      if (existing) {
        if (existing.task !== task || existing.goalId !== (normalized.goalId ?? null)) {
          throw new ValidationError("Agent run requestKey was reused with different durable meaning");
        }
        return this.#advance(sessionId, branchId, existing.id);
      }
      const active = Object.values(state.agentRuns).find((run) => !isTerminal(run.status));
      if (active) throw new ValidationError(`Agent run ${active.id} is already ${active.status}`);
      if (normalized.goalId && !state.goals[normalized.goalId]) throw new NotFoundError("goal", normalized.goalId);
      const runId = newId();
      await this.storage.appendEvents([{
        sessionId, branchId, type: "MessageAppended", producer: "client",
        idempotencyKey: `agent-run-task-message:${runId}`,
        payload: { messageId: `agent-run-task-${runId}`, role: "user", content: task },
      }, {
        sessionId, branchId, type: "AgentRunRequested", producer: "client",
        idempotencyKey: `agent-run-request:${runId}`,
        payload: { runId, task, requestKey, ...(normalized.goalId === undefined ? {} : { goalId: normalized.goalId }) },
      }]);
      state = await this.#state(sessionId, branchId);
      if (!state.agentRuns[runId]) throw new Error("Agent run request was not committed");
      return this.#advance(sessionId, branchId, runId);
    });
  }

  async advance(sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> {
    return this.#runs.run(`${sessionId}/${branchId}`, () => this.#advance(sessionId, branchId, runId));
  }

  async get(sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> {
    const state = await this.#state(sessionId, branchId);
    const run = state.agentRuns[runId];
    if (!run) throw new NotFoundError("agent run", runId);
    return this.#result(state, run);
  }

  async respond(
    sessionId: string,
    branchId: string,
    runId: string,
    requestId: string,
    input: AgentRunUserResponse | string,
  ): Promise<AgentRunResult> {
    if (typeof input !== "string" && (!input || typeof input !== "object" || Array.isArray(input))) {
      throw new ValidationError("Agent run response must be a string or object");
    }
    const normalized = typeof input === "string" ? { response: input } : input;
    if (typeof normalized.response !== "string") throw new ValidationError("Agent run response must be a string");
    if (normalized.approved !== undefined && typeof normalized.approved !== "boolean") {
      throw new ValidationError("Agent run approved value must be boolean");
    }
    return this.#runs.run(`${sessionId}/${branchId}`, async () => {
      const state = await this.#state(sessionId, branchId);
      const run = state.agentRuns[runId];
      if (!run) throw new NotFoundError("agent run", runId);
      const request = run.inputRequests[requestId];
      if (!request) throw new NotFoundError("agent run input request", requestId);
      const approved = request.kind === "permission" ? normalized.approved : undefined;
      if (request.response !== undefined) {
        if (request.response !== normalized.response || request.approved !== approved) {
          throw new ValidationError(`Agent run input request ${requestId} was already answered differently`);
        }
        return this.#result(state, run);
      }
      if (run.status !== "waiting_for_user") {
        throw new ValidationError(`Agent run input request ${requestId} is not awaiting a response`);
      }
      if (request.kind === "permission" && typeof approved !== "boolean") {
        throw new ValidationError("Permission responses require approved=true or approved=false");
      }
      await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunUserInputReceived", producer: "client",
        idempotencyKey: `agent-run-input-response:${requestId}`,
        payload: {
          runId, requestId, response: normalized.response,
          ...(request.kind === "permission" ? { approved: approved! } : {}),
        },
      }]);
      return this.#advance(sessionId, branchId, runId);
    });
  }

  /** Cancellation intent is committed outside the run queue so it can abort an admitted effect. */
  async cancel(sessionId: string, branchId: string, runId: string, reason?: string): Promise<AgentRunResult> {
    let state = await this.#state(sessionId, branchId);
    const run = state.agentRuns[runId];
    if (!run) throw new NotFoundError("agent run", runId);
    if (isTerminal(run.status)) return this.#result(state, run);
    if (!run.cancellationRequested) {
      await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunCancellationRequested", producer: "client",
        idempotencyKey: `agent-run-cancel:${runId}`,
        payload: { runId, ...(reason === undefined ? {} : { reason }) },
      }]);
    }
    state = await this.#state(sessionId, branchId);
    const runEffectIds = new Set(state.agentRuns[runId]?.steps.map((step) => step.effectId) ?? []);
    for (const effectId of runEffectIds) {
      const effect = state.effects[effectId];
      if (effect?.status === "requested" || effect?.status === "started") this.outbox.cancel(effect.id);
    }
    return this.advance(sessionId, branchId, runId);
  }

  /** Resumes queued/running runs after outbox and model-call reconciliation. */
  async recoverIncomplete(): Promise<number> {
    let recovered = 0;
    for (const branch of await this.storage.listBranches()) {
      if (!await this.#isExecutionOwner(branch.sessionId)) continue;
      const state = await this.#state(branch.sessionId, branch.branchId).catch(() => null);
      if (!state) continue;
      const active = Object.values(state.agentRuns).find((run) => ["queued", "running"].includes(run.status));
      if (!active) continue;
      await this.advance(branch.sessionId, branch.branchId, active.id);
      recovered++;
    }
    return recovered;
  }

  async #advance(sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> {
    await this.#assertExecutionOwner(sessionId);
    while (true) {
      let { state, events, run } = await this.#load(sessionId, branchId, runId);
      if (isTerminal(run.status) || run.status === "waiting_for_user") return this.#result(state, run);
      if (run.cancellationRequested) {
        await this.#terminal(sessionId, branchId, run, "cancelled", run.cancellationReason ?? "Cancellation requested");
        continue;
      }
      if (state.budget.exceeded || budgetReached(state.budget.limits, state.budget)) {
        await this.#terminal(sessionId, branchId, run, "budget_exceeded", "Session budget is exhausted");
        continue;
      }
      const unknown = this.#unknownEffectAfterRequest(events, state, run);
      if (unknown) {
        await this.#terminal(sessionId, branchId, run, "unknown", `Effect ${unknown.id} has an unknown outcome: ${unknown.error ?? "manual reconciliation required"}`);
        continue;
      }
      if (run.steps.length >= this.maxSteps) {
        await this.#terminal(sessionId, branchId, run, "budget_exceeded", `Agent run step limit ${this.maxSteps} reached`);
        continue;
      }

      let step = run.steps.at(-1);
      if (!step || step.action !== undefined || step.rejection !== undefined) {
        const ordinal = (step?.ordinal ?? 0) + 1;
        const observationEventIds = this.#unobserved(events, run);
        const stepId = `agent-run-${run.id}-step-${ordinal}`;
        const contextId = `${stepId}-context`;
        const callId = `${stepId}-call`;
        const actionId = `${stepId}-action`;
        const effectKey = `agent-run-model:${run.id}:${ordinal}`;
        const effectId = stableEffectId(sessionId, effectKey);
        await this.storage.appendEvents([{
          sessionId, branchId, type: "AgentRunStepStarted", producer: "supervisor",
          idempotencyKey: `agent-run-step:${run.id}:${ordinal}`,
          payload: { runId: run.id, stepId, ordinal, contextId, callId, effectId, actionId, observationEventIds },
        }]);
        ({ state, events, run } = await this.#load(sessionId, branchId, runId));
        step = run.steps.at(-1)!;
      }

      if (!step.action && !step.rejection) {
        await this.#completeStepModel(sessionId, branchId, state, events, run, step);
        ({ state, events, run } = await this.#load(sessionId, branchId, runId));
        step = run.steps.at(-1)!;
      }

      if (isTerminal(run.status) || run.status === "waiting_for_user") continue;
      if (run.cancellationRequested) continue;
      if (step.rejection) {
        await this.#terminal(sessionId, branchId, run, "failed", `Rejected model action: ${step.rejection}`);
        continue;
      }
      const action = step.action!;
      // The already-admitted model action is retained at the exact budget
      // boundary. Only non-effect run-control actions may be processed there.
      if (state.budget.exceeded && ["typescript", "clarification", "permission"].includes(action.type)) {
        await this.#terminal(sessionId, branchId, run, "budget_exceeded", "Session budget boundary reached before action execution");
        continue;
      }
      const progressed = await this.#applyAction(sessionId, branchId, state, run, step.actionId, action);
      if (!progressed) return this.get(sessionId, branchId, runId);
    }
  }

  async #completeStepModel(
    sessionId: string,
    branchId: string,
    state: AgentState,
    events: readonly AgentEvent[],
    run: AgentRunState,
    step: AgentRunState["steps"][number],
  ): Promise<void> {
    let contextEvent = events.find((event) => event.type === "ContextMaterialized" &&
      (event.payload as EventPayloads["ContextMaterialized"]).contextId === step.contextId) as AgentEvent<"ContextMaterialized"> | undefined;
    if (!contextEvent) {
      const observations = step.observationEventIds.map((eventId) => {
        const event = events.find((candidate) => candidate.id === eventId);
        if (!event) throw new ValidationError(`Agent run observation event is missing: ${eventId}`);
        return { eventId: event.id, type: event.type, payload: JSON.parse(JSON.stringify(event.payload)) as JsonValue };
      });
      const materialized = await this.contexts.materialize(sessionId, branchId, {
        contextId: step.contextId,
        idempotencyKey: `agent-run-context:${run.id}:${step.ordinal}`,
        additionalRecordIds: step.observationEventIds,
        transform: (base) => agentProviderContext(base, run, step.ordinal, observations),
      });
      contextEvent = materialized.event;
    }
    const context = contextEvent.payload.context;
    let current = await this.#state(sessionId, branchId);
    const effectKey = `agent-run-model:${run.id}:${step.ordinal}`;
    if (!current.modelCalls[step.callId]) {
      await this.storage.appendEvents([{
        sessionId, branchId, type: "SessionStatusChanged", producer: "supervisor",
        idempotencyKey: `agent-run-session-running:${step.callId}`, payload: { status: "running" },
      }, {
        sessionId, branchId, type: "ModelCallRequested", producer: "supervisor",
        idempotencyKey: `agent-run-model-call:${step.callId}`,
        payload: { callId: step.callId, contextId: step.contextId, effectId: step.effectId, provider: state.model.provider, model: state.model.model },
      }]);
      current = await this.#state(sessionId, branchId);
    }
    if (!current.effects[step.effectId]) {
      const requestedEffectId = await this.outbox.request({
        sessionId, branchId, executor: "model", operation: "complete",
        input: { callId: step.callId, context, configuration: state.model as unknown as JsonValue },
        idempotencyKey: effectKey, idempotent: false,
      });
      if (requestedEffectId !== step.effectId) throw new ValidationError("Agent run model effect identity is not stable");
      current = await this.#state(sessionId, branchId);
    }
    let call = current.modelCalls[step.callId]!;
    if (call.status === "requested") {
      const effect = current.effects[step.effectId];
      const execution = effect && !["requested", "started"].includes(effect.status)
        ? { outcome: effect.status, output: effect.output, error: effect.error }
        : await this.outbox.run(step.effectId);
      if (execution.outcome === "succeeded") {
        let output: ModelOutput | undefined;
        try { output = parseOutput(execution.output); }
        catch (error) {
          await this.#finalizeTerminated(
            sessionId,
            branchId,
            step.callId,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (output) {
          const terminalEvents = await this.storage.loadEvents(sessionId, { branchId });
          await this.#finalizeSucceeded(
            sessionId,
            branchId,
            step.callId,
            output,
            effectElapsedMs(terminalEvents, step.effectId),
          );
        }
      } else {
        if (execution.outcome === "requested" || execution.outcome === "started") throw new ValidationError("Model effect remained non-terminal");
        await this.#finalizeTerminated(sessionId, branchId, step.callId, execution.outcome, execution.error);
      }
      current = await this.#state(sessionId, branchId);
      call = current.modelCalls[step.callId]!;
    }
    if (call.status !== "succeeded") {
      const runNow = current.agentRuns[run.id]!;
      const status = call.status === "unknown" ? "unknown" : call.status === "cancelled" || runNow.cancellationRequested ? "cancelled" : "failed";
      if (status === "cancelled" && !runNow.cancellationRequested) {
        await this.storage.appendEvents([{
          sessionId, branchId, type: "AgentRunCancellationRequested", producer: "supervisor",
          idempotencyKey: `agent-run-effect-cancel:${run.id}`, payload: { runId: run.id, reason: call.error ?? "Model call cancelled" },
        }]);
      }
      const terminalReason = status === "cancelled"
        ? runNow.cancellationReason ?? call.error ?? "Cancellation requested"
        : call.error ?? `Model call ${call.status}`;
      await this.#terminal(sessionId, branchId, (await this.#state(sessionId, branchId)).agentRuns[run.id]!, status, terminalReason);
      return;
    }
    const raw = call.chunks.join("");
    try {
      const action = parseAgentAction(raw);
      await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunActionCommitted", producer: "supervisor",
        idempotencyKey: `agent-run-action:${step.actionId}`,
        payload: { runId: run.id, stepId: step.id, ordinal: step.ordinal, actionId: step.actionId, callId: step.callId, raw, action },
      }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunActionRejected", producer: "supervisor",
        idempotencyKey: `agent-run-action-rejected:${step.actionId}`,
        payload: { runId: run.id, stepId: step.id, ordinal: step.ordinal, actionId: step.actionId, callId: step.callId, raw, error: message },
      }]);
    }
  }

  async #applyAction(
    sessionId: string,
    branchId: string,
    state: AgentState,
    run: AgentRunState,
    actionId: string,
    action: AgentAction,
  ): Promise<boolean> {
    if (action.type === "typescript") {
      const cellId = `agent-run-cell-${actionId}`;
      const cell = state.cells[cellId];
      if (cell?.status === "abandoned" || cell?.status === "running" || cell?.status === "proposed") {
        await this.#terminal(sessionId, branchId, run, "unknown", `Cell ${cellId} did not reach a committed terminal boundary and was not replayed`);
        return true;
      }
      if (!cell) {
        try { await this.executeCell(sessionId, branchId, action.code, [], cellId); }
        catch {
          const after = await this.#state(sessionId, branchId);
          const terminal = after.cells[cellId];
          if (!terminal || terminal.status === "abandoned" || terminal.status === "running" || terminal.status === "proposed") {
            await this.#terminal(sessionId, branchId, after.agentRuns[run.id]!, "unknown", `Cell ${cellId} ended without a safe committed outcome`);
          }
          // A durable CellFailed observation is intentionally shown to the next
          // model step so the agent can diagnose and correct its program.
        }
      }
      return true;
    }
    if (action.type === "clarification" || action.type === "permission") {
      const requestId = `agent-run-input-${actionId}`;
      await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunUserInputRequested", producer: "supervisor",
        idempotencyKey: `agent-run-input-request:${requestId}`,
        payload: {
          runId: run.id, requestId, actionId, kind: action.type, question: action.question,
          ...(action.type === "permission" ? { permission: action.permission } : {}),
        },
      }, {
        sessionId, branchId, type: "AgentRunStatusChanged", producer: "supervisor",
        idempotencyKey: `agent-run-waiting:${requestId}`,
        payload: { runId: run.id, status: "waiting_for_user", reason: action.question },
      }]);
      return false;
    }
    if (action.type === "blocked") {
      await this.#terminal(sessionId, branchId, run, "blocked", action.reason);
      return true;
    }
    if (action.type === "failed") {
      await this.#terminal(sessionId, branchId, run, "failed", action.error);
      return true;
    }

    // A final response with an attached goal is provisional until every
    // required gate passes against the current attributable workspace pin.
    if (run.goalId) {
      const goal = await this.goals.requestCompletion(sessionId, branchId, run.goalId);
      const unknown = goal.gates.find((gate) => gate.required && gate.status === "unknown");
      if (unknown) {
        await this.#terminal(sessionId, branchId, run, "unknown", unknown.error ?? `Required completion gate ${unknown.name} is unknown`);
        return true;
      }
      if (goal.status !== "completed") {
        await this.#terminal(sessionId, branchId, run, goal.status === "failed" ? "failed" : "blocked", goal.reason ?? "Required completion gates did not pass");
        return true;
      }
    }
    const messageId = `agent-run-final-${run.id}`;
    await this.storage.appendEvents([{
      sessionId, branchId, type: "MessageAppended", producer: "supervisor",
      idempotencyKey: `agent-run-final-message:${run.id}`,
      payload: { messageId, role: "assistant", content: action.content },
    }, {
      sessionId, branchId, type: "AgentRunStatusChanged", producer: "supervisor",
      idempotencyKey: `agent-run-succeeded:${run.id}`,
      payload: { runId: run.id, status: "succeeded", finalMessageId: messageId },
    }]);
    return true;
  }

  async #terminal(
    sessionId: string,
    branchId: string,
    run: AgentRunState,
    status: Exclude<AgentRunStatus, "queued" | "running" | "waiting_for_user" | "succeeded">,
    reason: string,
  ): Promise<void> {
    const current = (await this.#state(sessionId, branchId)).agentRuns[run.id];
    if (!current || isTerminal(current.status)) return;
    if (status === "cancelled" && !current.cancellationRequested) {
      throw new ValidationError("An agent run must record cancellation intent before becoming cancelled");
    }
    await this.storage.appendEvents([{
      sessionId, branchId, type: "AgentRunStatusChanged", producer: "supervisor",
      idempotencyKey: `agent-run-terminal:${run.id}`,
      payload: { runId: run.id, status, reason },
    }]);
  }

  async #finalizeTerminated(
    sessionId: string,
    branchId: string,
    callId: string,
    outcome: "failed" | "cancelled" | "unknown",
    error?: string,
  ): Promise<void> {
    await this.storage.appendEvents([{
      sessionId, branchId, type: "ModelCallTerminated", producer: "supervisor",
      idempotencyKey: `model-terminal:${callId}`,
      payload: { callId, outcome, ...(error === undefined ? {} : { error }) },
    }, {
      sessionId, branchId, type: "SessionStatusChanged", producer: "supervisor",
      idempotencyKey: `turn-idle:${callId}`, payload: { status: "idle", reason: `model ${outcome}` },
    }]);
  }

  async #finalizeSucceeded(
    sessionId: string,
    branchId: string,
    callId: string,
    output: ModelOutput,
    wallTimeMs: number,
  ): Promise<void> {
    const state = await this.#state(sessionId, branchId);
    if (state.modelCalls[callId]?.status === "succeeded") return;
    const tokens = output.usage.inputTokens + output.usage.outputTokens;
    const completion: any[] = [{
      sessionId, branchId, type: "ModelOutputChunk", producer: "model",
      idempotencyKey: `model-chunk:${callId}:0`, payload: { callId, sequence: 0, text: output.text },
    }, {
      sessionId, branchId, type: "ModelCallCompleted", producer: "supervisor",
      idempotencyKey: `model-complete:${callId}`,
      payload: { callId, finishReason: output.finishReason, usage: output.usage },
    }, {
      sessionId, branchId, type: "BudgetDebited", producer: "supervisor",
      idempotencyKey: `budget:${callId}`,
      payload: { callId, tokens, costUsd: output.usage.costUsd, turns: 1, wallTimeMs },
    }];
    const exceeded = budgetReached(state.budget.limits, {
      tokens: state.budget.tokens + tokens,
      costUsd: state.budget.costUsd + output.usage.costUsd,
      turns: state.budget.turns + 1,
      wallTimeMs: state.budget.wallTimeMs + wallTimeMs,
    });
    if (exceeded) completion.push({
      sessionId, branchId, type: "BudgetExceeded", producer: "supervisor",
      idempotencyKey: `budget-exceeded:${callId}`, payload: exceeded,
    });
    completion.push({
      sessionId, branchId, type: "SessionStatusChanged", producer: "supervisor",
      idempotencyKey: `turn-idle:${callId}`, payload: { status: "idle" },
    });
    await this.storage.appendEvents(completion);
  }

  #unobserved(events: readonly AgentEvent[], run: AgentRunState): string[] {
    const observed = new Set(run.steps.flatMap((step) => step.observationEventIds));
    const modelEffects = new Set(run.steps.map((step) => step.effectId));
    const requestIndex = events.findIndex((event) => event.id === run.requestEventId);
    return events.slice(requestIndex + 1).filter((event) => {
      if (!OBSERVATION_TYPES.has(event.type) || observed.has(event.id)) return false;
      if (event.type === "EffectOutcomeRecorded" && modelEffects.has((event.payload as EventPayloads["EffectOutcomeRecorded"]).effectId)) return false;
      return true;
    }).map((event) => event.id);
  }

  #unknownEffectAfterRequest(events: readonly AgentEvent[], state: AgentState, run: AgentRunState) {
    const requestIndex = events.findIndex((event) => event.id === run.requestEventId);
    const after = new Set(events.slice(requestIndex + 1).map((event) => event.id));
    return Object.values(state.effects).find((effect) => effect.status === "unknown" && after.has(effect.eventId));
  }

  async #isExecutionOwner(sessionId: string): Promise<boolean> {
    const session = await this.storage.getSession?.(sessionId);
    return !session?.executionOwnerDeviceId || !this.storage.deviceId || session.executionOwnerDeviceId === this.storage.deviceId;
  }

  async #assertExecutionOwner(sessionId: string): Promise<void> {
    const session = await this.storage.getSession?.(sessionId);
    if (session?.executionOwnerDeviceId && this.storage.deviceId && session.executionOwnerDeviceId !== this.storage.deviceId) {
      throw new CapabilityUnavailableError(
        `execution of session owned by device ${session.executionOwnerDeviceId}`,
        `${this.storage.name} device ${this.storage.deviceId} (automatic ownership failover is unavailable)`,
      );
    }
  }

  async #state(sessionId: string, branchId: string): Promise<AgentState> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    return projectEvents(events);
  }

  async #load(sessionId: string, branchId: string, runId: string): Promise<{ state: AgentState; events: AgentEvent[]; run: AgentRunState }> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(events);
    const run = state.agentRuns[runId];
    if (!run) throw new NotFoundError("agent run", runId);
    return { state, events, run };
  }

  #result(state: AgentState, run: AgentRunState): AgentRunResult {
    const finalMessage = run.finalMessageId ? state.messages.find((message) => message.id === run.finalMessageId) : undefined;
    const pendingInput = Object.values(run.inputRequests).find((request) => request.response === undefined);
    return {
      runId: run.id, sessionId: state.sessionId, branchId: state.branch.id,
      status: run.status, steps: run.steps.length,
      ...(run.reason === undefined ? {} : { reason: run.reason }),
      ...(finalMessage === undefined ? {} : { final: finalMessage.content }),
      ...(run.finalMessageId === undefined ? {} : { finalMessageId: run.finalMessageId }),
      ...(pendingInput === undefined ? {} : { pendingInput }),
    };
  }
}

function agentProviderContext(
  base: JsonValue,
  run: AgentRunState,
  stepOrdinal: number,
  observations: readonly { eventId: string; type: string; payload: JsonValue }[],
): JsonValue {
  const durable = base && typeof base === "object" && !Array.isArray(base) ? base as Record<string, JsonValue> : {};
  const existingMessages = Array.isArray(durable.messages) ? durable.messages.filter((message) =>
    message && typeof message === "object" && !Array.isArray(message) &&
    ["system", "user", "assistant", "tool"].includes(String(message.role)) && typeof message.content === "string") : [];
  const recentActivity = Array.isArray(durable.recentActivity)
    ? durable.recentActivity.filter((item) => !item || typeof item !== "object" || Array.isArray(item) || !OBSERVATION_TYPES.has(String(item.type)))
    : [];
  const durableContext = Object.fromEntries([
    "runtime", "profile", "session", "budget", "goal", "tasks", "mailbox",
    "terminalNotices", "recursiveModels", "documents", "inputSets", "heartbeats",
    "harness", "compactions", "workingValues", "artifacts", "queryHints",
  ].filter((key) => durable[key] !== undefined).map((key) => [key, durable[key]]));
  const stepInput = {
    runId: run.id,
    task: run.task,
    stepOrdinal,
    status: run.status,
    observations,
    durableContext,
    instruction: observations.length
      ? "Continue from these new exact-once durable observations."
      : "Choose the first concrete action for this task.",
  };
  return JSON.parse(JSON.stringify({
    ...durable,
    recentActivity,
    actionProtocol: { policy: AGENT_ACTION_POLICY, schema: AGENT_ACTION_JSON_SCHEMA },
    run: stepInput,
    messages: [
      { role: "system", content: `${String(durable.basePolicy ?? "")}\n\n${AGENT_ACTION_POLICY}\nAction JSON Schema: ${JSON.stringify(AGENT_ACTION_JSON_SCHEMA)}\n\n${SDK_GUIDE}` },
      ...existingMessages,
      { role: "user", content: `AGENCITY DURABLE RUN STEP\n${JSON.stringify(stepInput)}` },
    ],
  })) as JsonValue;
}

function parseOutput(value: JsonValue | undefined): ModelOutput {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string" ||
      typeof value.finishReason !== "string" || !value.usage || typeof value.usage !== "object" || Array.isArray(value.usage)) {
    throw new ValidationError("Model executor returned an invalid response");
  }
  const usage = value.usage;
  if (typeof usage.inputTokens !== "number" || !Number.isFinite(usage.inputTokens) || usage.inputTokens < 0 ||
      typeof usage.outputTokens !== "number" || !Number.isFinite(usage.outputTokens) || usage.outputTokens < 0 ||
      typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    throw new ValidationError("Model usage is invalid");
  }
  return { text: value.text, finishReason: value.finishReason, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd } };
}

function effectElapsedMs(events: readonly AgentEvent[], effectId: string): number {
  const started = events.find((event) => event.type === "EffectAttemptStarted" &&
    (event.payload as EventPayloads["EffectAttemptStarted"]).effectId === effectId);
  const outcome = [...events].reverse().find((event) => event.type === "EffectOutcomeRecorded" &&
    (event.payload as EventPayloads["EffectOutcomeRecorded"]).effectId === effectId);
  if (!started || !outcome) return 0;
  const elapsed = Date.parse(outcome.committedAt) - Date.parse(started.committedAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function budgetReached(
  limits: BudgetLimits,
  spent: { tokens: number; costUsd: number; turns: number; wallTimeMs: number },
): EventPayloads["BudgetExceeded"] | null {
  if (limits.tokenLimit !== undefined && spent.tokens >= limits.tokenLimit) return { dimension: "tokens", limit: limits.tokenLimit, spent: spent.tokens };
  if (limits.costLimitUsd !== undefined && spent.costUsd >= limits.costLimitUsd) return { dimension: "cost", limit: limits.costLimitUsd, spent: spent.costUsd };
  if (limits.turnLimit !== undefined && spent.turns >= limits.turnLimit) return { dimension: "turns", limit: limits.turnLimit, spent: spent.turns };
  if (limits.wallTimeLimitMs !== undefined && spent.wallTimeMs >= limits.wallTimeLimitMs) return { dimension: "wallTime", limit: limits.wallTimeLimitMs, spent: spent.wallTimeMs };
  return null;
}

function isTerminal(status: AgentRunStatus): boolean { return TERMINAL_RUN_STATUSES.includes(status); }
