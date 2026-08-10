import {
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

  return selected.flatMap((event) => {
    if (ownedSuccessfulOutcomeIds.has(event.id)) return [];
    if (CELL_TERMINAL_TYPES.has(event.type)) {
      const cellId = (event.payload as { cellId: string }).cellId;
      return [{
        eventId: event.id,
        type: event.type,
        payload: cloneJson({
          ...(event.payload as unknown as Record<string, JsonValue>),
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
