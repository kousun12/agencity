import {
  computeCompactionThresholds,
  type CompactionThresholds,
} from "./compaction-core.ts";

/**
 * Pure context-window admission policy for FU-019.
 *
 * The controller owns no provider, model, storage, outbox, or event services.
 * It only coordinates caller-supplied candidate, estimate, and compaction
 * functions and returns attributable decisions for a later integration layer.
 */

export const OLDEST_ELIGIBLE_PREFIX = "oldest-eligible-prefix-v1" as const;
export const MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS = 8;
export const MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES = 2;

export enum ModelContextCapacitySource {
  ProviderMetadata = "provider-metadata",
  ModelCatalog = "model-catalog",
  OperatorConfiguration = "operator-configuration",
  Unknown = "unknown",
}

/** Exact model and source from which an advertised capacity was obtained. */
export interface ModelContextCapacityProvenance {
  readonly provider: string;
  readonly model: string;
  readonly source: ModelContextCapacitySource;
}

/**
 * Capacity and policy used for one admission decision. A null window is a
 * supported, explicit state: proactive compaction is skipped rather than
 * guessing a provider limit.
 */
export interface ModelContextWindowConfiguration {
  readonly provenance: ModelContextCapacityProvenance;
  readonly contextWindowTokens: number | null;
  readonly maxOutputReserveTokens: number;
  readonly estimatorId: string;
  readonly triggerRatio: number;
  readonly targetRatio: number;
}

export type ContextWindowAdmissionMode = "proactive" | "explicit";

export interface ContextWindowBuildRequest {
  readonly phase: "initial" | "after-compaction";
  readonly completedCompactions: number;
}

export interface ContextWindowEstimateRequest {
  readonly estimatorId: string;
  readonly completedCompactions: number;
}

export interface ContextWindowCompactionRequest<TCandidate> {
  readonly candidate: TCandidate;
  readonly estimatedInputTokens: number;
  readonly targetInputTokens: number | null;
  readonly iteration: number;
  /** Callers must compact the oldest eligible prefix, never live protected state. */
  readonly selection: typeof OLDEST_ELIGIBLE_PREFIX;
  readonly reason: "proactive-threshold" | "explicit-request";
  readonly capacity: ModelContextWindowConfiguration;
}

export type ContextWindowCompactionResult<TProvenance> =
  | {
    readonly outcome: "compacted";
    readonly provenance: TProvenance;
  }
  | {
    readonly outcome: "protected-only";
    readonly protectedSourceCount: number;
  };

export interface ContextWindowAdmissionCallbacks<TCandidate, TCompactionProvenance> {
  readonly buildCandidate: (
    request: ContextWindowBuildRequest,
  ) => TCandidate | Promise<TCandidate>;
  readonly estimate: (
    candidate: TCandidate,
    request: ContextWindowEstimateRequest,
  ) => number | Promise<number>;
  /**
   * Applies one derived-view compaction. The callback is responsible for the
   * requested oldest-prefix selection and returns its exact provenance. It must
   * not delete canonical history.
   */
  readonly compact: (
    request: ContextWindowCompactionRequest<TCandidate>,
  ) => ContextWindowCompactionResult<TCompactionProvenance>
    | Promise<ContextWindowCompactionResult<TCompactionProvenance>>;
}

export interface ContextWindowCompactionRecord<TProvenance> {
  readonly iteration: number;
  readonly selection: typeof OLDEST_ELIGIBLE_PREFIX;
  readonly reason: "proactive-threshold" | "explicit-request";
  readonly estimatorId: string;
  readonly capacityProvenance: ModelContextCapacityProvenance;
  readonly beforeEstimatedInputTokens: number;
  readonly afterEstimatedInputTokens: number;
  readonly reclaimedEstimatedTokens: number;
  readonly provenance: TProvenance;
}

export type ContextWindowAdmissionReason =
  | "below-trigger"
  | "target-reached"
  | "unknown-capacity"
  | "explicit-compaction-complete";

export interface ContextWindowAdmissionResult<TCandidate, TCompactionProvenance> {
  readonly candidate: TCandidate;
  readonly configuration: ModelContextWindowConfiguration;
  readonly thresholds: CompactionThresholds | null;
  readonly mode: ContextWindowAdmissionMode;
  readonly reason: ContextWindowAdmissionReason;
  readonly initialEstimatedInputTokens: number;
  readonly estimatedInputTokens: number;
  readonly compactions: readonly ContextWindowCompactionRecord<TCompactionProvenance>[];
}

