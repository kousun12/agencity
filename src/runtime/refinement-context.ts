/**
 * Pure, deterministic context planning for FU-016 trajectory reviews.
 *
 * This module deliberately performs no storage reads, model calls, event
 * appends, or harness mutation. The integration layer must supply the exact
 * branch events and already-known visibility metadata. The returned snapshot
 * is a bounded, deeply frozen value that can safely become recursive-model
 * input in a later tranche.
 */

import type { HarnessKind, HarnessScope, HarnessVersionStatus, MemoryKind } from "../domain/harness.ts";

const UTF8 = new TextEncoder();
const HARNESS_KINDS = new Set<HarnessKind>(["memory", "prompt_note", "skill", "subagent_spec"]);
const HARNESS_SCOPES = new Set<HarnessScope>(["local", "workspace", "user", "global"]);
const VERSION_STATUSES = new Set<HarnessVersionStatus>(["candidate", "active", "retired", "rejected", "rolled_back"]);
const MEMORY_KINDS = new Set<MemoryKind>(["claim", "preference", "decision", "observation", "constraint"]);

/** Strictly below models.ts' 256 KiB recursive-input hard limit. */
export const MAX_REFINEMENT_TRAJECTORY_SNAPSHOT_BYTES = 192 * 1024;
export const DEFAULT_REFINEMENT_EVENT_WINDOW_RADIUS = 3;
export const REFINEMENT_TRAJECTORY_SNAPSHOT_FORMAT = "agencity.refinement-trajectory-snapshot-v1" as const;

const MIN_SNAPSHOT_BYTES = 16 * 1024;
const MAX_EVENTS_INPUT = 10_000;
const MAX_VISIBLE_VERSIONS_INPUT = 512;
const MAX_MEMORY_INPUT = 512;
const MAX_EVALUATIONS_INPUT = 512;
const MAX_EVIDENCE_EVENTS = 64;
const MAX_SELECTED_EVENTS = 192;
const MAX_VISIBLE_ITEMS_PER_SECTION = 128;
const MAX_ID_BYTES = 256;
const MAX_ITEM_BYTES = 20 * 1024;
const MIN_TRUNCATED_PREVIEW_BYTES = 256;

export type RefinementCanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RefinementCanonicalJsonValue[]
  | { readonly [key: string]: RefinementCanonicalJsonValue };

export interface RefinementTrajectoryEventInput {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly cursor: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface RefinementCandidateExposureInput {
  readonly sessionId: string;
  readonly branchId: string;
}

/** A current or historical version with enough metadata to enforce visibility. */
export interface RefinementVisibleHarnessVersionInput {
  readonly entryId: string;
  readonly versionId: string;
  /** The entry's current version pointer at snapshot time. */
  readonly currentVersionId: string;
  readonly kind: HarnessKind;
  readonly scope: HarnessScope;
  readonly scopeKey: string;
  readonly name: string;
  readonly status: HarnessVersionStatus;
  readonly content: unknown;
  /** Candidate versions are visible only for an exact exposed allocation. */
  readonly exposedTo?: readonly RefinementCandidateExposureInput[];
}

/** Retrieved memory is separate so retrieval reason/rank remain attributable. */
export interface RefinementMemoryInput {
  readonly entryId: string;
  readonly versionId: string;
  readonly currentVersionId: string;
  readonly scope: HarnessScope;
  readonly scopeKey: string;
  readonly name: string;
  readonly status: HarnessVersionStatus;
  readonly memoryKind: MemoryKind;
  readonly text: string;
  readonly reason: string;
  readonly rank: number;
  readonly exposedTo?: readonly RefinementCandidateExposureInput[];
}

export type RefinementEvaluationCandidateStatus = "candidate" | "promoted" | "rejected" | "revision_required" | "rolled_back";

export interface RefinementEvaluationHistoryInput {
  readonly observationId: string;
  readonly proposalId: string;
  readonly candidateId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly candidateStatus: RefinementEvaluationCandidateStatus;
  readonly evaluator: string;
  readonly objective: boolean;
  readonly success: boolean;
  readonly metric: unknown;
  readonly baseline?: unknown;
  readonly evidenceEventIds: readonly string[];
  readonly notes?: string;
  readonly createdAt: string;
  readonly exposedTo?: readonly RefinementCandidateExposureInput[];
}

/**
 * Trigger records are explicit typed inputs. In particular, arbitrary user or
 * assistant prose is never scanned to guess that it is a correction.
 */
export type RefinementTrajectoryTriggerInput =
  | { readonly kind: "manual"; readonly focusEventIds?: readonly string[] }
  | { readonly kind: "repeated_effect_failure"; readonly failureEventIds: readonly string[] }
  | { readonly kind: "repeated_cell_failure"; readonly failureEventIds: readonly string[] }
  | { readonly kind: "repeated_gate_failure"; readonly failureEventIds: readonly string[] }
  | { readonly kind: "explicit_user_correction"; readonly correctionEventIds: readonly string[] };

export interface BuildRefinementTrajectorySnapshotInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly throughCursor: string;
  readonly userScopeKey?: string;
  readonly events: readonly RefinementTrajectoryEventInput[];
  readonly trigger: RefinementTrajectoryTriggerInput;
  readonly visibleHarnessVersions: readonly RefinementVisibleHarnessVersionInput[];
  readonly memory: readonly RefinementMemoryInput[];
  readonly evaluationHistory: readonly RefinementEvaluationHistoryInput[];
  readonly requestedScope: HarnessScope;
  readonly requestedScopeKey: string;
  readonly allowedKinds: readonly HarnessKind[];
}

export interface BuildRefinementTrajectorySnapshotOptions {
  /** Exact values brokered outside model-visible state. Values below four bytes are ignored. */
  readonly brokeredCredentialValues?: readonly string[];
  readonly maxBytes?: number;
  readonly eventWindowRadius?: number;
  readonly manualRecentEventCount?: number;
}

export type RefinementEventSelectionReason = "trigger" | "cluster" | "window" | "recent";

export interface RefinementTruncatedValue {
  readonly truncated: true;
  readonly originalUtf8Bytes: number;
  /** Hash of the complete, scrubbed canonical value. */
  readonly canonicalHash: string;
  /** A bounded canonical-JSON prefix; it is data, not a parseable replacement. */
  readonly preview: string;
}

