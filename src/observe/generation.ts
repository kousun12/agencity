import { reduceAgentState, type AgentEvent } from "../domain/index.ts";
import { boundText, serializedUtf8Bytes } from "./bounds.ts";
import { observerRouteKey } from "./discovery.ts";
import {
  OBSERVER_BOUNDS,
  OBSERVER_PROTOCOL,
  type ObserverDurableActivityDto,
  type ObserverGenerationState,
  type ObserverProgressInput,
  type ObserverRoute,
  type ObserverRouteProjection,
  type ObserverStreamEnvelope,
  type ObserverStreamPayload,
} from "./types.ts";

export function createObserverGeneration(input: {
  readonly generation: string;
  readonly managedInstanceId: string;
  readonly routes: readonly ObserverRouteProjection[];
}): ObserverGenerationState {
  return {
    generation: input.generation,
    managedInstanceId: input.managedInstanceId,
    sequence: 0,
    routes: new Map(input.routes.map((route) => [observerRouteKey(route.route), route])),
    progress: new Map(),
    activity: [],
    activityBytes: 0,
    replay: [],
    replayBytes: 0,
    replayFloorSequence: 1,
  };
}

function decimalCursor(value: string): bigint | null {
  return /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function isNewerCursor(next: string, current: string): boolean {
  const nextDecimal = decimalCursor(next);
  const currentDecimal = decimalCursor(current);
  if (nextDecimal === null || currentDecimal === null) {
    throw new Error("Observer route cursors must be decimal strings");
  }
  return nextDecimal > currentDecimal;
}

function progressKey(route: ObserverRoute, effectId: string): string {
  return `${observerRouteKey(route)}\u0000${effectId}`;
}

function boundedActivity(
  current: readonly ObserverDurableActivityDto[],
  next: ObserverDurableActivityDto,
): { readonly items: readonly ObserverDurableActivityDto[]; readonly bytes: number } {
  const items = [...current, next];
  let bytes = items.reduce((total, value) => total + serializedUtf8Bytes(value), 0);
  while (items.length > OBSERVER_BOUNDS.activityItems || bytes > OBSERVER_BOUNDS.activityBytes) {
    const removed = items.shift();
    if (!removed) break;
    bytes -= serializedUtf8Bytes(removed);
  }
  return { items, bytes };
}

function appendEnvelope(
  state: ObserverGenerationState,
  payload: ObserverStreamPayload,
): ObserverGenerationState {
  const sequence = state.sequence + 1;
  let envelope: ObserverStreamEnvelope = {
    version: OBSERVER_PROTOCOL,
    generation: state.generation,
    sequence,
    managedInstanceId: state.managedInstanceId,
    payload,
  };
  if (serializedUtf8Bytes(envelope) > OBSERVER_BOUNDS.streamEnvelopeBytes) {
    envelope = {
      ...envelope,
      payload: { kind: "resync_required", reason: "replay_overflow" },
    };
  }
  const replay = [...state.replay, envelope];
  let replayBytes = replay.reduce((total, value) => total + serializedUtf8Bytes(value), 0);
  if (replay.length > OBSERVER_BOUNDS.replayEnvelopes ||
      replayBytes > OBSERVER_BOUNDS.replayBytes) {
    const resyncEnvelope: ObserverStreamEnvelope = {
      version: OBSERVER_PROTOCOL,
      generation: state.generation,
      sequence,
      managedInstanceId: state.managedInstanceId,
      payload: { kind: "resync_required", reason: "replay_overflow" },
    };
    return {
      ...state,
      sequence,
      progress: new Map(),
      replay: [resyncEnvelope],
      replayBytes: serializedUtf8Bytes(resyncEnvelope),
      replayFloorSequence: sequence,
    };
  }
  replayBytes = replay.reduce((total, value) => total + serializedUtf8Bytes(value), 0);
  return {
    ...state,
    sequence,
    replay,
    replayBytes,
    replayFloorSequence: replay[0]?.sequence ?? sequence + 1,
  };
}

function generationMatches(
  state: ObserverGenerationState,
  generation: string,
  managedInstanceId: string,
): boolean {
  return state.generation === generation && state.managedInstanceId === managedInstanceId;
}

export type ObserverGenerationMutation =
  | { readonly kind: "applied"; readonly state: ObserverGenerationState }
  | { readonly kind: "ignored_duplicate"; readonly state: ObserverGenerationState }
  | { readonly kind: "ignored_old_cursor"; readonly state: ObserverGenerationState }
  | { readonly kind: "stale_generation"; readonly state: ObserverGenerationState }
  | { readonly kind: "route_unavailable"; readonly state: ObserverGenerationState };

export function applyObserverCommittedEvent(
  state: ObserverGenerationState,
  input: {
    readonly generation: string;
    readonly managedInstanceId: string;
    readonly route: ObserverRoute;
    readonly event: AgentEvent;
  },
): ObserverGenerationMutation {
  if (!generationMatches(state, input.generation, input.managedInstanceId)) {
    return { kind: "stale_generation", state };
  }
  const key = observerRouteKey(input.route);
  const projected = state.routes.get(key);
  if (!projected ||
      input.event.sessionId !== input.route.sessionId ||
      input.event.branchId !== input.route.branchId &&
        input.event.type !== "AgentProfileVersionCreated" &&
        input.event.type !== "AgentProfileActivated") {
    return { kind: "route_unavailable", state };
  }
  if (projected.state.appliedEventIds.includes(input.event.id)) {
    return { kind: "ignored_duplicate", state };
  }
  if (!isNewerCursor(input.event.cursor, projected.cursor)) {
    return { kind: "ignored_old_cursor", state };
  }
  const reduced = reduceAgentState(projected.state, input.event);
  const routes = new Map(state.routes);
  routes.set(key, { route: input.route, state: reduced, cursor: input.event.cursor });
  const activity: ObserverDurableActivityDto = {
    route: input.route,
    eventId: input.event.id,
    cursor: input.event.cursor,
    type: input.event.type,
    producer: input.event.producer,
    committedAt: input.event.committedAt,
  };
  const bounded = boundedActivity(state.activity, activity);
  let next = appendEnvelope({
    ...state,
    routes,
    activity: bounded.items,
    activityBytes: bounded.bytes,
  }, { kind: "committed_event", activity });

  if (input.event.type === "EffectOutcomeRecorded") {
    const effectId = (input.event.payload as { readonly effectId: string }).effectId;
    const key = progressKey(input.route, effectId);
    if (next.progress.has(key)) {
      const progress = new Map(next.progress);
      progress.delete(key);
      next = appendEnvelope(
        { ...next, progress },
        { kind: "progress_cleared", route: input.route, effectId, reason: "committed" },
      );
    }
  }
  return { kind: "applied", state: next };
}

export function recordObserverProgress(
  state: ObserverGenerationState,
  input: {
    readonly generation: string;
    readonly managedInstanceId: string;
    readonly route: ObserverRoute;
    readonly progress: ObserverProgressInput;
  },
): ObserverGenerationMutation {
  if (!generationMatches(state, input.generation, input.managedInstanceId)) {
    return { kind: "stale_generation", state };
  }
  if (!state.routes.has(observerRouteKey(input.route))) {
    return { kind: "route_unavailable", state };
  }
  const stage = boundText(input.progress.stage, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes });
  const message = input.progress.message === undefined
    ? null
    : boundText(input.progress.message, { maximumBytes: OBSERVER_BOUNDS.textBytes, mode: "head_tail" });
  const progress = new Map(state.progress);
  progress.set(progressKey(input.route, input.progress.effectId), {
    route: input.route,
    effectId: input.progress.effectId,
    stage,
    message,
  });
  const next = appendEnvelope({ ...state, progress }, {
    kind: "progress",
    route: input.route,
    effectId: input.progress.effectId,
    stage,
    message,
  });
  return { kind: "applied", state: next };
}

export function discardObserverProgress(
  state: ObserverGenerationState,
  reason: "disconnect" | "generation_replaced" | "resync",
): ObserverGenerationState {
  let next = state;
  for (const retained of state.progress.values()) {
    next = appendEnvelope(next, {
      kind: "progress_cleared",
      route: retained.route,
      effectId: retained.effectId,
      reason,
    });
  }
  return { ...next, progress: new Map() };
}

export type ObserverReplayResult =
  | { readonly kind: "replay"; readonly envelopes: readonly ObserverStreamEnvelope[] }
  | { readonly kind: "resync_required"; readonly reason: "generation_mismatch" | "replay_unavailable" };

export function replayObserverEnvelopes(
  state: ObserverGenerationState,
  generation: string,
  afterSequence: number,
): ObserverReplayResult {
  if (generation !== state.generation) {
    return { kind: "resync_required", reason: "generation_mismatch" };
  }
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
      afterSequence > state.sequence ||
      afterSequence + 1 < state.replayFloorSequence) {
    return { kind: "resync_required", reason: "replay_unavailable" };
  }
  return {
    kind: "replay",
    envelopes: state.replay.filter((envelope) => envelope.sequence > afterSequence),
  };
}