export type ContextWindowAdmissionBlockedCode =
  | "protected-only"
  | "no-progress"
  | "iteration-limit";

export interface ContextWindowAdmissionBlockedState<TProvenance> {
  readonly initialEstimatedInputTokens: number;
  readonly estimatedInputTokens: number;
  readonly targetInputTokens: number | null;
  readonly completedCompactions: readonly ContextWindowCompactionRecord<TProvenance>[];
}

export class ContextWindowAdmissionBlockedError<TProvenance = unknown> extends Error {
  readonly code: ContextWindowAdmissionBlockedCode;
  readonly state: ContextWindowAdmissionBlockedState<TProvenance>;

  constructor(
    code: ContextWindowAdmissionBlockedCode,
    message: string,
    state: ContextWindowAdmissionBlockedState<TProvenance>,
  ) {
    super(message);
    this.name = "ContextWindowAdmissionBlockedError";
    this.code = code;
    this.state = freezeBlockedState(state);
  }
}

export class ProtectedOnlyContextWindowError<TProvenance = unknown>
  extends ContextWindowAdmissionBlockedError<TProvenance> {
  readonly protectedSourceCount: number;

  constructor(protectedSourceCount: number, state: ContextWindowAdmissionBlockedState<TProvenance>) {
    super(
      "protected-only",
      "Context compaction is blocked because only protected state remains eligible for admission",
      state,
    );
    this.name = "ProtectedOnlyContextWindowError";
    this.protectedSourceCount = protectedSourceCount;
  }
}

export class NoContextWindowProgressError<TProvenance = unknown>
  extends ContextWindowAdmissionBlockedError<TProvenance> {
  readonly priorEstimatedInputTokens: number;
  readonly rebuiltEstimatedInputTokens: number;

  constructor(
    priorEstimatedInputTokens: number,
    rebuiltEstimatedInputTokens: number,
    state: ContextWindowAdmissionBlockedState<TProvenance>,
  ) {
    super(
      "no-progress",
      "Context compaction did not produce a strictly smaller rebuilt estimate",
      state,
    );
    this.name = "NoContextWindowProgressError";
    this.priorEstimatedInputTokens = priorEstimatedInputTokens;
    this.rebuiltEstimatedInputTokens = rebuiltEstimatedInputTokens;
  }
}

export class ContextWindowIterationLimitError<TProvenance = unknown>
  extends ContextWindowAdmissionBlockedError<TProvenance> {
  readonly iterationLimit = MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS;

  constructor(state: ContextWindowAdmissionBlockedState<TProvenance>) {
    super(
      "iteration-limit",
      `Context compaction did not reach its target within ${MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS} iterations`,
      state,
    );
    this.name = "ContextWindowIterationLimitError";
  }
}

export class ContextWindowConfigurationError extends Error {
  readonly code = "invalid-context-window-configuration" as const;

  constructor(message: string) {
    super(message);
    this.name = "ContextWindowConfigurationError";
  }
}

export interface AdmitContextWindowOptions {
  /** Explicit mode compacts at least once, including when capacity is unknown. */
  readonly mode?: ContextWindowAdmissionMode;
}

/** Stateful facade for one provider/model admission policy. Durable state remains caller-owned. */
export class ContextWindowController {
  constructor(readonly configuration: ModelContextWindowConfiguration) {}

  admit<TCandidate, TCompactionProvenance>(
    callbacks: ContextWindowAdmissionCallbacks<TCandidate, TCompactionProvenance>,
    options: AdmitContextWindowOptions = {},
  ): Promise<ContextWindowAdmissionResult<TCandidate, TCompactionProvenance>> {
    return admitContextWindow(this.configuration, callbacks, options);
  }
}

/**
 * Builds and estimates the exact provider candidate before admission. Known
 * capacities compact inclusively at the trigger and continue toward the lower
 * target. Every pass rebuilds and re-estimates; a pass which fails to strictly
 * reduce the estimate is blocked. Unknown capacities skip proactive work but
 * still support one explicitly requested compaction pass.
 */
