/**
 * Pure FU-016 automatic refinement-trigger detection.
 *
 * This module has no storage, clock, model, or harness side effects. Callers
 * provide a bounded projection of canonical event-like records plus durable
 * consumption/nonterminal state. The detector never treats free-form prose as
 * a correction.
 */

const UTF8 = new TextEncoder();

export const REFINEMENT_TRIGGER_POLICY_VERSION = 1 as const;
export const MAX_REFINEMENT_TRIGGER_RECORDS = 10_000;
export const MAX_REFINEMENT_TRIGGER_RECORD_BYTES = 1024 * 1024;
export const MAX_REFINEMENT_TRIGGER_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_REFINEMENT_TRIGGER_ERROR_BYTES = 16 * 1024;
export const MAX_REFINEMENT_TRIGGER_CONSUMPTIONS = 2_048;
export const MAX_REFINEMENT_TRIGGER_NONTERMINAL_KEYS = 2_048;
export const MAX_REFINEMENT_TRIGGER_SECRET_VALUES = 64;
export const MAX_REFINEMENT_TRIGGER_SECRET_BYTES = 64 * 1024;
export const MAX_REFINEMENT_CORRECTED_EVENT_IDS = 64;
export const MAX_REFINEMENT_TRIGGER_EVIDENCE_EVENTS = 64;

const MAX_ID_BYTES = 256;
const MAX_TYPE_BYTES = 128;
const MAX_POLICY_WINDOW_RECORDS = 2_048;
const MAX_POLICY_THRESHOLD = 64;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const TRIGGER_KEY_PATTERN = /^refinement-trigger-key-v1-[a-f0-9]{32}$/;
const NONTERMINAL_KEY_PATTERN = /^refinement-trigger-nonterminal-v1-[a-f0-9]{32}$/;

export type RefinementAutomaticTriggerKind =
  | "repeated_effect_failure"
  | "repeated_gate_failure"
  | "explicit_user_correction";

export interface RefinementTriggerThresholdPolicyV1 {
  readonly enabled: boolean;
  readonly threshold: number;
  /** Only this many most-recent local records may supply evidence. */
  readonly windowRecords: number;
  /** After consumption, this many qualifying records must be newer than its cursor. */
  readonly refireAfterNewEvidence: number;
}

export interface RefinementTriggerPolicyV1 {
  readonly version: typeof REFINEMENT_TRIGGER_POLICY_VERSION;
  /** Automatic invocation is deliberately opt-in. */
  readonly automatic: boolean;
  /** Version 1 cannot automatically widen authority beyond the owning session. */
  readonly scope: "local";
  readonly effectFailure: RefinementTriggerThresholdPolicyV1;
  readonly completionGateFailure: RefinementTriggerThresholdPolicyV1;
  readonly explicitUserCorrection: RefinementTriggerThresholdPolicyV1;
}

export const DEFAULT_REFINEMENT_TRIGGER_POLICY_V1: RefinementTriggerPolicyV1 = deepFreeze({
  version: REFINEMENT_TRIGGER_POLICY_VERSION,
  automatic: false,
  scope: "local",
  effectFailure: {
    enabled: true,
    threshold: 3,
    windowRecords: 128,
    refireAfterNewEvidence: 3,
  },
  completionGateFailure: {
    enabled: true,
    threshold: 2,
    windowRecords: 128,
    refireAfterNewEvidence: 2,
  },
  explicitUserCorrection: {
    enabled: true,
    threshold: 1,
    windowRecords: 128,
    refireAfterNewEvidence: 1,
  },
});

