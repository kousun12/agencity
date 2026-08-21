import {
  SESSION_TITLE_MODEL,
  SESSION_TITLE_SCHEMA,
  SESSION_TITLE_SYSTEM_INSTRUCTION,
  ValidationError,
  buildProviderInputCandidate,
  deterministicSessionTitleFallback,
  estimateProviderInputCandidate,
  isSessionTitleInputMessage,
  projectEvents,
  validateModelEffectOutputV2,
  validateSessionTitleFields,
  type AgentEvent,
  type EventPayloads,
  type JsonValue,
  type ModelConfiguration,
  type NewAgentEvent,
  type SessionTitleFields,
  type Usage,
  type ModelWarning,
  type ModelUsageSource,
} from "../domain/index.ts";
import type { ModelExecutor } from "../executors/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { ModelEffectAdmissionService } from "./model-effect-admission.ts";
import { stableEffectId, type OutboxRunner } from "./outbox.ts";

const TITLE_OUTPUT_TOKENS = 256;

export class SessionTitleService {
  readonly #jobs = new Set<Promise<void>>();
  readonly #running = new Set<string>();
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(
    readonly storage: AgentStorage,
    readonly outbox: OutboxRunner,
    readonly modelExecutor: ModelExecutor,
    readonly admission: ModelEffectAdmissionService,
  ) {
    this.#unsubscribe = storage.onCommitted((events) => this.#observe(events));
  }

  async recoverIncomplete(): Promise<number> {
    const seen = new Set<string>();
    let count = 0;
    for (const route of await this.storage.listBranches()) {
      const events = await this.storage.loadEvents(route.sessionId, {
        branchId: route.branchId,
      });
      const event = latestUserMessage(events);
      if (!event || seen.has(event.id)) continue;
      seen.add(event.id);
      this.#schedule(event);
      count++;
    }
    return count;
  }

