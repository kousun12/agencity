import {
  CapabilityUnavailableError,
  NotFoundError,
  ValidationError,
  newId,
  projectEvents,
  type AgentState,
  type BudgetLimits,
  type ContextCapacityProvenance,
  type EffectOutcome,
  type EventPayloads,
  type JsonValue,
  type Usage,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import { ContextMaterializer } from "./context.ts";
import { OutboxRunner } from "./outbox.ts";
import type { ModelExecutor } from "../executors/index.ts";
import { CompactionService, AUTOMATIC_COMPACTION_RECENT_MESSAGES } from "./context-compaction.ts";
import {
  ModelContextCapacitySource,
  ProviderModelErrorCode,
  ContextWindowController,
  planContextWindowOverflowRetry,
  type ModelContextWindowConfiguration,
  type ProviderModelErrorClassification,
} from "./context-window.ts";
import { estimateContextWindow } from "./compaction-core.ts";

interface ModelOutput { text: string; finishReason: string; usage: Usage }

function parseOutput(value: JsonValue | undefined): ModelOutput {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string" ||
      typeof value.finishReason !== "string" || !value.usage || typeof value.usage !== "object" ||
      Array.isArray(value.usage)) throw new ValidationError("Model executor returned an invalid response");
  const usage = value.usage;
  if (typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number" ||
      typeof usage.costUsd !== "number") throw new ValidationError("Model usage is invalid");
  return {
    text: value.text,
    finishReason: value.finishReason,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd },
  };
}

class TurnQueue {
  readonly #tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    await prior.catch(() => {});
    try { return await fn(); }
    finally { release(); if (this.#tails.get(key) === tail) this.#tails.delete(key); }
  }
}

export class ModelLoop {
  readonly #turns = new TurnQueue();

  constructor(
    readonly storage: AgentStorage,
    readonly contexts: ContextMaterializer,
    readonly outbox: OutboxRunner,
    readonly compactions?: CompactionService,
    readonly modelExecutor?: ModelExecutor,
  ) {}

  async turn(
    sessionId: string,
    branchId: string,
  ): Promise<{ outcome: EffectOutcome; message?: string; error?: string }> {
    return this.#turns.run(`${sessionId}/${branchId}`, () => this.#turn(sessionId, branchId));
  }