/** Minimal canonical record projection required by the pure detector. */
export interface RefinementTriggerRecordInput {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly cursor: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface RefinementTriggerConsumptionInput {
  readonly triggerKey: string;
  readonly lastConsumedEvidenceCursor: string;
}

export interface ScanRefinementTriggersInput {
  readonly sessionId: string;
  readonly branchId: string;
  readonly records: readonly RefinementTriggerRecordInput[];
  readonly policy?: RefinementTriggerPolicyV1;
  readonly consumptions?: readonly RefinementTriggerConsumptionInput[];
  /** Keys for reviews/proposals that have started but are not terminal yet. */
  readonly nonterminalKeys?: readonly string[];
  /** Exact supervisor-brokered values. Values shorter than four UTF-8 bytes are ignored. */
  readonly brokeredCredentialValues?: readonly string[];
}

interface RefinementDetectedTriggerBase {
  readonly policyVersion: typeof REFINEMENT_TRIGGER_POLICY_VERSION;
  readonly kind: RefinementAutomaticTriggerKind;
  readonly scope: "local";
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly branchId: string;
  /** Stable for the recurring failure/correction identity, independent of evidence instances. */
  readonly key: string;
  /** Stable idempotency/ownership key for one nonterminal review of this trigger key. */
  readonly nonterminalKey: string;
  /** Stable for this exact evidence tranche and prior consumption cursor. */
  readonly fingerprint: string;
  readonly summary: string;
  readonly evidenceEventIds: readonly string[];
  readonly newEvidenceEventIds: readonly string[];
  readonly evidenceThroughCursor: string;
  readonly lastConsumedEvidenceCursor: string | null;
}

export interface RefinementRepeatedEffectFailureTrigger extends RefinementDetectedTriggerBase {
  readonly kind: "repeated_effect_failure";
  readonly executor: string;
  readonly operation: string;
  /** Hash of the normalized error after exact supplied-value scrubbing. */
  readonly errorSignature: string;
}

export interface RefinementRepeatedGateFailureTrigger extends RefinementDetectedTriggerBase {
  readonly kind: "repeated_gate_failure";
  readonly goalId: string;
  readonly gateId: string;
  readonly definitionHash: string;
  /** One hash per distinct material evidence/workspace pin. */
  readonly evidencePins: readonly string[];
}

export interface RefinementExplicitUserCorrectionTrigger extends RefinementDetectedTriggerBase {
  readonly kind: "explicit_user_correction";
  /** Exact existing, earlier local event IDs named by the typed UserCorrection payload. */
  readonly correctedEventIds: readonly string[];
}

export type RefinementDetectedTrigger =
  | RefinementRepeatedEffectFailureTrigger
  | RefinementRepeatedGateFailureTrigger
  | RefinementExplicitUserCorrectionTrigger;

export type RefinementTriggerInputErrorCode =
  | "invalid-input"
  | "input-too-large"
  | "unsupported-policy";

export class RefinementTriggerInputError extends Error {
  constructor(readonly code: RefinementTriggerInputErrorCode, message: string) {
    super(message);
    this.name = "RefinementTriggerInputError";
  }
}

interface NormalizedRecord extends RefinementTriggerRecordInput {
  readonly position: number;
}
interface EffectRequest {
  readonly effectId: string;
  readonly executor: string;
  readonly operation: string;
  readonly cursor: string;
}
interface EffectFailureEvidence {
  readonly event: NormalizedRecord;
  readonly executor: string;
  readonly operation: string;
  readonly errorSignature: string;
}
interface GateFailureEvidence {
  readonly event: NormalizedRecord;
  readonly goalId: string;
  readonly gateId: string;
  readonly definitionHash: string;
  readonly evidencePin: string;
}
interface CorrectionEvidence {
  readonly event: NormalizedRecord;
  readonly correctedEventIds: readonly string[];
}

/**
 * Scans canonical event-like records in cursor order. The return is immutable,
 * canonically ordered, and independent of caller array/object ordering.
 */
export function scanRefinementTriggers(input: ScanRefinementTriggersInput): readonly RefinementDetectedTrigger[] {
  validateTopLevelCollections(input);
  const policy = validatePolicy(input.policy ?? DEFAULT_REFINEMENT_TRIGGER_POLICY_V1);
  const secrets = normalizeSecrets(input.brokeredCredentialValues ?? []);
  const records = normalizeRecords(input.records, input.sessionId, input.branchId);
  const consumptions = normalizeConsumptions(input.consumptions ?? []);
  const nonterminalKeys = normalizeNonterminalKeys(input.nonterminalKeys ?? []);

  if (!policy.automatic) return deepFreeze([] as RefinementDetectedTrigger[]);

  const localRecords = records.filter((record) => record.sessionId === input.sessionId && record.branchId === input.branchId);
  const allLocalById = new Map(localRecords.map((record) => [record.id, record] as const));
  const triggers: RefinementDetectedTrigger[] = [];

  if (policy.effectFailure.enabled) {
    const window = trailingWindow(localRecords, policy.effectFailure.windowRecords);
    const requests = collectEffectRequests(localRecords);
    const groups = new Map<string, EffectFailureEvidence[]>();
    for (const record of window) {
      if (record.type !== "EffectOutcomeRecorded") continue;
      const payload = asRecord(record.payload);
      // Cancelled and unknown are intentionally not failures, regardless of error text.
      if (!payload || payload.outcome !== "failed") continue;
      const effectId = boundedPayloadId(payload.effectId);
      const error = boundedError(payload.error);
      const request = effectId === null ? undefined : requests.get(effectId);
      if (!request || error === null || compareCursor(request.cursor, record.cursor) >= 0) continue;
      const errorSignature = normalizedRefinementErrorSignature(error, secrets);
      const identity = { executor: request.executor, operation: request.operation, errorSignature };
      const identityJson = canonicalJson(identity);
      const item: EffectFailureEvidence = { event: record, ...identity };
      const group = groups.get(identityJson);
      if (group) group.push(item); else groups.set(identityJson, [item]);
    }
    for (const unboundedEvidence of groups.values()) {
      if (unboundedEvidence.length < policy.effectFailure.threshold) continue;
      const evidence = unboundedEvidence.slice(-MAX_REFINEMENT_TRIGGER_EVIDENCE_EVENTS);
      const first = evidence[0]!;
      const identity = { executor: first.executor, operation: first.operation, errorSignature: first.errorSignature };
      const key = triggerKey("repeated_effect_failure", identity);
      const admitted = admitEvidence(key, evidence.map((item) => item.event), policy.effectFailure, consumptions, nonterminalKeys, input.sessionId, input.branchId);
      if (!admitted) continue;
      const summary = `Repeated ${first.executor}/${first.operation} effect failure (${first.errorSignature})`;
      triggers.push(deepFreeze({
        ...admitted,
        policyVersion: REFINEMENT_TRIGGER_POLICY_VERSION,
        kind: "repeated_effect_failure",
        scope: "local",
        scopeKey: input.sessionId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        summary,
        executor: first.executor,
        operation: first.operation,
        errorSignature: first.errorSignature,
      }));
    }
  }

  if (policy.completionGateFailure.enabled) {
    const window = trailingWindow(localRecords, policy.completionGateFailure.windowRecords);
    const windowIds = new Set(window.map((record) => record.id));
    const groups = new Map<string, GateFailureEvidence[]>();
    // Inspect the supplied history so a cached/repeated evaluation of a pin that
    // was already seen before the current window cannot masquerade as new pin evidence.
    for (const record of localRecords) {
      if (record.type !== "GoalGateEvaluationRecorded") continue;
      const parsed = parseFailedGateEvaluation(record);
      if (!parsed) continue;
      const identityJson = canonicalJson({ goalId: parsed.goalId, gateId: parsed.gateId, definitionHash: parsed.definitionHash });
      const group = groups.get(identityJson);
      if (group) group.push(parsed); else groups.set(identityJson, [parsed]);
    }
    for (const evidenceWithDuplicatePins of groups.values()) {
      // Re-evaluation/cached records against one identical material pin are one piece of evidence.
      const firstByPin = new Map<string, GateFailureEvidence>();
      for (const item of evidenceWithDuplicatePins) if (!firstByPin.has(item.evidencePin)) firstByPin.set(item.evidencePin, item);
      const unboundedEvidence = [...firstByPin.values()]
        .filter((item) => windowIds.has(item.event.id))
        .sort((left, right) => compareRecords(left.event, right.event));
      if (unboundedEvidence.length < policy.completionGateFailure.threshold) continue;
      const evidence = unboundedEvidence.slice(-MAX_REFINEMENT_TRIGGER_EVIDENCE_EVENTS);
      const first = evidence[0]!;
      const identity = { goalId: first.goalId, gateId: first.gateId, definitionHash: first.definitionHash };
      const key = triggerKey("repeated_gate_failure", identity);
      const admitted = admitEvidence(key, evidence.map((item) => item.event), policy.completionGateFailure, consumptions, nonterminalKeys, input.sessionId, input.branchId);
      if (!admitted) continue;
      triggers.push(deepFreeze({
        ...admitted,
        policyVersion: REFINEMENT_TRIGGER_POLICY_VERSION,
        kind: "repeated_gate_failure",
        scope: "local",
        scopeKey: input.sessionId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        summary: `Completion gate ${first.goalId}/${first.gateId} failed against distinct workspace evidence pins`,
        goalId: first.goalId,
        gateId: first.gateId,
        definitionHash: first.definitionHash,
        evidencePins: evidence.map((item) => item.evidencePin),
      }));
    }
  }

  if (policy.explicitUserCorrection.enabled) {
    const window = trailingWindow(localRecords, policy.explicitUserCorrection.windowRecords);
    const groups = new Map<string, CorrectionEvidence[]>();
    for (const record of window) {
      // No MessageAppended content, role, keyword, or other prose is inspected here.
      if (record.type !== "UserCorrection") continue;
      const parsed = parseUserCorrection(record, allLocalById);
      if (!parsed) continue;
      const identityJson = canonicalJson({ correctedEventIds: parsed.correctedEventIds });
      const group = groups.get(identityJson);
      if (group) group.push(parsed); else groups.set(identityJson, [parsed]);
    }
    for (const unboundedEvidence of groups.values()) {
      if (unboundedEvidence.length < policy.explicitUserCorrection.threshold) continue;
      const evidence = unboundedEvidence.slice(-MAX_REFINEMENT_TRIGGER_EVIDENCE_EVENTS);
      const first = evidence[0]!;
      const identity = { correctedEventIds: first.correctedEventIds };
      const key = triggerKey("explicit_user_correction", identity);
      const admitted = admitEvidence(key, evidence.map((item) => item.event), policy.explicitUserCorrection, consumptions, nonterminalKeys, input.sessionId, input.branchId);
      if (!admitted) continue;
      triggers.push(deepFreeze({
        ...admitted,
        policyVersion: REFINEMENT_TRIGGER_POLICY_VERSION,
        kind: "explicit_user_correction",
        scope: "local",
        scopeKey: input.sessionId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        summary: `Explicit typed user correction of ${first.correctedEventIds.length} retained event(s)`,
        correctedEventIds: first.correctedEventIds,
      }));
    }
  }

  triggers.sort(compareTriggers);
  assertNoSecretOutput(triggers, secrets);
  return deepFreeze(triggers);
}

/**
 * Derives the sole nonterminal idempotency key format used by v1 integration.
 * A caller persists this while a review/proposal is nonterminal and supplies it
 * back to `scanRefinementTriggers` to suppress duplicate concurrent work.
 */
export function refinementTriggerNonterminalKey(
  sessionId: string,
  branchId: string,
  triggerKeyValue: string,
): string {
  assertBoundedId(sessionId, "sessionId");
  assertBoundedId(branchId, "branchId");
  if (!TRIGGER_KEY_PATTERN.test(triggerKeyValue)) {
    throw new RefinementTriggerInputError("invalid-input", "triggerKey is not a version-1 refinement trigger key");
  }
  return `refinement-trigger-nonterminal-v1-${sha256Hex(canonicalJson({ sessionId, branchId, triggerKey: triggerKeyValue })).slice(0, 32)}`;
}

/** Produces the durable dedupe cursor to persist after a trigger is consumed. */
export function refinementTriggerConsumption(trigger: RefinementDetectedTrigger): RefinementTriggerConsumptionInput {
  return deepFreeze({ triggerKey: trigger.key, lastConsumedEvidenceCursor: trigger.evidenceThroughCursor });
}

/** Public for conformance tests and integrations that need to classify errors without retaining text. */
export function refinementErrorSignature(error: string, brokeredCredentialValues: readonly string[] = []): string {
  if (typeof error !== "string" || utf8Bytes(error) === 0 || utf8Bytes(error) > MAX_REFINEMENT_TRIGGER_ERROR_BYTES) {
    throw new RefinementTriggerInputError("invalid-input", `error must contain 1-${MAX_REFINEMENT_TRIGGER_ERROR_BYTES} UTF-8 bytes`);
  }
  const secrets = normalizeSecrets(brokeredCredentialValues);
  return normalizedRefinementErrorSignature(error, secrets);
}

function admitEvidence(
  key: string,
  evidence: readonly NormalizedRecord[],
  thresholdPolicy: RefinementTriggerThresholdPolicyV1,
  consumptions: ReadonlyMap<string, string>,
  nonterminalKeys: ReadonlySet<string>,
  sessionId: string,
  branchId: string,
): Pick<RefinementDetectedTriggerBase,
  "key" | "nonterminalKey" | "fingerprint" | "evidenceEventIds" | "newEvidenceEventIds" |
  "evidenceThroughCursor" | "lastConsumedEvidenceCursor"> | null {
  const nonterminalKey = refinementTriggerNonterminalKey(sessionId, branchId, key);
  if (nonterminalKeys.has(nonterminalKey)) return null;
  const lastConsumedEvidenceCursor = consumptions.get(key) ?? null;
  const newEvidence = lastConsumedEvidenceCursor === null
    ? evidence
    : evidence.filter((record) => compareCursor(record.cursor, lastConsumedEvidenceCursor) > 0);
  const requiredNewEvidence = lastConsumedEvidenceCursor === null
    ? thresholdPolicy.threshold
    : thresholdPolicy.refireAfterNewEvidence;
  if (newEvidence.length < requiredNewEvidence) return null;
  const evidenceThroughCursor = evidence.at(-1)!.cursor;
  const evidenceEventIds = evidence.map((record) => record.id);
  const newEvidenceEventIds = newEvidence.map((record) => record.id);
  const fingerprint = sha256(canonicalJson({
    policyVersion: REFINEMENT_TRIGGER_POLICY_VERSION,
    key,
    evidenceEventIds,
    newEvidenceEventIds,
    evidenceThroughCursor,
    lastConsumedEvidenceCursor,
  }));
  return {
    key,
    nonterminalKey,
    fingerprint,
    evidenceEventIds,
    newEvidenceEventIds,
    evidenceThroughCursor,
    lastConsumedEvidenceCursor,
  };
}

function parseFailedGateEvaluation(record: NormalizedRecord): GateFailureEvidence | null {
  const payload = asRecord(record.payload);
  if (!payload || payload.status !== "failed") return null;
  const goalId = boundedPayloadId(payload.goalId);
  const gateId = boundedPayloadId(payload.gateId);
  const definitionHash = boundedPayloadId(payload.definitionHash);
  const materialVersion = boundedPayloadId(payload.materialVersion);
  const materialEventIds = boundedUniqueIdList(payload.materialEventIds, MAX_REFINEMENT_CORRECTED_EVENT_IDS, true);
  if (goalId === null || gateId === null || definitionHash === null || materialVersion === null || materialEventIds === null) return null;
  const evidencePin = sha256(canonicalJson({ materialVersion, materialEventIds }));
  return { event: record, goalId, gateId, definitionHash, evidencePin };
}

function parseUserCorrection(
  record: NormalizedRecord,
  localById: ReadonlyMap<string, NormalizedRecord>,
): CorrectionEvidence | null {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const correctedEventIds = boundedUniqueIdList(payload.correctedEventIds, MAX_REFINEMENT_CORRECTED_EVENT_IDS, false);
  if (!correctedEventIds || correctedEventIds.length === 0) return null;
  for (const correctedId of correctedEventIds) {
    const corrected = localById.get(correctedId);
    if (!corrected || compareRecords(corrected, record) >= 0) return null;
  }
  return { event: record, correctedEventIds };
}

function collectEffectRequests(records: readonly NormalizedRecord[]): ReadonlyMap<string, EffectRequest> {
  const requests = new Map<string, EffectRequest | null>();
  for (const record of records) {
    if (record.type !== "EffectRequested") continue;
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const effectId = boundedPayloadId(payload.effectId);
    const executor = boundedPayloadId(payload.executor);
    const operation = boundedPayloadId(payload.operation);
    if (effectId === null || executor === null || operation === null) continue;
    // Ambiguous effect identity cannot safely be joined to an outcome.
    if (requests.has(effectId)) requests.set(effectId, null);
    else requests.set(effectId, { effectId, executor, operation, cursor: record.cursor });
  }
  const unambiguous = new Map<string, EffectRequest>();
  for (const [effectId, request] of requests) if (request) unambiguous.set(effectId, request);
  return unambiguous;
}

function normalizeRecords(
  inputs: readonly RefinementTriggerRecordInput[],
  sessionId: string,
  branchId: string,
): readonly NormalizedRecord[] {
  assertBoundedId(sessionId, "sessionId");
  assertBoundedId(branchId, "branchId");
  const seenIds = new Set<string>();
  let totalBytes = 0;
  const copied: RefinementTriggerRecordInput[] = [];
  for (const [index, input] of inputs.entries()) {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`records[${index}] must be an object`);
    assertBoundedId(input.id, `records[${index}].id`);
    assertBoundedId(input.sessionId, `records[${index}].sessionId`);
    assertBoundedId(input.branchId, `records[${index}].branchId`);
    assertCursor(input.cursor, `records[${index}].cursor`);
    assertBoundedText(input.type, MAX_TYPE_BYTES, `records[${index}].type`);
    if (seenIds.has(input.id)) invalid(`Duplicate canonical event id ${input.id}`);
    seenIds.add(input.id);
    const recordBytes = canonicalJsonBytes(input, `records[${index}]`);
    if (recordBytes > MAX_REFINEMENT_TRIGGER_RECORD_BYTES) {
      tooLarge(`records[${index}] exceeds ${MAX_REFINEMENT_TRIGGER_RECORD_BYTES} canonical UTF-8 bytes`);
    }
    totalBytes += recordBytes;
    if (totalBytes > MAX_REFINEMENT_TRIGGER_INPUT_BYTES) {
      tooLarge(`records exceed ${MAX_REFINEMENT_TRIGGER_INPUT_BYTES} canonical UTF-8 bytes`);
    }
    copied.push({
      id: input.id,
      sessionId: input.sessionId,
      branchId: input.branchId,
      cursor: input.cursor,
      type: input.type,
      payload: input.payload,
    });
  }
  copied.sort(compareRecords);
  return copied.map((record, position) => ({ ...record, position }));
}

