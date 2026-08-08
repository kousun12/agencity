import {
  CapabilityUnavailableError,
  NotFoundError,
  ValidationError,
  newId,
  projectEvents,
  type AgentEvent,
  type AgentState,
  type ContextCapacityProvenance,
  type ContextCompactionDerivation,
  type ContextCompactionReason,
  type ContextCompactionRequester,
  type ContextCompactionState,
  type ContextCompactionStrategy,
  type EventPayloads,
  type FrozenContextCompactionSource,
  type JsonValue,
  type ModelDispatch,
  type ModelEffectOutputV2,
  type Usage,
  validateModelEffectOutputV2,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { ModelExecutor } from "../executors/index.ts";
import { containsBrokeredSecret } from "../security/index.ts";
import { stableEffectId, type OutboxRunner } from "./outbox.ts";
import { ModelEffectAdmissionService } from "./model-effect-admission.ts";
import {
  assertCompactionProgress,
  buildDeterministicExtractiveSummary,
  composeRollingLeafProvenance,
  estimateContextWindow,
  planCompactionSources,
  validateCompactionInstructions,
  validateRematerializedSources,
  createExactSourceManifest,
  type FrozenCompactionSourceRecord,
} from "./compaction-core.ts";

export const MODEL_SUMMARY_STRATEGY = "model-summary-v1" as const;
export const DEFAULT_COMPACTION_RECENT_MESSAGES = 20;
export const AUTOMATIC_COMPACTION_RECENT_MESSAGES = 8;
const MODEL_SUMMARY_CHUNK_BYTES = 48 * 1024;
const MAX_MODEL_SUMMARY_BYTES = 64 * 1024;

export interface CompactContextInput {
  readonly strategy?: ContextCompactionStrategy;
  readonly instructions?: string;
  readonly reason?: ContextCompactionReason;
  readonly requestedBy?: ContextCompactionRequester;
  readonly idempotencyKey?: string;
  readonly retainRecentMessages?: number;
  readonly capacity?: ContextCapacityProvenance;
  /** Re-run a strategy over the exact frozen source set of this context. */
  readonly rematerializeFromContextId?: string;
}

export interface ContextCompactionView {
  readonly compactionId: string;
  readonly status: ContextCompactionState["status"];
  readonly strategy: ContextCompactionStrategy;
  readonly reason: ContextCompactionReason;
  readonly requestedBy: ContextCompactionRequester;
  readonly sourceEventIds: readonly string[];
  readonly sourceDigest: string;
  readonly throughCursor: string;
  readonly contextId?: string;
  readonly summary?: string;
  readonly effectIds: readonly string[];
  readonly usage?: Usage;
  readonly capacity?: ContextCapacityProvenance;
  readonly error?: string;
}

export interface ContextInspection {
  readonly sessionId: string;
  readonly branchId: string;
  readonly canonicalCursor: string;
  readonly canonicalEventCount: number;
  readonly messageCount: number;
  readonly uncoveredMessageCount: number;
  readonly estimatedUncompactedNarrativeTokens: number;
  readonly capacity: ContextCapacityProvenance;
  readonly effective: ContextCompactionView | null;
  readonly compactions: readonly ContextCompactionView[];
}

interface ExecuteRequest {
  readonly request: ContextCompactionState;
  readonly requestEvent: AgentEvent<"ContextCompactionRequested">;
  readonly state: AgentState;
  readonly events: readonly AgentEvent[];
}

/**
 * Durable derived-view compaction. Requests freeze exact canonical source
 * envelopes before any model effect is admitted. Success is an immutable
 * ContextMaterialized derivation; failure/unknown is canonical and recoverable.
 */
export class CompactionService {
  constructor(
    readonly storage: AgentStorage,
    readonly outbox: OutboxRunner,
    readonly capacities?: ModelExecutor,
  ) {}

  async inspect(sessionId: string, branchId: string): Promise<ContextInspection> {
    const events = await this.#events(sessionId, branchId);
    const state = projectEvents(events);
    const effective = effectiveCompaction(state, events);
    const covered = new Set(effective?.sourceEventIds ?? []);
    const messages = events.filter((event) => event.type === "MessageAppended");
    const uncovered = messages.filter((event) => !covered.has(event.id));
    const narrative = uncovered.map((event) => String((event.payload as EventPayloads["MessageAppended"]).content)).join("\n");
    const compactions = Object.values(state.compactions).map((item) => viewOf(item, state)).sort((left, right) => left.compactionId.localeCompare(right.compactionId));
    const resolved = this.capacities?.contextCapacity(state.model) ?? { provider: state.model.provider, model: state.model.model, source: "unknown" as const, contextWindowTokens: null };
    const outputReserveTokens = resolved.contextWindowTokens === null ? Math.max(0, state.model.maxOutputTokens ?? 0)
      : Math.min(resolved.contextWindowTokens - 1, Math.max(1, state.model.maxOutputTokens ?? Math.min(4_096, Math.floor(resolved.contextWindowTokens * 0.1))));
    const capacity: ContextCapacityProvenance = { ...resolved, outputReserveTokens, estimatorId: "utf8-bytes-per-token-v1", triggerRatio: 0.8, targetRatio: 0.6 };
    return Object.freeze({
      sessionId, branchId, canonicalCursor: state.cursor, canonicalEventCount: events.length,
      messageCount: messages.length, uncoveredMessageCount: uncovered.length,
      estimatedUncompactedNarrativeTokens: estimateContextWindow(narrative).estimatedTokens,
      capacity,
      effective: effective ? viewOf(effective, state) : null,
      compactions: Object.freeze(compactions),
    });
  }

  async compact(sessionId: string, branchId: string, input: CompactContextInput = {}): Promise<ContextCompactionView> {
    const strategy = input.strategy ?? "deterministic-extractive-v1";
    if (strategy !== "deterministic-extractive-v1" && strategy !== MODEL_SUMMARY_STRATEGY) throw new ValidationError("Unsupported context compaction strategy");
    const reason = input.reason ?? (input.requestedBy === "agent" ? "agent-request" : "user-request");
    const requestedBy = input.requestedBy ?? "user";
    const validatedInstructions = validateCompactionInstructions(input.instructions, { knownSecrets: brokeredSecrets() });
    if (containsBrokeredSecret(validatedInstructions?.text ?? "")) throw new ValidationError("Brokered credentials cannot enter compaction instructions");
    const retainRecentMessages = input.retainRecentMessages ?? DEFAULT_COMPACTION_RECENT_MESSAGES;
    if (!Number.isSafeInteger(retainRecentMessages) || retainRecentMessages < 1 || retainRecentMessages > 1_000) throw new ValidationError("retainRecentMessages must be an integer from 1 to 1000");

    let events = await this.#events(sessionId, branchId);
    let state = projectEvents(events);
    const stableIntent = input.idempotencyKey ?? newId();
    const compactionId = stableCompactionId(sessionId, branchId, stableIntent);
    const existing = state.compactions[compactionId];
    if (existing) {
      const expected = { strategy, reason, requestedBy, instructions: validatedInstructions?.text, capacity: input.capacity, rematerializedFromContextId: input.rematerializeFromContextId };
      const actual = { strategy: existing.strategy, reason: existing.reason, requestedBy: existing.requestedBy, instructions: existing.instructions, capacity: existing.capacity, rematerializedFromContextId: existing.rematerializedFromContextId };
      if (!Bun.deepEquals(expected, actual)) throw new ValidationError("Compaction idempotency key was reused with different durable meaning");
      if (existing.status === "requested") return this.#execute({ request: existing, requestEvent: requestEventFor(events, existing), state, events });
      return viewOf(existing, state);
    }

    const effective = effectiveCompaction(state, events);
    let selected: readonly FrozenCompactionSourceRecord[];
    let throughCursor = canonicalCursor(state.cursor);
    let rematerializedFromContextId: string | undefined;
    if (input.rematerializeFromContextId) {
      const sourceContext = state.contexts[input.rematerializeFromContextId];
      if (!sourceContext?.derivation) throw new NotFoundError("compaction context", input.rematerializeFromContextId);
      const sourceRequest = state.compactions[sourceContext.derivation.compactionId];
      if (!sourceRequest) throw new ValidationError("Compaction source request is unavailable");
      const manifest = createExactSourceManifest(sourceRequest.frozenSources.map((source) => toCoreSource(source, sessionId, branchId)), {
        sessionId, branchId, throughCursor: sourceRequest.throughCursor, allowLineageBranches: true,
      });
      selected = validateRematerializedSources(manifest, events.map(toCoreInput));
      throughCursor = sourceRequest.throughCursor;
      rematerializedFromContextId = input.rematerializeFromContextId;
    } else {
      const messages = events.filter((event) => event.type === "MessageAppended");
      const prefix = messages.slice(0, Math.max(0, messages.length - retainRecentMessages));
      const plan = planCompactionSources(prefix.map(toCoreInput), { sessionId, branchId, throughCursor, allowLineageBranches: true });
      selected = plan.compactable;
    }
    const exact = createExactSourceManifest(selected, { sessionId, branchId, throughCursor, allowLineageBranches: true });
    const frozenSources = selected.map(toDomainSource);
    const modelDispatch = strategy === MODEL_SUMMARY_STRATEGY
      ? this.capacities === undefined
        ? undefined
        : new ModelEffectAdmissionService(this.capacities).requestText(state.model).modelDispatch
      : undefined;
    if (strategy === MODEL_SUMMARY_STRATEGY && modelDispatch === undefined) {
      throw new CapabilityUnavailableError("model-summary compaction dispatch", "model executor is unavailable");
    }
    const requestEvents = await this.storage.appendEvents([{
      sessionId, branchId, type: "ContextCompactionRequested", producer: requestedBy === "user" ? "client" : "supervisor",
      idempotencyKey: `context-compaction-request:${compactionId}`,
      payload: {
        compactionId, strategy, reason, requestedBy,
        ...(validatedInstructions === null ? {} : { instructions: validatedInstructions.text }),
        throughCursor, sourceEventIds: [...exact.sourceEventIds], sourceDigest: exact.sourceDigest,
        frozenSources,
        ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
        ...(effective?.contextId === undefined ? {} : { ancestorContextId: effective.contextId }),
        ...(rematerializedFromContextId === undefined ? {} : { rematerializedFromContextId }),
        ...(modelDispatch === undefined ? {} : { modelDispatch }),
      },
    }]);
    const requestEvent = requestEvents[0] as AgentEvent<"ContextCompactionRequested"> | undefined;
    if (!requestEvent) throw new Error("Context compaction request was not committed");
    events = await this.#events(sessionId, branchId);
    state = projectEvents(events);
    return this.#execute({ request: state.compactions[compactionId]!, requestEvent, state, events });
  }

  /** Finalizes requests interrupted at any durable outbox boundary. */
  async recoverIncomplete(): Promise<number> {
    let recovered = 0;
    for (const branch of await this.storage.listBranches()) {
      const events = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      if (!events.length) continue;
      const state = projectEvents(events);
      for (const request of Object.values(state.compactions)) {
        if (request.status !== "requested") continue;
        await this.#execute({ request, requestEvent: requestEventFor(events, request), state, events });
        recovered++;
      }
    }
    return recovered;
  }

  async #execute(input: ExecuteRequest): Promise<ContextCompactionView> {
    const { request, requestEvent } = input;
    if (request.sourceEventIds.length === 0) {
      return this.#fail(requestEvent, "protected-only", "Compaction has no eligible narrative records; protected live state is retained exactly");
    }
    const sourceRecords = request.frozenSources.map((source) => toCoreSource(source, requestEvent.sessionId, requestEvent.branchId));
    let summary: string;
    let usage: Usage | undefined;
    let effectIds: string[] = [];
    if (request.strategy === "deterministic-extractive-v1") {
      const inputBytes = sourceRecords.reduce((sum, source) => sum + source.payloadUtf8Bytes, 0);
      const maximum = Math.min(64 * 1024, 2 * 1024, Math.max(64, Math.floor(inputBytes * 0.6)));
      const extractive = buildDeterministicExtractiveSummary(sourceRecords, { maxUtf8Bytes: maximum });
      summary = extractive.includedEventIds.length === 0 ? conciseExtractive(sourceRecords, Math.min(2 * 1024, Math.max(64, inputBytes - 1))) : extractive.text;
    } else {
      const modelResult = await this.#modelSummary(requestEvent, input.state, input.events, sourceRecords);
      if (modelResult.outcome !== "succeeded") return modelResult.view;
      summary = modelResult.summary;
      usage = modelResult.usage;
      effectIds = modelResult.effectIds;
    }
    const sourceTokens = estimateContextWindow(sourceRecords.map((source) => source.payload) as JsonValue).estimatedTokens;
    const replacementTokens = estimateContextWindow(summary).estimatedTokens;
    try {
      assertCompactionProgress({ compactableSourceCount: sourceRecords.length, protectedSourceCount: 0, compactableInputTokens: sourceTokens, replacementTokens });
    } catch (error) {
      return this.#fail(requestEvent, "no-progress", error instanceof Error ? error.message : String(error), effectIds.at(-1));
    }

    const provenanceBase = composeRollingLeafProvenance(sourceRecords);
    const ancestor = request.ancestorContextId ? input.state.contexts[request.ancestorContextId]?.derivation : undefined;
    const generation = Math.max(provenanceBase.generation, (ancestor?.generation ?? 0) + 1);
    const contextId = `context-compaction-${request.id}`;
    const derivation: ContextCompactionDerivation = {
      kind: "compaction", compactionId: request.id, requestEventId: request.requestEventId,
      strategy: request.strategy, reason: request.reason, requestedBy: request.requestedBy,
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      throughCursor: request.throughCursor, sourceEventIds: [...request.sourceEventIds], sourceDigest: request.sourceDigest,
      leafEventIds: [...provenanceBase.leafEventIds], leafDigest: provenanceBase.leafDigest, generation,
      summary, ...(effectIds.length ? { effectIds } : {}), ...(usage === undefined ? {} : { usage }),
      ...(request.capacity === undefined ? {} : { capacity: request.capacity }),
      ...(request.rematerializedFromContextId === undefined ? {} : { rematerializedFromContextId: request.rematerializedFromContextId }),
    };
    const context = validatedJson({ kind: "compaction", strategy: request.strategy, summary, sourceEventIds: [...request.sourceEventIds], sourceCount: request.sourceEventIds.length });
    const recordEvents = new Map(input.events.map((event) => [event.id, event]));
    const records = request.sourceEventIds.map((eventId) => {
      const event = recordEvents.get(eventId);
      if (!event) throw new ValidationError(`Frozen compaction source event is unavailable: ${eventId}`);
      return { eventId, type: event.type, schemaVersion: event.schemaVersion, reason: `covered narrative leaf for ${request.strategy}` };
    });
    await this.storage.appendEvents([{
      sessionId: requestEvent.sessionId, branchId: requestEvent.branchId, type: "ContextMaterialized", producer: "supervisor",
      idempotencyKey: `context-compaction-complete:${request.id}`,
      payload: { contextId, records, contentHash: sha256(JSON.stringify(context)), context, derivation },
    }]);
    const state = projectEvents(await this.#events(requestEvent.sessionId, requestEvent.branchId));
    return viewOf(state.compactions[request.id]!, state);
  }

  async #modelSummary(
    requestEvent: AgentEvent<"ContextCompactionRequested">,
    initialState: AgentState,
    initialEvents: readonly AgentEvent[],
    sources: readonly FrozenCompactionSourceRecord[],
  ): Promise<
    | { readonly outcome: "succeeded"; readonly summary: string; readonly usage: Usage; readonly effectIds: string[] }
    | { readonly outcome: "terminal"; readonly view: ContextCompactionView }
  > {
    const request = requestEvent.payload;
    const ancestor = request.ancestorContextId ? initialState.contexts[request.ancestorContextId]?.derivation?.summary : undefined;
    let nodes = partitionSources(sources).map((chunk, index) => ({
      label: `source chunk ${index + 1}`,
      text: buildDeterministicExtractiveSummary(chunk, { maxUtf8Bytes: MODEL_SUMMARY_CHUNK_BYTES }).text,
    }));
    if (ancestor) nodes.unshift({ label: "prior effective hierarchical summary", text: ancestor });
    const effectIds: string[] = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let level = 0;
    while (nodes.length > 1 || level === 0) {
      const groups = partitionTextNodes(nodes);
      const next: Array<{ label: string; text: string }> = [];
      for (let index = 0; index < groups.length; index++) {
        const current = projectEvents(await this.#events(requestEvent.sessionId, requestEvent.branchId));
        if (current.budget.exceeded || budgetBoundaryReached(current)) {
          return { outcome: "terminal", view: await this.#fail(requestEvent, "failed", "Session budget is exhausted before model-summary compaction") };
        }
        const key = `context-compaction-model:${request.compactionId}:level:${level}:chunk:${index}`;
        const effectId = stableEffectId(requestEvent.sessionId, key);
        const prompt = summaryPrompt(request, level, index, groups[index]!);
        if (!current.effects[effectId]) {
          if (!request.modelDispatch) throw new ValidationError("Model-summary compaction is missing its pinned model dispatch");
          const requested = await this.outbox.request({
            sessionId: requestEvent.sessionId, branchId: requestEvent.branchId, executor: "model", operation: "complete",
            input: { compactionId: request.compactionId, context: prompt, modelDispatch: request.modelDispatch as unknown as JsonValue },
            idempotencyKey: key, idempotent: false,
          });
          if (requested !== effectId) throw new ValidationError("Compaction model effect identity is not stable");
        }
        const execution = await this.outbox.run(effectId);
        effectIds.push(effectId);
        if (execution.outcome !== "succeeded") {
          const terminal = execution.outcome === "unknown" ? "unknown" : "failed";
          return { outcome: "terminal", view: await this.#fail(requestEvent, terminal, execution.error ?? `Compaction model effect ${execution.outcome}`, effectId) };
        }
        let output: ModelEffectOutputV2;
        try { output = parseModelOutput(execution.output, request.modelDispatch!); }
        catch (error) { return { outcome: "terminal", view: await this.#fail(requestEvent, "failed", error instanceof Error ? error.message : String(error), effectId) }; }
        if (output.result.kind !== "text" || output.response.kind !== "complete") {
          return { outcome: "terminal", view: await this.#fail(requestEvent, "failed", "Compaction text contract returned a non-text result", effectId) };
        }
        const text = boundedUtf8(output.result.text.trim(), MAX_MODEL_SUMMARY_BYTES);
        if (!text) return { outcome: "terminal", view: await this.#fail(requestEvent, "failed", "Compaction model returned an empty summary", effectId) };
        const elapsed = effectElapsedMs(await this.#events(requestEvent.sessionId, requestEvent.branchId), effectId);
        const callId = `context-compaction:${request.compactionId}:${level}:${index}`;
        const tokens = output.response.usage.inputTokens + output.response.usage.outputTokens;
        const budgetEvents: any[] = [{
          sessionId: requestEvent.sessionId, branchId: requestEvent.branchId, type: "BudgetDebited", producer: "supervisor",
          idempotencyKey: `context-compaction-budget:${request.compactionId}:${level}:${index}`,
          payload: { callId, tokens, costUsd: output.response.usage.costUsd, turns: 1, wallTimeMs: elapsed, usageSource: "provider-reported" },
        }];
        const exceeded = budgetExceeded(current, { tokens, costUsd: output.response.usage.costUsd, turns: 1, wallTimeMs: elapsed });
        if (exceeded) budgetEvents.push({
          sessionId: requestEvent.sessionId, branchId: requestEvent.branchId, type: "BudgetExceeded", producer: "supervisor",
          idempotencyKey: `context-compaction-budget-exceeded:${request.compactionId}:${level}:${index}`, payload: exceeded,
        });
        await this.storage.appendEvents(budgetEvents);
        usage = { inputTokens: usage.inputTokens + output.response.usage.inputTokens, outputTokens: usage.outputTokens + output.response.usage.outputTokens, costUsd: usage.costUsd + output.response.usage.costUsd };
        next.push({ label: `hierarchical level ${level + 1} chunk ${index + 1}`, text });
      }
      nodes = next;
      level++;
      if (nodes.length === 1) break;
      if (level > 16) return { outcome: "terminal", view: await this.#fail(requestEvent, "failed", "Model-summary hierarchy exceeded its deterministic level bound", effectIds.at(-1)) };
    }
    return { outcome: "succeeded", summary: nodes[0]!.text, usage, effectIds };
  }

  async #fail(
    requestEvent: AgentEvent<"ContextCompactionRequested">,
    outcome: EventPayloads["ContextCompactionFailed"]["outcome"],
    error: string,
    effectId?: string,
  ): Promise<ContextCompactionView> {
    await this.storage.appendEvents([{
      sessionId: requestEvent.sessionId, branchId: requestEvent.branchId, type: "ContextCompactionFailed", producer: outcome === "unknown" ? "recovery" : "supervisor",
      idempotencyKey: `context-compaction-failed:${requestEvent.payload.compactionId}`,
      payload: { compactionId: requestEvent.payload.compactionId, requestEventId: requestEvent.id, strategy: requestEvent.payload.strategy, outcome, error: boundedUtf8(error, 64 * 1024), ...(effectId === undefined ? {} : { effectId }) },
    }]);
    const state = projectEvents(await this.#events(requestEvent.sessionId, requestEvent.branchId));
    return viewOf(state.compactions[requestEvent.payload.compactionId]!, state);
  }

  async #events(sessionId: string, branchId: string): Promise<AgentEvent[]> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    return events;
  }
}

/** Latest successful derivation which covers an exact canonical narrative prefix. */
export function effectiveCompaction(state: AgentState, events: readonly AgentEvent[]): ContextCompactionState | null {
  const messageIds = events.filter((event) => event.type === "MessageAppended").map((event) => event.id);
  const eventCursor = new Map(events.map((event) => [event.id, event.cursor]));
  const candidates = Object.values(state.compactions).filter((request) => {
    if (request.status !== "completed" || !request.contextId) return false;
    return request.sourceEventIds.every((eventId, index) => messageIds[index] === eventId);
  });
  candidates.sort((left, right) => {
    const leftCursor = BigInt(eventCursor.get(left.eventId) ?? "0");
    const rightCursor = BigInt(eventCursor.get(right.eventId) ?? "0");
    return leftCursor < rightCursor ? -1 : leftCursor > rightCursor ? 1 : left.id.localeCompare(right.id);
  });
  return candidates.at(-1) ?? null;
}

function requestEventFor(events: readonly AgentEvent[], request: ContextCompactionState): AgentEvent<"ContextCompactionRequested"> {
  const event = events.find((candidate) => candidate.id === request.requestEventId && candidate.type === "ContextCompactionRequested");
  if (!event) throw new ValidationError(`Compaction request event is unavailable: ${request.requestEventId}`);
  return event as AgentEvent<"ContextCompactionRequested">;
}

function viewOf(request: ContextCompactionState, state: AgentState): ContextCompactionView {
  const derivation = request.contextId ? state.contexts[request.contextId]?.derivation : undefined;
  return Object.freeze({
    compactionId: request.id, status: request.status, strategy: request.strategy, reason: request.reason,
    requestedBy: request.requestedBy, sourceEventIds: Object.freeze([...request.sourceEventIds]),
    sourceDigest: request.sourceDigest, throughCursor: request.throughCursor,
    ...(request.contextId === undefined ? {} : { contextId: request.contextId }),
    ...(derivation?.summary === undefined ? {} : { summary: derivation.summary }),
    effectIds: Object.freeze([...(derivation?.effectIds ?? request.effectIds ?? [])]),
    ...(derivation?.usage === undefined ? {} : { usage: derivation.usage }),
    ...(request.capacity === undefined ? {} : { capacity: request.capacity }),
    ...(request.error === undefined ? {} : { error: request.error }),
  });
}

function toCoreInput(event: AgentEvent) {
  return { id: event.id, sessionId: event.sessionId, branchId: event.branchId, cursor: canonicalCursor(event.cursor), type: event.type, schemaVersion: event.schemaVersion, payload: event.payload };
}
function toDomainSource(source: FrozenCompactionSourceRecord): FrozenContextCompactionSource {
  if (source.disposition !== "compactable") throw new ValidationError("Protected state cannot enter a compaction source manifest");
  return { eventId: source.eventId, sessionId: source.sessionId, branchId: source.branchId, cursor: source.cursor, type: source.type as FrozenContextCompactionSource["type"], schemaVersion: source.schemaVersion, payload: source.payload as JsonValue, disposition: "compactable", classificationReason: source.classificationReason, payloadUtf8Bytes: source.payloadUtf8Bytes };
}
function toCoreSource(source: FrozenContextCompactionSource, _sessionId: string, _branchId: string): FrozenCompactionSourceRecord {
  return Object.freeze({ eventId: source.eventId, sessionId: source.sessionId, branchId: source.branchId, cursor: canonicalCursor(source.cursor), type: source.type, schemaVersion: source.schemaVersion, payload: source.payload, disposition: source.disposition, classificationReason: source.classificationReason, payloadUtf8Bytes: source.payloadUtf8Bytes });
}

function conciseExtractive(sources: readonly FrozenCompactionSourceRecord[], maximumBytes: number): string {
  const prefix = "[compaction strategy:deterministic-extractive-v1]";
  const lines = [prefix];
  for (const source of sources) {
    const payload = source.payload as { role?: unknown; content?: unknown };
    if (typeof payload.role !== "string" || typeof payload.content !== "string") continue;
    const line = `[${payload.role}] ${payload.content}`;
    const candidate = [...lines, line].join("\n");
    if (new TextEncoder().encode(candidate).byteLength > maximumBytes) {
      const marker = `[TRUNCATED summary omitted_events=${sources.length - lines.length + 1}]`;
      if (new TextEncoder().encode([...lines, marker].join("\n")).byteLength <= maximumBytes) lines.push(marker);
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function partitionSources(sources: readonly FrozenCompactionSourceRecord[]): FrozenCompactionSourceRecord[][] {
  const chunks: FrozenCompactionSourceRecord[][] = [];
  let current: FrozenCompactionSourceRecord[] = [];
  let bytes = 0;
  for (const source of sources) {
    if (current.length && bytes + source.payloadUtf8Bytes > MODEL_SUMMARY_CHUNK_BYTES) { chunks.push(current); current = []; bytes = 0; }
    current.push(source); bytes += source.payloadUtf8Bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
function partitionTextNodes(nodes: readonly { label: string; text: string }[]): Array<Array<{ label: string; text: string }>> {
  const groups: Array<Array<{ label: string; text: string }>> = [];
  let current: Array<{ label: string; text: string }> = [];
  let bytes = 0;
  for (const node of nodes) {
    const size = new TextEncoder().encode(node.text).byteLength;
    if (current.length && bytes + size > MODEL_SUMMARY_CHUNK_BYTES) { groups.push(current); current = []; bytes = 0; }
    current.push(node); bytes += size;
  }
  if (current.length) groups.push(current);
  return groups;
}
function summaryPrompt(
  request: EventPayloads["ContextCompactionRequested"],
  level: number,
  chunk: number,
  nodes: readonly { label: string; text: string }[],
): JsonValue {
  const instructions = request.instructions ? `\nPreservation guidance: ${request.instructions}` : "";
  return validatedJson({
    messages: [
      { role: "system", content: `Produce a faithful concise context summary. Preserve decisions, unresolved questions, constraints, names, paths, and evidence. Do not invent facts. Return summary text only.${instructions}` },
      { role: "user", content: JSON.stringify({ compactionId: request.compactionId, strategy: MODEL_SUMMARY_STRATEGY, level, chunk, sources: nodes }) },
    ],
  });
}
function parseModelOutput(value: JsonValue | undefined, dispatch: ModelDispatch): ModelEffectOutputV2 {
  return validateModelEffectOutputV2(value, {
    responseContract: dispatch.responseContract,
    responseCapability: dispatch.responseCapability,
    configuredProvider: dispatch.configuration.provider,
  });
}
function budgetExceeded(state: AgentState, delta: { tokens: number; costUsd: number; turns: number; wallTimeMs: number }): EventPayloads["BudgetExceeded"] | null {
  const limits = state.budget.limits;
  const spent = { tokens: state.budget.tokens + delta.tokens, costUsd: state.budget.costUsd + delta.costUsd, turns: state.budget.turns + delta.turns, wallTimeMs: state.budget.wallTimeMs + delta.wallTimeMs };
  if (limits.tokenLimit !== undefined && spent.tokens >= limits.tokenLimit) return { dimension: "tokens", limit: limits.tokenLimit, spent: spent.tokens };
  if (limits.costLimitUsd !== undefined && spent.costUsd >= limits.costLimitUsd) return { dimension: "cost", limit: limits.costLimitUsd, spent: spent.costUsd };
  if (limits.turnLimit !== undefined && spent.turns >= limits.turnLimit) return { dimension: "turns", limit: limits.turnLimit, spent: spent.turns };
  if (limits.wallTimeLimitMs !== undefined && spent.wallTimeMs >= limits.wallTimeLimitMs) return { dimension: "wallTime", limit: limits.wallTimeLimitMs, spent: spent.wallTimeMs };
  return null;
}
function budgetBoundaryReached(state: AgentState): boolean {
  const limits = state.budget.limits;
  return limits.tokenLimit !== undefined && state.budget.tokens >= limits.tokenLimit
    || limits.costLimitUsd !== undefined && state.budget.costUsd >= limits.costLimitUsd
    || limits.turnLimit !== undefined && state.budget.turns >= limits.turnLimit
    || limits.wallTimeLimitMs !== undefined && state.budget.wallTimeMs >= limits.wallTimeLimitMs;
}
function effectElapsedMs(events: readonly AgentEvent[], effectId: string): number {
  const started = events.find((event) => event.type === "EffectAttemptStarted" && (event.payload as EventPayloads["EffectAttemptStarted"]).effectId === effectId);
  const ended = [...events].reverse().find((event) => event.type === "EffectOutcomeRecorded" && (event.payload as EventPayloads["EffectOutcomeRecorded"]).effectId === effectId);
  if (!started || !ended) return 0;
  const elapsed = Date.parse(ended.committedAt) - Date.parse(started.committedAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}
function stableCompactionId(sessionId: string, branchId: string, key: string): string { return `compaction-${sha256(`${sessionId}\0${branchId}\0${key}`).slice(0, 40)}`; }
function canonicalCursor(cursor: string): string { return BigInt(cursor).toString(); }
function validatedJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function sha256(value: string): string { const hasher = new Bun.CryptoHasher("sha256"); hasher.update(value); return hasher.digest("hex"); }
function boundedUtf8(value: string, maximum: number): string { const bytes = new TextEncoder().encode(value); return bytes.byteLength <= maximum ? value : new TextDecoder().decode(bytes.slice(0, maximum)); }
function brokeredSecrets(): string[] { return Object.entries(process.env).filter(([key, value]) => /(?:key|token|secret|password|credential|auth)/i.test(key) && typeof value === "string" && value.length >= 4).map(([, value]) => value!); }