export interface RefinementTrajectorySnapshotEvent {
  readonly eventId: string;
  readonly cursor: string;
  readonly type: string;
  readonly payload: RefinementCanonicalJsonValue | RefinementTruncatedValue;
  readonly selection: RefinementEventSelectionReason;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

export interface RefinementTrajectorySnapshotHarnessVersion {
  readonly entryId: string;
  readonly versionId: string;
  readonly currentVersionId: string;
  readonly kind: HarnessKind;
  readonly scope: HarnessScope;
  readonly scopeKey: string;
  readonly name: string;
  readonly status: HarnessVersionStatus;
  readonly content: RefinementCanonicalJsonValue | RefinementTruncatedValue;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly editable: boolean;
}

export interface RefinementTrajectorySnapshotMemory {
  readonly entryId: string;
  readonly versionId: string;
  readonly currentVersionId: string;
  readonly scope: HarnessScope;
  readonly scopeKey: string;
  readonly name: string;
  readonly status: HarnessVersionStatus;
  readonly memoryKind: MemoryKind;
  readonly text: string | RefinementTruncatedValue;
  readonly reason: string;
  readonly rank: number;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly editable: boolean;
}

export interface RefinementTrajectorySnapshotEvaluation {
  readonly observationId: string;
  readonly proposalId: string;
  readonly candidateId: string;
  readonly candidateStatus: RefinementEvaluationCandidateStatus;
  readonly evaluator: string;
  readonly objective: boolean;
  readonly success: boolean;
  readonly metric: RefinementCanonicalJsonValue | RefinementTruncatedValue;
  readonly baseline?: RefinementCanonicalJsonValue | RefinementTruncatedValue;
  readonly evidenceEventIds: readonly string[];
  readonly notes?: string;
  readonly createdAt: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

export interface RefinementSnapshotEditableTarget {
  readonly entryId: string;
  readonly currentVersionId: string;
  readonly kind: HarnessKind;
  readonly scope: HarnessScope;
  readonly scopeKey: string;
  readonly name: string;
}

export interface RefinementTrajectorySnapshotTrigger {
  readonly kind: RefinementTrajectoryTriggerInput["kind"];
  readonly evidenceEventIds: readonly string[];
  readonly cluster: RefinementCanonicalJsonValue;
}

export interface RefinementTrajectorySnapshotTruncation {
  readonly eventsAfterCursor: number;
  readonly eventsOutsideBranch: number;
  readonly unselectedEvents: number;
  readonly excludedHarnessVersions: number;
  readonly omittedHarnessVersions: number;
  readonly excludedMemory: number;
  readonly omittedMemory: number;
  readonly excludedEvaluations: number;
  readonly omittedEvaluations: number;
  readonly truncatedEventIds: readonly string[];
  readonly truncatedHarnessVersionIds: readonly string[];
  readonly truncatedMemoryVersionIds: readonly string[];
  readonly truncatedEvaluationIds: readonly string[];
}

export interface RefinementTrajectorySnapshot {
  readonly format: typeof REFINEMENT_TRAJECTORY_SNAPSHOT_FORMAT;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly throughCursor: string;
  readonly trigger: RefinementTrajectorySnapshotTrigger;
  readonly events: readonly RefinementTrajectorySnapshotEvent[];
  readonly harnessVersions: readonly RefinementTrajectorySnapshotHarnessVersion[];
  readonly memory: readonly RefinementTrajectorySnapshotMemory[];
  readonly evaluationHistory: readonly RefinementTrajectorySnapshotEvaluation[];
  readonly editableTargets: readonly RefinementSnapshotEditableTarget[];
  /** Exactly the event IDs represented by `events`, in the same canonical order. */
  readonly sourceEventIds: readonly string[];
  readonly truncation: RefinementTrajectorySnapshotTruncation;
  /** SHA-256 over the canonical snapshot body (everything except this hash and utf8Bytes). */
  readonly canonicalHash: string;
  /** Exact canonical JSON size of this returned envelope. */
  readonly utf8Bytes: number;
}

export type RefinementContextErrorCode =
  | "invalid-input"
  | "invalid-trigger"
  | "missing-evidence"
  | "secret-escape"
  | "snapshot-too-large";

export class RefinementContextError extends Error {
  constructor(readonly code: RefinementContextErrorCode, message: string) {
    super(message);
    this.name = "RefinementContextError";
  }
}

interface NormalizedEvent {
  readonly eventId: string;
  readonly cursor: string;
  readonly type: string;
  readonly payload: unknown;
}
interface SelectedEvent extends NormalizedEvent {
  reason: RefinementEventSelectionReason;
  mandatory: boolean;
  priority: number;
}
interface Sanitized<T> { readonly value: T; readonly redacted: boolean }
interface MutableSnapshotState {
  events: RefinementTrajectorySnapshotEvent[];
  eventMeta: Map<string, SelectedEvent>;
  harness: RefinementTrajectorySnapshotHarnessVersion[];
  memory: RefinementTrajectorySnapshotMemory[];
  evaluations: RefinementTrajectorySnapshotEvaluation[];
}
interface SnapshotCounts {
  eventsAfterCursor: number;
  eventsOutsideBranch: number;
  selectedEventCandidates: number;
  eligibleHarness: number;
  excludedHarness: number;
  eligibleMemory: number;
  excludedMemory: number;
  eligibleEvaluations: number;
  excludedEvaluations: number;
}

/**
 * Builds a deterministic, bounded and attributable trajectory snapshot.
 * Inputs are cloned; neither nested inputs nor their arrays are ever mutated.
 */
export function buildRefinementTrajectorySnapshot(
  input: BuildRefinementTrajectorySnapshotInput,
  options: BuildRefinementTrajectorySnapshotOptions = {},
): RefinementTrajectorySnapshot {
  validateTopLevel(input, options);
  const secrets = normalizeSecrets(options.brokeredCredentialValues ?? []);
  assertSafeMetadata([
    input.workspaceId, input.sessionId, input.branchId, input.throughCursor,
    input.userScopeKey ?? "", input.requestedScopeKey, ...input.allowedKinds,
  ], secrets);

  const { events, eventsAfterCursor, eventsOutsideBranch } = normalizeEvents(input);
  if (events.length === 0) throw new RefinementContextError("missing-evidence", "No branch events exist at or before throughCursor");
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const trigger = validateAndDescribeTrigger(input.trigger, events, byId, secrets);
  const selected = selectTrajectoryEvents(input.trigger, events, byId, options);

  const maxBytes = options.maxBytes ?? MAX_REFINEMENT_TRAJECTORY_SNAPSHOT_BYTES;
  const sectionBudget = sectionBudgets(maxBytes);
  const eventRecords = materializeEvents(selected, sectionBudget.events, secrets);

  const harnessEligible = input.visibleHarnessVersions
    .filter((item) => versionVisible(item, input))
    .sort(compareHarnessInputs);
  const memoryEligible = input.memory
    .filter((item) => memoryVisible(item, input))
    .sort(compareMemoryInputs);
  const evaluationsEligible = input.evaluationHistory
    .filter((item) => evaluationVisible(item, input))
    .sort(compareEvaluationInputs);

  ensureUnique(harnessEligible.map((item) => item.versionId), "visible harness versionId");
  ensureUnique(memoryEligible.map((item) => item.versionId), "visible memory versionId");
  ensureUnique(evaluationsEligible.map((item) => item.observationId), "visible evaluation observationId");

  const harness = materializeHarness(harnessEligible.slice(0, MAX_VISIBLE_ITEMS_PER_SECTION), input, sectionBudget.harness, secrets);
  const memory = materializeMemory(memoryEligible.slice(0, MAX_VISIBLE_ITEMS_PER_SECTION), input, sectionBudget.memory, secrets);
  const evaluations = materializeEvaluations(evaluationsEligible.slice(0, MAX_VISIBLE_ITEMS_PER_SECTION), sectionBudget.evaluations, secrets);

  const state: MutableSnapshotState = {
    events: eventRecords,
    eventMeta: new Map(selected.map((item) => [item.eventId, item])),
    harness,
    memory,
    evaluations,
  };
  const counts: SnapshotCounts = {
    eventsAfterCursor,
    eventsOutsideBranch,
    selectedEventCandidates: selected.length,
    eligibleHarness: harnessEligible.length,
    excludedHarness: input.visibleHarnessVersions.length - harnessEligible.length,
    eligibleMemory: memoryEligible.length,
    excludedMemory: input.memory.length - memoryEligible.length,
    eligibleEvaluations: evaluationsEligible.length,
    excludedEvaluations: input.evaluationHistory.length - evaluationsEligible.length,
  };

  trimSnapshotToLimit(state, input, trigger, counts, maxBytes);
  const result = createSnapshotEnvelope(state, input, trigger, counts);
  if (result.utf8Bytes > maxBytes || result.utf8Bytes > MAX_REFINEMENT_TRAJECTORY_SNAPSHOT_BYTES) {
    throw new RefinementContextError("snapshot-too-large", "Refinement trajectory snapshot cannot fit its hard byte limit");
  }
  assertNoSecretEscape(result as unknown as RefinementCanonicalJsonValue, secrets);
  return deepFreeze(result);
}

function validateTopLevel(input: BuildRefinementTrajectorySnapshotInput, options: BuildRefinementTrajectorySnapshotOptions): void {
  assertId(input.workspaceId, "workspaceId");
  assertId(input.sessionId, "sessionId");
  assertId(input.branchId, "branchId");
  assertCursor(input.throughCursor, "throughCursor");
  if (input.userScopeKey !== undefined) assertId(input.userScopeKey, "userScopeKey");
  if (!HARNESS_SCOPES.has(input.requestedScope)) invalid("requestedScope is invalid");
  assertId(input.requestedScopeKey, "requestedScopeKey");
  if (scopeKeyFor(input.requestedScope, input) !== input.requestedScopeKey) invalid("requestedScopeKey is outside the requested authority scope");
  if (!Array.isArray(input.allowedKinds) || input.allowedKinds.length === 0 || input.allowedKinds.length > HARNESS_KINDS.size) invalid("allowedKinds must contain 1-4 harness kinds");
  ensureUnique(input.allowedKinds, "allowedKinds");
  for (const kind of input.allowedKinds) if (!HARNESS_KINDS.has(kind)) invalid(`Unknown allowed harness kind: ${String(kind)}`);
  boundedArray(input.events, MAX_EVENTS_INPUT, "events");
  boundedArray(input.visibleHarnessVersions, MAX_VISIBLE_VERSIONS_INPUT, "visibleHarnessVersions");
  boundedArray(input.memory, MAX_MEMORY_INPUT, "memory");
  boundedArray(input.evaluationHistory, MAX_EVALUATIONS_INPUT, "evaluationHistory");
  const maxBytes = options.maxBytes ?? MAX_REFINEMENT_TRAJECTORY_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_SNAPSHOT_BYTES || maxBytes > MAX_REFINEMENT_TRAJECTORY_SNAPSHOT_BYTES) {
    invalid(`maxBytes must be an integer from ${MIN_SNAPSHOT_BYTES} to ${MAX_REFINEMENT_TRAJECTORY_SNAPSHOT_BYTES}`);
  }
  const window = options.eventWindowRadius ?? DEFAULT_REFINEMENT_EVENT_WINDOW_RADIUS;
  if (!Number.isSafeInteger(window) || window < 0 || window > 32) invalid("eventWindowRadius must be an integer from 0 to 32");
  const recent = options.manualRecentEventCount ?? 32;
  if (!Number.isSafeInteger(recent) || recent < 1 || recent > MAX_SELECTED_EVENTS) invalid(`manualRecentEventCount must be from 1 to ${MAX_SELECTED_EVENTS}`);
}

function normalizeEvents(input: BuildRefinementTrajectorySnapshotInput): {
  events: NormalizedEvent[];
  eventsAfterCursor: number;
  eventsOutsideBranch: number;
} {
  const target: NormalizedEvent[] = [];
  let eventsAfterCursor = 0;
  let eventsOutsideBranch = 0;
  const seen = new Set<string>();
  for (const source of input.events) {
    if (!source || typeof source !== "object") invalid("Every trajectory event must be an object");
    assertId(source.id, "event.id");
    assertId(source.sessionId, "event.sessionId");
    assertId(source.branchId, "event.branchId");
    assertCursor(source.cursor, "event.cursor");
    if (typeof source.type !== "string" || source.type.length === 0 || utf8Bytes(source.type) > 128) invalid("event.type is invalid");
    if (source.sessionId !== input.sessionId || source.branchId !== input.branchId) {
      eventsOutsideBranch += 1;
      continue;
    }
    if (seen.has(source.id)) invalid(`Duplicate target-branch event ID: ${source.id}`);
    seen.add(source.id);
    if (compareCursor(source.cursor, input.throughCursor) > 0) {
      eventsAfterCursor += 1;
      continue;
    }
    target.push({ eventId: source.id, cursor: source.cursor, type: source.type, payload: source.payload });
  }
  target.sort(compareEvents);
  return { events: target, eventsAfterCursor, eventsOutsideBranch };
}

function validateAndDescribeTrigger(
  triggerInput: RefinementTrajectoryTriggerInput,
  events: readonly NormalizedEvent[],
  byId: ReadonlyMap<string, NormalizedEvent>,
  secrets: readonly string[],
): RefinementTrajectorySnapshotTrigger {
  if (!triggerInput || typeof triggerInput !== "object") throw new RefinementContextError("invalid-trigger", "Refinement trigger must be an explicit typed input");
  let evidenceEventIds: readonly string[];
  let cluster: RefinementCanonicalJsonValue;
  if (triggerInput.kind === "manual") {
    evidenceEventIds = normalizedEvidenceIds(triggerInput.focusEventIds ?? [], false);
    for (const id of evidenceEventIds) requireEvent(byId, id);
    cluster = { kind: "manual", focusEventCount: evidenceEventIds.length };
  } else if (triggerInput.kind === "repeated_effect_failure") {
    evidenceEventIds = normalizedEvidenceIds(triggerInput.failureEventIds, true);
    const failures = evidenceEventIds.map((id) => requireEvent(byId, id));
    const effectIds: string[] = [];
    for (const event of failures) {
      const payload = recordPayload(event.payload);
      if (event.type !== "EffectOutcomeRecorded" || payload.outcome !== "failed") {
        throw new RefinementContextError("invalid-trigger", `Effect failure evidence ${event.eventId} is not a typed failed EffectOutcomeRecorded event`);
      }
      effectIds.push(payloadString(payload, "effectId", event.eventId));
    }
    const uniqueEffects = sortedUnique(effectIds);
    const requests = events.filter((event) => event.type === "EffectRequested" && uniqueEffects.includes(optionalPayloadString(event.payload, "effectId") ?? ""));
    const signatures = sortedUnique(requests.map((event) => {
      const payload = recordPayload(event.payload);
      return `${payloadString(payload, "executor", event.eventId)}\u0000${payloadString(payload, "operation", event.eventId)}`;
    }));
    if (uniqueEffects.length > 1 && (requests.length !== uniqueEffects.length || signatures.length !== 1)) {
      throw new RefinementContextError("invalid-trigger", "Repeated effect failures must identify retries of one effect or requests with one exact executor/operation signature");
    }
    cluster = {
      kind: "repeated_effect_failure",
      effectIds: uniqueEffects,
      ...(signatures.length === 1 ? { executor: signatures[0]!.split("\u0000")[0]!, operation: signatures[0]!.split("\u0000")[1]! } : {}),
    };
  } else if (triggerInput.kind === "repeated_cell_failure") {
    evidenceEventIds = normalizedEvidenceIds(triggerInput.failureEventIds, true);
    const failures = evidenceEventIds.map((id) => requireEvent(byId, id));
    const runByCellId = agentRunCellOwners(events);
    const cells = failures.map((event) => {
      if (event.type !== "CellFailed") {
        throw new RefinementContextError("invalid-trigger", `Cell failure evidence ${event.eventId} is not a typed CellFailed event`);
      }
      const payload = recordPayload(event.payload);
      const cellId = payloadString(payload, "cellId", event.eventId);
      const runId = runByCellId.get(cellId);
      if (!runId) {
        throw new RefinementContextError("invalid-trigger", `Cell failure evidence ${event.eventId} has no retained agent-run action owner`);
      }
      return { cellId, runId };
    });
    if (new Set(cells.map((cell) => cell.runId)).size !== 1) {
      throw new RefinementContextError("invalid-trigger", "Repeated cell failures must reference one exact agent run");
    }
    cluster = {
      kind: "repeated_cell_failure",
      runId: cells[0]!.runId,
      cellIds: cells.map((cell) => cell.cellId),
    };
  } else if (triggerInput.kind === "repeated_gate_failure") {
    evidenceEventIds = normalizedEvidenceIds(triggerInput.failureEventIds, true);
    const failures = evidenceEventIds.map((id) => requireEvent(byId, id));
    const gates = failures.map((event) => {
      const payload = recordPayload(event.payload);
      if (!["GoalGateStatusChanged", "GoalGateEvaluationRecorded"].includes(event.type) || payload.status !== "failed") {
        throw new RefinementContextError("invalid-trigger", `Gate failure evidence ${event.eventId} is not a typed failed gate status/evaluation event`);
      }
      return { goalId: payloadString(payload, "goalId", event.eventId), gateId: payloadString(payload, "gateId", event.eventId) };
    });
    if (new Set(gates.map((gate) => `${gate.goalId}\u0000${gate.gateId}`)).size !== 1) {
      throw new RefinementContextError("invalid-trigger", "Repeated gate failures must reference one exact goal/gate cluster");
    }
    cluster = { kind: "repeated_gate_failure", goalId: gates[0]!.goalId, gateId: gates[0]!.gateId };
  } else if (triggerInput.kind === "explicit_user_correction") {
    evidenceEventIds = normalizedEvidenceIds(triggerInput.correctionEventIds, false, true);
    for (const id of evidenceEventIds) {
      const event = requireEvent(byId, id);
      const payload = recordPayload(event.payload);
      const explicitlyTyped = event.type === "UserCorrection";
      const retainedUserMessage = event.type === "MessageAppended" && payload.role === "user";
      if (!explicitlyTyped && !retainedUserMessage) {
        throw new RefinementContextError("invalid-trigger", `Correction evidence ${id} is not an explicitly identified user input event`);
      }
      if (explicitlyTyped) {
        const correctedEventIds = Array.isArray(payload.correctedEventIds) ? payload.correctedEventIds : null;
        if (!correctedEventIds || correctedEventIds.length === 0 || correctedEventIds.some((correctedId) => typeof correctedId !== "string" || !byId.has(correctedId) || compareCursor(byId.get(correctedId)!.cursor, event.cursor) >= 0)) {
          throw new RefinementContextError("invalid-trigger", `Typed correction ${id} does not cite existing earlier trajectory events`);
        }
      }
    }
    cluster = { kind: "explicit_user_correction", correctionCount: evidenceEventIds.length };
  } else {
    throw new RefinementContextError("invalid-trigger", "Unknown refinement trigger input kind");
  }
  assertSafeMetadata(evidenceEventIds, secrets);
  return {
    kind: triggerInput.kind,
    evidenceEventIds: Object.freeze([...evidenceEventIds]),
    cluster: sanitizeJson(cluster, secrets).value,
  };
}

function agentRunCellOwners(
  events: readonly NormalizedEvent[],
): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "AgentRunActionCommitted") continue;
    const payload = recordPayload(event.payload);
    const action = recordPayload(payload.action);
    const actionId = optionalPayloadString(payload, "actionId");
    const runId = optionalPayloadString(payload, "runId");
    if (action.type !== "typescript" || !actionId || !runId) continue;
    owners.set(`agent-run-cell-${actionId}`, runId);
  }
  return owners;
}