function normalizeConsumptions(inputs: readonly RefinementTriggerConsumptionInput[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const [index, input] of inputs.entries()) {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`consumptions[${index}] must be an object`);
    if (!TRIGGER_KEY_PATTERN.test(input.triggerKey)) invalid(`consumptions[${index}].triggerKey is invalid`);
    assertCursor(input.lastConsumedEvidenceCursor, `consumptions[${index}].lastConsumedEvidenceCursor`);
    const prior = values.get(input.triggerKey);
    if (prior === undefined || compareCursor(prior, input.lastConsumedEvidenceCursor) < 0) {
      values.set(input.triggerKey, input.lastConsumedEvidenceCursor);
    }
  }
  return values;
}

function normalizeNonterminalKeys(inputs: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [index, key] of inputs.entries()) {
    if (typeof key !== "string" || !NONTERMINAL_KEY_PATTERN.test(key)) invalid(`nonterminalKeys[${index}] is invalid`);
    keys.add(key);
  }
  return keys;
}

function normalizeSecrets(inputs: readonly string[]): readonly string[] {
  let total = 0;
  const unique = new Set<string>();
  for (const [index, value] of inputs.entries()) {
    if (typeof value !== "string") invalid(`brokeredCredentialValues[${index}] must be a string`);
    const bytes = utf8Bytes(value);
    total += bytes;
    if (total > MAX_REFINEMENT_TRIGGER_SECRET_BYTES) tooLarge(`brokered credential values exceed ${MAX_REFINEMENT_TRIGGER_SECRET_BYTES} UTF-8 bytes`);
    if (bytes >= 4) unique.add(value);
  }
  return [...unique].sort((left, right) => utf8Bytes(right) - utf8Bytes(left) || compareText(left, right));
}