  async enableAutomatic(
    sessionId: string,
    branchId: string,
    reason = "Automatic session titles re-enabled by the owner",
  ): Promise<void> {
    const branches = (await this.storage.listBranches())
      .filter((route) => route.sessionId === sessionId);
    if (!branches.some((route) => route.branchId === branchId)) {
      throw new ValidationError(`Session branch not found: ${sessionId}/${branchId}`);
    }
    await this.storage.appendEvents(branches.map((route) => ({
      sessionId,
      branchId: route.branchId,
      type: "SessionTitleModeChanged" as const,
      producer: "client",
      idempotencyKey: `session-title-mode:${stableToken(`${Date.now()}:${reason}`)}:${route.branchId}`,
      payload: { mode: "automatic" as const, reason },
    })));
    const events = await this.storage.loadEvents(sessionId, { branchId });
    const latest = latestUserMessage(events);
    if (latest) this.#schedule(latest as AgentEvent<"MessageAppended">, true);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe();
    await Promise.allSettled([...this.#jobs]);
  }

  #observe(events: readonly AgentEvent[]): void {
    if (this.#closed) return;
    const latestByRoute = new Map<string, AgentEvent<"MessageAppended">>();
    for (const event of events) {
      if (isEligibleTitleEvent(event)) {
        latestByRoute.set(
          `${event.sessionId}\0${event.branchId}`,
          event as AgentEvent<"MessageAppended">,
        );
      }
      if (event.type === "AgentRunStatusChanged") {
        this.#schedulePending(event.sessionId, event.branchId);
      }
    }
    for (const event of latestByRoute.values()) this.#schedule(event);
  }

  #schedule(event: AgentEvent<"MessageAppended">, force = false): void {
    const key = force ? `${event.id}:reenabled` : event.id;
    if (this.#closed || this.#running.has(key)) return;
    this.#running.add(key);
    let job!: Promise<void>;
    job = Promise.resolve()
      .then(() => {
        if (!this.#closed) return this.#process(event, force);
      })
      .catch(() => {})
      .finally(() => {
        this.#running.delete(key);
        this.#jobs.delete(job);
      });
    this.#jobs.add(job);
  }

  #schedulePending(sessionId: string, branchId: string): void {
    setTimeout(() => {
      if (this.#closed) return;
      void this.storage.loadEvents(sessionId, { branchId }).then((events) => {
        const event = latestUserMessage(events);
        if (event) this.#schedule(event);
      }).catch(() => {});
    }, 0);
  }

  async #process(
    source: AgentEvent<"MessageAppended">,
    force: boolean,
  ): Promise<void> {
    const events = await this.storage.loadEvents(source.sessionId, {
      branchId: source.branchId,
    });
    if (!events.some((event) => event.id === source.id)) return;
    const state = projectEvents(events);
    const requestId = titleRequestId(source.sessionId, source.id, force);
    const existing = state.sessionTitle.requests[requestId];
    if (existing) {
      if (existing.status === "resolved") return;
      if (existing.effectId) {
        await this.#settleModelRequest(
          source.sessionId,
          source.branchId,
          requestId,
        );
      } else if (existing.mode === "fallback") {
        const requested = events.find((event) =>
          event.id === existing.eventId && event.type === "SessionTitleRequested");
        const fallbackReason = requested
          ? (requested.payload as EventPayloads["SessionTitleRequested"]).fallbackReason
          : undefined;
        const userMessages = existing.sourceMessageEventIds.map((eventId) =>
          state.messages.find((message) => message.eventId === eventId)?.content ?? "");
        await this.#appendResolution(
          source.sessionId,
          existing.sourceBranchId,
          existing,
          deterministicSessionTitleFallback(userMessages),
          {
            method: "fallback",
            fallbackReason: fallbackReason ??
              "Automatic title generation was unavailable",
          },
        );
      }
      return;
    }
    const userEvents = events.filter((event): event is AgentEvent<"MessageAppended"> =>
      isEligibleTitleEvent(event) &&
      BigInt(event.cursor) <= BigInt(source.cursor));
    const sourceMessageEventIds = userEvents.map((event) => event.id);
    const userMessages = userEvents.map((event) =>
      (event.payload as EventPayloads["MessageAppended"]).content);
    const route = state.model.provider;
    if (route !== "vercel" && route !== "openai") {
      return;
    }
    const configuration: ModelConfiguration = {
      provider: route,
      model: SESSION_TITLE_MODEL,
      maxOutputTokens: TITLE_OUTPUT_TOKENS,
      reasoningEffort: "provider-default",
    };
    let admitted: ReturnType<ModelEffectAdmissionService["requestDeclaredData"]>;
    let providerInput: ReturnType<typeof buildProviderInputCandidate>;
    let estimate: ReturnType<typeof estimateProviderInputCandidate>;
    try {
      admitted = this.admission.requestDeclaredData(
        SESSION_TITLE_SCHEMA,
        configuration,
      );
      const capacity = providerInputCapacity(
        this.modelExecutor,
        admitted.modelDispatch.configuration,
      );
      providerInput = buildProviderInputCandidate({
        context: {
          messages: [
            { role: "system", content: SESSION_TITLE_SYSTEM_INSTRUCTION },
            ...userMessages.map((content) => ({ role: "user", content })),
          ],
        },
        modelDispatch: admitted.modelDispatch,
        capacity,
      });
      estimate = estimateProviderInputCandidate(providerInput);
    } catch (error) {
      await this.#appendFallbackRequest(
        source,
        requestId,
        sourceMessageEventIds,
        userMessages,
        boundedReason(error),
      );
      return;
    }
    const effectKey = `session-title-effect:${requestId}`;
    const effectId = stableEffectId(source.sessionId, effectKey);
    const request: EventPayloads["SessionTitleRequested"] = {
      requestId,
      sourceMessageEventId: source.id,
      sourceMessageCursor: source.cursor,
      sourceMessageEventIds,
      mode: "model",
      effectId,
      modelDispatch: admitted.modelDispatch,
      providerInput,
      estimatedInputTokens: estimate.estimatedTokens,
    };
    const effectEvent = this.outbox.requestEvent({
      sessionId: source.sessionId,
      branchId: source.branchId,
      executor: "model",
      operation: "complete",
      input: {
        requestId,
        providerInput: providerInput as unknown as JsonValue,
        modelDispatch: admitted.modelDispatch as unknown as JsonValue,
      },
      origin: { kind: "session-title", requestId },
      idempotencyKey: effectKey,
      idempotent: false,
    });
    await this.storage.appendEvents([{
      id: requestId,
      sessionId: source.sessionId,
      branchId: source.branchId,
      type: "SessionTitleRequested",
      producer: "supervisor",
      idempotencyKey: `session-title-request:${requestId}`,
      payload: request,
    }, effectEvent]);
    await this.#settleModelRequest(source.sessionId, source.branchId, requestId);
  }

  async #settleModelRequest(
    sessionId: string,
    branchId: string,
    requestId: string,
  ): Promise<void> {
    let state = projectEvents(await this.storage.loadEvents(sessionId, { branchId }));
    const request = state.sessionTitle.requests[requestId];
    if (!request || request.status === "resolved" || !request.effectId) return;
    await this.outbox.run(request.effectId);
    state = projectEvents(await this.storage.loadEvents(sessionId, { branchId }));
    const current = state.sessionTitle.requests[requestId];
    const effect = state.effects[request.effectId];
    if (!current || current.status === "resolved" || !effect ||
        ["requested", "started"].includes(effect.status)) return;
    const userMessages = current.sourceMessageEventIds.map((eventId) =>
      state.messages.find((message) => message.eventId === eventId)?.content ?? "");
    const fallback = deterministicSessionTitleFallback(userMessages);
    let fields: ReturnType<typeof validateSessionTitleFields> = fallback;
    let method: "model" | "fallback" = "fallback";
    let fallbackReason = effect.error ?? `Title model effect ended ${effect.status}`;
    let usage: Usage | undefined;
    let warnings: readonly ModelWarning[] | undefined;
    let usageSource: ModelUsageSource | undefined;
    if (effect.status === "succeeded" && effect.output !== undefined &&
        current.modelDispatch) {
      try {
        const output = validateModelEffectOutputV2(effect.output, {
          responseContract: current.modelDispatch.responseContract,
          responseCapability: current.modelDispatch.responseCapability,
          configuredProvider: current.modelDispatch.configuration.provider,
        });
        const value = output.result.kind === "tool-submission" &&
          output.result.submission.input &&
          typeof output.result.submission.input === "object" &&
          !Array.isArray(output.result.submission.input)
          ? output.result.submission.input.value
          : undefined;
        fields = validateSessionTitleFields(value);
        method = "model";
        fallbackReason = "";
        usage = output.response.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
        warnings = output.response.warnings;
        usageSource = output.response.kind === "guard-aborted"
          ? "conservative-guard-estimate"
          : "provider-reported";
      } catch (error) {
        fallbackReason = boundedReason(error);
        try {
          const output = validateModelEffectOutputV2(effect.output, {
            responseContract: current.modelDispatch.responseContract,
            responseCapability: current.modelDispatch.responseCapability,
            configuredProvider: current.modelDispatch.configuration.provider,
          });
          usage = output.response.usage ?? undefined;
          warnings = output.response.warnings;
          usageSource = output.response.kind === "guard-aborted"
            ? "conservative-guard-estimate"
            : "provider-reported";
        } catch {}
      }
    }
    await this.#appendResolution(sessionId, branchId, current, fields, {
      method,
      sourceOutcomeEventId: effect.eventId,
      ...(usage === undefined ? {} : { usage }),
      ...(warnings === undefined ? {} : { warnings: [...warnings] }),
      ...(usageSource === undefined ? {} : { usageSource }),
      ...(method === "model" ? {} : { fallbackReason }),
    });
  }

  async #appendFallbackRequest(
    source: AgentEvent<"MessageAppended">,
    requestId: string,
    sourceMessageEventIds: string[],
    userMessages: string[],
    reason: string,
  ): Promise<void> {
    const request: EventPayloads["SessionTitleRequested"] = {
      requestId,
      sourceMessageEventId: source.id,
      sourceMessageCursor: source.cursor,
      sourceMessageEventIds,
      mode: "fallback",
      fallbackReason: reason,
    };
    await this.storage.appendEvents([{
      id: requestId,
      sessionId: source.sessionId,
      branchId: source.branchId,
      type: "SessionTitleRequested",
      producer: "supervisor",
      idempotencyKey: `session-title-request:${requestId}`,
      payload: request,
    }]);
    await this.#appendResolution(
      source.sessionId,
      source.branchId,
      {
        id: requestId,
        sourceMessageEventId: source.id,
        sourceMessageCursor: source.cursor,
        sourceMessageEventIds,
      },
      deterministicSessionTitleFallback(userMessages),
      { method: "fallback", fallbackReason: reason },
    );
  }

  async #appendResolution(
    sessionId: string,
    originBranchId: string,
    request: {
      readonly id: string;
      readonly sourceMessageEventId: string;
      readonly sourceMessageCursor: string;
      readonly sourceMessageEventIds: readonly string[];
    },
    fields: SessionTitleFields & { readonly title: string },
    settlement: {
      readonly method: "model" | "fallback";
      readonly sourceOutcomeEventId?: string;
      readonly usage?: Usage;
      readonly warnings?: ModelWarning[];
      readonly usageSource?: ModelUsageSource;
      readonly fallbackReason?: string;
    },
  ): Promise<void> {
    const routes = (await this.storage.listBranches())
      .filter((route) => route.sessionId === sessionId)
      .sort((left, right) =>
        left.branchId === originBranchId ? -1
          : right.branchId === originBranchId ? 1
            : left.branchId.localeCompare(right.branchId));
    const payload: EventPayloads["SessionTitleResolved"] = {
      requestId: request.id,
      sourceMessageEventId: request.sourceMessageEventId,
      sourceMessageCursor: request.sourceMessageCursor,
      sourceMessageEventIds: [...request.sourceMessageEventIds],
      sourceBranchId: originBranchId,
      method: settlement.method,
      title: fields.title,
      verb: fields.verb,
      subject: fields.subject,
      intentSummary: fields.intentSummary,
      ...(settlement.sourceOutcomeEventId === undefined ? {} : {
        sourceOutcomeEventId: settlement.sourceOutcomeEventId,
      }),
      ...(settlement.usage === undefined ? {} : { usage: settlement.usage }),
      ...(settlement.warnings === undefined ? {} : { warnings: settlement.warnings }),
      ...(settlement.usageSource === undefined ? {} : {
        usageSource: settlement.usageSource,
      }),
      ...(settlement.fallbackReason === undefined ? {} : {
        fallbackReason: settlement.fallbackReason,
      }),
    };
    const events: NewAgentEvent<"SessionTitleResolved">[] = routes.map((route) => ({
      sessionId,
      branchId: route.branchId,
      type: "SessionTitleResolved",
      producer: "supervisor",
      idempotencyKey: `session-title-resolution:${request.id}:${route.branchId}`,
      payload,
    }));
    if (events.length) await this.storage.appendEvents(events);
  }
}

