/**
 * Pure planning primitives for FU-019 context compaction.
 *
 * This module deliberately knows nothing about storage, reducers, model calls,
 * or context persistence. Callers provide immutable event-shaped data and may
 * persist a returned plan in a later integration tranche. Canonical history is
 * never changed here.
 */

const UTF8 = new TextEncoder();
const COMPACTABLE_EVENT_TYPES = new Set(["MessageAppended"]);
const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

export const DETERMINISTIC_EXTRACTIVE_STRATEGY = "deterministic-extractive-v1" as const;
export const COMPACTION_SOURCE_FORMAT = "agencity-compaction-sources-v1" as const;
export const COMPACTION_LEAF_FORMAT = "agencity-compaction-leaves-v1" as const;

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type CompactionSourceDisposition = "compactable" | "protected";

/** The structural subset of AgentEvent consumed by the pure planner. */
export interface CompactionSourceInput {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly cursor: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
}

export interface FrozenCompactionSourceRecord {
  readonly eventId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly cursor: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: CanonicalJsonValue;
  readonly disposition: CompactionSourceDisposition;
  readonly classificationReason: string;
  /** Size of the exact canonical payload, not a provider token count. */
  readonly payloadUtf8Bytes: number;
}

export interface CompactionSourcePlan {
  readonly sessionId: string;
  readonly branchId: string;
  readonly throughCursor: string;
  readonly records: readonly FrozenCompactionSourceRecord[];
  readonly compactable: readonly FrozenCompactionSourceRecord[];
  readonly protected: readonly FrozenCompactionSourceRecord[];
  /** Digest of every frozen record through the cursor. */
  readonly frozenSourceDigest: string;
  /** Digest of only the ordered records eligible for narrative compaction. */
  readonly compactableSourceDigest: string;
}

export interface PlanCompactionSourcesOptions {
  readonly sessionId: string;
  readonly branchId: string;
  readonly throughCursor: string;
  /** Explicit branch-lineage mode retains original source branch envelopes. */
  readonly allowLineageBranches?: boolean;
}

export type CompactionPlanningErrorCode = "protected-only" | "no-progress";

export class CompactionPlanningError extends Error {
  readonly code: CompactionPlanningErrorCode;
  readonly details: Readonly<Record<string, number>>;

  constructor(code: CompactionPlanningErrorCode, message: string, details: Record<string, number> = {}) {
    super(message);
    this.name = "CompactionPlanningError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class ProtectedOnlyCompactionError extends CompactionPlanningError {
  constructor(protectedSourceCount: number) {
    super(
      "protected-only",
      "Compaction has no narrative source records; protected durable state cannot be summarized away",
      { protectedSourceCount },
    );
    this.name = "ProtectedOnlyCompactionError";
  }
}

export class NoCompactionProgressError extends CompactionPlanningError {
  constructor(compactableInputTokens: number, replacementTokens: number, minimumReclaimedTokens: number) {
    super(
      "no-progress",
      "Compaction would not reclaim the required context capacity",
      { compactableInputTokens, replacementTokens, minimumReclaimedTokens },
    );
    this.name = "NoCompactionProgressError";
  }
}

export type CompactionRematerializationErrorCode =
  | "invalid-manifest"
  | "missing-source"
  | "duplicate-source"
  | "source-after-cursor"
  | "source-order-mismatch"
  | "source-digest-mismatch";

export class CompactionRematerializationError extends Error {
  readonly code: CompactionRematerializationErrorCode;

  constructor(code: CompactionRematerializationErrorCode, message: string) {
    super(message);
    this.name = "CompactionRematerializationError";
    this.code = code;
  }
}

export type CompactionInstructionErrorCode =
  | "instructions-invalid"
  | "instructions-too-large"
  | "instructions-contain-secret";

export class CompactionInstructionError extends Error {
  readonly code: CompactionInstructionErrorCode;

  constructor(code: CompactionInstructionErrorCode, message: string) {
    super(message);
    this.name = "CompactionInstructionError";
    this.code = code;
  }
}

export class CompactionConfigurationError extends Error {
  readonly code = "invalid-compaction-configuration" as const;

