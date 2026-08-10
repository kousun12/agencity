import {
  BOUNDED_OUTPUT_PROTOCOL,
  OUTPUT_LIMITS,
  Utf8HeadTailCapture,
  ValidationError,
  type AgentEvent,
  type EffectOutcome,
  type EventPayloads,
  type JsonValue,
} from "../domain/index.ts";

export interface AgentProviderObservation {
  readonly eventId: string;
  readonly type: string;
  readonly payload: JsonValue;
}

interface EffectManifestItem {
  readonly effectId: string;
  readonly executor: string;
  readonly operation: string;
  readonly terminalStatus: EffectOutcome;
  readonly attemptCount: number;
}

const CELL_TERMINAL_TYPES = new Set(["CellCommitted", "CellFailed", "CellAbandoned"]);
const MAX_ACTIONABLE_ERROR_BYTES = 4_096;
const MAX_ACTIONABLE_OUTPUT_PREVIEW_BYTES = 4_096;
const MAX_RETAINED_IDENTITY_BYTES = 256;
const MAX_RETAINED_STATUS_BYTES = 128;

/**
 * Derives the provider-facing view of one exact canonical observation ledger.
 * Canonical events and the ledger remain unchanged; only successful payload
 * duplication owned by a selected terminal cell is removed.
 */
export function deriveAgentProviderObservations(
  events: readonly AgentEvent[],
  observationEventIds: readonly string[],
): AgentProviderObservation[] {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const eventIndex = new Map(events.map((event, index) => [event.id, index]));
  const selected = observationEventIds.map((eventId) => {
    const event = eventById.get(eventId);
    if (!event) throw new ValidationError(`Agent run observation event is missing: ${eventId}`);
    return event;
  });
  const selectedCellTerminals = new Map<string, AgentEvent>();
  for (const event of selected) {
    if (!CELL_TERMINAL_TYPES.has(event.type)) continue;
    selectedCellTerminals.set((event.payload as { cellId: string }).cellId, event);
  }

  type IndexedRequest = {
    readonly index: number;
    readonly payload: EventPayloads["EffectRequested"];
  };
  type IndexedOutcome = {
    readonly event: AgentEvent;
    readonly index: number;
    readonly payload: EventPayloads["EffectOutcomeRecorded"];
  };
  const requestByEffectId = new Map<string, IndexedRequest>();
  const requestsByCellId = new Map<string, IndexedRequest[]>();
  const outcomeByEffectId = new Map<string, IndexedOutcome>();
  const attemptCountByEffectId = new Map<string, number>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === "EffectRequested") {
      const payload = event.payload as EventPayloads["EffectRequested"];
      const request = { index, payload };
      requestByEffectId.set(payload.effectId, request);
      if (payload.origin.kind === "cell") {
        const cellRequests = requestsByCellId.get(payload.origin.cellId) ?? [];
        cellRequests.push(request);
        requestsByCellId.set(payload.origin.cellId, cellRequests);
      }
    } else if (event.type === "EffectOutcomeRecorded") {
      const payload = event.payload as EventPayloads["EffectOutcomeRecorded"];
      outcomeByEffectId.set(payload.effectId, { event, index, payload });
    } else if (event.type === "EffectAttemptStarted") {
      const payload = event.payload as EventPayloads["EffectAttemptStarted"];
      attemptCountByEffectId.set(
        payload.effectId,
        (attemptCountByEffectId.get(payload.effectId) ?? 0) + 1,
      );
    }
  }

  const ownedSuccessfulOutcomeIds = new Set<string>();
  const manifestByCellId = new Map<string, EffectManifestItem[]>();
  for (const [cellId, terminal] of selectedCellTerminals) {
    const terminalIndex = eventIndex.get(terminal.id)!;
    const manifest: EffectManifestItem[] = [];
    for (const request of requestsByCellId.get(cellId) ?? []) {
      if (request.index > terminalIndex) continue;
      const outcome = outcomeByEffectId.get(request.payload.effectId);
      if (!outcome || outcome.index > terminalIndex) continue;
      const attemptCount = Math.max(
        outcome.payload.attempt,
        attemptCountByEffectId.get(request.payload.effectId) ?? 0,
      );
      manifest.push({
        effectId: request.payload.effectId,
        executor: request.payload.executor,
        operation: request.payload.operation,
        terminalStatus: outcome.payload.outcome,
        attemptCount,
      });
      if (outcome.payload.outcome === "succeeded") {
        ownedSuccessfulOutcomeIds.add(outcome.event.id);
      }
    }
    manifestByCellId.set(cellId, manifest);
  }

  const derived = selected.flatMap((event) => {
    if (ownedSuccessfulOutcomeIds.has(event.id)) return [];
    if (CELL_TERMINAL_TYPES.has(event.type)) {
      const cellId = (event.payload as { cellId: string }).cellId;
      const {
        repositoryInstructions: _repositoryInstructions,
        repositoryInstructionOmission: _repositoryInstructionOmission,
        ...providerPayload
      } =
        event.payload as EventPayloads["CellCommitted"] & Record<string, JsonValue>;
      return [{
        eventId: event.id,
        type: event.type,
        payload: cloneJson({
          ...providerPayload,
          effectManifest: (manifestByCellId.get(cellId) ?? []) as unknown as JsonValue,
        }),
      }];
    }
    if (event.type === "EffectOutcomeRecorded") {
      const payload = event.payload as EventPayloads["EffectOutcomeRecorded"];
      const request = requestByEffectId.get(payload.effectId);
      const cellId = request?.payload.origin.kind === "cell"
        ? request.payload.origin.cellId
        : undefined;
      if (cellId && selectedCellTerminals.has(cellId) && payload.outcome !== "succeeded") {
        const outputPreview = payload.output === undefined
          ? undefined
          : boundedUtf8(
            JSON.stringify(payload.output),
            MAX_ACTIONABLE_OUTPUT_PREVIEW_BYTES,
          );
        return [{
          eventId: event.id,
          type: event.type,
          payload: cloneJson({
            effectId: payload.effectId,
            attempt: payload.attempt,
            outcome: payload.outcome,
            ...(payload.error === undefined ? {} : {
              error: boundedUtf8(payload.error, MAX_ACTIONABLE_ERROR_BYTES).value,
            }),
            ...(outputPreview === undefined ? {} : {
              outputPreview: outputPreview.value,
              outputPreviewTruncated: outputPreview.truncated,
            }),
            guidance: outcomeGuidance(payload.outcome),
          }),
        }];
      }
    }
    return [{
      eventId: event.id,
      type: event.type,
      payload: cloneJson(event.payload as unknown as JsonValue),
    }];
  });
  return enforceObservationBudget(derived);
}