function normalizedRefinementErrorSignature(error: string, secrets: readonly string[]): string {
  let scrubbed = error;
  for (const secret of secrets) scrubbed = scrubbed.split(secret).join("[REDACTED]");
  // Intentionally conservative: normalize representation, not semantic error codes.
  const normalized = scrubbed
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return sha256(normalized);
}

function assertNoSecretOutput(triggers: readonly RefinementDetectedTrigger[], secrets: readonly string[]): void {
  if (secrets.length === 0) return;
  const serialized = canonicalJson(triggers);
  if (secrets.some((secret) => serialized.includes(secret))) {
    invalid("A supplied brokered credential value appears in attributable trigger metadata");
  }
}

function boundedError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bytes = utf8Bytes(value);
  if (bytes === 0) return null;
  if (bytes > MAX_REFINEMENT_TRIGGER_ERROR_BYTES) {
    tooLarge(`Effect failure error exceeds ${MAX_REFINEMENT_TRIGGER_ERROR_BYTES} UTF-8 bytes`);
  }
  return value;
}

function boundedPayloadId(value: unknown): string | null {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return null;
  const bytes = utf8Bytes(value);
  return bytes > 0 && bytes <= MAX_ID_BYTES ? value : null;
}

function boundedUniqueIdList(value: unknown, maximum: number, sort: boolean): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = boundedPayloadId(item);
    if (id === null || seen.has(id)) return null;
    seen.add(id);
    result.push(id);
  }
  if (sort) result.sort(compareText);
  return result;
}