export async function admitContextWindow<TCandidate, TCompactionProvenance>(
  configuration: ModelContextWindowConfiguration,
  callbacks: ContextWindowAdmissionCallbacks<TCandidate, TCompactionProvenance>,
  options: AdmitContextWindowOptions = {},
): Promise<ContextWindowAdmissionResult<TCandidate, TCompactionProvenance>> {
  const checked = validateContextWindowConfiguration(configuration);
  const mode = options.mode ?? "proactive";
  if (mode !== "proactive" && mode !== "explicit") {
    throw new ContextWindowConfigurationError("Context-window admission mode must be proactive or explicit");
  }
  const thresholds = checked.contextWindowTokens === null
    ? null
    : computeCompactionThresholds({
      contextWindowTokens: checked.contextWindowTokens,
      outputReserveTokens: checked.maxOutputReserveTokens,
      triggerRatio: checked.triggerRatio,
      targetRatio: checked.targetRatio,
    });

  let candidate = await callbacks.buildCandidate({ phase: "initial", completedCompactions: 0 });
  let estimatedInputTokens = checkedEstimate(await callbacks.estimate(candidate, {
    estimatorId: checked.estimatorId,
    completedCompactions: 0,
  }));
  const initialEstimatedInputTokens = estimatedInputTokens;
  const compactions: ContextWindowCompactionRecord<TCompactionProvenance>[] = [];

  if (mode === "proactive" && thresholds === null) {
    return admissionResult(
      candidate,
      checked,
      thresholds,
      mode,
      "unknown-capacity",
      initialEstimatedInputTokens,
      estimatedInputTokens,
      compactions,
    );
  }
  if (mode === "proactive" && thresholds !== null && estimatedInputTokens < thresholds.triggerInputTokens) {
    return admissionResult(
      candidate,
      checked,
      thresholds,
      mode,
      "below-trigger",
      initialEstimatedInputTokens,
      estimatedInputTokens,
      compactions,
    );
  }

  const targetInputTokens = thresholds?.targetInputTokens ?? null;
  const compactionReason: ContextWindowCompactionRecord<unknown>["reason"] = mode === "explicit"
    ? "explicit-request"
    : "proactive-threshold";
  while (
    (mode === "explicit" && compactions.length === 0)
    || (targetInputTokens !== null && estimatedInputTokens > targetInputTokens)
  ) {
    if (compactions.length >= MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS) {
      throw new ContextWindowIterationLimitError(blockedState(
        initialEstimatedInputTokens,
        estimatedInputTokens,
        targetInputTokens,
        compactions,
      ));
    }
    const iteration = compactions.length + 1;
    const priorEstimate = estimatedInputTokens;
    const compacted = await callbacks.compact({
      candidate,
      estimatedInputTokens,
      targetInputTokens,
      iteration,
      selection: OLDEST_ELIGIBLE_PREFIX,
      reason: compactionReason,
      capacity: checked,
    });
    if (compacted.outcome === "protected-only") {
      validateNonnegativeInteger(compacted.protectedSourceCount, "protectedSourceCount");
      throw new ProtectedOnlyContextWindowError(
        compacted.protectedSourceCount,
        blockedState(initialEstimatedInputTokens, estimatedInputTokens, targetInputTokens, compactions),
      );
    }

    candidate = await callbacks.buildCandidate({
      phase: "after-compaction",
      completedCompactions: iteration,
    });
    estimatedInputTokens = checkedEstimate(await callbacks.estimate(candidate, {
      estimatorId: checked.estimatorId,
      completedCompactions: iteration,
    }));
    const record = Object.freeze({
      iteration,
      selection: OLDEST_ELIGIBLE_PREFIX,
      reason: compactionReason,
      estimatorId: checked.estimatorId,
      capacityProvenance: checked.provenance,
      beforeEstimatedInputTokens: priorEstimate,
      afterEstimatedInputTokens: estimatedInputTokens,
      reclaimedEstimatedTokens: priorEstimate - estimatedInputTokens,
      provenance: compacted.provenance,
    });
    compactions.push(record);
    if (estimatedInputTokens >= priorEstimate) {
      throw new NoContextWindowProgressError(
        priorEstimate,
        estimatedInputTokens,
        blockedState(initialEstimatedInputTokens, estimatedInputTokens, targetInputTokens, compactions),
      );
    }
  }

  return admissionResult(
    candidate,
    checked,
    thresholds,
    mode,
    mode === "explicit" && thresholds === null ? "explicit-compaction-complete" : "target-reached",
    initialEstimatedInputTokens,
    estimatedInputTokens,
    compactions,
  );
}

