import {
  NotFoundError,
  ValidationError,
  assertJsonValue,
  assertNoReservedModelDispatchInputFields,
  buildProviderInputCandidate,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  estimateProviderInputCandidate,
  AI_GENERATION_SYSTEM_INSTRUCTION,
  MAX_AI_GENERATIONS_PER_CELL,
  MAX_CONCURRENT_AI_GENERATIONS_PER_CELL,
  newId,
  projectEvents,
  validateModelEffectOutputV2,
  type AiGenerationKind,
  type AiGenerationStatus,
  type AiGenerationBudgetLimits,
  type BudgetLimits,
  type EffectOutcome,
  type EventPayloads,
  type JsonValue,
  type ModelConfiguration,
  type ModelWarning,
  type Usage,
} from "../domain/index.ts";
import { containsBrokeredSecret, containsCredentialMaterial } from "../security/index.ts";
import {
  requireRecursiveStorage,
  type AgentStorage,
  type AiGenerationRecord,
} from "../storage/index.ts";
import type { ModelExecutor } from "../executors/index.ts";
import { stableEffectId, type OutboxRunner } from "./outbox.ts";
import type { ModelEffectAdmissionService } from "./model-effect-admission.ts";
import type { ModelSelectionInput, ModelSelectionService } from "./model-selection.ts";
import {
  ExplicitContextMaterializer,
  cloneExactJsonValue,
  type ExplicitContextInput,
} from "./explicit-context.ts";

export const MAX_AI_PROMPT_BYTES = 64 * 1024;
export const MAX_AI_MESSAGES = 64;
export const MAX_AI_MESSAGE_BYTES = 64 * 1024;
export const MAX_AI_TOTAL_MESSAGE_BYTES = 128 * 1024;
export const MAX_AI_INLINE_RESULT_BYTES = 64 * 1024;
export { MAX_AI_GENERATIONS_PER_CELL, MAX_CONCURRENT_AI_GENERATIONS_PER_CELL };
export const DEFAULT_AI_GENERATION_TIMEOUT_MS = 120_000;
export const AI_GENERATION_CANCELLATION_GRACE_MS = 1_000;

export interface AiGenerationBudget extends BudgetLimits {
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
  readonly inlineResultByteLimit?: number;
}

export interface AiGenerationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AiGenerationInput {
  readonly model?: ModelSelectionInput;
  readonly prompt?: string;
  readonly messages?: readonly AiGenerationMessage[];
  readonly context?: readonly ExplicitContextInput[];
  readonly budget?: AiGenerationBudget;
  readonly idempotencyKey?: string;
}

export interface AiObjectGenerationInput extends AiGenerationInput {
  readonly schema: JsonValue;
}

export interface AiGenerationHandle {
  readonly generationId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly kind: AiGenerationKind;
  readonly status: AiGenerationStatus;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiGenerationResult {
  readonly generationId: string;
  readonly status: AiGenerationStatus;
  readonly kind: AiGenerationKind;
  readonly text?: string;
  readonly object?: JsonValue;
  readonly error?: string;
  readonly finishReason?: string;
  readonly usage?: Usage;
  readonly warnings?: readonly ModelWarning[];
  readonly provenance: {
    readonly sessionId: string;
    readonly branchId: string;
    readonly effectId: string;
    readonly requestDigest: string;
    readonly model: ModelConfiguration;
    readonly responseContract: EventPayloads["AiGenerationRequested"]["modelDispatch"]["responseContract"];
    readonly responseCapability: EventPayloads["AiGenerationRequested"]["modelDispatch"]["responseCapability"];
    readonly contextEventId: string;
    readonly contextDigest: string;
    readonly providerInputDigest: string;
    readonly resultDigest?: string;
    readonly resultBytes?: number;
    readonly usageSource?: EventPayloads["AiGenerationResultCommitted"]["usageSource"];
    readonly sourceOutcomeEventId?: string;
  };
}

export class AiGenerationService {
  readonly #recursive;
  readonly #context;
  readonly #runs = new Set<Promise<void>>();
  readonly #running = new Set<string>();
  readonly #activeByCell = new Map<string, number>();
  #admissionTail: Promise<void> = Promise.resolve();

  constructor(
    readonly storage: AgentStorage,
    readonly outbox: OutboxRunner,
    readonly modelExecutor: ModelExecutor,
    readonly admission: ModelEffectAdmissionService,
    readonly modelSelection: ModelSelectionService,
    context: ExplicitContextMaterializer,
  ) {
    this.#recursive = requireRecursiveStorage(storage);
    this.#context = context;
  }

  admitText(
    sessionId: string,
    branchId: string,
    input: AiGenerationInput,
    caller: { readonly cellId?: string } = {},
  ): Promise<AiGenerationHandle> {
    return this.#serializedAdmission(() =>
      this.#admit(sessionId, branchId, "text", input, caller));
  }

  admitObject(
    sessionId: string,
    branchId: string,
    input: AiObjectGenerationInput,
    caller: { readonly cellId?: string } = {},
  ): Promise<AiGenerationHandle> {
    return this.#serializedAdmission(() =>
      this.#admit(sessionId, branchId, "object", input, caller));
  }