function validateTopLevelCollections(input: ScanRefinementTriggersInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Refinement trigger scan input must be an object");
  if (!Array.isArray(input.records)) invalid("records must be an array");
  if (input.records.length > MAX_REFINEMENT_TRIGGER_RECORDS) tooLarge(`records exceed ${MAX_REFINEMENT_TRIGGER_RECORDS}`);
  if (input.consumptions !== undefined && !Array.isArray(input.consumptions)) invalid("consumptions must be an array");
  if ((input.consumptions?.length ?? 0) > MAX_REFINEMENT_TRIGGER_CONSUMPTIONS) tooLarge(`consumptions exceed ${MAX_REFINEMENT_TRIGGER_CONSUMPTIONS}`);
  if (input.nonterminalKeys !== undefined && !Array.isArray(input.nonterminalKeys)) invalid("nonterminalKeys must be an array");
  if ((input.nonterminalKeys?.length ?? 0) > MAX_REFINEMENT_TRIGGER_NONTERMINAL_KEYS) tooLarge(`nonterminalKeys exceed ${MAX_REFINEMENT_TRIGGER_NONTERMINAL_KEYS}`);
  if (input.brokeredCredentialValues !== undefined && !Array.isArray(input.brokeredCredentialValues)) invalid("brokeredCredentialValues must be an array");
  if ((input.brokeredCredentialValues?.length ?? 0) > MAX_REFINEMENT_TRIGGER_SECRET_VALUES) tooLarge(`brokeredCredentialValues exceed ${MAX_REFINEMENT_TRIGGER_SECRET_VALUES}`);
}