export enum ProviderModelErrorCode {
  ProviderConfirmedContextWindowOverflow = "provider-confirmed-context-window-overflow",
  Generic = "generic",
  Unknown = "unknown",
}

/** Adapter-supplied classification. Raw provider text is deliberately absent. */
export interface ProviderModelErrorClassification {
  readonly provider: string;
  readonly model: string;
  readonly code: ProviderModelErrorCode;
}

export function isProviderConfirmedContextWindowOverflow(
  classification: ProviderModelErrorClassification,
): boolean {
  return validateProviderClassification(classification).code
    === ProviderModelErrorCode.ProviderConfirmedContextWindowOverflow;
}

export type ContextWindowOverflowRetryReason =
  | "provider-overflow-smaller-candidate"
  | "generic-error"
  | "unknown-error"
  | "estimate-not-strictly-smaller"
  | "retry-limit";

export interface ContextWindowOverflowRetryInput {
  readonly classification: ProviderModelErrorClassification;
  /** Number of overflow retries already issued after the original attempt. */
  readonly retriesAlreadyAttempted: number;
  readonly rejectedEstimatedInputTokens: number;
  readonly nextEstimatedInputTokens: number;
}

export interface ContextWindowOverflowRetryPlan {
  readonly retry: boolean;
  readonly reason: ContextWindowOverflowRetryReason;
  readonly nextRetryOrdinal: number | null;
  readonly retryLimit: typeof MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES;
  readonly remainingRetriesAfterPlan: number;
  readonly rejectedEstimatedInputTokens: number;
  readonly nextEstimatedInputTokens: number;
  readonly classification: ProviderModelErrorClassification;
}

/**
 * Plans only typed, provider-confirmed overflow retries. Generic/unknown errors
 * never retry here, and even confirmed overflow requires a strictly smaller
 * rebuilt estimate and stays under the fixed module cap.
 */
export function planContextWindowOverflowRetry(
  input: ContextWindowOverflowRetryInput,
): ContextWindowOverflowRetryPlan {
  validateNonnegativeInteger(input.retriesAlreadyAttempted, "retriesAlreadyAttempted");
  validateNonnegativeInteger(input.rejectedEstimatedInputTokens, "rejectedEstimatedInputTokens");
  validateNonnegativeInteger(input.nextEstimatedInputTokens, "nextEstimatedInputTokens");
  const classification = validateProviderClassification(input.classification);

  let retry = false;
  let reason: ContextWindowOverflowRetryReason;
  if (classification.code === ProviderModelErrorCode.Generic) reason = "generic-error";
  else if (classification.code === ProviderModelErrorCode.Unknown) reason = "unknown-error";
  else if (input.retriesAlreadyAttempted >= MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES) reason = "retry-limit";
  else if (input.nextEstimatedInputTokens >= input.rejectedEstimatedInputTokens) reason = "estimate-not-strictly-smaller";
  else {
    retry = true;
    reason = "provider-overflow-smaller-candidate";
  }
  const consumedRetries = input.retriesAlreadyAttempted + (retry ? 1 : 0);
  return Object.freeze({
    retry,
    reason,
    nextRetryOrdinal: retry ? input.retriesAlreadyAttempted + 1 : null,
    retryLimit: MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES,
    remainingRetriesAfterPlan: Math.max(0, MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES - consumedRetries),
    rejectedEstimatedInputTokens: input.rejectedEstimatedInputTokens,
    nextEstimatedInputTokens: input.nextEstimatedInputTokens,
    classification,
  });
}