  async #serializedAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#admissionTail;
    let release!: () => void;
    this.#admissionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  async #admit(
    sessionId: string,
    branchId: string,
    kind: AiGenerationKind,
    rawInput: AiGenerationInput,
    caller: { readonly cellId?: string },
  ): Promise<AiGenerationHandle> {
    const raw = cloneExactJsonValue(rawInput) as unknown as AiGenerationInput;
    assertPublicInput(raw, kind);
    const schema = kind === "object"
      ? (raw as AiObjectGenerationInput).schema
      : undefined;
    const normalized = normalizeInput(raw);
    const idempotencyKey = normalized.idempotencyKey ?? newId();
    const generationId = stableGenerationId(sessionId, branchId, idempotencyKey);
    const requestDigest = canonicalJsonDigest({
      kind,
      prompt: normalized.prompt ?? null,
      messages: normalized.messages ?? null,
      context: normalized.context ?? [],
      model: normalized.model ?? null,
      budget: normalized.budget ?? null,
      schema: schema ?? null,
      cellId: caller.cellId ?? null,
    });
    const existing = await this.#recursive.findAiGeneration(sessionId, branchId, idempotencyKey);
    if (existing) {
      if (existing.request.requestDigest !== requestDigest) {
        throw new ValidationError("AI generation idempotency key was reused with a different request");
      }
      this.#launch(existing);
      return handle(existing);
    }
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(events);
    const session = await this.#recursive.getSession(sessionId);
    if (!session) throw new NotFoundError("session", sessionId);
    if (caller.cellId) {
      const count = Object.values(state.aiGenerations).filter((item) => item.cellId === caller.cellId).length;
      if (count >= MAX_AI_GENERATIONS_PER_CELL) {
        throw new ValidationError(`A cell may admit at most ${MAX_AI_GENERATIONS_PER_CELL} raw AI generations`);
      }
      if ((this.#activeByCell.get(caller.cellId) ?? 0) >= MAX_CONCURRENT_AI_GENERATIONS_PER_CELL) {
        throw new ValidationError(`A cell may run at most ${MAX_CONCURRENT_AI_GENERATIONS_PER_CELL} raw AI generations concurrently`);
      }
    }
    const budget = generationBudget(state.budget.limits, state.budget, normalized.budget);
    const selectedModel = await this.modelSelection.admit(state.model, normalized.model);
    const requestedOutputLimit = [budget.outputTokenLimit, budget.tokenLimit]
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>((minimum, value) => minimum === undefined ? value : Math.min(minimum, value), undefined);
    const model = requestedOutputLimit === undefined
      ? selectedModel
      : {
          ...selectedModel,
          maxOutputTokens: Math.min(
            selectedModel.maxOutputTokens ?? requestedOutputLimit,
            requestedOutputLimit,
          ),
        };
    const admitted = kind === "text"
      ? this.admission.requestText(model)
      : this.admission.requestDeclaredData(schema, model);
    const frozen = await this.#context.materialize(
      sessionId,
      branchId,
      session.rootSessionId,
      normalized.context,
    );
    const messages = providerMessages(normalized, frozen.value);
    const capacity = providerInputCapacity(this.modelExecutor, admitted.modelDispatch.configuration);
    const providerInput = buildProviderInputCandidate({
      context: { messages: messages as unknown as JsonValue },
      modelDispatch: admitted.modelDispatch,
      capacity,
    });
    const estimate = estimateProviderInputCandidate(providerInput);
    if (budget.inputTokenLimit !== undefined && estimate.estimatedTokens > budget.inputTokenLimit) {
      throw new ValidationError("AI generation estimated input exceeds the caller input-token limit");
    }
    if (budget.tokenLimit !== undefined &&
        estimate.estimatedTokens + capacity.outputReserveTokens > budget.tokenLimit) {
      throw new ValidationError("AI generation conservative input/output reservation exceeds the caller token limit");
    }
    const reservation = {
      tokens: estimate.estimatedTokens + capacity.outputReserveTokens,
      costUsd: generationCostReservation(
        admitted.execution.catalog.pricing,
        estimate.estimatedTokens,
        capacity.outputReserveTokens,
        budget.costLimitUsd,
      ),
      turns: 1 as const,
      wallTimeMs: budget.wallTimeLimitMs ?? DEFAULT_AI_GENERATION_TIMEOUT_MS,
    };
    const effectKey = `ai-generation-effect:${generationId}`;
    const effectId = stableEffectId(sessionId, effectKey);
    const contextEventId = stableGenerationContextEventId(generationId);
    const activeRun = Object.values(state.agentRuns).find((run) =>
      !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
    const ancestorTaskIds = await this.#ancestorTaskIds(sessionId);
    const requested: EventPayloads["AiGenerationRequested"] = {
      generationId, kind, effectId, idempotencyKey, requestDigest,
      ...(caller.cellId === undefined ? {} : { cellId: caller.cellId }),
      ...(activeRun === undefined ? {} : { runId: activeRun.id }),
      ...(state.taskId === null ? {} : { taskId: state.taskId }),
      ancestorTaskIds,
      modelDispatch: admitted.modelDispatch,
      providerInput,
      estimatedInputTokens: estimate.estimatedTokens,
      contextEventId,
      contextDigest: frozen.digest,
      budget,
      reservation,
    };
    const effectEvent = this.outbox.requestEvent({
      sessionId,
      branchId,
      executor: "model",
      operation: "complete",
      input: {
        generationId,
        providerInput: providerInput as unknown as JsonValue,
        modelDispatch: admitted.modelDispatch as unknown as JsonValue,
        maxInlineResultBytes: budget.inlineResultByteLimit,
      },
      origin: { kind: "ai-generation", generationId },
      idempotencyKey: effectKey,
      idempotent: false,
    });
    await this.storage.appendEvents([
      {
        id: contextEventId, sessionId, branchId, type: "AiGenerationContextFrozen",
        producer: "supervisor", idempotencyKey: `ai-generation-context:${generationId}`,
        payload: {
          generationId, context: frozen.value, provenance: frozen.provenance,
          contextDigest: frozen.digest, exactUtf8Bytes: frozen.exactUtf8Bytes,
        },
      },
      {
        sessionId, branchId, type: "AiGenerationRequested", producer: "supervisor",
        idempotencyKey: `ai-generation-request:${generationId}`, payload: requested,
      },
      effectEvent,
    ]);
    const record = await this.#load(generationId);
    this.#launch(record);
    return handle(record);
  }

  async get(generationId: string): Promise<AiGenerationHandle> {
    return handle(await this.#load(generationId));
  }

  async getFor(sessionId: string, branchId: string, generationId: string): Promise<AiGenerationHandle> {
    return handle(await this.#loadFor(sessionId, branchId, generationId));
  }

  async find(sessionId: string, branchId: string, idempotencyKey: string): Promise<AiGenerationHandle | null> {
    const record = await this.#recursive.findAiGeneration(sessionId, branchId, idempotencyKey);
    return record ? handle(record) : null;
  }

  async result(
    generationId: string,
    options: { readonly wait?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<AiGenerationResult> {
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86_400_000)) {
      throw new ValidationError("AI generation wait timeout must be from 0 to 86400000ms");
    }
    const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    let record = await this.#load(generationId);
    while (options.wait !== false && !terminal(record.status) && Date.now() < deadline) {
      await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
      record = await this.#load(generationId);
    }
    return resultRecord(record);
  }

  async resultFor(
    sessionId: string,
    branchId: string,
    generationId: string,
    options: { readonly wait?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<AiGenerationResult> {
    await this.#loadFor(sessionId, branchId, generationId);
    const result = await this.result(generationId, options);
    if (result.provenance.sessionId !== sessionId || result.provenance.branchId !== branchId) {
      throw new NotFoundError("AI generation", generationId);
    }
    return result;
  }

  async cancel(generationId: string, reason = "AI generation cancelled"): Promise<AiGenerationHandle> {
    const record = await this.#load(generationId);
    if (terminal(record.status)) return handle(record);
    const outbox = await this.storage.getOutbox(record.effectId);
    if (!outbox || outbox.status === "pending") {
      const events: import("../domain/index.ts").NewAgentEvent[] = [];
      if (outbox) {
        events.push({
          sessionId: record.sessionId, branchId: record.branchId,
          type: "EffectOutcomeRecorded", producer: "client",
          idempotencyKey: `ai-generation-effect-cancel:${generationId}`,
          payload: {
            effectId: record.effectId, attempt: Math.max(1, outbox.attempt),
            outcome: "cancelled", error: reason, observedAt: new Date().toISOString(),
          },
        });
      }
      events.push({
        sessionId: record.sessionId, branchId: record.branchId,
        type: "AiGenerationStatusChanged", producer: "client",
        idempotencyKey: `ai-generation-cancel:${generationId}`,
        payload: { generationId, status: "cancelled", effectId: record.effectId, error: reason },
      });
      await this.storage.appendEvents(events);
      return handle(await this.#load(generationId));
    }
    if (outbox.status === "running") {
      this.outbox.cancel(record.effectId);
      // A running provider may race cancellation. Let the authoritative outbox
      // outcome decide whether this generation cancelled, completed, failed,
      // or became unknown instead of discarding retained usage.
      await this.result(generationId, {
        wait: true,
        timeoutMs: Math.min(
          AI_GENERATION_CANCELLATION_GRACE_MS,
          record.request.budget.wallTimeLimitMs ?? DEFAULT_AI_GENERATION_TIMEOUT_MS,
        ),
      });
      let current = await this.#load(generationId);
      if (!terminal(current.status)) {
        const retained = await this.storage.getOutbox(record.effectId);
        if (retained && ["pending", "running"].includes(retained.status)) {
          try {
            await this.storage.appendEvents([{
              sessionId: record.sessionId,
              branchId: record.branchId,
              type: "EffectOutcomeRecorded",
              producer: "client",
              idempotencyKey: `ai-generation-cancel-unknown:${generationId}`,
              payload: {
                effectId: record.effectId,
                attempt: Math.max(1, retained.attempt),
                outcome: "unknown",
                error: `${reason}; executor cancellation did not settle within ${AI_GENERATION_CANCELLATION_GRACE_MS}ms`,
                observedAt: new Date().toISOString(),
              },
            }]);
          } catch (error) {
            const raced = await this.storage.getOutbox(record.effectId);
            if (raced && ["pending", "running"].includes(raced.status)) throw error;
          }
        }
        current = await this.#load(generationId);
        const finalOutbox = await this.storage.getOutbox(record.effectId);
        if (!terminal(current.status) && finalOutbox?.status === "unknown") {
          await this.#terminal(current, "unknown", finalOutbox.status === "unknown"
            ? `${reason}; provider outcome is unknown`
            : reason);
        } else if (!terminal(current.status)) {
          this.#launch(current);
          await this.result(generationId, { wait: true, timeoutMs: AI_GENERATION_CANCELLATION_GRACE_MS });
        }
      }
      return handle(await this.#load(generationId));
    }
    this.#launch(record);
    await this.result(generationId, { wait: true, timeoutMs: 5_000 });
    return handle(await this.#load(generationId));
  }

  async cancelFor(
    sessionId: string,
    branchId: string,
    generationId: string,
    reason?: string,
  ): Promise<AiGenerationHandle> {
    await this.#loadFor(sessionId, branchId, generationId);
    return this.cancel(generationId, reason);
  }

  async recoverIncomplete(): Promise<number> {
    const records = (await this.#recursive.listAiGenerations(["pending", "running"]))
      .filter((record) => record.executionOwned);
    for (const record of records) this.#launch(record);
    return records.length;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#runs]);
  }

  #launch(record: AiGenerationRecord): void {
    if (!record.executionOwned || terminal(record.status) || this.#running.has(record.generationId)) return;
    this.#running.add(record.generationId);
    const cellId = record.request.cellId;
    if (cellId) this.#activeByCell.set(cellId, (this.#activeByCell.get(cellId) ?? 0) + 1);
    let running!: Promise<void>;
    running = this.#run(record).catch(async (error) => {
      const current = await this.#load(record.generationId).catch(() => null);
      if (current && !terminal(current.status)) {
        await this.#terminal(current, "failed", error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      this.#running.delete(record.generationId);
      this.#runs.delete(running);
      if (cellId) {
        const next = Math.max(0, (this.#activeByCell.get(cellId) ?? 1) - 1);
        if (next) this.#activeByCell.set(cellId, next); else this.#activeByCell.delete(cellId);
      }
    });
    this.#runs.add(running);
  }

  async #run(record: AiGenerationRecord): Promise<void> {
    let current = await this.#load(record.generationId);
    if (terminal(current.status)) return;
    const outbox = await this.storage.getOutbox(current.effectId);
    if (!outbox) throw new ValidationError("AI generation is missing its atomically admitted model effect");
    current = await this.#load(record.generationId);
    if (terminal(current.status)) return;
    if (current.status === "pending" && ["pending", "running"].includes(outbox.status)) {
      await this.storage.appendEvents([{
        sessionId: current.sessionId, branchId: current.branchId,
        type: "AiGenerationStatusChanged", producer: "supervisor",
        idempotencyKey: `ai-generation-running:${current.generationId}`,
        payload: { generationId: current.generationId, status: "running", effectId: current.effectId },
      }]);
    }
    const timeoutMs = current.request.budget.wallTimeLimitMs ?? DEFAULT_AI_GENERATION_TIMEOUT_MS;
    const executionPromise = this.outbox.run(current.effectId);
    const first = await Promise.race([
      executionPromise.then((value) => ({ type: "result" as const, value })),
      Bun.sleep(timeoutMs).then(() => ({ type: "timeout" as const })),
    ]);
    let timedOut = false;
    let outcome;
    if (first.type === "timeout") {
      timedOut = true;
      this.outbox.cancel(current.effectId);
      const afterAbort = await Promise.race([
        executionPromise.then((value) => ({ type: "result" as const, value })),
        Bun.sleep(AI_GENERATION_CANCELLATION_GRACE_MS).then(() => ({ type: "unresolved" as const })),
      ]);
      if (afterAbort.type === "unresolved") {
        const retained = await this.storage.getOutbox(current.effectId);
        const timeoutError = `AI generation remained unresolved after its ${timeoutMs}ms wall-time limit`;
        try {
          await this.storage.appendEvents([{
            sessionId: current.sessionId,
            branchId: current.branchId,
            type: "EffectOutcomeRecorded",
            producer: "supervisor",
            idempotencyKey: `ai-generation-timeout-unknown:${current.generationId}`,
            payload: {
              effectId: current.effectId,
              attempt: Math.max(1, retained?.attempt ?? 1),
              outcome: "unknown",
              error: timeoutError,
              observedAt: new Date().toISOString(),
            },
          }]);
          outcome = { outcome: "unknown" as const, error: timeoutError };
        } catch (error) {
          const raced = await this.storage.getOutbox(current.effectId);
          if (!raced || raced.status === "pending" || raced.status === "running") throw error;
          outcome = await this.#authoritativeEffectOutcome(
            current.sessionId,
            current.branchId,
            current.effectId,
            raced.status,
          );
        }
      } else {
        outcome = afterAbort.value;
      }
    } else {
      outcome = first.value;
    }
    current = await this.#load(current.generationId);
    if (terminal(current.status)) return;
    if (outcome.outcome !== "succeeded" || outcome.output === undefined) {
      const status = outcome.outcome === "unknown" ? "unknown"
        : outcome.outcome === "cancelled" && timedOut ? "budget_exceeded"
        : outcome.outcome === "cancelled" ? "cancelled" : "failed";
      await this.#terminal(current, status, outcome.error);
      return;
    }
    const output = validateModelEffectOutputV2(outcome.output, {
      responseContract: current.request.modelDispatch.responseContract,
      responseCapability: current.request.modelDispatch.responseCapability,
      configuredProvider: current.request.modelDispatch.configuration.provider,
    });
    const effect = projectEvents(await this.storage.loadEvents(current.sessionId, { branchId: current.branchId })).effects[current.effectId];
    if (!effect || effect.status !== "succeeded") throw new ValidationError("AI generation effect outcome is missing");
    const usage = output.response.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const usageSource = output.response.kind === "guard-aborted"
      ? "conservative-guard-estimate" as const
      : "provider-reported" as const;
    const elapsed = Math.max(0, Date.now() - Date.parse(current.createdAt));
    const exceeded = generationBudgetExceeded(current.request.budget, usage, elapsed);
    if (exceeded) {
      await this.#terminal(current, "budget_exceeded", exceeded, {
        usage,
        usageSource,
        sourceOutcomeEventId: effect.eventId,
      });
      return;
    }
    let value: JsonValue;
    try {
      value = generationValue(current.kind, output);
    } catch (error) {
      await this.#terminal(current, "failed", error instanceof Error ? error.message : String(error), {
        usage,
        usageSource,
        sourceOutcomeEventId: effect.eventId,
      });
      return;
    }
    if (containsBrokeredSecret(value) ||
        containsCredentialMaterial(typeof value === "string" ? value : JSON.stringify(value))) {
      await this.#terminal(current, "failed", "AI generation output contained credential material", {
        usage,
        usageSource,
        sourceOutcomeEventId: effect.eventId,
      });
      return;
    }
    const resultBytes = canonicalJsonByteLength(value);
    if (resultBytes > current.request.budget.inlineResultByteLimit) {
      await this.#terminal(current, "failed", "AI generation output exceeded the hard inline result bound", {
        usage,
        usageSource,
        sourceOutcomeEventId: effect.eventId,
      });
      return;
    }
    const resultEventId = newId();
    await this.storage.appendEvents([
      {
        id: resultEventId, sessionId: current.sessionId, branchId: current.branchId,
        type: "AiGenerationResultCommitted", producer: "supervisor",
        idempotencyKey: `ai-generation-result:${current.generationId}`,
        payload: {
          generationId: current.generationId, effectId: current.effectId,
          sourceOutcomeEventId: effect.eventId, kind: current.kind, value,
          resultDigest: canonicalJsonDigest(value), resultBytes,
          finishReason: finishReason(output.response.termination),
          usage, warnings: [...output.response.warnings], usageSource,
        },
      },
      {
        sessionId: current.sessionId, branchId: current.branchId,
        type: "AiGenerationBudgetDebited", producer: "supervisor",
        idempotencyKey: `ai-generation-budget:${current.generationId}`,
        payload: {
          generationId: current.generationId, sessionId: current.sessionId,
          branchId: current.branchId,
          ...(current.request.runId === undefined ? {} : { runId: current.request.runId }),
          ...(current.request.taskId === undefined ? {} : { taskId: current.request.taskId }),
          ancestorTaskIds: current.request.ancestorTaskIds,
          tokens: usage.inputTokens + usage.outputTokens, costUsd: usage.costUsd,
          turns: 1, wallTimeMs: elapsed, usageSource,
          sourceResultEventId: resultEventId,
        },
      },
    ]);
  }

  async #terminal(
    record: AiGenerationRecord,
    status: "failed" | "cancelled" | "unknown" | "budget_exceeded",
    error?: string,
    settlement?: {
      readonly usage: Usage;
      readonly usageSource: EventPayloads["AiGenerationBudgetDebited"]["usageSource"];
      readonly sourceOutcomeEventId: string;
    },
  ): Promise<void> {
    if (terminal(record.status)) return;
    const statusEventId = newId();
    const events: import("../domain/index.ts").NewAgentEvent[] = [{
      id: statusEventId, sessionId: record.sessionId, branchId: record.branchId,
      type: "AiGenerationStatusChanged", producer: "supervisor",
      idempotencyKey: `ai-generation-${status}:${record.generationId}`,
      payload: {
        generationId: record.generationId, status, effectId: record.effectId,
        ...(error === undefined ? {} : { error }),
      },
    }];
    const outbox = await this.storage.getOutbox(record.effectId);
    if (settlement || status === "unknown" || (outbox?.attempt ?? 0) > 0) {
      const elapsed = Math.max(0, Date.now() - Date.parse(record.createdAt));
      const debit = settlement?.usageSource === "provider-reported"
        ? {
            tokens: settlement.usage.inputTokens + settlement.usage.outputTokens,
            costUsd: settlement.usage.costUsd,
            turns: 1,
            wallTimeMs: elapsed,
            usageSource: settlement.usageSource,
          }
        : {
            ...record.request.reservation,
            wallTimeMs: Math.max(elapsed, record.request.reservation.wallTimeMs),
            usageSource: "conservative-guard-estimate" as const,
          };
      events.push({
        sessionId: record.sessionId, branchId: record.branchId,
        type: "AiGenerationBudgetDebited", producer: "supervisor",
        idempotencyKey: `ai-generation-budget:${record.generationId}`,
        payload: {
          generationId: record.generationId, sessionId: record.sessionId,
          branchId: record.branchId,
          ...(record.request.runId === undefined ? {} : { runId: record.request.runId }),
          ...(record.request.taskId === undefined ? {} : { taskId: record.request.taskId }),
          ancestorTaskIds: record.request.ancestorTaskIds,
          ...debit,
          sourceResultEventId: statusEventId,
        },
      });
    }
    await this.storage.appendEvents(events);
  }

  async #authoritativeEffectOutcome(
    sessionId: string,
    branchId: string,
    effectId: string,
    retainedStatus: EffectOutcome,
  ): Promise<{
    readonly outcome: EffectOutcome;
    readonly output?: JsonValue;
    readonly error?: string;
  }> {
    const event = [...await this.storage.loadEvents(sessionId, { branchId })]
      .reverse()
      .find((candidate) =>
        candidate.type === "EffectOutcomeRecorded" &&
        (candidate.payload as EventPayloads["EffectOutcomeRecorded"]).effectId === effectId);
    if (!event) {
      throw new ValidationError("Terminal AI generation effect is missing its authoritative outcome event");
    }
    const payload = event.payload as EventPayloads["EffectOutcomeRecorded"];
    if (payload.outcome !== retainedStatus) {
      throw new ValidationError("AI generation outbox status disagrees with its authoritative outcome event");
    }
    return {
      outcome: payload.outcome,
      ...(payload.output === undefined ? {} : { output: payload.output }),
      ...(payload.error === undefined ? {} : { error: payload.error }),
    };
  }

  async #load(generationId: string): Promise<AiGenerationRecord> {
    const result = await this.#recursive.getAiGeneration(generationId);
    if (!result) throw new NotFoundError("AI generation", generationId);
    return result;
  }

  async #loadFor(sessionId: string, branchId: string, generationId: string): Promise<AiGenerationRecord> {
    const result = await this.#load(generationId);
    if (result.sessionId !== sessionId || result.branchId !== branchId) {
      throw new NotFoundError("AI generation", generationId);
    }
    return result;
  }

  async #ancestorTaskIds(sessionId: string): Promise<string[]> {
    const result: string[] = [];
    let current = await this.#recursive.getSession(sessionId);
    while (current?.taskId && current.parentSessionId) {
      result.push(current.taskId);
      current = await this.#recursive.getSession(current.parentSessionId);
    }
    return result;
  }
}