function selectTrajectoryEvents(
  trigger: RefinementTrajectoryTriggerInput,
  events: readonly NormalizedEvent[],
  byId: ReadonlyMap<string, NormalizedEvent>,
  options: BuildRefinementTrajectorySnapshotOptions,
): SelectedEvent[] {
  const selected = new Map<string, SelectedEvent>();
  const add = (event: NormalizedEvent, reason: RefinementEventSelectionReason, mandatory: boolean, priority: number): void => {
    const current = selected.get(event.eventId);
    if (!current || priority < current.priority || mandatory && !current.mandatory) {
      selected.set(event.eventId, { ...event, reason, mandatory: mandatory || current?.mandatory === true, priority: Math.min(priority, current?.priority ?? priority) });
    }
  };

  const evidenceIds = trigger.kind === "manual" ? trigger.focusEventIds ?? []
    : trigger.kind === "explicit_user_correction" ? trigger.correctionEventIds
    : trigger.failureEventIds;
  const anchors = evidenceIds.map((id) => requireEvent(byId, id));
  for (const event of anchors) add(event, "trigger", true, 0);

  if (trigger.kind === "repeated_effect_failure") {
    const effectIds = new Set(anchors.map((event) => optionalPayloadString(event.payload, "effectId")!));
    for (const event of events) {
      if (!["EffectRequested", "EffectAttemptStarted", "EffectOutcomeRecorded"].includes(event.type)) continue;
      if (effectIds.has(optionalPayloadString(event.payload, "effectId") ?? "")) add(event, "cluster", false, 1);
    }
  } else if (trigger.kind === "repeated_cell_failure") {
    const cellIds = new Set(anchors.map((event) =>
      optionalPayloadString(event.payload, "cellId")!
    ));
    const runIds = new Set(
      [...agentRunCellOwners(events).entries()]
        .filter(([cellId]) => cellIds.has(cellId))
        .map(([, runId]) => runId),
    );
    for (const event of events) {
      if (["CellProposed", "CellStarted", "CellCommitted", "CellFailed", "CellAbandoned"].includes(event.type) &&
          cellIds.has(optionalPayloadString(event.payload, "cellId") ?? "")) {
        add(event, "cluster", false, 1);
      }
      if (event.type === "AgentRunActionCommitted" &&
          runIds.has(optionalPayloadString(event.payload, "runId") ?? "")) {
        add(event, "cluster", false, 1);
      }
    }
  } else if (trigger.kind === "repeated_gate_failure") {
    const anchorPayload = recordPayload(anchors[0]!.payload);
    const goalId = payloadString(anchorPayload, "goalId", anchors[0]!.eventId);
    const gateId = payloadString(anchorPayload, "gateId", anchors[0]!.eventId);
    for (const event of events) {
      if (!["GoalGateAdded", "GoalGateStatusChanged", "GoalGateEvaluationRecorded"].includes(event.type)) continue;
      if (optionalPayloadString(event.payload, "goalId") === goalId && optionalPayloadString(event.payload, "gateId") === gateId) {
        add(event, "cluster", false, 1);
      }
    }
  } else if (trigger.kind === "explicit_user_correction") {
    for (const anchor of anchors) {
      if (anchor.type !== "UserCorrection") continue;
      const payload = recordPayload(anchor.payload);
      const correctedEventIds = Array.isArray(payload.correctedEventIds) ? payload.correctedEventIds : [];
      for (const correctedId of correctedEventIds) if (typeof correctedId === "string") add(requireEvent(byId, correctedId), "cluster", false, 1);
    }
  }

  if (anchors.length === 0) {
    const recent = options.manualRecentEventCount ?? 32;
    const chosen = events.slice(-recent);
    chosen.forEach((event, index) => add(event, "recent", index === chosen.length - 1, 2 + (chosen.length - index)));
  } else {
    const radius = options.eventWindowRadius ?? DEFAULT_REFINEMENT_EVENT_WINDOW_RADIUS;
    const positions = new Map(events.map((event, index) => [event.eventId, index]));
    for (const anchor of anchors) {
      const index = positions.get(anchor.eventId)!;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const event = events[index + offset];
        if (event) add(event, "window", false, 2 + Math.abs(offset));
      }
    }
  }

  const ranked = [...selected.values()].sort((left, right) =>
    Number(right.mandatory) - Number(left.mandatory) || left.priority - right.priority || compareEvents(left, right));
  const kept = ranked.slice(0, MAX_SELECTED_EVENTS);
  const mandatoryCount = ranked.filter((item) => item.mandatory).length;
  if (mandatoryCount > MAX_SELECTED_EVENTS) throw new RefinementContextError("snapshot-too-large", "Trigger evidence exceeds the selected-event hard count");
  return kept.sort(compareEvents);
}