function validatePolicy(policy: RefinementTriggerPolicyV1): RefinementTriggerPolicyV1 {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) unsupported("Refinement trigger policy must be an object");
  if (policy.version !== REFINEMENT_TRIGGER_POLICY_VERSION) unsupported(`Unsupported refinement trigger policy version ${String(policy.version)}`);
  if (typeof policy.automatic !== "boolean") unsupported("Refinement trigger policy automatic must be boolean");
  if (policy.scope !== "local") unsupported("Automatic refinement trigger policy scope must be local");
  validateThresholdPolicy(policy.effectFailure, "effectFailure");
  validateThresholdPolicy(policy.completionGateFailure, "completionGateFailure");
  validateThresholdPolicy(policy.explicitUserCorrection, "explicitUserCorrection");
  return policy;
}

function validateThresholdPolicy(value: RefinementTriggerThresholdPolicyV1, name: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) unsupported(`${name} policy must be an object`);
  if (typeof value.enabled !== "boolean") unsupported(`${name}.enabled must be boolean`);
  assertPolicyInteger(value.threshold, `${name}.threshold`, 1, MAX_POLICY_THRESHOLD);
  assertPolicyInteger(value.windowRecords, `${name}.windowRecords`, value.threshold, MAX_POLICY_WINDOW_RECORDS);
  assertPolicyInteger(value.refireAfterNewEvidence, `${name}.refireAfterNewEvidence`, 1, MAX_POLICY_THRESHOLD);
}