function assertPublicInput(value: unknown, kind: AiGenerationKind): asserts value is AiGenerationInput {
  assertNoReservedModelDispatchInputFields(value, "Public AI generation input");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("AI generation input must be an object");
  }
  const allowed = new Set(["prompt", "messages", "context", "model", "budget", "idempotencyKey", "schema"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new ValidationError(`AI generation input has unsupported field ${unexpected[0]}`);
  if (kind === "text" && Object.hasOwn(value, "schema")) {
    throw new ValidationError("Text AI generation cannot declare an object schema");
  }
  if (kind === "object" && !Object.hasOwn(value, "schema")) {
    throw new ValidationError("Object AI generation requires a schema");
  }
  const budget = (value as Record<string, unknown>).budget;
  if (budget !== undefined) {
    if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
      throw new ValidationError("AI generation budget must be an object");
    }
    const budgetFields = new Set([
      "tokenLimit", "costLimitUsd", "turnLimit", "wallTimeLimitMs",
      "inputTokenLimit", "outputTokenLimit", "inlineResultByteLimit",
    ]);
    const unsupported = Object.keys(budget).filter((key) => !budgetFields.has(key));
    if (unsupported.length) throw new ValidationError(`AI generation budget has unsupported field ${unsupported[0]}`);
  }
}