function materializeEvents(selected: readonly SelectedEvent[], budget: number, secrets: readonly string[]): RefinementTrajectorySnapshotEvent[] {
  const mandatory = selected.filter((item) => item.mandatory).sort(compareEvents);
  const optional = selected.filter((item) => !item.mandatory)
    .sort((left, right) => left.priority - right.priority || compareEvents(left, right));
  const records: RefinementTrajectorySnapshotEvent[] = [];
  let used = 2;

  // Reserve a minimal attributable envelope for every trigger evidence event.
  for (const event of mandatory) {
    const payload = sanitizeJson(event.payload, secrets);
    const marker = truncatedValue(payload.value, 0);
    const record = eventRecord(event, marker, true, payload.redacted);
    const bytes = utf8Bytes(canonicalJson(record));
    if (used + bytes + 1 > budget) throw new RefinementContextError("snapshot-too-large", "Trigger evidence cannot fit the trajectory event budget");
    records.push(record);
    used += bytes + 1;
  }

  // Upgrade mandatory payloads when possible without ever dropping evidence.
  for (const event of mandatory) {
    const index = records.findIndex((item) => item.eventId === event.eventId);
    const payload = sanitizeJson(event.payload, secrets);
    const bounded = boundedValue(payload.value, MAX_ITEM_BYTES);
    const upgraded = eventRecord(event, bounded.value, bounded.truncated, payload.redacted);
    const oldBytes = utf8Bytes(canonicalJson(records[index]!));
    const nextBytes = utf8Bytes(canonicalJson(upgraded));
    if (used - oldBytes + nextBytes <= budget) {
      records[index] = upgraded;
      used = used - oldBytes + nextBytes;
    }
  }

  for (const event of optional) {
    const payload = sanitizeJson(event.payload, secrets);
    let bounded = boundedValue(payload.value, MAX_ITEM_BYTES);
    let record = eventRecord(event, bounded.value, bounded.truncated, payload.redacted);
    let bytes = utf8Bytes(canonicalJson(record));
    if (used + bytes + 1 > budget) {
      bounded = { value: truncatedValue(payload.value, MIN_TRUNCATED_PREVIEW_BYTES), truncated: true };
      record = eventRecord(event, bounded.value, true, payload.redacted);
      bytes = utf8Bytes(canonicalJson(record));
    }
    if (used + bytes + 1 <= budget) {
      records.push(record);
      used += bytes + 1;
    }
  }
  return records.sort(compareSnapshotEvents);
}