  async #turn(
    sessionId: string,
    branchId: string,
  ): Promise<{ outcome: EffectOutcome; message?: string; error?: string }> {
    const history = await this.storage.loadEvents(sessionId, { branchId });
    if (!history.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const session = await this.storage.getSession?.(sessionId);
    if (session?.executionOwnerDeviceId && this.storage.deviceId && session.executionOwnerDeviceId !== this.storage.deviceId) {
      throw new CapabilityUnavailableError(`execution of session owned by device ${session.executionOwnerDeviceId}`, `${this.storage.name} device ${this.storage.deviceId} (automatic ownership failover is unavailable)`);
    }
    const state = projectEvents(history);
    assertBudgetAvailable(state);
    const turnId = newId();
    await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "SessionStatusChanged",
      producer: "supervisor",
      idempotencyKey: `turn-running:${turnId}`,
      payload: { status: "running" },
    }]);
    const started = performance.now();
    const window = this.#windowConfiguration(state);
    let materialized;
    if (this.compactions) {
      const admission = await new ContextWindowController(window.configuration).admit({
        buildCandidate: ({ completedCompactions }) => this.contexts.materialize(sessionId, branchId, {
          contextId: `legacy-turn-${turnId}-context-${completedCompactions}`,
          idempotencyKey: `legacy-turn-context:${turnId}:${completedCompactions}`,
        }),
        estimate: (candidate) => estimateContextWindow(candidate.context).estimatedTokens,
        compact: async ({ iteration }) => {
          const compacted = await this.compactions!.compact(sessionId, branchId, {
            strategy: "deterministic-extractive-v1", reason: "automatic-threshold", requestedBy: "supervisor",
            idempotencyKey: `legacy-turn-threshold:${turnId}:${iteration}`,
            retainRecentMessages: Math.max(1, AUTOMATIC_COMPACTION_RECENT_MESSAGES - iteration + 1), capacity: window.provenance,
          });
          return compacted.status === "completed"
            ? { outcome: "compacted" as const, provenance: { compactionId: compacted.compactionId, contextId: compacted.contextId, sourceDigest: compacted.sourceDigest } }
            : { outcome: "protected-only" as const, protectedSourceCount: Math.max(0, history.length - compacted.sourceEventIds.length) };
        },
      });
      materialized = admission.candidate;
    } else materialized = await this.contexts.materialize(sessionId, branchId);

    let rejectedEstimate = estimateContextWindow(materialized.context).estimatedTokens;
    let priorCallId: string | undefined;
    for (let attempt = 1; attempt <= 1 + 2; attempt++) {
      const callId = `legacy-turn-${turnId}-call-${attempt}`;
      const effectId = `legacy-turn-${turnId}-effect-${attempt}`;
      const effectKey = `model:${callId}`;
      await this.storage.appendEvents([{
        sessionId, branchId, type: "SessionStatusChanged", producer: "supervisor",
        idempotencyKey: `turn-running:${turnId}:${attempt}`, payload: { status: "running" },
      }, {
        sessionId, branchId, type: "ModelCallRequested", producer: "supervisor",
        idempotencyKey: `model-call:${callId}`,
        payload: {
          callId, contextId: materialized.contextId, effectId, provider: state.model.provider, model: state.model.model,
          attempt, ...(priorCallId === undefined ? {} : { retryOfCallId: priorCallId }), contextWindow: window.provenance,
        },
      }, {
        sessionId, branchId, type: "EffectRequested", producer: "supervisor",
        idempotencyKey: effectKey,
        payload: { effectId, executor: "model", operation: "complete", input: { callId, context: materialized.context, configuration: state.model as unknown as JsonValue }, idempotencyKey: effectKey, idempotent: false },
      }]);
      const execution = await this.outbox.run(effectId);
      if (execution.outcome === "succeeded") {
        const output = parseOutput(execution.output);
        await this.#finalizeSucceeded(sessionId, branchId, callId, output, Math.round(performance.now() - started));
        return { outcome: "succeeded", message: output.text };
      }
      await this.#finalizeTerminated(sessionId, branchId, callId, execution.outcome, execution.error);
      const classification = providerClassification(execution.output, state.model.provider, state.model.model, execution.outcome);
      if (!this.compactions || classification.code !== ProviderModelErrorCode.ProviderConfirmedContextWindowOverflow) {
        return { outcome: execution.outcome, ...(execution.error === undefined ? {} : { error: execution.error }) };
      }
      const compacted = await this.compactions.compact(sessionId, branchId, {
        strategy: "deterministic-extractive-v1", reason: "provider-overflow", requestedBy: "supervisor",
        idempotencyKey: `legacy-turn-overflow:${turnId}:${attempt}`,
        retainRecentMessages: Math.max(1, AUTOMATIC_COMPACTION_RECENT_MESSAGES - attempt), capacity: window.provenance,
      });
      if (compacted.status !== "completed") return { outcome: execution.outcome, error: compacted.error ?? execution.error ?? "Provider overflow compaction failed" };
      const next = await this.contexts.materialize(sessionId, branchId, {
        contextId: `legacy-turn-${turnId}-overflow-context-${attempt}`,
        idempotencyKey: `legacy-turn-overflow-context:${turnId}:${attempt}`,
      });
      const nextEstimate = estimateContextWindow(next.context).estimatedTokens;
      const retry = planContextWindowOverflowRetry({ classification, retriesAlreadyAttempted: attempt - 1, rejectedEstimatedInputTokens: rejectedEstimate, nextEstimatedInputTokens: nextEstimate });
      if (!retry.retry) return { outcome: execution.outcome, error: execution.error ?? `Provider overflow retry refused: ${retry.reason}` };
      materialized = next;
      rejectedEstimate = nextEstimate;
      priorCallId = callId;
    }
    return { outcome: "failed", error: "Provider context-window overflow retry limit reached" };
  }

  async run(sessionId: string, branchId: string, maxTurns = 1): Promise<void> {
    for (let index = 0; index < maxTurns; index++) {
      const result = await this.turn(sessionId, branchId);
      if (result.outcome !== "succeeded") break;
      const state = projectEvents(await this.storage.loadEvents(sessionId, { branchId }));
      if (state.budget.exceeded || state.status === "stopped" || state.status === "failed") break;
    }
  }

  /** Finalizes effects committed before a supervisor crash without calling the model twice. */
  async recoverIncomplete(): Promise<number> {
    let recovered = 0;
    for (const branch of await this.storage.listBranches()) {
      const events = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      const state = projectEvents(events);
      const agentRunCallIds = new Set(
        Object.values(state.agentRuns).flatMap((run) => run.steps.flatMap((step) => [step.callId, ...step.modelAttempts.map((attempt) => attempt.callId)])),
      );
      for (const call of Object.values(state.modelCalls)) {
        if (call.status !== "requested" || agentRunCallIds.has(call.id)) continue;
        const effect = state.effects[call.effectId];
        if (!effect || effect.status === "requested" || effect.status === "started") continue;
        if (effect.status === "succeeded") {
          const started = events.find((event) => event.type === "EffectAttemptStarted" && (event.payload as EventPayloads["EffectAttemptStarted"]).effectId === effect.id);
          const outcome = [...events].reverse().find((event) => event.type === "EffectOutcomeRecorded" && (event.payload as EventPayloads["EffectOutcomeRecorded"]).effectId === effect.id);
          const elapsed = started && outcome ? Math.max(0, Date.parse(outcome.committedAt) - Date.parse(started.committedAt)) : 0;
          await this.#finalizeSucceeded(branch.sessionId, branch.branchId, call.id, parseOutput(effect.output), elapsed);
        } else {
          await this.#finalizeTerminated(branch.sessionId, branch.branchId, call.id, effect.status, effect.error);
        }
        recovered++;
      }
    }
    return recovered;
  }

  /** Restores an idle branch after a crash between turn-running and terminal finalization. */
  async reconcileRunningSessions(): Promise<number> {
    let reconciled = 0;
    for (const branch of await this.storage.listBranches()) {
      const events = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      if (!events.length || projectEvents(events).status !== "running") continue;
      const running = [...events].reverse().find((event) =>
        event.type === "SessionStatusChanged" &&
        (event.payload as EventPayloads["SessionStatusChanged"]).status === "running");
      if (!running) continue;
      await this.storage.appendEvents([{
        sessionId: branch.sessionId,
        branchId: branch.branchId,
        type: "SessionStatusChanged",
        producer: "recovery",
        idempotencyKey: `recovery-status-idle:${branch.branchId}:${running.id}`,
        payload: { status: "idle", reason: "Recovered interrupted model turn" },
      }]);
      reconciled++;
    }
    return reconciled;
  }

  #windowConfiguration(state: AgentState): { configuration: ModelContextWindowConfiguration; provenance: ContextCapacityProvenance } {
    const resolved = this.modelExecutor?.contextCapacity(state.model) ?? { provider: state.model.provider, model: state.model.model, source: "unknown" as const, contextWindowTokens: null };
    const outputReserveTokens = resolved.contextWindowTokens === null
      ? Math.max(0, state.model.maxOutputTokens ?? 0)
      : Math.min(resolved.contextWindowTokens - 1, Math.max(1, state.model.maxOutputTokens ?? Math.min(4_096, Math.floor(resolved.contextWindowTokens * 0.1))));
    const source = resolved.source === "provider-metadata" ? ModelContextCapacitySource.ProviderMetadata
      : resolved.source === "model-catalog" ? ModelContextCapacitySource.ModelCatalog
      : resolved.source === "operator-configuration" ? ModelContextCapacitySource.OperatorConfiguration
      : ModelContextCapacitySource.Unknown;
    const configuration: ModelContextWindowConfiguration = {
      provenance: { provider: resolved.provider, model: resolved.model, source },
      contextWindowTokens: resolved.contextWindowTokens, maxOutputReserveTokens: outputReserveTokens,
      estimatorId: "utf8-bytes-per-token-v1", triggerRatio: 0.8, targetRatio: 0.6,
    };
    return { configuration, provenance: { provider: resolved.provider, model: resolved.model, source, contextWindowTokens: resolved.contextWindowTokens, outputReserveTokens, estimatorId: configuration.estimatorId, triggerRatio: configuration.triggerRatio, targetRatio: configuration.targetRatio } };
  }

  async #finalizeTerminated(
    sessionId: string,
    branchId: string,
    callId: string,
    outcome: Exclude<EffectOutcome, "succeeded">,
    error?: string,
  ): Promise<void> {
    await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "ModelCallTerminated",
      producer: "supervisor",
      idempotencyKey: `model-terminal:${callId}`,
      payload: { callId, outcome, ...(error === undefined ? {} : { error }) },
    }, {
      sessionId,
      branchId,
      type: "SessionStatusChanged",
      producer: "supervisor",
      idempotencyKey: `turn-idle:${callId}`,
      payload: { status: "idle", reason: `model ${outcome}` },
    }]);
  }

  async #finalizeSucceeded(
    sessionId: string,
    branchId: string,
    callId: string,
    output: ModelOutput,
    wallTimeMs: number,
  ): Promise<void> {
    const state = projectEvents(await this.storage.loadEvents(sessionId, { branchId }));
    const existing = state.modelCalls[callId];
    if (existing?.status === "succeeded") return;
    const messageId = newId();
    const tokens = output.usage.inputTokens + output.usage.outputTokens;
    const completionEvents: any[] = [{
      sessionId,
      branchId,
      type: "ModelOutputChunk",
      producer: "model",
      idempotencyKey: `model-chunk:${callId}:0`,
      payload: { callId, sequence: 0, text: output.text },
    }, {
      sessionId,
      branchId,
      type: "MessageAppended",
      producer: "model",
      idempotencyKey: `model-message:${callId}`,
      payload: { messageId, role: "assistant", content: output.text, modelCallId: callId },
    }, {
      sessionId,
      branchId,
      type: "ModelCallCompleted",
      producer: "supervisor",
      idempotencyKey: `model-complete:${callId}`,
      payload: { callId, responseMessageId: messageId, finishReason: output.finishReason, usage: output.usage },
    }, {
      sessionId,
      branchId,
      type: "BudgetDebited",
      producer: "supervisor",
      idempotencyKey: `budget:${callId}`,
      payload: { callId, tokens, costUsd: output.usage.costUsd, turns: 1, wallTimeMs },
    }];
    const exceeded = budgetReached(state.budget.limits, {
      tokens: state.budget.tokens + tokens,
      costUsd: state.budget.costUsd + output.usage.costUsd,
      turns: state.budget.turns + 1,
      wallTimeMs: state.budget.wallTimeMs + wallTimeMs,
    });
    if (exceeded) {
      completionEvents.push({
        sessionId,
        branchId,
        type: "BudgetExceeded",
        producer: "supervisor",
        idempotencyKey: `budget-exceeded:${callId}`,
        payload: exceeded,
      });
    }
    completionEvents.push({
      sessionId,
      branchId,
      type: "SessionStatusChanged",
      producer: "supervisor",
      idempotencyKey: `turn-idle:${callId}`,
      payload: { status: "idle" },
    });
    await this.storage.appendEvents(completionEvents);
  }
}