function normalizeInput(input: AiGenerationInput): AiGenerationInput {
  const prompt = input.prompt;
  const messages = input.messages;
  if ((prompt === undefined) === (messages === undefined)) {
    throw new ValidationError("AI generation requires exactly one of prompt or messages");
  }
  if (prompt !== undefined) {
    if (typeof prompt !== "string" || !prompt.trim() || bytes(prompt) > MAX_AI_PROMPT_BYTES ||
        containsBrokeredSecret(prompt)) {
      throw new ValidationError("AI generation prompt is empty, oversized, or contains credential material");
    }
  }
  if (messages !== undefined) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_AI_MESSAGES) {
      throw new ValidationError(`AI generation messages require 1-${MAX_AI_MESSAGES} entries`);
    }
    let total = 0;
    for (const message of messages) {
      if (!message || !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string" || !message.content ||
          Object.keys(message).some((key) => key !== "role" && key !== "content") ||
          bytes(message.content) > MAX_AI_MESSAGE_BYTES || containsBrokeredSecret(message.content)) {
        throw new ValidationError("AI generation message is invalid, oversized, or contains credential material");
      }
      total += bytes(message.content);
    }
    if (total > MAX_AI_TOTAL_MESSAGE_BYTES) throw new ValidationError("AI generation messages exceed the total byte bound");
  }
  if (input.idempotencyKey !== undefined &&
      (!input.idempotencyKey.trim() || bytes(input.idempotencyKey) > 256)) {
    throw new ValidationError("AI generation idempotencyKey must contain 1-256 UTF-8 bytes");
  }
  return input;
}

