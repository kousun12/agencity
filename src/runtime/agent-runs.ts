import {
  AGENT_TOOL_CONTRACT_ID,
  AGENT_TOOL_SELECTION_POLICY,
  agentActionFromToolSubmission,
  assertNoReservedModelDispatchInputFields,
  newId,
  CapabilityUnavailableError,
  NotFoundError,
  projectEvents,
  resolveModelDispatch,
  resolveBuiltInModelResponseContract,
  STANDARD_UNVERIFIED_REASONING_LEVELS,
  ValidationError,
  type AgentAction,
  type AgentEvent,
  type AgentRunGoalMode,
  type AgentRunInputRequestState,
  type AgentRunState,
  type AgentRunStatus,
  type AgentState,
  type BudgetLimits,
  type ContextCapacityProvenance,
  type EventPayloads,
  type JsonValue,
  type ModelDispatch,
  type ModelEffectFailureCode,
  type ModelEffectOutputV2,
  validateModelEffectOutputV2,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { ContextMaterializer } from "./context.ts";
import { stableEffectId, type OutboxRunner } from "./outbox.ts";
import type { CreateGoalInput, GoalHandle, GoalService } from "./goals.ts";
import type { ModelExecutor } from "../executors/index.ts";
import { CompactionService, AUTOMATIC_COMPACTION_RECENT_MESSAGES } from "./context-compaction.ts";
import { estimateContextWindow } from "./compaction-core.ts";
import {
  ModelContextCapacitySource, ProviderModelErrorCode, ContextWindowController, planContextWindowOverflowRetry,
  type ModelContextWindowConfiguration, type ProviderModelErrorClassification,
} from "./context-window.ts";
import { ModelEffectAdmissionService } from "./model-effect-admission.ts";

export interface StartAgentRunInput {
  readonly task: string;
  /** Stable caller intent. Reusing it returns the same durable run. */
  readonly requestKey?: string;
  /** Explicit goal selection; product tasks use auto/current/create, never prose inference. */
  readonly goalMode?: AgentRunGoalMode;
  /** Goal definition used only when goalMode creates a goal. Defaults to the task. */
  readonly goal?: CreateGoalInput;
  /** Legacy/internal exact goal attachment. Mutually exclusive with create. */
  readonly goalId?: string;
  /** Durable wake provenance for scheduled AgentRun delivery. */
  readonly wakeId?: string;
  /** Internal stable run identity used by retained family delivery recovery. */
  readonly requestedRunId?: string;
  /** Internal: the task is already a provenance-rich mailbox/session message. */
  readonly suppressTaskMessage?: boolean;
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
  "MailboxMessageContextDelivered", "MailboxMessageDeliveryFailed", "MailboxMessageAcknowledged", "TaskTerminalNoticeSent", "TaskTerminalNoticeDelivered",
  "RecursiveModelStarted", "RecursiveModelStatusChanged", "SkillInvocationRecorded",
  "SubagentSpecInvoked", "AgentRunUserInputReceived", "AgentRunGoalCheckRecorded",
  "AgentRunActionRejected", "RefinementObservationRecorded", "RefinementDecided",
]);

const MAX_ACTION_CORRECTION_ATTEMPTS = 1;