  constructor(message: string) {
    super(message);
    this.name = "CompactionConfigurationError";
  }
}

/**
 * Returns the strict, future-safe source classification. Only complete retained
 * messages are compactable. Unknown and newly introduced event types are
 * protected until explicitly reviewed; name-based categories below improve
 * audit explanations but never broaden eligibility.
 */
export function classifyCompactionSource(
  source: Pick<CompactionSourceInput, "type" | "payload">,
): Readonly<{ disposition: CompactionSourceDisposition; reason: string }> {
  if (COMPACTABLE_EVENT_TYPES.has(source.type) && isNarrativeMessagePayload(source.payload)) {
    return Object.freeze({ disposition: "compactable", reason: "retained canonical conversation narrative" });
  }
  if (source.type === "MessageAppended") {
    return Object.freeze({ disposition: "protected", reason: "malformed message payload is not compactable narrative" });
  }
  const reason = protectionReason(source.type);
  return Object.freeze({ disposition: "protected", reason });
}

/**
 * Clones, deep-freezes, classifies, and canonically orders one branch's exact
 * records at or before `throughCursor`. Inputs are never mutated.
 */
export function planCompactionSources(
  sources: readonly CompactionSourceInput[],
  options: PlanCompactionSourcesOptions,
): CompactionSourcePlan {
  validateIdentity(options.sessionId, "sessionId");
  validateIdentity(options.branchId, "branchId");
  validateCursor(options.throughCursor, "throughCursor");

  const seenIds = new Set<string>();
  const records: FrozenCompactionSourceRecord[] = [];
  for (const source of sources) {
    validateSourceShape(source);
    if (source.sessionId !== options.sessionId || (!options.allowLineageBranches && source.branchId !== options.branchId)) {
      throw new TypeError("Compaction sources must all belong to the requested session and branch unless lineage mode is explicit");
    }
    if (seenIds.has(source.id)) throw new TypeError(`Duplicate compaction source event ID: ${source.id}`);
    seenIds.add(source.id);
    if (compareCursors(source.cursor, options.throughCursor) > 0) continue;

    const canonicalPayload = canonicalJson(source.payload);
    const payload = deepFreeze(JSON.parse(canonicalPayload) as CanonicalJsonValue);
    const classification = classifyCompactionSource({ type: source.type, payload });
    records.push(Object.freeze({
      eventId: source.id,
      sessionId: source.sessionId,
      branchId: source.branchId,
      cursor: source.cursor,
      type: source.type,
      schemaVersion: source.schemaVersion,
      payload,
      disposition: classification.disposition,
      classificationReason: classification.reason,
      payloadUtf8Bytes: utf8Bytes(canonicalPayload),
    }));
  }
  records.sort(compareSources);

  const frozenRecords = Object.freeze([...records]);
  const compactable = Object.freeze(records.filter((record) => record.disposition === "compactable"));
  const protectedRecords = Object.freeze(records.filter((record) => record.disposition === "protected"));
  return Object.freeze({
    sessionId: options.sessionId,
    branchId: options.branchId,
    throughCursor: options.throughCursor,
    records: frozenRecords,
    compactable,
    protected: protectedRecords,
    frozenSourceDigest: canonicalSourceDigest(frozenRecords),
    compactableSourceDigest: canonicalSourceDigest(compactable),
  });
}

/** SHA-256 over canonical, content-bearing source envelopes in cursor order. */
export function canonicalSourceDigest(sources: readonly FrozenCompactionSourceRecord[]): string {
  const ordered = canonicalOrderedSources(sources);
  const envelope = {
    format: COMPACTION_SOURCE_FORMAT,
    sources: ordered.map(sourceEnvelope),
  };
  return sha256(canonicalJson(envelope));
}

export interface ExactCompactionSourceManifest {
  readonly format: typeof COMPACTION_SOURCE_FORMAT;
  readonly sessionId: string;
  readonly branchId: string;
  readonly throughCursor: string;
  readonly sourceEventIds: readonly string[];
  readonly sourceDigest: string;
  readonly allowLineageBranches?: boolean;
}

/** Captures the exact source set required to reproduce a derived summary. */
export function createExactSourceManifest(
  sources: readonly FrozenCompactionSourceRecord[],
  options: PlanCompactionSourcesOptions,
): ExactCompactionSourceManifest {
  validateIdentity(options.sessionId, "manifest sessionId");
  validateIdentity(options.branchId, "manifest branchId");
  validateCursor(options.throughCursor, "manifest throughCursor");
  const ordered = canonicalOrderedSources(sources);
  for (const source of ordered) {
    if (source.sessionId !== options.sessionId || (!options.allowLineageBranches && source.branchId !== options.branchId)) {
      throw new CompactionRematerializationError("invalid-manifest", "Manifest sources cross a session or branch boundary without explicit lineage mode");
    }
    if (compareCursors(source.cursor, options.throughCursor) > 0) {
      throw new CompactionRematerializationError("source-after-cursor", `Source ${source.eventId} is after the manifest cursor`);
    }
  }
  return Object.freeze({
    format: COMPACTION_SOURCE_FORMAT,
    sessionId: options.sessionId,
    branchId: options.branchId,
    throughCursor: options.throughCursor,
    sourceEventIds: Object.freeze(ordered.map((source) => source.eventId)),
    sourceDigest: canonicalSourceDigest(ordered),
    ...(options.allowLineageBranches ? { allowLineageBranches: true } : {}),
  });
}

/**
 * Resolves a manifest against retained events and proves exact identity,
 * ordering, type/schema/cursor metadata, and canonical payload equality.
 * Unselected branch events are allowed; the manifest's selected set is exact.
 */
export function validateRematerializedSources(
  manifest: ExactCompactionSourceManifest,
  retainedSources: readonly CompactionSourceInput[],
): readonly FrozenCompactionSourceRecord[] {
  validateManifest(manifest);
  const retainedById = new Map<string, CompactionSourceInput>();
  for (const source of retainedSources) {
    validateSourceShape(source);
    if (source.sessionId !== manifest.sessionId) continue;
    if (retainedById.has(source.id)) {
      throw new CompactionRematerializationError("duplicate-source", `Retained source ${source.id} appears more than once`);
    }
    retainedById.set(source.id, source);
  }

  const exactInputs: CompactionSourceInput[] = [];
  for (const eventId of manifest.sourceEventIds) {
    const source = retainedById.get(eventId);
    if (!source) throw new CompactionRematerializationError("missing-source", `Retained source ${eventId} is unavailable`);
    if (compareCursors(source.cursor, manifest.throughCursor) > 0) {
      throw new CompactionRematerializationError("source-after-cursor", `Retained source ${eventId} moved after the manifest cursor`);
    }
    exactInputs.push(source);
  }

  const rematerialized = planCompactionSources(exactInputs, manifest);
  const actualIds = rematerialized.records.map((record) => record.eventId);
  if (!sameStrings(actualIds, manifest.sourceEventIds)) {
    throw new CompactionRematerializationError("source-order-mismatch", "Retained sources no longer have the manifest's canonical order");
  }
  if (rematerialized.frozenSourceDigest !== manifest.sourceDigest) {
    throw new CompactionRematerializationError("source-digest-mismatch", "Retained source content differs from the manifest digest");
  }
  return rematerialized.records;
}

export interface CompactionLeafReference {
  readonly eventId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly cursor: string;
  /** Canonical singleton source digest, including the exact payload. */
  readonly sourceDigest: string;
}

export interface RollingCompactionProvenance {
  readonly format: typeof COMPACTION_LEAF_FORMAT;
  readonly generation: number;
  readonly leaves: readonly CompactionLeafReference[];
  readonly leafEventIds: readonly string[];
  /** Digest of the ordered leaf references and their singleton digests. */
  readonly leafDigest: string;
}

/**
 * Flattens earlier rollups plus newly summarized records into ordered leaf
 * provenance. Duplicate leaves must agree exactly, preventing provenance from
 * being silently rewritten as rolling summaries are composed.
 */
export function composeRollingLeafProvenance(
  newSources: readonly FrozenCompactionSourceRecord[],
  ancestors: readonly RollingCompactionProvenance[] = [],
): RollingCompactionProvenance {
  const leaves = new Map<string, CompactionLeafReference>();
  let maxGeneration = 0;
  for (const ancestor of ancestors) {
    validateRollingProvenance(ancestor);
    maxGeneration = Math.max(maxGeneration, ancestor.generation);
    for (const leaf of ancestor.leaves) addLeaf(leaves, leaf);
  }
  for (const source of canonicalOrderedSources(newSources)) {
    addLeaf(leaves, Object.freeze({
      eventId: source.eventId,
      sessionId: source.sessionId,
      branchId: source.branchId,
      type: source.type,
      schemaVersion: source.schemaVersion,
      cursor: source.cursor,
      sourceDigest: canonicalSourceDigest([source]),
    }));
  }
  const ordered = [...leaves.values()].sort(compareLeaves);
  const frozenLeaves = Object.freeze(ordered.map((leaf) => Object.freeze({ ...leaf })));
  const leafDigest = digestLeaves(frozenLeaves);
  return Object.freeze({
    format: COMPACTION_LEAF_FORMAT,
    generation: maxGeneration + 1,
    leaves: frozenLeaves,
    leafEventIds: Object.freeze(frozenLeaves.map((leaf) => leaf.eventId)),
    leafDigest,
  });
}

export interface DeterministicExtractiveOptions {
  /** Hard UTF-8 output bound. Defaults to 64 KiB. */
  readonly maxUtf8Bytes?: number;
  /** Per-message bound before the whole-summary bound is applied. */
  readonly maxSourceUtf8Bytes?: number;
}

export interface DeterministicExtractiveSummary {
  readonly strategy: typeof DETERMINISTIC_EXTRACTIVE_STRATEGY;
  readonly text: string;
  readonly utf8Bytes: number;
  readonly sourceEventIds: readonly string[];
  readonly includedEventIds: readonly string[];
  readonly truncatedEventIds: readonly string[];
  readonly omittedEventIds: readonly string[];
  readonly sourceDigest: string;
}

/**
 * Renders retained narrative in canonical source order. Every included block
 * names its event ID and type. Content and whole-summary truncation use
 * explicit markers, and truncation never slices a UTF-8 sequence.
 */
export function buildDeterministicExtractiveSummary(
  sources: readonly FrozenCompactionSourceRecord[],
  options: DeterministicExtractiveOptions = {},
): DeterministicExtractiveSummary {
  const ordered = canonicalOrderedSources(sources);
  if (!ordered.length) throw new ProtectedOnlyCompactionError(0);
  if (ordered.some((source) => source.disposition !== "compactable")) {
    const protectedCount = ordered.filter((source) => source.disposition === "protected").length;
    throw new ProtectedOnlyCompactionError(protectedCount);
  }

  const maxUtf8Bytes = options.maxUtf8Bytes ?? 64 * 1024;
  const maxSourceUtf8Bytes = options.maxSourceUtf8Bytes ?? 4 * 1024;
  validateIntegerBound(maxUtf8Bytes, 64, 1024 * 1024, "maxUtf8Bytes");
  validateIntegerBound(maxSourceUtf8Bytes, 64, 1024 * 1024, "maxSourceUtf8Bytes");

  const prefix = `[compaction strategy:${DETERMINISTIC_EXTRACTIVE_STRATEGY}]`;
  if (utf8Bytes(prefix) > maxUtf8Bytes) {
    throw new CompactionConfigurationError("maxUtf8Bytes cannot hold the deterministic strategy marker");
  }

  const parts = [prefix];
  const included: string[] = [];
  const truncated: string[] = [];
  let currentBytes = utf8Bytes(prefix);
  let index = 0;
  for (; index < ordered.length; index += 1) {
    const source = ordered[index]!;
    const remainingAfter = ordered.length - index - 1;
    const reserveMarker = remainingAfter > 0 ? summaryTruncationMarker(remainingAfter) : "";
    const separatorBytes = utf8Bytes("\n");
    const availableForBlock = maxUtf8Bytes - currentBytes - separatorBytes
      - (reserveMarker ? separatorBytes + utf8Bytes(reserveMarker) : 0);
    const block = renderExtractiveBlock(source, Math.min(maxSourceUtf8Bytes, availableForBlock));
    if (!block) break;
    parts.push(block.text);
    currentBytes += separatorBytes + block.utf8Bytes;
    included.push(source.eventId);
    if (block.truncated) truncated.push(source.eventId);
  }

  const omitted = ordered.slice(index).map((source) => source.eventId);
  if (omitted.length) parts.push(summaryTruncationMarker(omitted.length));
  const text = parts.join("\n");
  const finalBytes = utf8Bytes(text);
  if (finalBytes > maxUtf8Bytes) throw new Error("Internal error: extractive summary exceeded its UTF-8 bound");
  return Object.freeze({
    strategy: DETERMINISTIC_EXTRACTIVE_STRATEGY,
    text,
    utf8Bytes: finalBytes,
    sourceEventIds: Object.freeze(ordered.map((source) => source.eventId)),
    includedEventIds: Object.freeze(included),
    truncatedEventIds: Object.freeze(truncated),
    omittedEventIds: Object.freeze(omitted),
    sourceDigest: canonicalSourceDigest(ordered),
  });
}

export interface CompactionProgressInput {
  readonly compactableSourceCount: number;
  readonly protectedSourceCount: number;
  readonly compactableInputTokens: number;
  readonly replacementTokens: number;
  readonly minimumReclaimedTokens?: number;
}

export interface CompactionProgress {
  readonly compactableInputTokens: number;
  readonly replacementTokens: number;
  readonly reclaimedTokens: number;
  readonly minimumReclaimedTokens: number;
}

/** Rejects protected-only and non-shrinking plans before any effect is issued. */
export function assertCompactionProgress(input: CompactionProgressInput): CompactionProgress {
  for (const [name, value] of Object.entries({
    compactableSourceCount: input.compactableSourceCount,
    protectedSourceCount: input.protectedSourceCount,
    compactableInputTokens: input.compactableInputTokens,
    replacementTokens: input.replacementTokens,
  })) validateNonnegativeInteger(value, name);
  const minimumReclaimedTokens = input.minimumReclaimedTokens ?? 1;
  validateNonnegativeInteger(minimumReclaimedTokens, "minimumReclaimedTokens");
  if (input.compactableSourceCount === 0 || input.compactableInputTokens === 0) {
    throw new ProtectedOnlyCompactionError(input.protectedSourceCount);
  }
  const reclaimedTokens = input.compactableInputTokens - input.replacementTokens;
  if (reclaimedTokens < minimumReclaimedTokens) {
    throw new NoCompactionProgressError(
      input.compactableInputTokens,
      input.replacementTokens,
      minimumReclaimedTokens,
    );
  }
  return Object.freeze({
    compactableInputTokens: input.compactableInputTokens,
    replacementTokens: input.replacementTokens,
    reclaimedTokens,
    minimumReclaimedTokens,
  });
}

export interface CompactionInstructionBounds {
  readonly maxUtf8Bytes?: number;
  readonly maxCodePoints?: number;
  /** Explicit brokered values supplied by the caller; no environment is read. */
  readonly knownSecrets?: readonly string[];
}

export interface ValidatedCompactionInstructions {
  readonly text: string;
  readonly utf8Bytes: number;
  readonly codePoints: number;
}

/**
 * Validates optional preservation guidance without reading process state.
 * Callers must pass brokered secret values explicitly, preserving purity.
 */
export function validateCompactionInstructions(
  instructions: string | undefined,
  bounds: CompactionInstructionBounds = {},
): ValidatedCompactionInstructions | null {
  if (instructions === undefined) return null;
  if (typeof instructions !== "string" || instructions.includes("\0")) {
    throw new CompactionInstructionError("instructions-invalid", "Compaction instructions must be NUL-free text");
  }
  const maxUtf8Bytes = bounds.maxUtf8Bytes ?? 8 * 1024;
  const maxCodePoints = bounds.maxCodePoints ?? 4 * 1024;
  validateIntegerBound(maxUtf8Bytes, 1, 1024 * 1024, "instruction maxUtf8Bytes");
  validateIntegerBound(maxCodePoints, 1, 1024 * 1024, "instruction maxCodePoints");
  const size = utf8Bytes(instructions);
  const codePoints = [...instructions].length;
  if (size > maxUtf8Bytes || codePoints > maxCodePoints) {
    throw new CompactionInstructionError(
      "instructions-too-large",
      `Compaction instructions exceed their bound (${size}/${maxUtf8Bytes} UTF-8 bytes, ${codePoints}/${maxCodePoints} code points)`,
    );
  }
  if ((bounds.knownSecrets ?? []).some((secret) =>
    secret.length > 0 && instructions.includes(secret)
  )) {
    throw new CompactionInstructionError(
      "instructions-contain-secret",
      "Compaction instructions contain a registered credential value and cannot be retained",
    );
  }
  return Object.freeze({ text: instructions, utf8Bytes: size, codePoints });
}

export interface ContextEstimateOptions {
  /** Conservative UTF-8-byte/token ratio. Defaults to 3. */
  readonly utf8BytesPerToken?: number;
  readonly fixedTokenOverhead?: number;
}

export interface ContextWindowEstimate {
  readonly serialized: string;
  readonly utf8Bytes: number;
  readonly codePoints: number;
  readonly estimatedTokens: number;
  readonly utf8BytesPerToken: number;
  readonly fixedTokenOverhead: number;
}

/** Estimates a provider-facing string, or canonical JSON for structured context. */
export function estimateContextWindow(
  context: string | CanonicalJsonValue,
  options: ContextEstimateOptions = {},
): ContextWindowEstimate {
  const utf8BytesPerToken = options.utf8BytesPerToken ?? 3;
  const fixedTokenOverhead = options.fixedTokenOverhead ?? 0;
  if (!Number.isFinite(utf8BytesPerToken) || utf8BytesPerToken <= 0) {
    throw new CompactionConfigurationError("utf8BytesPerToken must be a positive finite number");
  }
  validateNonnegativeInteger(fixedTokenOverhead, "fixedTokenOverhead");
  const serialized = typeof context === "string" ? context : canonicalJson(context);
  const size = utf8Bytes(serialized);
  return Object.freeze({
    serialized,
    utf8Bytes: size,
    codePoints: [...serialized].length,
    estimatedTokens: Math.ceil(size / utf8BytesPerToken) + fixedTokenOverhead,
    utf8BytesPerToken,
    fixedTokenOverhead,
  });
}

export interface CompactionThresholdConfiguration {
  readonly contextWindowTokens: number;
  readonly outputReserveTokens?: number;
  /** Fraction of the whole provider window. Defaults to 0.8. */
  readonly triggerRatio?: number;
  /** Post-compaction fraction of the whole provider window. Defaults to 0.6. */
  readonly targetRatio?: number;
}

export interface CompactionThresholds {
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly hardInputLimitTokens: number;
  readonly triggerInputTokens: number;
  readonly targetInputTokens: number;
  readonly triggerRatio: number;
  readonly targetRatio: number;
}

/**
 * Computes input thresholds while reserving output space. Ratios apply to the
 * whole advertised window; the hard input limit caps them so input plus the
 * reserve can never exceed provider capacity.
 */
export function computeCompactionThresholds(
  configuration: CompactionThresholdConfiguration,
): CompactionThresholds {
  validatePositiveInteger(configuration.contextWindowTokens, "contextWindowTokens");
  const contextWindowTokens = configuration.contextWindowTokens;
  const outputReserveTokens = configuration.outputReserveTokens
    ?? Math.min(contextWindowTokens - 1, Math.max(1, Math.floor(contextWindowTokens * 0.1)));
  validateNonnegativeInteger(outputReserveTokens, "outputReserveTokens");
  if (outputReserveTokens >= contextWindowTokens) {
    throw new CompactionConfigurationError("outputReserveTokens must be smaller than the provider context window");
  }
  const triggerRatio = configuration.triggerRatio ?? 0.8;
  const targetRatio = configuration.targetRatio ?? 0.6;
  if (!Number.isFinite(triggerRatio) || triggerRatio <= 0 || triggerRatio > 1) {
    throw new CompactionConfigurationError("triggerRatio must be in (0, 1]");
  }
  if (!Number.isFinite(targetRatio) || targetRatio < 0 || targetRatio >= triggerRatio) {
    throw new CompactionConfigurationError("targetRatio must be in [0, triggerRatio)");
  }

  const hardInputLimitTokens = contextWindowTokens - outputReserveTokens;
  const triggerCandidate = Math.max(1, Math.floor(contextWindowTokens * triggerRatio));
  const triggerInputTokens = Math.min(hardInputLimitTokens, triggerCandidate);
  const targetCandidate = Math.max(0, Math.floor(contextWindowTokens * targetRatio));
  const targetInputTokens = Math.min(targetCandidate, Math.max(0, triggerInputTokens - 1));
  return Object.freeze({
    contextWindowTokens,
    outputReserveTokens,
    hardInputLimitTokens,
    triggerInputTokens,
    targetInputTokens,
    triggerRatio,
    targetRatio,
  });
}

export interface CompactionThresholdAssessment extends CompactionThresholds {
  readonly estimatedInputTokens: number;
  readonly shouldCompact: boolean;
  readonly hardLimitExceeded: boolean;
  readonly tokensToTarget: number;
  readonly tokensBeforeTrigger: number;
  readonly reason: "below-trigger" | "trigger-threshold" | "hard-input-limit";
}

/** Applies inclusive trigger math to one estimate. */
export function assessCompactionThreshold(
  estimatedInputTokens: number,
  thresholds: CompactionThresholds,
): CompactionThresholdAssessment {
  validateNonnegativeInteger(estimatedInputTokens, "estimatedInputTokens");
  const checked = computeCompactionThresholds(thresholds);
  if (
    checked.outputReserveTokens !== thresholds.outputReserveTokens
    || checked.triggerInputTokens !== thresholds.triggerInputTokens
    || checked.targetInputTokens !== thresholds.targetInputTokens
    || checked.hardInputLimitTokens !== thresholds.hardInputLimitTokens
  ) throw new CompactionConfigurationError("Threshold object is inconsistent with its configuration");

  const hardLimitExceeded = estimatedInputTokens > checked.hardInputLimitTokens;
  const shouldCompact = estimatedInputTokens >= checked.triggerInputTokens;
  const reason = hardLimitExceeded
    ? "hard-input-limit"
    : shouldCompact ? "trigger-threshold" : "below-trigger";
  return Object.freeze({
    ...checked,
    estimatedInputTokens,
    shouldCompact,
    hardLimitExceeded,
    tokensToTarget: Math.max(0, estimatedInputTokens - checked.targetInputTokens),
    tokensBeforeTrigger: Math.max(0, checked.triggerInputTokens - estimatedInputTokens),
    reason,
  });
}

/** Canonical JSON with lexicographically sorted object keys and no whitespace. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>(), "$ ".trim());
}

function canonicalize(value: unknown, stack: Set<object>, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`Non-JSON value at ${path}`);
  if (stack.has(value)) throw new TypeError(`Cyclic JSON value at ${path}`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError(`Sparse JSON array at ${path}`);
        items.push(canonicalize(value[index], stack, `${path}[${index}]`));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Non-plain JSON object at ${path}`);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], stack, `${path}.${key}`)}`).join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function validateSourceShape(source: CompactionSourceInput): void {
  validateIdentity(source.id, "source id", 256);
  validateIdentity(source.sessionId, "source sessionId");
  validateIdentity(source.branchId, "source branchId");
  validateCursor(source.cursor, `source ${source.id} cursor`);
  validateIdentity(source.type, `source ${source.id} type`, 128);
  if (!Number.isInteger(source.schemaVersion) || source.schemaVersion <= 0) {
    throw new TypeError(`Source ${source.id} schemaVersion must be a positive integer`);
  }
  canonicalJson(source.payload);
}

function validateManifest(manifest: ExactCompactionSourceManifest): void {
  if (manifest.format !== COMPACTION_SOURCE_FORMAT || !/^[a-f0-9]{64}$/.test(manifest.sourceDigest)) {
    throw new CompactionRematerializationError("invalid-manifest", "Invalid exact-source manifest format or digest");
  }
  validateIdentity(manifest.sessionId, "manifest sessionId");
  validateIdentity(manifest.branchId, "manifest branchId");
  validateCursor(manifest.throughCursor, "manifest throughCursor");
  const seen = new Set<string>();
  for (const eventId of manifest.sourceEventIds) {
    validateIdentity(eventId, "manifest eventId", 256);
    if (seen.has(eventId)) {
      throw new CompactionRematerializationError("duplicate-source", `Manifest source ${eventId} appears more than once`);
    }
    seen.add(eventId);
  }
}

function canonicalOrderedSources(
  sources: readonly FrozenCompactionSourceRecord[],
): readonly FrozenCompactionSourceRecord[] {
  const seen = new Set<string>();
  const ordered = [...sources];
  for (const source of ordered) {
    if (seen.has(source.eventId)) throw new TypeError(`Duplicate compaction source event ID: ${source.eventId}`);
    seen.add(source.eventId);
    validateCursor(source.cursor, `source ${source.eventId} cursor`);
    canonicalJson(source.payload);
  }
  ordered.sort(compareSources);
  return ordered;
}

function sourceEnvelope(source: FrozenCompactionSourceRecord): CanonicalJsonValue {
  return {
    eventId: source.eventId,
    sessionId: source.sessionId,
    branchId: source.branchId,
    cursor: source.cursor,
    type: source.type,
    schemaVersion: source.schemaVersion,
    payload: source.payload,
  };
}

function isNarrativeMessagePayload(payload: unknown): payload is { readonly role: string; readonly content: string } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.content === "string"
    && typeof candidate.role === "string"
    && MESSAGE_ROLES.has(candidate.role);
}

function protectionReason(type: string): string {
  if (type.startsWith("Goal")) return "goals and completion gates remain live across compaction";
  if (type.startsWith("Heartbeat")) return "heartbeat state remains live across compaction";
  if (type.startsWith("Schedule")) return "schedule state remains live across compaction";
  if (type.startsWith("Task") || type.startsWith("Subagent")) return "task and child-session state remains live across compaction";
  if (type.startsWith("Mailbox")) return "mailbox state remains live across compaction";
  if (type.startsWith("RecursiveModel")) return "recursive model handles remain live across compaction";
  if (type.startsWith("WorkingValue")) return "durable working values remain exact across compaction";
  if (type.startsWith("Artifact")) return "artifact identity and provenance remain exact across compaction";
  if (type.startsWith("AgentRun")) return "active run control state remains exact across compaction";
  return "non-narrative and unknown event types are protected by default";
}

function compareSources(left: FrozenCompactionSourceRecord, right: FrozenCompactionSourceRecord): number {
  const cursor = compareCursors(left.cursor, right.cursor);
  return cursor || compareCanonicalText(left.eventId, right.eventId);
}

function compareLeaves(left: CompactionLeafReference, right: CompactionLeafReference): number {
  const cursor = compareCursors(left.cursor, right.cursor);
  return cursor || compareCanonicalText(left.eventId, right.eventId);
}

/** Locale-independent UTF-16 code-unit ordering, matching default key sort. */
function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCursors(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function addLeaf(target: Map<string, CompactionLeafReference>, leaf: CompactionLeafReference): void {
  validateLeaf(leaf);
  const prior = target.get(leaf.eventId);
  if (prior && canonicalJson(prior) !== canonicalJson(leaf)) {
    throw new CompactionRematerializationError(
      "source-digest-mismatch",
      `Rolling provenance disagrees about leaf ${leaf.eventId}`,
    );
  }
  if (!prior) target.set(leaf.eventId, Object.freeze({ ...leaf }));
}

function validateLeaf(leaf: CompactionLeafReference): void {
  validateIdentity(leaf.eventId, "leaf eventId", 256);
  validateIdentity(leaf.sessionId, "leaf sessionId");
  validateIdentity(leaf.branchId, "leaf branchId");
  validateIdentity(leaf.type, "leaf type", 128);
  validateCursor(leaf.cursor, `leaf ${leaf.eventId} cursor`);
  if (!Number.isInteger(leaf.schemaVersion) || leaf.schemaVersion <= 0 || !/^[a-f0-9]{64}$/.test(leaf.sourceDigest)) {
    throw new CompactionRematerializationError("invalid-manifest", `Invalid rolling leaf ${leaf.eventId}`);
  }
}

function validateRollingProvenance(provenance: RollingCompactionProvenance): void {
  if (provenance.format !== COMPACTION_LEAF_FORMAT || !Number.isInteger(provenance.generation) || provenance.generation <= 0) {
    throw new CompactionRematerializationError("invalid-manifest", "Invalid rolling provenance header");
  }
  const leaves = [...provenance.leaves];
  for (const leaf of leaves) validateLeaf(leaf);
  leaves.sort(compareLeaves);
  if (!sameStrings(leaves.map((leaf) => leaf.eventId), provenance.leafEventIds)) {
    throw new CompactionRematerializationError("source-order-mismatch", "Rolling leaf event IDs are not canonical");
  }
  if (digestLeaves(leaves) !== provenance.leafDigest) {
    throw new CompactionRematerializationError("source-digest-mismatch", "Rolling provenance leaf digest is invalid");
  }
}

function digestLeaves(leaves: readonly CompactionLeafReference[]): string {
  return sha256(canonicalJson({ format: COMPACTION_LEAF_FORMAT, leaves }));
}

function renderExtractiveBlock(
  source: FrozenCompactionSourceRecord,
  maxBytes: number,
): Readonly<{ text: string; utf8Bytes: number; truncated: boolean }> | null {
  if (!isNarrativeMessagePayload(source.payload) || maxBytes <= 0) return null;
  const header = `[event id=${JSON.stringify(source.eventId)} type=${JSON.stringify(source.type)} cursor=${JSON.stringify(source.cursor)} role=${JSON.stringify(source.payload.role)}]`;
  // JSON string encoding makes embedded newlines and marker-like source text
  // unambiguous without changing the retained narrative value.
  const full = `${header}
content_json=${JSON.stringify(source.payload.content)}`;
  const fullBytes = utf8Bytes(full);
  if (fullBytes <= maxBytes) return Object.freeze({ text: full, utf8Bytes: fullBytes, truncated: false });

  const contentBytes = utf8Bytes(source.payload.content);
  const codePoints = [...source.payload.content];
  const candidate = (count: number): Readonly<{ text: string; utf8Bytes: number }> => {
    const retained = codePoints.slice(0, count).join("");
    const retainedBytes = utf8Bytes(retained);
    const marker = `[TRUNCATED event_id=${JSON.stringify(source.eventId)} original_utf8_bytes=${contentBytes} retained_utf8_bytes=${retainedBytes}]`;
    const text = `${header}
content_json=${JSON.stringify(retained)}
${marker}`;
    return Object.freeze({ text, utf8Bytes: utf8Bytes(text) });
  };
  if (candidate(0).utf8Bytes > maxBytes) return null;
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (candidate(middle).utf8Bytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const rendered = candidate(low);
  return Object.freeze({ ...rendered, truncated: true });
}

function summaryTruncationMarker(omittedEvents: number): string {
  return `[TRUNCATED summary omitted_events=${omittedEvents}]`;
}

function validateIdentity(value: string, name: string, maxLength = 512): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError(`${name} must be non-empty bounded text without control characters`);
  }
}

function validateCursor(value: string, name: string): void {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical nonnegative decimal cursor`);
  }
}

function validateIntegerBound(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CompactionConfigurationError(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
}

function validateNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CompactionConfigurationError(`${name} must be a nonnegative safe integer`);
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CompactionConfigurationError(`${name} must be a positive safe integer`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function deepFreeze<T extends CanonicalJsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item as CanonicalJsonValue);
    Object.freeze(value);
  }
  return value;
}