function validateContextWindowConfiguration(
  configuration: ModelContextWindowConfiguration,
): ModelContextWindowConfiguration {
  if (configuration === null || typeof configuration !== "object") {
    throw new ContextWindowConfigurationError("Context-window configuration must be an object");
  }
  const provider = validatedModelIdentity(configuration.provenance?.provider, "capacity provider");
  const model = validatedModelIdentity(configuration.provenance?.model, "capacity model");
  const source = configuration.provenance?.source;
  if (!Object.values(ModelContextCapacitySource).includes(source)) {
    throw new ContextWindowConfigurationError("Context-window capacity source is invalid");
  }
  if (configuration.contextWindowTokens !== null) {
    validatePositiveInteger(configuration.contextWindowTokens, "contextWindowTokens");
  }
  validateNonnegativeInteger(configuration.maxOutputReserveTokens, "maxOutputReserveTokens");
  const estimatorId = validatedModelIdentity(configuration.estimatorId, "estimatorId");
  if (!Number.isFinite(configuration.triggerRatio)
    || configuration.triggerRatio <= 0
    || configuration.triggerRatio > 1) {
    throw new ContextWindowConfigurationError("triggerRatio must be in (0, 1]");
  }
  if (!Number.isFinite(configuration.targetRatio)
    || configuration.targetRatio < 0
    || configuration.targetRatio >= configuration.triggerRatio) {
    throw new ContextWindowConfigurationError("targetRatio must be in [0, triggerRatio)");
  }
  if (configuration.contextWindowTokens !== null
    && configuration.maxOutputReserveTokens >= configuration.contextWindowTokens) {
    throw new ContextWindowConfigurationError(
      "maxOutputReserveTokens must be smaller than contextWindowTokens",
    );
  }
  return Object.freeze({
    provenance: Object.freeze({ provider, model, source }),
    contextWindowTokens: configuration.contextWindowTokens,
    maxOutputReserveTokens: configuration.maxOutputReserveTokens,
    estimatorId,
    triggerRatio: configuration.triggerRatio,
    targetRatio: configuration.targetRatio,
  });
}

function validateProviderClassification(
  classification: ProviderModelErrorClassification,
): ProviderModelErrorClassification {
  if (classification === null || typeof classification !== "object") {
    throw new ContextWindowConfigurationError("Provider error classification must be an object");
  }
  const provider = validatedModelIdentity(classification.provider, "classification provider");
  const model = validatedModelIdentity(classification.model, "classification model");
  if (!Object.values(ProviderModelErrorCode).includes(classification.code)) {
    throw new ContextWindowConfigurationError("Provider error classification code is invalid");
  }
  return Object.freeze({ provider, model, code: classification.code });
}

function checkedEstimate(value: number): number {
  validateNonnegativeInteger(value, "estimatedInputTokens");
  return value;
}

function admissionResult<TCandidate, TProvenance>(
  candidate: TCandidate,
  configuration: ModelContextWindowConfiguration,
  thresholds: CompactionThresholds | null,
  mode: ContextWindowAdmissionMode,
  reason: ContextWindowAdmissionReason,
  initialEstimatedInputTokens: number,
  estimatedInputTokens: number,
  compactions: readonly ContextWindowCompactionRecord<TProvenance>[],
): ContextWindowAdmissionResult<TCandidate, TProvenance> {
  return Object.freeze({
    candidate,
    configuration,
    thresholds,
    mode,
    reason,
    initialEstimatedInputTokens,
    estimatedInputTokens,
    compactions: Object.freeze([...compactions]),
  });
}

function blockedState<TProvenance>(
  initialEstimatedInputTokens: number,
  estimatedInputTokens: number,
  targetInputTokens: number | null,
  compactions: readonly ContextWindowCompactionRecord<TProvenance>[],
): ContextWindowAdmissionBlockedState<TProvenance> {
  return {
    initialEstimatedInputTokens,
    estimatedInputTokens,
    targetInputTokens,
    completedCompactions: compactions,
  };
}

function freezeBlockedState<TProvenance>(
  state: ContextWindowAdmissionBlockedState<TProvenance>,
): ContextWindowAdmissionBlockedState<TProvenance> {
  return Object.freeze({
    initialEstimatedInputTokens: state.initialEstimatedInputTokens,
    estimatedInputTokens: state.estimatedInputTokens,
    targetInputTokens: state.targetInputTokens,
    completedCompactions: Object.freeze([...state.completedCompactions]),
  });
}

function validatedModelIdentity(value: unknown, name: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\u0000-\u001f]/.test(value)) {
    throw new ContextWindowConfigurationError(`${name} must be bounded non-empty text without control characters`);
  }
  return value;
}

function validateNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContextWindowConfigurationError(`${name} must be a nonnegative safe integer`);
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ContextWindowConfigurationError(`${name} must be a positive safe integer`);
  }
}