function materializeHarness(
  inputs: readonly RefinementVisibleHarnessVersionInput[],
  request: BuildRefinementTrajectorySnapshotInput,
  budget: number,
  secrets: readonly string[],
): RefinementTrajectorySnapshotHarnessVersion[] {
  const records: RefinementTrajectorySnapshotHarnessVersion[] = [];
  let used = 2;
  for (const input of inputs) {
    validateHarnessInput(input);
    assertSafeMetadata([input.entryId, input.versionId, input.currentVersionId, input.scopeKey], secrets);
    const name = sanitizeText(input.name, secrets);
    const content = sanitizeJson(input.content, secrets);
    let bounded = boundedValue(content.value, MAX_ITEM_BYTES);
    let record = harnessRecord(input, name, content.redacted, bounded.value, bounded.truncated, request);
    let bytes = utf8Bytes(canonicalJson(record));
    if (used + bytes + 1 > budget) {
      bounded = { value: truncatedValue(content.value, MIN_TRUNCATED_PREVIEW_BYTES), truncated: true };
      record = harnessRecord(input, name, content.redacted, bounded.value, true, request);
      bytes = utf8Bytes(canonicalJson(record));
    }
    if (used + bytes + 1 <= budget) {
      records.push(record);
      used += bytes + 1;
    }
  }
  return records;
}

function materializeMemory(
  inputs: readonly RefinementMemoryInput[],
  request: BuildRefinementTrajectorySnapshotInput,
  budget: number,
  secrets: readonly string[],
): RefinementTrajectorySnapshotMemory[] {
  const records: RefinementTrajectorySnapshotMemory[] = [];
  let used = 2;
  for (const input of inputs) {
    validateMemoryInput(input);
    assertSafeMetadata([input.entryId, input.versionId, input.currentVersionId, input.scopeKey], secrets);
    const name = sanitizeText(input.name, secrets);
    const reason = sanitizeText(input.reason, secrets);
    const text = sanitizeText(input.text, secrets);
    const combinedRedaction = name.redacted || reason.redacted || text.redacted;
    const value = text.value;
    let bounded: { value: string | RefinementTruncatedValue; truncated: boolean } = utf8Bytes(canonicalJson(value)) <= MAX_ITEM_BYTES
      ? { value, truncated: false }
      : { value: truncatedValue(value, Math.min(2048, MAX_ITEM_BYTES - 256)), truncated: true };
    let record = memoryRecord(input, name.value, reason.value, combinedRedaction, bounded.value, bounded.truncated, request);
    let bytes = utf8Bytes(canonicalJson(record));
    if (used + bytes + 1 > budget) {
      bounded = { value: truncatedValue(value, MIN_TRUNCATED_PREVIEW_BYTES), truncated: true };
      record = memoryRecord(input, name.value, reason.value, combinedRedaction, bounded.value, true, request);
      bytes = utf8Bytes(canonicalJson(record));
    }
    if (used + bytes + 1 <= budget) {
      records.push(record);
      used += bytes + 1;
    }
  }
  return records;
}

function materializeEvaluations(
  inputs: readonly RefinementEvaluationHistoryInput[],
  budget: number,
  secrets: readonly string[],
): RefinementTrajectorySnapshotEvaluation[] {
  const records: RefinementTrajectorySnapshotEvaluation[] = [];
  let used = 2;
  for (const input of inputs) {
    validateEvaluationInput(input);
    assertSafeMetadata([input.observationId, input.proposalId, input.candidateId, ...input.evidenceEventIds], secrets);
    const evaluator = sanitizeText(input.evaluator, secrets);
    const notes = input.notes === undefined ? undefined : sanitizeText(input.notes, secrets);
    const metric = sanitizeJson(input.metric, secrets);
    const baseline = input.baseline === undefined ? undefined : sanitizeJson(input.baseline, secrets);
    let metricBounded = boundedValue(metric.value, MAX_ITEM_BYTES / 2);
    let baselineBounded = baseline === undefined ? undefined : boundedValue(baseline.value, MAX_ITEM_BYTES / 2);
    let record = evaluationRecord(input, evaluator, notes, metric, baseline, metricBounded, baselineBounded);
    let bytes = utf8Bytes(canonicalJson(record));
    if (used + bytes + 1 > budget) {
      metricBounded = { value: truncatedValue(metric.value, MIN_TRUNCATED_PREVIEW_BYTES), truncated: true };
      baselineBounded = baseline === undefined ? undefined : { value: truncatedValue(baseline.value, MIN_TRUNCATED_PREVIEW_BYTES), truncated: true };
      record = evaluationRecord(input, evaluator, notes, metric, baseline, metricBounded, baselineBounded);
      bytes = utf8Bytes(canonicalJson(record));
    }
    if (used + bytes + 1 <= budget) {
      records.push(record);
      used += bytes + 1;
    }
  }
  return records;
}