function providerMessages(input: AiGenerationInput, context: JsonValue): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const result: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{
    role: "system",
    content: AI_GENERATION_SYSTEM_INSTRUCTION,
  }];
  if (input.messages) result.push(...input.messages);
  else result.push({ role: "user", content: input.prompt! });
  if (Array.isArray(context) && context.length) {
    result.push({ role: "user", content: `EXPLICIT CONTEXT (ordered JSON)\n${JSON.stringify(context)}` });
  }
  return result;
}

function providerInputCapacity(
  executor: ModelExecutor,
  configuration: ModelConfiguration,
) {
  const resolved = executor.contextCapacity(configuration);
  const outputReserveTokens = resolved.contextWindowTokens === null
    ? Math.max(1, configuration.maxOutputTokens ?? 4_096)
    : Math.min(
        resolved.contextWindowTokens - 1,
        Math.max(1, configuration.maxOutputTokens ?? Math.min(4_096, Math.floor(resolved.contextWindowTokens * 0.1))),
      );
  return {
    ...resolved, outputReserveTokens,
    estimatorId: "provider-input-utf8-bytes-per-4-tokens-v1",
    triggerRatio: 0.8, targetRatio: 0.6,
  } as const;
}

function generationBudget(
  parent: BudgetLimits,
  spent: { readonly tokens: number; readonly costUsd: number; readonly turns: number; readonly wallTimeMs: number },
  requested?: AiGenerationBudget,
): AiGenerationBudgetLimits {
  const remaining: BudgetLimits = {
    ...(parent.tokenLimit === undefined ? {} : { tokenLimit: Math.max(0, parent.tokenLimit - spent.tokens) }),
    ...(parent.costLimitUsd === undefined ? {} : { costLimitUsd: Math.max(0, parent.costLimitUsd - spent.costUsd) }),
    ...(parent.turnLimit === undefined ? {} : { turnLimit: Math.max(0, parent.turnLimit - spent.turns) }),
    ...(parent.wallTimeLimitMs === undefined ? {} : { wallTimeLimitMs: Math.max(0, parent.wallTimeLimitMs - spent.wallTimeMs) }),
  };
  const narrow = (key: keyof BudgetLimits): number | undefined => {
    const value = requested?.[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new ValidationError(`AI generation ${key} must be nonnegative`);
    const available = remaining[key];
    if (value !== undefined && available !== undefined && value > available) {
      throw new ValidationError(`AI generation ${key} cannot widen the caller budget`);
    }
    return value ?? available;
  };
  const inlineResultByteLimit = requested?.inlineResultByteLimit ?? MAX_AI_INLINE_RESULT_BYTES;
  if (!Number.isSafeInteger(inlineResultByteLimit) || inlineResultByteLimit < 1 ||
      inlineResultByteLimit > MAX_AI_INLINE_RESULT_BYTES) {
    throw new ValidationError(`AI generation inlineResultByteLimit must be from 1 to ${MAX_AI_INLINE_RESULT_BYTES}`);
  }
  const result: {
    tokenLimit?: number; costLimitUsd?: number; turnLimit?: number;
    wallTimeLimitMs?: number; inputTokenLimit?: number; outputTokenLimit?: number;
    inlineResultByteLimit: number;
  } = { inlineResultByteLimit };
  const tokenLimit = narrow("tokenLimit");
  const costLimitUsd = narrow("costLimitUsd");
  const turnLimit = narrow("turnLimit");
  const wallTimeLimitMs = narrow("wallTimeLimitMs");
  if (tokenLimit !== undefined) result.tokenLimit = tokenLimit;
  if (costLimitUsd !== undefined) result.costLimitUsd = costLimitUsd;
  if (turnLimit !== undefined) result.turnLimit = turnLimit;
  if (wallTimeLimitMs !== undefined) result.wallTimeLimitMs = wallTimeLimitMs;
  for (const key of ["inputTokenLimit", "outputTokenLimit"] as const) {
    const value = requested?.[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new ValidationError(`AI generation ${key} must be a positive integer`);
    }
    if (value !== undefined) result[key] = value;
  }
  if (result.tokenLimit !== undefined &&
      (result.inputTokenLimit ?? 0) + (result.outputTokenLimit ?? 0) > result.tokenLimit) {
    throw new ValidationError("AI generation input/output token limits exceed the total token limit");
  }
  return result;
}

function generationCostReservation(
  pricing: {
    readonly inputUsdPerToken: number;
    readonly outputUsdPerToken: number;
  } | null,
  estimatedInputTokens: number,
  reservedOutputTokens: number,
  costLimitUsd: number | undefined,
): number {
  if (pricing === null) return costLimitUsd ?? 0;
  const estimated =
    estimatedInputTokens * pricing.inputUsdPerToken +
    reservedOutputTokens * pricing.outputUsdPerToken;
  if (!Number.isFinite(estimated) || estimated < 0) {
    throw new ValidationError("AI generation catalog pricing produced an invalid cost reservation");
  }
  return costLimitUsd === undefined ? estimated : Math.min(estimated, costLimitUsd);
}

function generationBudgetExceeded(
  budget: AiGenerationBudgetLimits,
  usage: Usage,
  elapsedMs: number,
): string | undefined {
  if (budget.inputTokenLimit !== undefined && usage.inputTokens > budget.inputTokenLimit) {
    return `AI generation input-token budget ${budget.inputTokenLimit} was exceeded`;
  }
  if (budget.outputTokenLimit !== undefined && usage.outputTokens > budget.outputTokenLimit) {
    return `AI generation output-token budget ${budget.outputTokenLimit} was exceeded`;
  }
  if (budget.tokenLimit !== undefined && usage.inputTokens + usage.outputTokens > budget.tokenLimit) {
    return `AI generation token budget ${budget.tokenLimit} was exceeded`;
  }
  if (budget.costLimitUsd !== undefined && usage.costUsd > budget.costLimitUsd) {
    return `AI generation cost budget ${budget.costLimitUsd} USD was exceeded`;
  }
  if (budget.wallTimeLimitMs !== undefined && elapsedMs > budget.wallTimeLimitMs) {
    return `AI generation wall-time budget ${budget.wallTimeLimitMs}ms was exceeded`;
  }
  return undefined;
}

function generationValue(kind: AiGenerationKind, output: ReturnType<typeof validateModelEffectOutputV2>): JsonValue {
  if (kind === "text") {
    if (output.result.kind !== "text") throw new ValidationError("Text AI generation returned a structured result");
    return output.result.text;
  }
  if (output.result.kind !== "tool-submission") throw new ValidationError("Object AI generation did not submit its declared object");
  const input = output.result.submission.input;
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, "value")) {
    throw new ValidationError("Object AI generation has no validated value");
  }
  assertJsonValue(input.value);
  return input.value;
}