function outcomeGuidance(outcome: Exclude<EffectOutcome, "succeeded">): string {
  if (outcome === "unknown") {
    return "Do not retry automatically. Inspect retained effect history and reconcile the external outcome.";
  }
  if (outcome === "cancelled") return "The effect was cancelled; decide whether a new explicit request is safe.";
  return "Inspect the bounded error and adjust the next action before retrying.";
}

function boundedUtf8(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };
  const suffix = "…";
  const suffixBytes = encoder.encode(suffix).byteLength;
  const byteLimit = Math.max(0, maxBytes - suffixBytes);
  let validEnd = byteLimit;
  while (validEnd > 0 && (encoded[validEnd]! & 0xc0) === 0x80) {
    validEnd--;
  }
  const prefix = new TextDecoder().decode(encoded.subarray(0, validEnd));
  return { value: prefix + suffix, truncated: true };
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function observationBytes(observation: AgentProviderObservation): number {
  return new TextEncoder().encode(JSON.stringify(observation)).byteLength;
}

function observationsBytes(observations: readonly AgentProviderObservation[]): number {
  return new TextEncoder().encode(JSON.stringify(observations)).byteLength;
}

function sha256Text(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function retainedString(value: string, maxBytes: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

function reducedIdentity(eventId: string): {
  readonly eventId: string;
  readonly metadata: Record<string, JsonValue>;
} {
  if (retainedString(eventId, MAX_RETAINED_IDENTITY_BYTES)) {
    return { eventId, metadata: {} };
  }
  const digest = sha256Text(eventId);
  return {
    eventId: `synthetic:observation:${digest}`,
    metadata: {
      sourceEventIdentity: {
        completeness: "digest",
        sha256: digest,
        exactIdentityInCanonicalLedger: true,
      },
    },
  };
}

function reducedType(type: string): {
  readonly type: string;
  readonly metadata: Record<string, JsonValue>;
} {
  if (retainedString(type, MAX_RETAINED_IDENTITY_BYTES)) return { type, metadata: {} };
  return {
    type: "AgentObservationReduced",
    metadata: {
      sourceType: {
        completeness: "digest",
        sha256: sha256Text(type),
      },
    },
  };
}

function requiredObservation(observation: AgentProviderObservation): boolean {
  if (CELL_TERMINAL_TYPES.has(observation.type)) return true;
  if (observation.type.endsWith("Failed") || observation.type.endsWith("Unknown") ||
      observation.type === "AgentRunActionRejected") return true;
  if (!observation.payload || typeof observation.payload !== "object" || Array.isArray(observation.payload)) return false;
  const payload = observation.payload as Record<string, JsonValue>;
  if (payload.outcome === "unknown") return true;
  return ["failed", "cancelled", "unknown", "blocked", "budget_exceeded", "succeeded", "completed"]
    .includes(String(payload.status ?? payload.outcome ?? ""));
}

function observationPriority(observation: AgentProviderObservation): number {
  if (requiredObservation(observation)) return 0;
  if (observation.payload && typeof observation.payload === "object" && !Array.isArray(observation.payload)) {
    const payload = observation.payload as Record<string, JsonValue>;
    if (payload.error !== undefined || payload.reason !== undefined) return 1;
  }
  return 3;
}

function terminalFact(observation: AgentProviderObservation): string {
  if (observation.payload && typeof observation.payload === "object" && !Array.isArray(observation.payload)) {
    const payload = observation.payload as Record<string, JsonValue>;
    const value = String(payload.status ?? payload.outcome ?? payload.terminalStatus ?? "");
    if (["unknown", "failed", "cancelled", "blocked", "budget_exceeded", "succeeded", "completed"]
      .includes(value)) {
      return value;
    }
  }
  if (observation.type.endsWith("Unknown")) return "unknown";
  if (observation.type.endsWith("Failed") || observation.type === "AgentRunActionRejected") return "failed";
  return "terminal";
}

function statusMetadata(payload: JsonValue): JsonValue {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const source = payload as Record<string, JsonValue>;
  const result: Record<string, JsonValue> = {};
  for (const key of ["effectId", "cellId", "taskId", "runId"]) {
    const value = source[key];
    if (typeof value !== "string") continue;
    if (retainedString(value, MAX_RETAINED_IDENTITY_BYTES)) {
      result[key] = value;
    } else {
      result[`${key}Digest`] = sha256Text(value);
      result[`${key}Exact`] = false;
    }
  }
  for (const key of ["status", "outcome", "terminalStatus"]) {
    const value = source[key];
    if (typeof value !== "string") continue;
    if (retainedString(value, MAX_RETAINED_STATUS_BYTES)) {
      result[key] = value;
    } else {
      result[key] = "terminal";
      result[`${key}Digest`] = sha256Text(value);
      result[`${key}Exact`] = false;
    }
  }
  if (typeof source.attempt === "number" && Number.isFinite(source.attempt)) {
    result.attempt = source.attempt;
  }
  if (typeof source.unknown === "boolean") result.unknown = source.unknown;
  for (const key of ["error", "reason"]) {
    const value = source[key];
    if (typeof value === "string") {
      result[key] = boundedUtf8(value, MAX_ACTIONABLE_ERROR_BYTES).value;
    }
  }
  return result;
}

function reducedObservation(
  observation: AgentProviderObservation,
  headBytes: number,
  tailBytes: number,
): AgentProviderObservation {
  const serialized = JSON.stringify(observation.payload);
  const capture = new Utf8HeadTailCapture(headBytes, tailBytes);
  capture.push(serialized);
  const preview = capture.value();
  const identity = reducedIdentity(observation.eventId);
  const sourceType = reducedType(observation.type);
  return {
    eventId: identity.eventId,
    type: sourceType.type,
    payload: {
      ...identity.metadata,
      ...sourceType.metadata,
      ...(statusMetadata(observation.payload) as Record<string, JsonValue>),
      output: {
        protocol: BOUNDED_OUTPUT_PROTOCOL,
        completeness: "truncated",
        byteLength: preview.byteLength,
        preview: { head: preview.head, tail: preview.tail },
        reason: "observation-budget",
        guidance: "The exact event remains in the AgentRunStepStarted observationEventIds ledger. Use a source-specific file page or artifact range only when this event contains that reference.",
      },
    },
  };
}

function fittedReducedObservation(
  observation: AgentProviderObservation,
  initialHeadBytes: number,
  initialTailBytes: number,
): AgentProviderObservation {
  let headBytes = initialHeadBytes;
  let tailBytes = initialTailBytes;
  let reduced = reducedObservation(observation, headBytes, tailBytes);
  while (observationBytes(reduced) > OUTPUT_LIMITS.agentObservationItemBytes &&
         (headBytes > 0 || tailBytes > 0)) {
    headBytes = Math.floor(headBytes / 2);
    tailBytes = Math.floor(tailBytes / 2);
    reduced = reducedObservation(observation, headBytes, tailBytes);
  }
  return reduced;
}

/** Final deterministic dependent-step guard; the canonical exact-once ledger is unchanged. */
export function enforceObservationBudget(
  observations: readonly AgentProviderObservation[],
): AgentProviderObservation[] {
  let bounded = observations.map((observation) =>
    observationBytes(observation) <= OUTPUT_LIMITS.agentObservationItemBytes
      ? observation
      : fittedReducedObservation(observation, 20 * 1024, 28 * 1024));
  if (observationsBytes(bounded) <= OUTPUT_LIMITS.agentObservationBytes) return bounded;

  const candidates = bounded
    .map((observation, index) => ({ observation, index, priority: observationPriority(observation) }))
    .sort((left, right) => right.priority - left.priority || right.index - left.index);
  for (const candidate of candidates) {
    bounded = bounded.map((observation, index) =>
      index === candidate.index ? fittedReducedObservation(observation, 512, 2_048) : observation);
    if (observationsBytes(bounded) <= OUTPUT_LIMITS.agentObservationBytes) return bounded;
  }

  const omitted: AgentProviderObservation[] = [];
  for (const candidate of candidates.filter(({ observation }) => !requiredObservation(observation))) {
    const index = bounded.findIndex((item) =>
      item.eventId === candidate.observation.eventId && item.type === candidate.observation.type);
    if (index < 0) continue;
    omitted.push(observations[candidate.index]!);
    bounded = bounded.filter((_, current) => current !== index);
    if (observationsBytes(bounded) <= OUTPUT_LIMITS.agentObservationBytes - 1_024) break;
  }
  if (omitted.length) {
    const hasher = new Bun.CryptoHasher("sha256");
    const eventIds = omitted.map((item) => item.eventId).sort();
    hasher.update(JSON.stringify(eventIds));
    const eventIdsDigest = hasher.digest("hex");
    bounded.push({
      eventId: `synthetic:observation-set:${eventIdsDigest}`,
      type: "AgentObservationBudgetApplied",
      payload: {
        protocol: BOUNDED_OUTPUT_PROTOCOL,
        completeness: "truncated",
        byteLength: observationsBytes(omitted),
        preview: {
          omittedCount: omitted.length,
          eventIdsDigest,
          exactEventIdentitiesInCanonicalLedger: true,
        },
        reason: "observation-budget",
        guidance: "The AgentRunStepStarted observationEventIds ledger remains complete. Use source-specific bounded retrieval only for retained file or artifact references.",
      },
    });
  }
  if (observationsBytes(bounded) <= OUTPUT_LIMITS.agentObservationBytes) return bounded;

  // Required terminal and uncertainty facts are never dropped. Remove previews
  // before status metadata if an unusually large terminal-only ledger remains.
  bounded = bounded.map((observation) => requiredObservation(observation)
    ? fittedReducedObservation(observation, 0, 0)
    : observation);
  if (observationsBytes(bounded) <= OUTPUT_LIMITS.agentObservationBytes) return bounded;

  const required = observations.filter(requiredObservation);
  const statuses = new Map<string, number>();
  const terminalFacts = new Map<string, number>();
  for (const observation of required) {
    const metadata = statusMetadata(observation.payload) as Record<string, JsonValue>;
    const type = retainedString(observation.type, MAX_RETAINED_STATUS_BYTES)
      ? observation.type
      : `type-sha256:${sha256Text(observation.type)}`;
    const status = String(metadata.status ?? metadata.outcome ?? metadata.terminalStatus ?? "terminal");
    const key = `${type}:${retainedString(status, MAX_RETAINED_STATUS_BYTES) ? status : "terminal"}`;
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
    const fact = terminalFact(observation);
    terminalFacts.set(fact, (terminalFacts.get(fact) ?? 0) + 1);
  }
  const eventIds = required.map((item) => item.eventId).sort();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(eventIds));
  const terminalEventIdsDigest = hasher.digest("hex");
  const summary: AgentProviderObservation[] = [{
    eventId: `synthetic:terminal-observation-set:${terminalEventIdsDigest}`,
    type: "AgentObservationBudgetApplied",
    payload: {
      terminalStatusSummary: [...statuses].sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => ({ status, count })),
      terminalFactCounts: [...terminalFacts].sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => ({ status, count })),
      terminalEventCount: required.length,
      terminalEventIdsDigest,
      output: {
        protocol: BOUNDED_OUTPUT_PROTOCOL,
        completeness: "truncated",
        byteLength: observationsBytes(observations),
        preview: { exactEventIdentitiesInCanonicalLedger: true },
        reason: "observation-budget",
        guidance: "Terminal and uncertainty status counts are preserved. Inspect the complete AgentRunStepStarted observationEventIds ledger for exact retained event identities and evidence.",
      },
    },
  }];
  if (observationBytes(summary[0]!) <= OUTPUT_LIMITS.agentObservationItemBytes &&
      observationsBytes(summary) <= OUTPUT_LIMITS.agentObservationBytes) {
    return summary;
  }
  // This constant-size last resort preserves the terminal/unknown count and
  // exact-ledger digest without copying any adversarial source string.
  return [{
    eventId: `synthetic:terminal-observation-set:${terminalEventIdsDigest}`,
    type: "AgentObservationBudgetApplied",
    payload: {
      terminalEventCount: required.length,
      terminalEventIdsDigest,
      terminalFactCounts: [...terminalFacts].sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => ({ status, count })),
    },
  }];
}