function trimSnapshotToLimit(
  state: MutableSnapshotState,
  input: BuildRefinementTrajectorySnapshotInput,
  trigger: RefinementTrajectorySnapshotTrigger,
  counts: SnapshotCounts,
  maxBytes: number,
): void {
  const size = (): number => createSnapshotEnvelope(state, input, trigger, counts).utf8Bytes;
  if (size() <= maxBytes) return;

  // Drop least relevant window records before any trigger evidence.
  const optionalByWorstPriority = state.events
    .filter((event) => !state.eventMeta.get(event.eventId)?.mandatory)
    .sort((left, right) => {
      const l = state.eventMeta.get(left.eventId)!;
      const r = state.eventMeta.get(right.eventId)!;
      return r.priority - l.priority || compareSnapshotEvents(right, left);
    });
  for (const event of optionalByWorstPriority) {
    state.events = state.events.filter((item) => item.eventId !== event.eventId);
    if (size() <= maxBytes) return;
  }
  for (const section of [state.evaluations, state.memory, state.harness] as Array<Array<unknown>>) {
    while (section.length > 0) {
      section.pop();
      if (size() <= maxBytes) return;
    }
  }
  // Mandatory records already carry at most one bounded payload. Reduce their
  // previews to zero as the final safe operation; event identity remains exact.
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const record = state.events[index]!;
    if (isTruncatedValue(record.payload) && record.payload.preview.length === 0) continue;
    const sanitizedPayload = isTruncatedValue(record.payload)
      ? record.payload
      : record.payload as RefinementCanonicalJsonValue;
    const marker = isTruncatedValue(sanitizedPayload)
      ? { ...sanitizedPayload, preview: "" }
      : truncatedValue(sanitizedPayload, 0);
    state.events[index] = { ...record, payload: marker, truncated: true };
    if (size() <= maxBytes) return;
  }
  throw new RefinementContextError("snapshot-too-large", "Required refinement evidence cannot fit the requested snapshot byte limit");
}

function createSnapshotEnvelope(
  state: MutableSnapshotState,
  input: BuildRefinementTrajectorySnapshotInput,
  trigger: RefinementTrajectorySnapshotTrigger,
  counts: SnapshotCounts,
): RefinementTrajectorySnapshot {
  state.events.sort(compareSnapshotEvents);
  const targets = editableTargets(state.harness, state.memory);
  const body = {
    format: REFINEMENT_TRAJECTORY_SNAPSHOT_FORMAT,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    branchId: input.branchId,
    throughCursor: input.throughCursor,
    trigger,
    events: state.events,
    harnessVersions: state.harness,
    memory: state.memory,
    evaluationHistory: state.evaluations,
    editableTargets: targets,
    sourceEventIds: state.events.map((event) => event.eventId),
    truncation: {
      eventsAfterCursor: counts.eventsAfterCursor,
      eventsOutsideBranch: counts.eventsOutsideBranch,
      unselectedEvents: counts.selectedEventCandidates - state.events.length,
      excludedHarnessVersions: counts.excludedHarness,
      omittedHarnessVersions: counts.eligibleHarness - state.harness.length,
      excludedMemory: counts.excludedMemory,
      omittedMemory: counts.eligibleMemory - state.memory.length,
      excludedEvaluations: counts.excludedEvaluations,
      omittedEvaluations: counts.eligibleEvaluations - state.evaluations.length,
      truncatedEventIds: state.events.filter((item) => item.truncated).map((item) => item.eventId),
      truncatedHarnessVersionIds: state.harness.filter((item) => item.truncated).map((item) => item.versionId),
      truncatedMemoryVersionIds: state.memory.filter((item) => item.truncated).map((item) => item.versionId),
      truncatedEvaluationIds: state.evaluations.filter((item) => item.truncated).map((item) => item.observationId),
    },
  } as const;
  const canonicalHash = sha256(canonicalJson(body));
  let utf8BytesValue = 0;
  let envelope: RefinementTrajectorySnapshot;
  do {
    envelope = { ...body, canonicalHash, utf8Bytes: utf8BytesValue };
    const next = utf8Bytes(canonicalJson(envelope));
    if (next === utf8BytesValue) break;
    utf8BytesValue = next;
  } while (true);
  return envelope!;
}

function editableTargets(
  harness: readonly RefinementTrajectorySnapshotHarnessVersion[],
  memory: readonly RefinementTrajectorySnapshotMemory[],
): RefinementSnapshotEditableTarget[] {
  const targets: RefinementSnapshotEditableTarget[] = [];
  for (const item of harness) if (item.editable) targets.push({
    entryId: item.entryId, currentVersionId: item.currentVersionId, kind: item.kind,
    scope: item.scope, scopeKey: item.scopeKey, name: item.name,
  });
  for (const item of memory) if (item.editable) targets.push({
    entryId: item.entryId, currentVersionId: item.currentVersionId, kind: "memory",
    scope: item.scope, scopeKey: item.scopeKey, name: item.name,
  });
  const byEntry = new Map<string, RefinementSnapshotEditableTarget>();
  for (const target of targets.sort((left, right) => compareText(left.entryId, right.entryId))) {
    const existing = byEntry.get(target.entryId);
    if (existing && canonicalJson(existing) !== canonicalJson(target)) invalid(`Conflicting editable target metadata for ${target.entryId}`);
    byEntry.set(target.entryId, target);
  }
  return [...byEntry.values()];
}

function versionVisible(item: RefinementVisibleHarnessVersionInput, input: BuildRefinementTrajectorySnapshotInput): boolean {
  validateHarnessInputMetadata(item);
  if (!scopeVisible(item.scope, item.scopeKey, input)) return false;
  if (item.status === "active") return true;
  return item.status === "candidate" && exposedHere(item.exposedTo, input.sessionId, input.branchId);
}
function memoryVisible(item: RefinementMemoryInput, input: BuildRefinementTrajectorySnapshotInput): boolean {
  validateMemoryInputMetadata(item);
  if (!scopeVisible(item.scope, item.scopeKey, input)) return false;
  if (item.status === "active") return true;
  return item.status === "candidate" && exposedHere(item.exposedTo, input.sessionId, input.branchId);
}
function evaluationVisible(item: RefinementEvaluationHistoryInput, input: BuildRefinementTrajectorySnapshotInput): boolean {
  validateEvaluationInputMetadata(item);
  if (item.workspaceId !== input.workspaceId || item.sessionId !== input.sessionId || item.branchId !== input.branchId) return false;
  return item.candidateStatus !== "candidate" || exposedHere(item.exposedTo, input.sessionId, input.branchId);
}
function scopeVisible(scope: HarnessScope, scopeKey: string, input: BuildRefinementTrajectorySnapshotInput): boolean {
  return scopeKeyFor(scope, input) === scopeKey;
}
function scopeKeyFor(scope: HarnessScope, input: Pick<BuildRefinementTrajectorySnapshotInput, "workspaceId" | "sessionId" | "userScopeKey">): string | undefined {
  if (scope === "local") return input.sessionId;
  if (scope === "workspace") return input.workspaceId;
  if (scope === "user") return input.userScopeKey;
  return "global";
}
function exposedHere(exposures: readonly RefinementCandidateExposureInput[] | undefined, sessionId: string, branchId: string): boolean {
  return exposures?.some((item) => item.sessionId === sessionId && item.branchId === branchId) === true;
}