function assertPolicyInteger(value: unknown, name: string, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    unsupported(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

function trailingWindow<T>(values: readonly T[], maximum: number): readonly T[] {
  return values.slice(Math.max(0, values.length - maximum));
}

function triggerKey(kind: RefinementAutomaticTriggerKind, identity: unknown): string {
  return `refinement-trigger-key-v1-${sha256Hex(canonicalJson({ policyVersion: 1, kind, identity })).slice(0, 32)}`;
}

function compareTriggers(left: RefinementDetectedTrigger, right: RefinementDetectedTrigger): number {
  const cursor = compareCursor(left.evidenceThroughCursor, right.evidenceThroughCursor);
  if (cursor !== 0) return cursor;
  const kind = compareText(left.kind, right.kind);
  return kind !== 0 ? kind : compareText(left.key, right.key);
}

function compareRecords(left: Pick<RefinementTriggerRecordInput, "cursor" | "id">, right: Pick<RefinementTriggerRecordInput, "cursor" | "id">): number {
  const cursor = compareCursor(left.cursor, right.cursor);
  return cursor !== 0 ? cursor : compareText(left.id, right.id);
}

function compareCursor(left: string, right: string): number {
  const a = BigInt(left), b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCursor(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !CURSOR_PATTERN.test(value)) invalid(`${name} must be a canonical non-negative decimal cursor`);
}

function assertBoundedId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || utf8Bytes(value) > MAX_ID_BYTES) {
    invalid(`${name} must be a bounded identifier`);
  }
}