function titleRequestId(
  sessionId: string,
  sourceMessageEventId: string,
  force: boolean,
): string {
  return `session-title-${stableToken(
    `${sessionId}\0${sourceMessageEventId}${force ? "\0reenabled" : ""}`,
  )}`;
}

function stableToken(value: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(value);
  return hash.digest("hex").slice(0, 32);
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1024) ||
    "Automatic title generation was unavailable";
}

function providerInputCapacity(
  executor: ModelExecutor,
  configuration: ModelConfiguration,
) {
  const resolved = executor.contextCapacity(configuration);
  const outputReserveTokens = resolved.contextWindowTokens === null
    ? TITLE_OUTPUT_TOKENS
    : Math.min(resolved.contextWindowTokens - 1, TITLE_OUTPUT_TOKENS);
  return {
    ...resolved,
    outputReserveTokens,
    estimatorId: "provider-input-utf8-bytes-per-4-tokens-v1",
    triggerRatio: 0.8,
    targetRatio: 0.6,
  } as const;
}

function latestUserMessage(
  events: readonly AgentEvent[],
): AgentEvent<"MessageAppended"> | undefined {
  return [...events].reverse().find((event): event is AgentEvent<"MessageAppended"> =>
    isEligibleTitleEvent(event));
}

function isEligibleTitleEvent(
  event: AgentEvent,
): event is AgentEvent<"MessageAppended"> {
  if (event.type !== "MessageAppended") return false;
  const payload = event.payload as EventPayloads["MessageAppended"];
  return isSessionTitleInputMessage({
    role: payload.role,
    producer: event.producer,
    idempotencyKey: event.idempotencyKey,
    ...(payload.mailbox === undefined ? {} : { mailbox: payload.mailbox }),
  });
}