function harnessRecord(
  input: RefinementVisibleHarnessVersionInput,
  name: Sanitized<string>,
  contentRedacted: boolean,
  content: RefinementCanonicalJsonValue | RefinementTruncatedValue,
  truncated: boolean,
  request: BuildRefinementTrajectorySnapshotInput,
): RefinementTrajectorySnapshotHarnessVersion {
  const redacted = name.redacted || contentRedacted;
  const editable = !truncated && !redacted && input.status === "active" && input.versionId === input.currentVersionId
    && input.scope === request.requestedScope && input.scopeKey === request.requestedScopeKey && request.allowedKinds.includes(input.kind);
  return {
    entryId: input.entryId, versionId: input.versionId, currentVersionId: input.currentVersionId,
    kind: input.kind, scope: input.scope, scopeKey: input.scopeKey, name: name.value, status: input.status,
    content, truncated, redacted, editable,
  };
}
function memoryRecord(
  input: RefinementMemoryInput,
  name: string,
  reason: string,
  redacted: boolean,
  text: string | RefinementTruncatedValue,
  truncated: boolean,
  request: BuildRefinementTrajectorySnapshotInput,
): RefinementTrajectorySnapshotMemory {
  const editable = !truncated && !redacted && input.status === "active" && input.versionId === input.currentVersionId
    && input.scope === request.requestedScope && input.scopeKey === request.requestedScopeKey && request.allowedKinds.includes("memory");
  return {
    entryId: input.entryId, versionId: input.versionId, currentVersionId: input.currentVersionId,
    scope: input.scope, scopeKey: input.scopeKey, name, status: input.status,
    memoryKind: input.memoryKind,
    text: typeof text === "string" ? text : text,
    reason, rank: input.rank, truncated, redacted, editable,
  };
}
function evaluationRecord(
  input: RefinementEvaluationHistoryInput,
  evaluator: Sanitized<string>,
  notes: Sanitized<string> | undefined,
  metric: Sanitized<RefinementCanonicalJsonValue>,
  baseline: Sanitized<RefinementCanonicalJsonValue> | undefined,
  metricBounded: { value: RefinementCanonicalJsonValue | RefinementTruncatedValue; truncated: boolean },
  baselineBounded: { value: RefinementCanonicalJsonValue | RefinementTruncatedValue; truncated: boolean } | undefined,
): RefinementTrajectorySnapshotEvaluation {
  const truncated = metricBounded.truncated || baselineBounded?.truncated === true;
  return {
    observationId: input.observationId, proposalId: input.proposalId, candidateId: input.candidateId,
    candidateStatus: input.candidateStatus, evaluator: evaluator.value, objective: input.objective, success: input.success,
    metric: metricBounded.value,
    ...(baselineBounded === undefined ? {} : { baseline: baselineBounded.value }),
    evidenceEventIds: sortedUnique(input.evidenceEventIds),
    ...(notes === undefined ? {} : { notes: notes.value }),
    createdAt: input.createdAt,
    truncated,
    redacted: evaluator.redacted || notes?.redacted === true || metric.redacted || baseline?.redacted === true,
  };
}
function eventRecord(
  event: SelectedEvent,
  payload: RefinementCanonicalJsonValue | RefinementTruncatedValue,
  truncated: boolean,
  redacted: boolean,
): RefinementTrajectorySnapshotEvent {
  return { eventId: event.eventId, cursor: event.cursor, type: event.type, payload, selection: event.reason, truncated, redacted };
}

function validateHarnessInputMetadata(input: RefinementVisibleHarnessVersionInput): void {
  assertId(input.entryId, "harness.entryId"); assertId(input.versionId, "harness.versionId"); assertId(input.currentVersionId, "harness.currentVersionId");
  assertId(input.scopeKey, "harness.scopeKey");
  if (!HARNESS_KINDS.has(input.kind) || !HARNESS_SCOPES.has(input.scope) || !VERSION_STATUSES.has(input.status)) invalid("Harness version metadata is invalid");
  if (input.exposedTo !== undefined) validateExposures(input.exposedTo);
}
function validateHarnessInput(input: RefinementVisibleHarnessVersionInput): void {
  validateHarnessInputMetadata(input);
  if (typeof input.name !== "string" || input.name.trim().length === 0) invalid("Harness version name is invalid");
}
function validateMemoryInputMetadata(input: RefinementMemoryInput): void {
  assertId(input.entryId, "memory.entryId"); assertId(input.versionId, "memory.versionId"); assertId(input.currentVersionId, "memory.currentVersionId"); assertId(input.scopeKey, "memory.scopeKey");
  if (!HARNESS_SCOPES.has(input.scope) || !VERSION_STATUSES.has(input.status) || !MEMORY_KINDS.has(input.memoryKind)) invalid("Memory metadata is invalid");
  if (input.exposedTo !== undefined) validateExposures(input.exposedTo);
}
function validateMemoryInput(input: RefinementMemoryInput): void {
  validateMemoryInputMetadata(input);
  if (typeof input.name !== "string" || input.name.trim().length === 0 || typeof input.text !== "string" || typeof input.reason !== "string") invalid("Memory content is invalid");
  if (!Number.isSafeInteger(input.rank) || input.rank < 0) invalid("Memory rank must be a nonnegative integer");
}
function validateEvaluationInputMetadata(input: RefinementEvaluationHistoryInput): void {
  assertId(input.observationId, "evaluation.observationId"); assertId(input.proposalId, "evaluation.proposalId"); assertId(input.candidateId, "evaluation.candidateId");
  assertId(input.workspaceId, "evaluation.workspaceId"); assertId(input.sessionId, "evaluation.sessionId"); assertId(input.branchId, "evaluation.branchId");
  if (!["candidate", "promoted", "rejected", "revision_required", "rolled_back"].includes(input.candidateStatus)) invalid("Evaluation candidateStatus is invalid");
  if (input.exposedTo !== undefined) validateExposures(input.exposedTo);
}
function validateEvaluationInput(input: RefinementEvaluationHistoryInput): void {
  validateEvaluationInputMetadata(input);
  if (typeof input.evaluator !== "string" || input.evaluator.trim().length === 0 || typeof input.objective !== "boolean" || typeof input.success !== "boolean") invalid("Evaluation content is invalid");
  if (!Array.isArray(input.evidenceEventIds) || input.evidenceEventIds.length > MAX_EVIDENCE_EVENTS) invalid("Evaluation evidenceEventIds exceed their bound");
  ensureUnique(input.evidenceEventIds, "evaluation evidenceEventIds");
  input.evidenceEventIds.forEach((id) => assertId(id, "evaluation.evidenceEventId"));
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) invalid("Evaluation createdAt is invalid");
}
function validateExposures(exposures: readonly RefinementCandidateExposureInput[]): void {
  if (!Array.isArray(exposures) || exposures.length > 128) invalid("Candidate exposures exceed their bound");
  for (const exposure of exposures) { assertId(exposure.sessionId, "exposure.sessionId"); assertId(exposure.branchId, "exposure.branchId"); }
}

function normalizedEvidenceIds(ids: readonly string[], repeated: boolean, requireAtLeastOne = false): string[] {
  if (!Array.isArray(ids) || ids.length > MAX_EVIDENCE_EVENTS) throw new RefinementContextError("invalid-trigger", `Trigger evidence is limited to ${MAX_EVIDENCE_EVENTS} events`);
  if (repeated && ids.length < 2) throw new RefinementContextError("invalid-trigger", "A repeated failure trigger requires at least two durable failure events");
  if (requireAtLeastOne && ids.length < 1) throw new RefinementContextError("invalid-trigger", "An explicit user correction requires a durable user input event");
  ids.forEach((id) => assertId(id, "trigger evidence event ID"));
  if (new Set(ids).size !== ids.length) throw new RefinementContextError("invalid-trigger", "Trigger evidence event IDs must be unique");
  return [...ids].sort(compareText);
}
function requireEvent(byId: ReadonlyMap<string, NormalizedEvent>, id: string): NormalizedEvent {
  const event = byId.get(id);
  if (!event) throw new RefinementContextError("missing-evidence", `Trigger evidence is outside the frozen branch trajectory: ${id}`);
  return event;
}
function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RefinementContextError("invalid-trigger", "Typed trigger evidence has a malformed payload");
  return payload as Record<string, unknown>;
}
function payloadString(payload: Record<string, unknown>, key: string, eventId: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new RefinementContextError("invalid-trigger", `Trigger evidence ${eventId} lacks ${key}`);
  return value;
}
function optionalPayloadString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function boundedValue(value: RefinementCanonicalJsonValue, maximum: number): {
  value: RefinementCanonicalJsonValue | RefinementTruncatedValue;
  truncated: boolean;
} {
  const text = canonicalJson(value);
  if (utf8Bytes(text) <= maximum) return { value, truncated: false };
  return { value: truncatedValue(value, Math.min(2048, Math.max(0, maximum - 256))), truncated: true };
}
function truncatedValue(value: RefinementCanonicalJsonValue | RefinementTruncatedValue, previewBytes: number): RefinementTruncatedValue {
  if (isTruncatedValue(value)) return { ...value, preview: truncateUtf8(value.preview, previewBytes) };
  const text = canonicalJson(value);
  return {
    truncated: true,
    originalUtf8Bytes: utf8Bytes(text),
    canonicalHash: sha256(text),
    preview: truncateUtf8(text, previewBytes),
  };
}
function isTruncatedValue(value: unknown): value is RefinementTruncatedValue {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).truncated === true
    && typeof (value as Record<string, unknown>).canonicalHash === "string"
    && typeof (value as Record<string, unknown>).preview === "string";
}