function providerClassification(
  output: JsonValue | undefined,
  provider: string,
  model: string,
  outcome: Exclude<EffectOutcome, "succeeded">,
): ProviderModelErrorClassification {
  if (outcome === "unknown") return { provider, model, code: ProviderModelErrorCode.Unknown };
  if (output && typeof output === "object" && !Array.isArray(output) && output.errorClassification && typeof output.errorClassification === "object" && !Array.isArray(output.errorClassification)) {
    const value = output.errorClassification;
    if (value.provider === provider && value.model === model && value.code === ProviderModelErrorCode.ProviderConfirmedContextWindowOverflow) return { provider, model, code: ProviderModelErrorCode.ProviderConfirmedContextWindowOverflow };
  }
  return { provider, model, code: ProviderModelErrorCode.Generic };
}

function assertBudgetAvailable(state: AgentState): void {
  if (state.budget.exceeded || budgetReached(state.budget.limits, state.budget)) {
    throw new ValidationError("Session budget is exhausted");
  }
}

function budgetReached(
  limits: BudgetLimits,
  spent: { tokens: number; costUsd: number; turns: number; wallTimeMs: number },
): EventPayloads["BudgetExceeded"] | null {
  if (limits.tokenLimit !== undefined && spent.tokens >= limits.tokenLimit) {
    return { dimension: "tokens", limit: limits.tokenLimit, spent: spent.tokens };
  }
  if (limits.costLimitUsd !== undefined && spent.costUsd >= limits.costLimitUsd) {
    return { dimension: "cost", limit: limits.costLimitUsd, spent: spent.costUsd };
  }
  if (limits.turnLimit !== undefined && spent.turns >= limits.turnLimit) {
    return { dimension: "turns", limit: limits.turnLimit, spent: spent.turns };
  }
  if (limits.wallTimeLimitMs !== undefined && spent.wallTimeMs >= limits.wallTimeLimitMs) {
    return { dimension: "wallTime", limit: limits.wallTimeLimitMs, spent: spent.wallTimeMs };
  }
  return null;
}