const SDK_GUIDE = [
  "The only executable action is a TypeScript cell. Do not request parallel provider tools.",
  "Cell globals: sdk, sql, session, console, state, artifacts, tools, inspect, cells, rlm.",
  "Use tools.readFile(path), tools.writeFile(path, content, expectedSha256?), and tools.shell(command, options?) for repository work.",
  "Tool results are objects, not strings: readFile returns { content, sha256, size }; writeFile returns { path, sha256, size, unchanged? }; shell returns { exitCode, stdout, stderr, truncated }.",
  "Read and edit file.content, and pass file.sha256 as expectedSha256 when replacing a previously read file. Shell options use { timeoutMs, cwd?, idempotencyKey? }; the option is timeoutMs, not timeout.",
  "tools.readFile, tools.writeFile, and tools.shell throw when their durable effect does not succeed. Use tools.request(executor, operation, input, options?) when an expected failed outcome must be inspected without failing the cell.",
  "Use sql`SELECT ... ${value}` only for read-only relational queries; use state.get/set/list for durable JSON and artifacts.put/get for larger content.",
  "Use cells.list/get for retained notebook history; use sdk.context.inspect/compact for attributable context-window control; sdk.goals is read-only; sdk.heartbeats and sdk.schedules manage only agent-owned wakes; sdk.agents spawn/list/send/messages/acknowledge/cancel/followUp provides durable nuclear-family messaging; sdk.memory, sdk.harness, sdk.skills, sdk.specs, and rlm.start/startMany/get/result/cancel provide adaptation and delegation.",
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
  #terminalObserver: ((result: AgentRunResult) => Promise<void>) | null = null;
  #boundaryObserver: ((sessionId: string, branchId: string, runId: string) => Promise<void>) | null = null;

  setTerminalObserver(observer: (result: AgentRunResult) => Promise<void>): void { this.#terminalObserver = observer; }
  setBoundaryObserver(observer: (sessionId: string, branchId: string, runId: string) => Promise<void>): void { this.#boundaryObserver = observer; }

  constructor(
    readonly storage: AgentStorage,
    readonly contexts: ContextMaterializer,
    readonly outbox: OutboxRunner,
    readonly goals: GoalService,
    readonly executeCell: ExecuteCell,
    readonly maxSteps = 128,
    readonly compactions?: CompactionService,
    readonly modelExecutor?: ModelExecutor,
  ) {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new ValidationError("Agent run maxSteps must be positive");
  }

  async start(sessionId: string, branchId: string, input: StartAgentRunInput | string): Promise<AgentRunResult> {
    const admitted = await this.admit(sessionId, branchId, input);
    if (isTerminal(admitted.status) || admitted.status === "waiting_for_user") return admitted;
    return this.advance(sessionId, branchId, admitted.runId);
  }

  /** Commits a queued run without advancing it; resident services own advancement. */
  async admit(sessionId: string, branchId: string, input: StartAgentRunInput | string): Promise<AgentRunResult> {
    if (typeof input !== "string" && (!input || typeof input !== "object" || Array.isArray(input))) {
      throw new ValidationError("Agent run input must be a task string or object");
    }
    assertNoReservedModelDispatchInputFields(
      input,
      "Public agent run input",
    );
    const normalized: StartAgentRunInput = typeof input === "string" ? { task: input, goalMode: "none" } : input;
    if (typeof normalized.task !== "string") throw new ValidationError("Agent run task must be a string");
    const task = normalized.task.trim();
    if (!task) throw new ValidationError("Agent run task cannot be empty");
    if (normalized.requestKey !== undefined && (typeof normalized.requestKey !== "string" || !normalized.requestKey.trim())) throw new ValidationError("Agent run requestKey must be a non-empty string");
    if (normalized.goalId !== undefined && (typeof normalized.goalId !== "string" || !normalized.goalId.trim())) throw new ValidationError("Agent run goalId must be a non-empty string");
    if (normalized.goalMode !== undefined && !["none", "auto", "current", "create"].includes(normalized.goalMode)) throw new ValidationError("Agent run goalMode must be none, auto, current, or create");
    if (normalized.goalId && normalized.goalMode === "create") throw new ValidationError("Agent run cannot create and attach an exact goal simultaneously");
    if (normalized.goal && normalized.goalMode !== "auto" && normalized.goalMode !== "create") throw new ValidationError("Agent run goal definition requires goalMode auto or create");
    if (normalized.wakeId !== undefined && (typeof normalized.wakeId !== "string" || !normalized.wakeId.trim())) throw new ValidationError("Agent run wakeId must be a non-empty string");
    if (normalized.requestedRunId !== undefined && (typeof normalized.requestedRunId !== "string" || !normalized.requestedRunId.trim())) throw new ValidationError("Agent run requestedRunId must be a non-empty string");
    if (normalized.suppressTaskMessage !== undefined && typeof normalized.suppressTaskMessage !== "boolean") throw new ValidationError("Agent run suppressTaskMessage must be boolean");
    const requestedGoalMode: AgentRunGoalMode = normalized.goalId ? "current" : normalized.goalMode ?? "none";
    const requestKey = normalized.requestKey ?? `agent-run-request:${newId()}`;
    const result = await this.#runs.run(`${sessionId}/${branchId}`, async () => {
      let state = await this.#state(sessionId, branchId);
      const existing = Object.values(state.agentRuns).find((run) => run.requestKey === requestKey);
      if (existing) {
        if (existing.task !== task || existing.goalMode !== requestedGoalMode || existing.wakeId !== (normalized.wakeId ?? null) || (normalized.goalId !== undefined && existing.goalId !== normalized.goalId)) {
          throw new ValidationError("Agent run requestKey was reused with different durable meaning");
        }
        return this.#result(state, existing);
      }
      const active = Object.values(state.agentRuns).find((run) => !isTerminal(run.status));
      if (active) throw new ValidationError(`Agent run ${active.id} is already ${active.status}`);
      const runId = normalized.requestedRunId ?? newId();
      const currentGoal = Object.values(state.goals).find((goal) => !["completed", "failed", "cancelled"].includes(goal.status));
      let goalId = normalized.goalId;
      const atomic: any[] = [];
      if (goalId) {
        const exact = state.goals[goalId];
        if (!exact) throw new NotFoundError("goal", goalId);
        if (["completed", "failed", "cancelled", "paused"].includes(exact.status)) throw new ValidationError(`Cannot attach a ${exact.status} goal`);
      } else if (requestedGoalMode === "current") {
        if (!currentGoal || currentGoal.status === "paused") throw new ValidationError("goalMode current requires an active current goal");
        goalId = currentGoal.id;
      } else if (requestedGoalMode === "auto" && currentGoal && currentGoal.status !== "paused") {
        goalId = currentGoal.id;
      } else if (requestedGoalMode === "create" || requestedGoalMode === "auto") {
        if (currentGoal) throw new ValidationError(`Cannot create a goal while current goal ${currentGoal.id} is ${currentGoal.status}`);
        goalId = `agent-run-goal:${runId}`;
        atomic.push(...await this.goals.prepareCreateEvents(sessionId, branchId, normalized.goal ?? { description: task }, goalId, "client"));
      }
      const selected = goalId ? state.goals[goalId] : undefined;
      if (selected?.status === "blocked") {
        atomic.push({ sessionId, branchId, type: "GoalStatusChanged", producer: "client", idempotencyKey: `goal-run-resume:${goalId}:${runId}`, payload: { goalId, status: "active", reason: "Product run continued current goal" } });
      }
      const requested = {
        sessionId, branchId, type: "AgentRunRequested" as const, producer: "client",
        idempotencyKey: `agent-run-request:${runId}`,
        payload: {
          runId, task, requestKey, goalMode: requestedGoalMode,
          ...(goalId === undefined ? {} : { goalId }),
          ...(normalized.wakeId === undefined ? {} : { wakeId: normalized.wakeId }),
        },
      };
      if (!normalized.suppressTaskMessage) atomic.push({
        sessionId, branchId, type: "MessageAppended", producer: "client",
        idempotencyKey: `agent-run-task-message:${runId}`,
        payload: { messageId: `agent-run-task-${runId}`, role: "user", content: task },
      });
      atomic.push(requested);
      await this.storage.appendEvents(atomic);
      state = await this.#state(sessionId, branchId);
      if (!state.agentRuns[runId]) throw new Error("Agent run request was not committed");
      return this.#result(state, state.agentRuns[runId]!);
    });
    return result;
  }

  async advance(sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> {
    const result = await this.#runs.run(`${sessionId}/${branchId}`, () => this.#advance(sessionId, branchId, runId));
    await this.#notifyTerminal(result);
    return result;
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
    const result = await this.#runs.run(`${sessionId}/${branchId}`, async () => {
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
    await this.#notifyTerminal(result);
    return result;
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
    const runEffectIds = new Set(state.agentRuns[runId]?.steps.flatMap((step) => [step.effectId, ...step.modelAttempts.map((attempt) => attempt.effectId)]) ?? []);
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

  /** Migrates orphan legacy active goals onto the single typed AgentRun loop. */
  async recoverOrphanGoals(): Promise<number> {
    let recovered = 0;
    for (const branch of await this.storage.listBranches()) {
      if (!await this.#isExecutionOwner(branch.sessionId)) continue;
      const state = await this.#state(branch.sessionId, branch.branchId).catch(() => null);
      if (!state || Object.values(state.agentRuns).some((run) => !isTerminal(run.status))) continue;
      const orphan = Object.values(state.goals).find((goal) => goal.status === "active" && !Object.values(state.agentRuns).some((run) => run.goalId === goal.id));
      if (!orphan) continue;
      await this.start(branch.sessionId, branch.branchId, {
        task: orphan.description, goalId: orphan.id, goalMode: "current",
        requestKey: `legacy-goal-run:${orphan.id}`, requestedRunId: `legacy-goal-run:${orphan.id}`,
      });
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
      let step = run.steps.at(-1);
      if (step?.action && !this.#actionApplied(state, run, step.actionId, step.action)) {
        const action = step.action;
        const cell = action.type === "typescript" ? state.cells[`agent-run-cell-${step.actionId}`] : undefined;
        const interruptedCell = cell && ["proposed", "running", "abandoned"].includes(cell.status);
        // A retained action is already admitted model output. Reconcile it before
        // admitting another model call. Effectful/user-input actions still honor
        // a budget reached by the call that produced them, while an interrupted
        // stable cell is an explicit unknown outcome rather than a budget result.
        if (!interruptedCell &&
            (state.budget.exceeded || budgetReached(state.budget.limits, state.budget)) &&
            ["typescript", "clarification", "permission"].includes(action.type)) {
          await this.#terminal(sessionId, branchId, run, "budget_exceeded", "Session budget boundary reached before action execution");
          continue;
        }
        const progressed = await this.#applyAction(sessionId, branchId, state, run, step.actionId, action);
        if (!progressed) return this.get(sessionId, branchId, runId);
        continue;
      }
      if (step?.rejection && consecutiveActionRejections(run) > MAX_ACTION_CORRECTION_ATTEMPTS) {
        const failedCheck = Object.values(run.goalChecks).at(-1);
        await this.#terminal(sessionId, branchId, run, failedCheck?.status === "failed" ? "blocked" : "failed", failedCheck?.status === "failed" ? `Goal repair stopped after a failed required gate: ${failedCheck.summary}` : `Rejected model action: ${step.rejection}`);
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

      if (!step || step.action !== undefined || step.rejection !== undefined) {
        if (this.#boundaryObserver) {
          await this.#boundaryObserver(sessionId, branchId, run.id);
          ({ state, events, run } = await this.#load(sessionId, branchId, runId));
        }
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
      if (step.rejection) continue;
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
    const observations = step.observationEventIds.map((eventId) => {
      const event = events.find((candidate) => candidate.id === eventId);
      if (!event) throw new ValidationError(`Agent run observation event is missing: ${eventId}`);
      return { eventId: event.id, type: event.type, payload: JSON.parse(JSON.stringify(event.payload)) as JsonValue };
    });
    const window = this.#windowConfiguration(state);
    let attempt = step.modelAttempts.at(-1);
    if (!attempt && state.contexts[step.contextId]) {
      const retainedContextEvent = events.find((event) => event.type === "ContextMaterialized" && (event.payload as EventPayloads["ContextMaterialized"]).contextId === step.contextId) as AgentEvent<"ContextMaterialized"> | undefined;
      if (!retainedContextEvent) throw new ValidationError(`Agent run retained context is unavailable: ${step.contextId}`);
      const modelDispatch = this.#agentDispatch(state);
      const estimatedInputTokens = estimateContextWindow(retainedContextEvent.payload.context).estimatedTokens;
      await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunModelAttemptStarted", producer: "recovery",
        idempotencyKey: `agent-run-model-attempt:${run.id}:${step.ordinal}:1`,
        payload: {
          runId: run.id, stepId: step.id, ordinal: step.ordinal, attempt: 1,
          contextId: step.contextId, callId: step.callId, effectId: step.effectId, reason: "initial",
          estimatedInputTokens, contextWindow: window.provenance,
        },
      }, {
        sessionId, branchId, type: "SessionStatusChanged", producer: "recovery",
        idempotencyKey: `agent-run-session-running:${step.callId}`, payload: { status: "running" },
      }, {
        sessionId, branchId, type: "ModelCallRequested", producer: "recovery",
        idempotencyKey: `agent-run-model-call:${step.callId}`,
        payload: {
          callId: step.callId, contextId: step.contextId, effectId: step.effectId,
          modelDispatch, estimatedInputTokens, attempt: 1, contextWindow: window.provenance,
        },
      }]);
      const loaded = await this.#load(sessionId, branchId, run.id);
      return this.#completeStepModel(sessionId, branchId, loaded.state, loaded.events, loaded.run, loaded.run.steps.at(-1)!);
    }
    if (!attempt) {
      const modelDispatch = this.#agentDispatch(state);
      let materialized;
      let proactiveCompactions = 0;
      if (this.compactions) {
        const admission = await new ContextWindowController(window.configuration).admit({
          buildCandidate: ({ completedCompactions }) => this.contexts.materialize(sessionId, branchId, {
            contextId: completedCompactions === 0 ? step.contextId : `${step.contextId}-window-${completedCompactions}`,
            idempotencyKey: `agent-run-context:${run.id}:${step.ordinal}:window:${completedCompactions}`,
            additionalRecordIds: step.observationEventIds,
            transform: (base) => agentProviderContext(base, run, step.ordinal, observations, modelDispatch),
          }),
          estimate: (candidate) => estimateContextWindow(candidate.context).estimatedTokens,
          compact: async ({ iteration }) => {
            const compacted = await this.compactions!.compact(sessionId, branchId, {
              strategy: "deterministic-extractive-v1", reason: "automatic-threshold", requestedBy: "supervisor",
              idempotencyKey: `agent-run-threshold:${run.id}:${step.ordinal}:${iteration}`,
              retainRecentMessages: Math.max(1, AUTOMATIC_COMPACTION_RECENT_MESSAGES - iteration + 1), capacity: window.provenance,
            });
            if (compacted.status === "completed") {
              proactiveCompactions++;
              return { outcome: "compacted" as const, provenance: { compactionId: compacted.compactionId, contextId: compacted.contextId, sourceDigest: compacted.sourceDigest } };
            }
            return { outcome: "protected-only" as const, protectedSourceCount: Math.max(0, events.length - compacted.sourceEventIds.length) };
          },
        });
        materialized = admission.candidate;
      } else {
        let contextEvent = events.find((event) => event.type === "ContextMaterialized" && (event.payload as EventPayloads["ContextMaterialized"]).contextId === step.contextId) as AgentEvent<"ContextMaterialized"> | undefined;
        if (!contextEvent) contextEvent = (await this.contexts.materialize(sessionId, branchId, {
          contextId: step.contextId, idempotencyKey: `agent-run-context:${run.id}:${step.ordinal}`,
          additionalRecordIds: step.observationEventIds,
          transform: (base) => agentProviderContext(base, run, step.ordinal, observations, modelDispatch),
        })).event;
        materialized = { contextId: step.contextId, context: contextEvent.payload.context, event: contextEvent };
      }
      const estimatedInputTokens = estimateContextWindow(materialized.context).estimatedTokens;
      await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunModelAttemptStarted", producer: "supervisor",
        idempotencyKey: `agent-run-model-attempt:${run.id}:${step.ordinal}:1`,
        payload: {
          runId: run.id, stepId: step.id, ordinal: step.ordinal, attempt: 1,
          contextId: materialized.contextId, callId: step.callId, effectId: step.effectId,
          reason: proactiveCompactions ? "proactive-compaction" : "initial",
          estimatedInputTokens,
          contextWindow: window.provenance,
        },
      }, {
        sessionId, branchId, type: "SessionStatusChanged", producer: "supervisor",
        idempotencyKey: `agent-run-session-running:${step.callId}`, payload: { status: "running" },
      }, {
        sessionId, branchId, type: "ModelCallRequested", producer: "supervisor",
        idempotencyKey: `agent-run-model-call:${step.callId}`,
        payload: {
          callId: step.callId, contextId: materialized.contextId, effectId: step.effectId,
          modelDispatch, estimatedInputTokens, attempt: 1, contextWindow: window.provenance,
        },
      }]);
      const loaded = await this.#load(sessionId, branchId, run.id);
      return this.#completeStepModel(sessionId, branchId, loaded.state, loaded.events, loaded.run, loaded.run.steps.at(-1)!);
    }

    const contextEvent = events.find((event) => event.type === "ContextMaterialized" &&
      (event.payload as EventPayloads["ContextMaterialized"]).contextId === attempt!.contextId) as AgentEvent<"ContextMaterialized"> | undefined;
    if (!contextEvent) throw new ValidationError(`Agent run attempt context is unavailable: ${attempt.contextId}`);
    const context = contextEvent.payload.context;
    let current = await this.#state(sessionId, branchId);
    const effectKey = attempt.attempt === 1
      ? `agent-run-model:${run.id}:${step.ordinal}`
      : `agent-run-model:${run.id}:${step.ordinal}:attempt:${attempt.attempt}`;
    const admittedCall = current.modelCalls[attempt.callId];
    if (!admittedCall) throw new ValidationError("Agent run attempt is missing its atomically retained model call");
    const retainedDispatch = admittedCall.modelDispatch;
    if (!current.effects[attempt.effectId]) {
      const requestedEffectId = await this.outbox.request({
        sessionId, branchId, executor: "model", operation: "complete",
        input: { callId: attempt.callId, context, modelDispatch: retainedDispatch as unknown as JsonValue },
        idempotencyKey: effectKey, idempotent: false,
      });
      if (requestedEffectId !== attempt.effectId) throw new ValidationError("Agent run model effect identity is not stable");
      current = await this.#state(sessionId, branchId);
    }
    let call = current.modelCalls[attempt.callId]!;
    if (call.status === "requested") {
      const effect = current.effects[attempt.effectId];
      const execution = effect && !["requested", "started"].includes(effect.status)
        ? { outcome: effect.status, output: effect.output, error: effect.error, modelFailure: effect.modelFailure }
        : await this.outbox.run(attempt.effectId);
      if (execution.outcome === "succeeded") {
        const output = modelOutput(execution.output, retainedDispatch);
        const terminalEvents = await this.storage.loadEvents(sessionId, { branchId });
        await this.#finalizeSucceeded(sessionId, branchId, attempt.callId, output, effectElapsedMs(terminalEvents, attempt.effectId));
      } else {
        if (execution.outcome === "requested" || execution.outcome === "started") throw new ValidationError("Model effect remained non-terminal");
        await this.#finalizeTerminated(sessionId, branchId, attempt.callId, execution.outcome, execution.error, execution.modelFailure);
      }
      current = await this.#state(sessionId, branchId);
      call = current.modelCalls[attempt.callId]!;
    }
    if (call.status !== "succeeded") {
      const effect = current.effects[attempt.effectId];
      const classification = providerClassification(effect?.modelFailure, call.modelDispatch.configuration.provider, call.modelDispatch.configuration.model, call.status);
      if (this.compactions && classification.code === ProviderModelErrorCode.ProviderConfirmedContextWindowOverflow) {
        const compacted = await this.compactions.compact(sessionId, branchId, {
          strategy: "deterministic-extractive-v1", reason: "provider-overflow", requestedBy: "supervisor",
          idempotencyKey: `agent-run-overflow:${run.id}:${step.ordinal}:${attempt.attempt}`,
          retainRecentMessages: Math.max(1, AUTOMATIC_COMPACTION_RECENT_MESSAGES - attempt.attempt), capacity: window.provenance,
        });
        if (compacted.status === "completed") {
          const nextAttempt = attempt.attempt + 1;
          const nextContext = await this.contexts.materialize(sessionId, branchId, {
            contextId: `${step.contextId}-overflow-${nextAttempt}`,
            idempotencyKey: `agent-run-overflow-context:${run.id}:${step.ordinal}:${nextAttempt}`,
            additionalRecordIds: step.observationEventIds,
            transform: (base) => agentProviderContext(base, run, step.ordinal, observations, call.modelDispatch),
          });
          const nextEstimate = estimateContextWindow(nextContext.context).estimatedTokens;
          const retry = planContextWindowOverflowRetry({
            classification, retriesAlreadyAttempted: attempt.attempt - 1,
            rejectedEstimatedInputTokens: attempt.estimatedInputTokens, nextEstimatedInputTokens: nextEstimate,
          });
          if (retry.retry) {
            const callId = `${step.id}-call-attempt-${nextAttempt}`;
            const retryEffectKey = `agent-run-model:${run.id}:${step.ordinal}:attempt:${nextAttempt}`;
            const effectId = stableEffectId(sessionId, retryEffectKey);
            await this.storage.appendEvents([{
              sessionId, branchId, type: "AgentRunModelAttemptStarted", producer: "supervisor",
              idempotencyKey: `agent-run-model-attempt:${run.id}:${step.ordinal}:${nextAttempt}`,
              payload: {
                runId: run.id, stepId: step.id, ordinal: step.ordinal, attempt: nextAttempt,
                contextId: nextContext.contextId, callId, effectId,
                reason: "provider-overflow", estimatedInputTokens: nextEstimate, contextWindow: window.provenance,
                retryOfCallId: attempt.callId,
              },
            }, {
              sessionId, branchId, type: "SessionStatusChanged", producer: "supervisor",
              idempotencyKey: `agent-run-session-running:${callId}`, payload: { status: "running" },
            }, {
              sessionId, branchId, type: "ModelCallRequested", producer: "supervisor",
              idempotencyKey: `agent-run-model-call:${callId}`,
              payload: {
                callId, contextId: nextContext.contextId, effectId,
                modelDispatch: call.modelDispatch, estimatedInputTokens: nextEstimate,
                attempt: nextAttempt, retryOfCallId: attempt.callId, contextWindow: window.provenance,
              },
            }]);
            const loaded = await this.#load(sessionId, branchId, run.id);
            return this.#completeStepModel(sessionId, branchId, loaded.state, loaded.events, loaded.run, loaded.run.steps.at(-1)!);
          }
        }
      }
      const runNow = current.agentRuns[run.id]!;
      const failedCheck = Object.values(runNow.goalChecks).at(-1);
      const status = call.status === "unknown" ? "unknown" : call.status === "cancelled" || runNow.cancellationRequested ? "cancelled" : failedCheck?.status === "failed" ? "blocked" : "failed";
      if (status === "cancelled" && !runNow.cancellationRequested) await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunCancellationRequested", producer: "supervisor",
        idempotencyKey: `agent-run-effect-cancel:${run.id}`, payload: { runId: run.id, reason: call.error ?? "Model call cancelled" },
      }]);
      const terminalReason = status === "cancelled" ? runNow.cancellationReason ?? call.error ?? "Cancellation requested"
        : status === "blocked" ? `Goal repair stopped after a failed required gate: ${failedCheck!.summary}` : call.error ?? `Model call ${call.status}`;
      await this.#terminal(sessionId, branchId, (await this.#state(sessionId, branchId)).agentRuns[run.id]!, status, terminalReason);
      return;
    }
    const output = completedModelOutput(current, call);
    if (output.result.kind === "contract-violation") {
      const providerToolCallId = output.result.violation.evidence.toolCalls
        .find((item) => item.callId !== undefined)?.callId;
      await this.storage.appendEvents([{
        sessionId, branchId, type: "AgentRunActionRejected", producer: "supervisor",
        idempotencyKey: `agent-run-action-rejected:${step.actionId}`,
        payload: {
          runId: run.id, stepId: step.id, ordinal: step.ordinal, actionId: step.actionId,
          source: {
            kind: "contract-violation", modelCallId: attempt.callId,
            ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
            resultDigest: output.resultDigest,
          },
          error: output.result.violation.message,
        },
      }]);
      return;
    }
    if (output.result.kind !== "tool-submission") {
      throw new ValidationError("Agent run required-tool dispatch returned a text result");
    }
    const submission = output.result.submission;
    const action: AgentAction = agentActionFromToolSubmission({
      name: submission.name,
      input: submission.input,
    } as unknown as Parameters<typeof agentActionFromToolSubmission>[0]);
    await this.storage.appendEvents([{
      sessionId, branchId, type: "AgentRunActionCommitted", producer: "supervisor",
      idempotencyKey: `agent-run-action:${step.actionId}`,
      payload: {
        runId: run.id, stepId: step.id, ordinal: step.ordinal, actionId: step.actionId,
        source: {
          kind: "tool-submission", modelCallId: attempt.callId,
          providerToolCallId: submission.providerToolCallId,
          resultDigest: output.resultDigest,
        },
        action,
      },
    }]);
    acceptanceCrashAfterActionCommit(step.ordinal);
  }

  #actionApplied(state: AgentState, run: AgentRunState, actionId: string, action: AgentAction): boolean {
    if (action.type === "typescript") {
      const status = state.cells[`agent-run-cell-${actionId}`]?.status;
      return status === "committed" || status === "failed";
    }
    if (action.type === "clarification" || action.type === "permission") {
      const request = run.inputRequests[`agent-run-input-${actionId}`];
      return request?.actionId === actionId && request.kind === action.type && request.question === action.question &&
        (action.type === "clarification" || request.permission === action.permission);
    }
    if (action.type === "final") {
      const messageId = `agent-run-final-${run.id}`;
      const message = state.messages.find((candidate) => candidate.id === messageId);
      if (run.status === "succeeded" && run.finalMessageId === messageId && message?.role === "assistant" && message.content === action.content) return true;
      const check = run.goalChecks[actionId];
      return check?.status === "failed" || (check?.status === "unknown" && run.status === "unknown");
    }
    if (action.type === "blocked") return run.status === "blocked" && run.reason === action.reason;
    return run.status === "failed" && run.reason === action.error;
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
    // required gate passes against the attributable workspace material pin.
    if (run.goalId) {
      const prior = run.goalChecks[actionId];
      if (!prior) {
        const goal = await this.goals.requestCompletion(sessionId, branchId, run.goalId);
        const requestId = goal.completionRequestId;
        if (!requestId) throw new ValidationError("Gate-checked goal is missing its completion request ID");
        const unknown = goal.gates.find((gate) => gate.required && gate.status === "unknown");
        const status = unknown ? "unknown" as const : goal.status === "completed" ? "passed" as const : "failed" as const;
        const summary = boundedGoalSummary(goal, status);
        const gateEvaluationEventIds = await this.goals.completionEvaluationEventIds(goal.goalId, requestId);
        const check = {
          sessionId, branchId, type: "AgentRunGoalCheckRecorded" as const, producer: "supervisor",
          idempotencyKey: `agent-run-goal-check:${run.id}:${actionId}`,
          payload: { runId: run.id, actionId, goalId: goal.goalId, requestId, status, summary, gateEvaluationEventIds },
        };
        if (status === "failed") {
          // The bounded check record is the one exact-once next-step
          // observation; raw gate/effect chatter remains queryable history.
          await this.storage.appendEvents([check, {
            sessionId, branchId, type: "GoalStatusChanged", producer: "supervisor",
            idempotencyKey: `agent-run-goal-repair:${run.id}:${actionId}`,
            payload: { goalId: goal.goalId, status: "active", reason: "Agent run continuing after required completion gates did not pass" },
          }]);
          return true;
        }
        if (status === "unknown") {
          await this.storage.appendEvents([check, {
            sessionId, branchId, type: "AgentRunStatusChanged", producer: "supervisor",
            idempotencyKey: `agent-run-terminal:${run.id}`,
            payload: { runId: run.id, status: "unknown", reason: summary },
          }]);
          return true;
        }
        const messageId = `agent-run-final-${run.id}`;
        await this.storage.appendEvents([check, {
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
      if (prior.status === "failed") return true;
      if (prior.status === "unknown") {
        await this.#terminal(sessionId, branchId, run, "unknown", prior.summary);
        return true;
      }
      // Recovery after a retained passed check but before terminal commit.
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

  #windowConfiguration(state: AgentState): { configuration: ModelContextWindowConfiguration; provenance: ContextCapacityProvenance } {
    const resolved = this.modelExecutor?.contextCapacity(state.model) ?? { provider: state.model.provider, model: state.model.model, source: "unknown" as const, contextWindowTokens: null };
    const outputReserveTokens = resolved.contextWindowTokens === null ? Math.max(0, state.model.maxOutputTokens ?? 0)
      : Math.min(resolved.contextWindowTokens - 1, Math.max(1, state.model.maxOutputTokens ?? Math.min(4_096, Math.floor(resolved.contextWindowTokens * 0.1))));
    const source = resolved.source === "provider-metadata" ? ModelContextCapacitySource.ProviderMetadata
      : resolved.source === "model-catalog" ? ModelContextCapacitySource.ModelCatalog
      : resolved.source === "operator-configuration" ? ModelContextCapacitySource.OperatorConfiguration : ModelContextCapacitySource.Unknown;
    const configuration: ModelContextWindowConfiguration = { provenance: { provider: resolved.provider, model: resolved.model, source }, contextWindowTokens: resolved.contextWindowTokens, maxOutputReserveTokens: outputReserveTokens, estimatorId: "utf8-bytes-per-token-v1", triggerRatio: 0.8, targetRatio: 0.6 };
    return { configuration, provenance: { provider: resolved.provider, model: resolved.model, source, contextWindowTokens: resolved.contextWindowTokens, outputReserveTokens, estimatorId: configuration.estimatorId, triggerRatio: configuration.triggerRatio, targetRatio: configuration.targetRatio } };
  }

  #agentDispatch(state: AgentState): ModelDispatch {
    return this.modelExecutor
      ? new ModelEffectAdmissionService(this.modelExecutor)
          .requestBuiltInStructured(AGENT_TOOL_CONTRACT_ID, state.model).modelDispatch
      : fallbackDispatch(state);
  }

  async #terminal(
    sessionId: string,
    branchId: string,
    run: AgentRunState,
    status: Exclude<AgentRunStatus, "queued" | "running" | "waiting_for_user" | "succeeded">,
    reason: string,
  ): Promise<void> {
    const state = await this.#state(sessionId, branchId);
    const current = state.agentRuns[run.id];
    if (!current || isTerminal(current.status)) return;
    if (status === "cancelled" && !current.cancellationRequested) {
      throw new ValidationError("An agent run must record cancellation intent before becoming cancelled");
    }
    const events: any[] = [];
    const goal = current.goalId ? state.goals[current.goalId] : undefined;
    const failedCheck = Object.values(current.goalChecks).at(-1);
    const effectiveStatus = status === "failed" && failedCheck?.status === "failed" ? "blocked" : status;
    const effectiveReason = effectiveStatus === "blocked" && failedCheck?.status === "failed" ? `Goal repair stopped after a failed required gate: ${failedCheck.summary}` : reason;
    if (effectiveStatus === "blocked" && goal?.status === "active" && failedCheck?.status === "failed") {
      events.push({ sessionId, branchId, type: "GoalStatusChanged", producer: "supervisor", idempotencyKey: `agent-run-goal-bounded:${run.id}`, payload: { goalId: goal.id, status: "blocked", reason: effectiveReason } });
    }
    events.push({
      sessionId, branchId, type: "AgentRunStatusChanged", producer: "supervisor",
      idempotencyKey: `agent-run-terminal:${run.id}`,
      payload: { runId: run.id, status: effectiveStatus, reason: effectiveReason },
    });
    await this.storage.appendEvents(events);
  }

  async #finalizeTerminated(
    sessionId: string,
    branchId: string,
    callId: string,
    outcome: "failed" | "cancelled" | "unknown",
    error?: string,
    failureCode?: ModelEffectFailureCode,
  ): Promise<void> {
    await this.storage.appendEvents([{
      sessionId, branchId, type: "ModelCallTerminated", producer: "supervisor",
      idempotencyKey: `model-terminal:${callId}`,
      payload: { callId, outcome, ...(error === undefined ? {} : { error }), ...(failureCode === undefined ? {} : { failureCode }) },
    }, {
      sessionId, branchId, type: "SessionStatusChanged", producer: "supervisor",
      idempotencyKey: `turn-idle:${callId}`, payload: { status: "idle", reason: `model ${outcome}` },
    }]);
  }

  async #finalizeSucceeded(
    sessionId: string,
    branchId: string,
    callId: string,
    output: ModelEffectOutputV2,
    wallTimeMs: number,
  ): Promise<void> {
    const state = await this.#state(sessionId, branchId);
    if (state.modelCalls[callId]?.status === "succeeded") return;
    const call = state.modelCalls[callId];
    if (!call) throw new ValidationError(`Model call is unavailable: ${callId}`);
    const usageSource = output.response.kind === "guard-aborted" ? "conservative-guard-estimate" as const : "provider-reported" as const;
    const usage = output.response.usage;
    const tokens = usageSource === "provider-reported"
      ? usage!.inputTokens + usage!.outputTokens
      : call.estimatedInputTokens + (call.contextWindow?.outputReserveTokens ?? call.modelDispatch.configuration.maxOutputTokens ?? 0);
    const costUsd = usage?.costUsd ?? 0;
    const result = compactModelCallResult(output);
    const completion: any[] = [{
      sessionId, branchId, type: "ModelCallCompleted", producer: "supervisor",
      idempotencyKey: `model-complete:${callId}`,
      payload: {
        callId, result, resultDigest: output.resultDigest,
        termination: output.response.termination, usage,
        warnings: [...output.response.warnings], usageSource,
      },
    }, {
      sessionId, branchId, type: "BudgetDebited", producer: "supervisor",
      idempotencyKey: `budget:${callId}`,
      payload: { callId, tokens, costUsd, turns: 1, wallTimeMs, usageSource },
    }];
    const exceeded = budgetReached(state.budget.limits, {
      tokens: state.budget.tokens + tokens,
      costUsd: state.budget.costUsd + costUsd,
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
    const modelEffects = new Set(run.steps.flatMap((step) => [step.effectId, ...step.modelAttempts.map((attempt) => attempt.effectId)]));
    const gateEffects = new Set(events.filter((event) => event.type === "GoalGateEvaluationRecorded").map((event) => (event.payload as EventPayloads["GoalGateEvaluationRecorded"]).effectId).filter((id): id is string => id !== undefined));
    const requestIndex = events.findIndex((event) => event.id === run.requestEventId);
    return events.slice(requestIndex + 1).filter((event) => {
      if (!OBSERVATION_TYPES.has(event.type) || observed.has(event.id)) return false;
      if (event.type === "EffectOutcomeRecorded" && (modelEffects.has((event.payload as EventPayloads["EffectOutcomeRecorded"]).effectId) || gateEffects.has((event.payload as EventPayloads["EffectOutcomeRecorded"]).effectId))) return false;
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

  async #notifyTerminal(result: AgentRunResult): Promise<void> {
    if (this.#terminalObserver && isTerminal(result.status)) await this.#terminalObserver(result);
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

function acceptanceCrashAfterActionCommit(ordinal: number): void {
  if (process.env.AGENCITY_ACCEPTANCE !== "1") return;
  if (process.env.AGENCITY_ACCEPTANCE_FAILPOINT !== `agent-action-committed:${ordinal}`) return;
  process.stderr.write(`[agencity acceptance failpoint] committed AgentRunActionCommitted for step ${ordinal}; exiting service before action application\n`);
  process.exit(86);
}

function agentProviderContext(
  base: JsonValue,
  run: AgentRunState,
  stepOrdinal: number,
  observations: readonly { eventId: string; type: string; payload: JsonValue }[],
  modelDispatch: ModelDispatch,
): JsonValue {
  if (modelDispatch.responseContract.kind !== "required-tool-set") {
    throw new ValidationError("Agent provider context requires its retained formal tool contract");
  }
  const durable = base && typeof base === "object" && !Array.isArray(base) ? base as Record<string, JsonValue> : {};
  const existingMessages = Array.isArray(durable.messages) ? durable.messages.filter((message) =>
    message && typeof message === "object" && !Array.isArray(message) &&
    ["system", "user", "assistant", "tool"].includes(String(message.role)) && typeof message.content === "string") : [];
  const recentActivity = Array.isArray(durable.recentActivity)
    ? durable.recentActivity.filter((item) => !item || typeof item !== "object" || Array.isArray(item) || !OBSERVATION_TYPES.has(String(item.type)))
    : [];
  const durableContext = Object.fromEntries([
    "runtime", "profile", "session", "budget", "goal", "tasks", "mailbox",
    "terminalNotices", "recursiveModels", "documents", "inputSets", "heartbeats", "schedules", "wakes", "activeRuns",
    "harness", "compactions", "workingValues", "artifacts", "queryHints",
  ].filter((key) => durable[key] !== undefined).map((key) => [key, durable[key]]));
  const correctingRejectedAction = observations.some((observation) => observation.type === "AgentRunActionRejected");
  const stepInput = {
    runId: run.id,
    task: run.task,
    stepOrdinal,
    status: run.status,
    observations,
    durableContext,
    instruction: correctingRejectedAction
      ? "The prior response was rejected without executing any code. Use the exact typed validation error in the observation and call exactly one provided tool with valid input."
      : observations.length
      ? "Continue from these new exact-once durable observations."
      : "Choose the first concrete action for this task.",
  };
  return JSON.parse(JSON.stringify({
    ...durable,
    recentActivity,
    responseContract: {
      contractId: modelDispatch.responseContract.contractId,
      version: modelDispatch.responseContract.version,
      contractDigest: modelDispatch.responseContract.contractDigest,
      schemaEnforcement: modelDispatch.responseContract.schemaEnforcement,
      selection: modelDispatch.responseContract.selection,
    },
    run: stepInput,
    messages: [
      { role: "system", content: `${String(durable.basePolicy ?? "")}\n\n${AGENT_TOOL_SELECTION_POLICY}\n\n${SDK_GUIDE}` },
      ...existingMessages,
      { role: "user", content: `AGENCITY DURABLE RUN STEP\n${JSON.stringify(stepInput)}` },
    ],
  })) as JsonValue;
}

function providerClassification(
  failureCode: ModelEffectFailureCode | undefined,
  provider: string,
  model: string,
  outcome: "requested" | "succeeded" | "failed" | "cancelled" | "unknown",
): ProviderModelErrorClassification {
  if (outcome === "unknown") return { provider, model, code: ProviderModelErrorCode.Unknown };
  if (failureCode === "provider-context-window-overflow") return { provider, model, code: ProviderModelErrorCode.ProviderConfirmedContextWindowOverflow };
  return { provider, model, code: ProviderModelErrorCode.Generic };
}

function fallbackDispatch(state: AgentState): ModelDispatch {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(JSON.stringify({ provider: state.model.provider, model: state.model.model, fallback: true }));
  const catalogDigest = hash.digest("hex");
  const responseContract = resolveBuiltInModelResponseContract(AGENT_TOOL_CONTRACT_ID, "runtime-validated");
  return resolveModelDispatch({
    configuration: state.model,
    capability: state.model.reasoningEffort === "provider-default"
      ? { status: "unsupported", levels: [] }
      : { status: "unverified", levels: STANDARD_UNVERIFIED_REASONING_LEVELS },
    catalogDigest,
    responseContract,
    responseCapability: {
      kind: "required-tool-set",
      capability: {
        status: "runtime-validated",
        requiredChoice: "unknown",
        parallelCalls: "runtime-rejected",
        streaming: true,
        catalogDigest,
        adapter: "agencity.agent-run.fallback.v1",
      },
    },
  });
}

function modelOutput(value: JsonValue | undefined, dispatch: ModelDispatch): ModelEffectOutputV2 {
  return validateModelEffectOutputV2(value, {
    responseContract: dispatch.responseContract,
    responseCapability: dispatch.responseCapability,
    configuredProvider: dispatch.configuration.provider,
  });
}

function completedModelOutput(
  state: AgentState,
  call: AgentState["modelCalls"][string],
): ModelEffectOutputV2 {
  const effect = state.effects[call.effectId];
  if (!effect || effect.status !== "succeeded") {
    throw new ValidationError("Agent run model completion is missing its retained successful effect");
  }
  const output = modelOutput(effect.output, call.modelDispatch);
  if (call.resultDigest !== output.resultDigest) {
    throw new ValidationError("Agent run model completion result digest disagrees with its retained effect");
  }
  return output;
}

function compactModelCallResult(output: ModelEffectOutputV2): EventPayloads["ModelCallCompleted"]["result"] {
  if (output.result.kind === "text") return { kind: "text", textDigest: output.result.textDigest };
  if (output.result.kind === "tool-submission") {
    return {
      kind: "tool-submission",
      providerToolCallId: output.result.submission.providerToolCallId,
      name: output.result.submission.name,
      inputDigest: output.result.submission.inputDigest,
    };
  }
  const providerToolCallId = output.result.violation.evidence.toolCalls
    .find((item) => item.callId !== undefined)?.callId;
  return {
    kind: "contract-violation",
    code: output.result.violation.code,
    evidenceDigest: output.result.violation.evidenceDigest,
    ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
  };
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

function boundedGoalSummary(goal: GoalHandle, status: "passed" | "failed" | "unknown"): string {
  const gates = goal.gates.filter((gate) => gate.required).map((gate) => ({
    gateId: gate.gateId, name: gate.name, status: gate.status,
    currentStale: gate.currentStale,
    ...(gate.output === undefined ? {} : { output: gate.output }),
    ...(gate.error === undefined ? {} : { error: gate.error }),
    ...(gate.currentStaleReason === undefined ? {} : { staleReason: gate.currentStaleReason }),
  }));
  const encoded = JSON.stringify({ status, goalId: goal.goalId, reason: goal.reason ?? null, gates });
  return encoded.length <= 16_384 ? encoded : `${encoded.slice(0, 16_383)}…`;
}

function consecutiveActionRejections(run: AgentRunState): number {
  const firstNonRejectedOffset = [...run.steps].reverse()
    .findIndex((step) => step.rejection === undefined);
  return firstNonRejectedOffset === -1 ? run.steps.length : firstNonRejectedOffset;
}

function isTerminal(status: AgentRunStatus): boolean { return TERMINAL_RUN_STATUSES.includes(status); }