function sanitizeJson(value: unknown, secrets: readonly string[]): Sanitized<RefinementCanonicalJsonValue> {
  const seen = new Set<object>();
  const walk = (current: unknown): Sanitized<RefinementCanonicalJsonValue> => {
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      if (typeof current !== "string") return { value: current, redacted: false };
      return sanitizeText(current, secrets);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalid("Snapshot inputs must contain finite JSON numbers");
      return { value: Object.is(current, -0) ? 0 : current, redacted: false };
    }
    if (typeof current !== "object") invalid("Snapshot inputs must be JSON values");
    if (seen.has(current as object)) invalid("Snapshot inputs cannot contain cycles or shared object references");
    seen.add(current as object);
    if (Array.isArray(current)) {
      const values = current.map(walk);
      seen.delete(current);
      return { value: values.map((item) => item.value), redacted: values.some((item) => item.redacted) };
    }
    const output: Record<string, RefinementCanonicalJsonValue> = {};
    let redacted = false;
    for (const key of Object.keys(current as Record<string, unknown>).sort(compareText)) {
      const safeKey = sanitizeText(key, secrets);
      if (safeKey.value !== key) throw new RefinementContextError("secret-escape", "Brokered credential material cannot be used as an object key");
      const item = walk((current as Record<string, unknown>)[key]);
      output[key] = item.value;
      redacted ||= item.redacted;
    }
    seen.delete(current);
    return { value: output, redacted };
  };
  return walk(value);
}
function sanitizeText(text: string, secrets: readonly string[]): Sanitized<string> {
  let value = text;
  let redacted = false;
  for (const secret of secrets) {
    if (!value.includes(secret)) continue;
    value = value.split(secret).join("[REDACTED]");
    redacted = true;
  }
  return { value, redacted };
}
function normalizeSecrets(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 256) invalid("brokeredCredentialValues exceed their bound");
  return sortedUnique(values.filter((value) => typeof value === "string" && utf8Bytes(value) >= 4))
    .sort((left, right) => utf8Bytes(right) - utf8Bytes(left) || compareText(left, right));
}
function assertSafeMetadata(values: readonly string[], secrets: readonly string[]): void {
  for (const value of values) {
    if (secrets.some((secret) => value.includes(secret))) {
      throw new RefinementContextError("secret-escape", "Brokered secret values cannot appear in refinement attribution metadata");
    }
  }
}
function assertNoSecretEscape(value: RefinementCanonicalJsonValue, secrets: readonly string[]): void {
  for (const text of stringLeaves(value)) {
    if (secrets.some((secret) => text.includes(secret))) {
      throw new RefinementContextError("secret-escape", "A brokered secret value escaped into the refinement snapshot");
    }
  }
}
function* stringLeaves(value: RefinementCanonicalJsonValue): Generator<string> {
  if (typeof value === "string") { yield value; return; }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) yield* stringLeaves(item); return; }
  for (const item of Object.values(value)) yield* stringLeaves(item);
}

function sectionBudgets(maxBytes: number): { events: number; harness: number; memory: number; evaluations: number } {
  // Thirty-six percent remains for duplicate provenance IDs, editable targets,
  // the trigger, hashes, and the envelope itself.
  return {
    events: Math.floor(maxBytes * 0.38),
    harness: Math.floor(maxBytes * 0.12),
    memory: Math.floor(maxBytes * 0.07),
    evaluations: Math.floor(maxBytes * 0.07),
  };
}
function compareEvents(left: Pick<NormalizedEvent, "cursor" | "eventId">, right: Pick<NormalizedEvent, "cursor" | "eventId">): number {
  return compareCursor(left.cursor, right.cursor) || compareText(left.eventId, right.eventId);
}
function compareSnapshotEvents(left: RefinementTrajectorySnapshotEvent, right: RefinementTrajectorySnapshotEvent): number {
  return compareCursor(left.cursor, right.cursor) || compareText(left.eventId, right.eventId);
}
function compareHarnessInputs(left: RefinementVisibleHarnessVersionInput, right: RefinementVisibleHarnessVersionInput): number {
  return compareText(left.scope, right.scope) || compareText(left.kind, right.kind) || compareText(left.name, right.name)
    || compareText(left.entryId, right.entryId) || compareText(left.versionId, right.versionId);
}
function compareMemoryInputs(left: RefinementMemoryInput, right: RefinementMemoryInput): number {
  return left.rank - right.rank || compareText(left.entryId, right.entryId) || compareText(left.versionId, right.versionId);
}
function compareEvaluationInputs(left: RefinementEvaluationHistoryInput, right: RefinementEvaluationHistoryInput): number {
  return compareText(left.createdAt, right.createdAt) || compareText(left.observationId, right.observationId);
}
function compareCursor(left: string, right: string): number {
  const a = BigInt(left), b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

/** Locale-independent canonical JSON for hashing and exact byte accounting. */
export function canonicalRefinementSnapshotJson(value: RefinementCanonicalJsonValue): string { return canonicalJson(value); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return `sha256:${hasher.digest("hex")}`;
}
function utf8Bytes(value: string): number { return UTF8.encode(value).byteLength; }
function truncateUtf8(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (utf8Bytes(value) <= maximum) return value;
  let low = 0, high = value.length;
  while (low < high) {
    let middle = Math.ceil((low + high) / 2);
    if (middle < value.length && middle > 0 && /[\uD800-\uDBFF]/.test(value[middle - 1]!) && /[\uDC00-\uDFFF]/.test(value[middle]!)) middle -= 1;
    if (utf8Bytes(value.slice(0, middle)) <= maximum) low = Math.max(low + 1, middle);
    else high = middle - 1;
  }
  let end = Math.min(low, value.length);
  if (end < value.length && end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!) && /[\uDC00-\uDFFF]/.test(value[end]!)) end -= 1;
  while (end > 0 && utf8Bytes(value.slice(0, end)) > maximum) end -= 1;
  return value.slice(0, end);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function ensureUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} contains duplicates`);
}
function sortedUnique(values: readonly string[]): string[] { return [...new Set(values)].sort(compareText); }
function boundedArray(value: readonly unknown[], maximum: number, label: string): void {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} exceeds ${maximum} items`);
}
function assertId(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > MAX_ID_BYTES || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) invalid(`${label} is not a bounded identifier`);
}
function assertCursor(value: string, label: string): void {
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 40) invalid(`${label} is not a bounded decimal cursor`);
}
function invalid(message: string): never { throw new RefinementContextError("invalid-input", message); }