function assertBoundedText(value: unknown, maximum: number, name: string): asserts value is string {
  if (typeof value !== "string" || utf8Bytes(value) === 0 || utf8Bytes(value) > maximum) invalid(`${name} must contain 1-${maximum} UTF-8 bytes`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJsonBytes(value: unknown, path: string): number {
  let nodes = 0;
  const active = new Set<object>();
  function visit(item: unknown, depth: number): string {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) tooLarge(`${path} exceeds ${MAX_JSON_NODES} JSON nodes`);
    if (depth > MAX_JSON_DEPTH) tooLarge(`${path} exceeds JSON depth ${MAX_JSON_DEPTH}`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid(`${path} contains a non-finite number`);
      return JSON.stringify(item);
    }
    if (typeof item !== "object") invalid(`${path} contains a non-JSON value`);
    if (active.has(item)) invalid(`${path} contains a cycle`);
    active.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = `[${item.map((child) => visit(child, depth + 1)).join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) invalid(`${path} contains a non-plain object`);
      const object = item as Record<string, unknown>;
      result = `{${Object.keys(object).sort(compareText).map((key) => `${JSON.stringify(key)}:${visit(object[key], depth + 1)}`).join(",")}}`;
    }
    active.delete(item);
    return result;
  }
  return utf8Bytes(visit(value, 0));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function sha256(value: string): string { return `sha256:${sha256Hex(value)}`; }
function sha256Hex(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}
function utf8Bytes(value: string): number { return UTF8.encode(value).byteLength; }

function invalid(message: string): never { throw new RefinementTriggerInputError("invalid-input", message); }
function tooLarge(message: string): never { throw new RefinementTriggerInputError("input-too-large", message); }
function unsupported(message: string): never { throw new RefinementTriggerInputError("unsupported-policy", message); }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