function finishReason(value: { readonly kind: string; readonly rawReason?: string }): string {
  return value.rawReason?.trim() || value.kind;
}

function handle(record: AiGenerationRecord): AiGenerationHandle {
  return {
    generationId: record.generationId, sessionId: record.sessionId,
    branchId: record.branchId, kind: record.kind, status: record.status,
    idempotencyKey: record.idempotencyKey, createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

function resultRecord(record: AiGenerationRecord): AiGenerationResult {
  const result = record.result;
  return {
    generationId: record.generationId, status: record.status, kind: record.kind,
    ...(record.kind === "text" && typeof result?.value === "string" ? { text: result.value } : {}),
    ...(record.kind === "object" && result?.value !== undefined ? { object: result.value } : {}),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(result === undefined ? {} : {
      finishReason: result.finishReason, usage: result.usage, warnings: result.warnings,
    }),
    provenance: {
      sessionId: record.sessionId, branchId: record.branchId, effectId: record.effectId,
      requestDigest: record.request.requestDigest,
      model: record.request.modelDispatch.configuration,
      responseContract: record.request.modelDispatch.responseContract,
      responseCapability: record.request.modelDispatch.responseCapability,
      contextEventId: record.request.contextEventId,
      contextDigest: record.request.contextDigest,
      providerInputDigest: record.request.providerInput.digest,
      ...(result === undefined ? {} : {
        resultDigest: result.resultDigest,
        resultBytes: result.resultBytes,
        usageSource: result.usageSource,
        sourceOutcomeEventId: result.sourceOutcomeEventId,
      }),
    },
  };
}

function terminal(status: AiGenerationStatus): boolean {
  return ["succeeded", "failed", "cancelled", "unknown", "budget_exceeded"].includes(status);
}

function stableGenerationId(sessionId: string, branchId: string, key: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(`${sessionId}\0${branchId}\0${key}`);
  return `generation-${hash.digest("hex").slice(0, 32)}`;
}

function stableGenerationContextEventId(generationId: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(`ai-generation-context:${generationId}`);
  return `generation-context-${hash.digest("hex").slice(0, 32)}`;
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
