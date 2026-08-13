import { reduceAgentState, type AgentEvent, type AgentInvocationContract, type AgentProfileInput, type AgentState, type ModelConfigurationInput, type ModelDescriptor, type ObjectiveEvaluation, type ReasoningEffort } from "../domain/index.ts";
import { HttpProtocolTransport, type ProtocolTransport } from "./transport.ts";
import type { ModelProviderDescriptor } from "../executors/index.ts";
import type {
  AiGenerationHandle, AiGenerationInput, AiGenerationResult, AiObjectGenerationInput,
  CreateGoalInput, CreateHeartbeatInput, CreateScheduleInput, CreateInputSetInput, DocumentHandle, GoalHandle,
  HeartbeatHandle, ImportDocumentInput, InputSetHandle, ScheduleHandle, SendMessageInput,
  AgentInvocationResult, SpawnAgentInput, SubagentHandle, CreateMemoryInput,
  ProposeRefinementInput, ActivateCandidateInput, AllocateCandidateInput, RecordObservationInput, DecideRefinementInput, ApproveRollbackInput,
  InvokeSkillOptions, SpawnSpecInput, SpecSubagentHandle, EffectProgressNotification,
  StartAgentRunInput, AgentRunResult, FamilyListResult, MailboxListOptions, MailboxListResult, MailboxMessageHandle, MailboxMessageResult,
  RecordEffectReconciliationInput, EffectReconciliationView, UnknownEffectView, RecoverySummaryView,
  StartRefinementReviewInput, RefinementReviewRecord, RefinementTriggerPolicyV1,
  LearningActivity, LearningHistoryView, LearningStatusView,
  SubmitGovernedRefinementInput,
  SkillManagementView, SkillImportPreview, InstallLocalSkillInput,
  AgentToolContractCapabilityView, ModelContractDiagnosticsView,
  AgentProfileDetail, AgentProfileSummary,
} from "../runtime/index.ts";
import type { CandidateAllocationRecord, EvaluationObservationRecord, GovernedRefinementRecord, GovernedRefinementRollbackRecord, HarnessRecord, HarnessVersionRecord, MemorySearchOptions, MemorySearchResult, RefinementDecisionRecord, RefinementProposalRecord, RefinementRollbackResult, RollbackGovernedRefinementInput, RollbackRefinementInput, SkillInvocationResult, SkillTestReport, JsonValue } from "../domain/index.ts";
import type { DataManifestRecord, GoalGateEvaluationRecord, HeartbeatRecord, ScheduleRecord, SyncConflictRecord, TaskRecord, WakeRecord } from "../storage/index.ts";
import type { DeleteOwnedDataInput, PhysicalDeletionReceipt, ResolveConflictInput, SyncCheckpointResult, SyncCycleResult, SyncPullResult, SyncPushResult, SyncStatusView, SyncTransportStats, WorkspaceAnnouncement } from "../sync/index.ts";
import type { ProductBranchSummary } from "../product/index.ts";


const PROTOCOL_STREAM_ITEMS_PER_TURN = 32;
const MAX_AGENT_INVOCATION_WAIT_MS = 86_400_000;

export interface ProtocolCapabilities {
  readonly protocol: "agencity.protocol";
  readonly version: 1;
  readonly mode: "trusted-local";
  readonly trustedLocal: true;
  readonly hostileCodeSandbox: false;
  readonly snapshotCursorResume: boolean;
  readonly committedEventDeduplication: boolean;
  readonly cursorlessProgress: boolean;
  readonly historicalProjection: boolean;
  readonly managedService: boolean;
  readonly productCatalog: boolean;
  readonly reasoningEffortSelection?: boolean;
  readonly sync: Record<string, unknown>;
  readonly providers: ModelProviderDescriptor[];
  readonly agentTools: AgentToolContractCapabilityView;
}

/** Typed, scrubbed protocol failure shared by both transports. */
export class ProtocolClientError extends Error {
  override readonly name = "ProtocolClientError";
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: unknown = null,
  ) { super(`[${code}] ${message}`); }
}

export interface BranchWatchHandlers {
  readonly onSnapshot: (snapshot: { cursor: string; state: AgentState }) => unknown | Promise<unknown>;
  readonly onEvent: (event: AgentEvent) => unknown | Promise<unknown>;
  readonly onProgress?: (progress: EffectProgressNotification) => unknown | Promise<unknown>;
  /** Ephemeral prefixes must be removed on commit, disconnect, or reconnect. */
  readonly onProgressDiscard?: (effectIds: readonly string[], reason: "committed" | "disconnect" | "reconnect") => unknown | Promise<unknown>;
  readonly onReconnect?: (attempt: number, afterCursor: string) => unknown | Promise<unknown>;
  readonly onConnectionState?: (state: "connected" | "reconnecting" | "disconnected") => unknown | Promise<unknown>;
}

export interface BranchWatchOptions {
  readonly signal?: AbortSignal;
  readonly reconnectDelayMs?: number;
  /** Mainly for bounded clients/tests. Omit to reconnect until aborted. */
  readonly maxReconnects?: number;
}

export interface AgentStreamHandlers {
  readonly onEvent: (event: AgentEvent) => unknown | Promise<unknown>;
  readonly onProgress?: (progress: EffectProgressNotification) => unknown | Promise<unknown>;
  readonly onOpen?: () => unknown | Promise<unknown>;
}

export class AgentClient {
  readonly transport: ProtocolTransport;
  readonly baseUrl: string;
  readonly bearerToken: string | undefined;
  readonly #pendingRequests = new Set<AbortController>();
  #capabilitiesSnapshot: Promise<ProtocolCapabilities> | null = null;
  constructor(baseUrlOrTransport: string | ProtocolTransport, bearerToken?: string) {
    this.transport = typeof baseUrlOrTransport === "string"
      ? new HttpProtocolTransport(baseUrlOrTransport, bearerToken)
      : baseUrlOrTransport;
    this.baseUrl = "baseUrl" in this.transport ? String(this.transport.baseUrl) : "http://agencity.in-process";
    this.bearerToken = bearerToken;
  }
  abortPendingRequests(reason = "Protocol client detached"): void {
    for (const controller of this.#pendingRequests) controller.abort(new DOMException(reason, "AbortError"));
  }
  health(): Promise<{ ok: boolean; authenticated?: boolean; workspaceId?: string; instanceId?: string; appVersion?: string; protocolMin?: number; protocolMax?: number; configHash?: string }> { return this.#json("/health"); }
  capabilities(): Promise<ProtocolCapabilities> {
    if (this.#capabilitiesSnapshot === null) {
      const request = this.#json<ProtocolCapabilities>("/capabilities");
      this.#capabilitiesSnapshot = request;
      void request.catch(() => {
        if (this.#capabilitiesSnapshot === request) this.#capabilitiesSnapshot = null;
      });
    }
    return this.#capabilitiesSnapshot;
  }
  async agentToolCapability(
    model: Pick<ModelConfigurationInput, "provider" | "model">,
  ): Promise<AgentToolContractCapabilityView> {
    const response = await this.#json<ProtocolCapabilities>(
      `/capabilities?provider=${encodeURIComponent(model.provider)}&model=${encodeURIComponent(model.model)}`,
    );
    if (!response.agentTools?.selected) {
      throw new ProtocolClientError(
        "INVALID_RESPONSE",
        "Protocol response omitted selected agent-tool capability",
        502,
      );
    }
    return response.agentTools;
  }
  async requireCapability(capability: "reasoningEffortSelection"): Promise<void> {
    if ((await this.capabilities())[capability] !== true) {
      throw new ProtocolClientError("CAPABILITY_UNAVAILABLE", `Server does not support ${capability}`, 501);
    }
  }
  async #compatibleModel<T>(model: T): Promise<T> {
    if (!model || typeof model !== "object" || Array.isArray(model)) return model;
    const record = model as Record<string, unknown>;
    const effort = record.reasoningEffort;
    if (effort === undefined) return model;
    if (effort === "provider-default" || effort === "default") {
      const legacy = { ...record };
      delete legacy.reasoningEffort;
      return legacy as T;
    }
    await this.requireCapability("reasoningEffortSelection");
    return model;
  }
  serviceStatus(): Promise<unknown> { return this.#json("/service/status"); }
  shutdownService(): Promise<unknown> { return this.#post("/service/shutdown"); }
  serviceAgents(): Promise<any[]> { return this.#json("/service/agents"); }
  productSessions(): Promise<ProductBranchSummary[]> { return this.#json("/product/sessions"); }
  productSelect(target?: string, branchId?: string): Promise<{ sessionId: string; branchId: string }> { return this.#post("/product/select", { ...(target === undefined ? {} : { target }), ...(branchId === undefined ? {} : { branchId }) }); }
  productRename(sessionId: string, branchId: string | undefined, name: string): Promise<unknown> { return this.#post("/product/rename", { sessionId, ...(branchId === undefined ? {} : { branchId }), name }); }
  productConfig(model?: string): Promise<{ defaultModel: string | null; catalogEndpointId: string; catalogOrigin: string; executionOrigins: Record<string, string>; selectedModelEffortPreference: ReasoningEffort | null; credentialReferences: unknown[]; providers?: ModelProviderDescriptor[] }> { return this.#json(`/product/config${model ? `?model=${encodeURIComponent(model)}` : ""}`); }
  productSetModel(model: string | null): Promise<unknown> { return this.#post("/product/config/model", { model }); }
  async productSetReasoningEffort(model: string, effort: ReasoningEffort | null): Promise<unknown> {
    await this.requireCapability("reasoningEffortSelection");
    return this.#post("/product/config/reasoning-effort", { model, effort });
  }
  productSetProviderKey(provider: string, apiKey: string | null): Promise<unknown> { return this.#post("/product/config/provider-key", { provider, apiKey }); }
  productCredentialReference(provider: string, reference: string, label: string): Promise<unknown> { return this.#post("/product/config/credential-reference", { provider, reference, label }); }
  stopSession(sessionId: string, branchId: string, reason?: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/stop?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  modelProviders(): Promise<ModelProviderDescriptor[]> { return this.#json("/model-providers"); }
  async createSession(workspaceId: string, options: { model?: unknown; budget?: unknown; sessionName?: string; branchName?: string; agentProfile?: AgentProfileInput } = {}): Promise<{ sessionId: string; branchId: string }> {
    const model = await this.#compatibleModel(options.model);
    return this.#post("/sessions", { workspaceId, ...options, ...(model === undefined ? {} : { model }) });
  }
  snapshot(sessionId: string, branchId: string): Promise<{ cursor: string; state: AgentState }> { return this.#json(`/sessions/${sessionId}/snapshot?branch=${branchId}`); }
  agentProfile(sessionId: string, includePrompt = false): Promise<AgentProfileSummary | AgentProfileDetail> { return this.#json(`/sessions/${sessionId}/agent-profile${includePrompt ? "?detail=full" : ""}`); }
  agentProfiles(sessionId: string, options: { readonly includePrompt?: boolean; readonly limit?: number } = {}): Promise<{ activeProfileVersionId: string; items: Array<AgentProfileSummary | AgentProfileDetail> }> {
    const query = new URLSearchParams();
    if (options.includePrompt) query.set("detail", "full");
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return this.#json(`/sessions/${sessionId}/agent-profiles${query.size ? `?${query}` : ""}`);
  }
  proposeProfileUpdate(sessionId: string, branchId: string, input: {
    readonly expectedProfileVersionId: string;
    readonly replacement: AgentProfileInput;
    readonly reason: string;
    readonly predictedEffect: string;
    readonly evidenceEventIds: readonly string[];
    readonly evaluation?: ObjectiveEvaluation;
    readonly revisesProposalId?: string;
    readonly clientRequestId?: string;
    readonly wait?: boolean;
  }): Promise<GovernedRefinementRecord> {
    return this.#post(`/sessions/${sessionId}/profile-proposals?branch=${encodeURIComponent(branchId)}`, input);
  }
  governedRefinement(proposalId: string): Promise<GovernedRefinementRecord> {
    return this.#json(`/governed-refinements/${encodeURIComponent(proposalId)}`);
  }
  proposeGovernedRefinement(sessionId: string, branchId: string, input: SubmitGovernedRefinementInput): Promise<GovernedRefinementRecord> {
    return this.#post(`/sessions/${sessionId}/governed-refinements?branch=${encodeURIComponent(branchId)}`, input);
  }
  governedRefinements(options: { readonly status?: string; readonly limit?: number } = {}): Promise<GovernedRefinementRecord[]> {
    const query = new URLSearchParams();
    if (options.status) query.set("status", options.status);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return this.#json(`/governed-refinements${query.size ? `?${query}` : ""}`);
  }
  rollbackRefinement(sessionId: string, branchId: string, input: RollbackRefinementInput): Promise<RefinementRollbackResult> {
    return this.#post(`/sessions/${sessionId}/profiles/rollback?branch=${encodeURIComponent(branchId)}`, input);
  }
  rollbackGovernedRefinement(sessionId: string, branchId: string, proposalId: string, input: RollbackGovernedRefinementInput): Promise<GovernedRefinementRollbackRecord> {
    return this.#post(`/sessions/${sessionId}/governed-refinements/${encodeURIComponent(proposalId)}/rollback?branch=${encodeURIComponent(branchId)}`, input);
  }
  refinementCapabilities(): Promise<JsonValue> {
    return this.#json("/refinement-capabilities");
  }
  modelContractDiagnostics(sessionId: string, branchId: string): Promise<ModelContractDiagnosticsView> { return this.#json(`/sessions/${sessionId}/model-contract-diagnostics?branch=${branchId}`); }
  message(sessionId: string, branchId: string, content: string): Promise<AgentEvent> { return this.#post(`/sessions/${sessionId}/messages?branch=${branchId}`, { content }); }
  async selectModel(sessionId: string, branchId: string, model: ModelConfigurationInput): Promise<unknown> {
    return this.#post(`/sessions/${sessionId}/model?branch=${branchId}`, { model: await this.#compatibleModel(model) });
  }
  async modelCatalog(refresh = false): Promise<{ endpointId?: string; origin?: string; status?: "refreshed" | "cached-fallback" | "unavailable"; descriptors: ModelDescriptor[]; error?: string }> {
    await this.requireCapability("reasoningEffortSelection");
    return refresh ? this.#post("/model-catalog/refresh") : this.#json("/model-catalog");
  }
  startRun(sessionId: string, branchId: string, input: StartAgentRunInput | string): Promise<AgentRunResult> { return this.#post(`/sessions/${sessionId}/runs?branch=${branchId}`, typeof input === "string" ? { task: input } : input); }
  run(sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> { return this.#json(`/sessions/${sessionId}/runs/${runId}?branch=${branchId}`); }
  resumeRun(sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> { return this.#post(`/sessions/${sessionId}/runs/${runId}/resume?branch=${branchId}`); }
  cancelRun(sessionId: string, branchId: string, runId: string, reason?: string): Promise<AgentRunResult> { return this.#post(`/sessions/${sessionId}/runs/${runId}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  /** Retained diagnostic compatibility run. Product tasks use startRun. */
  turn(sessionId: string, branchId: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/turns?branch=${branchId}`); }
  cell(sessionId: string, branchId: string, code: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/cells?branch=${branchId}`, { code }); }
  fork(sessionId: string, branchId: string, cursor: string, name?: string, compactionStrategy?: "deterministic-extractive-v1" | "model-summary-v1"): Promise<{ branchId: string }> { return this.#post(`/sessions/${sessionId}/branches?branch=${branchId}`, { cursor, ...(name === undefined ? {} : { name }), ...(compactionStrategy === undefined ? {} : { compactionStrategy }) }); }
  history(sessionId: string, branchId: string): Promise<AgentEvent[]> { return this.#json(`/sessions/${sessionId}/history?branch=${branchId}`); }
  async stream(
    sessionId: string,
    branchId: string,
    afterCursor: string,
    handlers: AgentStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const request = await this.#request(
      `/sessions/${encodeURIComponent(sessionId)}/stream?branch=${encodeURIComponent(branchId)}&after=${encodeURIComponent(afterCursor)}`,
      signal === undefined ? {} : { signal },
    );
    try {
      const response = request.response;
      if (!response.ok) throw await protocolError(response);
      if (!response.body) throw new Error("Protocol stream response has no body");
      await handlers.onOpen?.();
      let cursor = afterCursor;
      await readProtocolStream(response.body, async (eventName, data) => {
        const value = JSON.parse(data) as AgentEvent | EffectProgressNotification;
        if (eventName === "progress") {
          await handlers.onProgress?.(value as EffectProgressNotification);
          return;
        }
        const event = value as AgentEvent;
        if (BigInt(event.cursor) <= BigInt(cursor)) return;
        await handlers.onEvent(event);
        cursor = event.cursor;
      }, signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      request.release();
    }
  }
  /**
   * Snapshot-then-cursor watch. Every reconnect starts after the last committed
   * cursor, duplicate committed events are ignored, and progress is never replayed.
   */
  async watchBranch(
    sessionId: string,
    branchId: string,
    handlers: BranchWatchHandlers,
    options: BranchWatchOptions = {},
  ): Promise<void> {
    const snapshot = await this.snapshot(sessionId, branchId);
    let cursor = snapshot.cursor;
    await handlers.onSnapshot(snapshot);
    let attempt = 0;
    const delay = options.reconnectDelayMs ?? 50;
    const progressEffects = new Set<string>();
    const discard = async (reason: "committed" | "disconnect" | "reconnect", only?: string): Promise<void> => {
      const ids = only === undefined ? [...progressEffects] : progressEffects.has(only) ? [only] : [];
      ids.forEach((id) => progressEffects.delete(id));
      if (ids.length) await handlers.onProgressDiscard?.(ids, reason);
    };
    while (!options.signal?.aborted) {
      if (attempt > 0) {
        await discard("reconnect");
        await handlers.onConnectionState?.("reconnecting");
        await handlers.onReconnect?.(attempt, cursor);
      }
      let endedNormally = false;
      try {
        await this.stream(sessionId, branchId, cursor, {
          onOpen: async () => { await handlers.onConnectionState?.("connected"); },
          onEvent: async (event) => {
            if (BigInt(event.cursor) <= BigInt(cursor)) return;
            const effectId = event.type === "EffectOutcomeRecorded"
              ? (event.payload as { effectId?: string }).effectId
              : undefined;
            if (effectId) await discard("committed", effectId);
            await handlers.onEvent(event);
            cursor = event.cursor;
          },
          onProgress: async (progress) => {
            progressEffects.add(progress.effectId);
            await handlers.onProgress?.(progress);
          },
        }, options.signal);
        endedNormally = true;
      } catch (error) {
        if (options.signal?.aborted) break;
        await discard("disconnect");
        await handlers.onConnectionState?.("disconnected");
        if (error instanceof ProtocolClientError && error.status >= 400 && error.status < 500) throw error;
      }
      if (options.signal?.aborted) break;
      if (endedNormally) {
        await discard("disconnect");
        await handlers.onConnectionState?.("disconnected");
      }
      if (options.maxReconnects !== undefined && attempt >= options.maxReconnects) break;
      attempt++;
      await abortableDelay(delay, options.signal);
    }
    await discard("disconnect");
  }

  resume(sessionId:string,branchId:string):Promise<{sessionId:string;branchId:string;cursor:string}>{return this.#post(`/sessions/${sessionId}/resume?branch=${branchId}`);}
  inspectContext(sessionId:string,branchId:string):Promise<import("../runtime/index.ts").ContextInspection>{return this.#json(`/sessions/${sessionId}/context?branch=${branchId}`);}
  compact(sessionId:string,branchId:string,input:import("../runtime/index.ts").CompactContextInput={}):Promise<import("../runtime/index.ts").ContextCompactionView>{return this.#post(`/sessions/${sessionId}/compact?branch=${branchId}`,input);}
  recoverySummary(sessionId: string, branchId: string): Promise<RecoverySummaryView> { return this.#json(`/sessions/${sessionId}/recovery-summary?branch=${branchId}`); }
  unknownEffects(sessionId: string, branchId: string): Promise<UnknownEffectView[]> { return this.#json(`/sessions/${sessionId}/effects/unknown?branch=${branchId}`); }
  inspectUnknownEffect(sessionId: string, branchId: string, effectId: string): Promise<UnknownEffectView> { return this.#json(`/sessions/${sessionId}/effects/${encodeURIComponent(effectId)}/reconciliation?branch=${branchId}`); }
  reconcileUnknownEffect(sessionId: string, branchId: string, effectId: string, input: RecordEffectReconciliationInput): Promise<EffectReconciliationView> { return this.#post(`/sessions/${sessionId}/effects/${encodeURIComponent(effectId)}/reconciliation?branch=${branchId}`, input); }

  async spawn(sessionId: string, branchId: string, input: SpawnAgentInput | string): Promise<SubagentHandle> {
    if (typeof input === "string") return this.#post(`/sessions/${sessionId}/agent-invocations?branch=${branchId}`, { task: input });
    const model = await this.#compatibleModel(input.model);
    return this.#post(`/sessions/${sessionId}/agent-invocations?branch=${branchId}`, { ...input, ...(model === undefined ? {} : { model }) });
  }
  async spawnMany(sessionId: string, branchId: string, inputs: readonly (SpawnAgentInput | string)[]): Promise<SubagentHandle[]> {
    const compatible = await Promise.all(inputs.map(async input => {
      if (typeof input === "string") return input;
      const model = await this.#compatibleModel(input.model);
      return { ...input, ...(model === undefined ? {} : { model }) };
    }));
    return this.#post(`/sessions/${sessionId}/agent-invocations/batch?branch=${branchId}`, { inputs: compatible });
  }
  agentInvocationResult(sessionId: string, branchId: string, taskId: string): Promise<AgentInvocationResult> {
    return this.#json(`/sessions/${sessionId}/agent-invocations/${encodeURIComponent(taskId)}/result?branch=${branchId}`);
  }
  agentInvocationContract(sessionId: string, branchId: string, taskId: string): Promise<AgentInvocationContract> {
    return this.#json(`/sessions/${sessionId}/agent-invocations/${encodeURIComponent(taskId)}/contract?branch=${branchId}`);
  }
  findAgentInvocation(sessionId: string, branchId: string, idempotencyKey: string): Promise<SubagentHandle | null> {
    return this.#json(`/sessions/${sessionId}/agent-invocations/by-key?branch=${branchId}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
  }
  cancelAgentInvocation(sessionId: string, branchId: string, taskId: string, reason?: string): Promise<unknown> {
    return this.#post(`/sessions/${sessionId}/agent-invocations/${encodeURIComponent(taskId)}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason });
  }
  async runAgent(
    sessionId: string,
    branchId: string,
    input: SpawnAgentInput | string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<AgentInvocationResult> {
    assertWaitTimeout(options.timeoutMs, "Agent invocation");
    const handle = await this.spawn(sessionId, branchId, input);
    return this.#waitForBranchResult(
      handle.sessionId,
      handle.branchId,
      (state) => {
        const run = handle.runId ? state.agentRuns[handle.runId] : undefined;
        return run !== undefined &&
          ["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status);
      },
      () => this.agentInvocationResult(sessionId, branchId, handle.taskId),
      options.timeoutMs ?? 120_000,
    );
  }
  tasks(sessionId: string, branchId: string): Promise<TaskRecord[]> { return this.#json(`/sessions/${sessionId}/tasks?branch=${branchId}`); }
  cancelTask(sessionId: string, branchId: string, taskId: string, reason?: string): Promise<TaskRecord> { return this.#post(`/sessions/${sessionId}/tasks/${taskId}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  agents(sessionId: string, branchId: string): Promise<FamilyListResult> { return this.#json(`/sessions/${sessionId}/agents?branch=${branchId}`); }
  sendMailbox(sessionId: string, branchId: string, input: SendMessageInput): Promise<MailboxMessageHandle> { return this.#post(`/sessions/${sessionId}/mailbox?branch=${branchId}`, input); }
  mailbox(sessionId: string, branchId: string, options: MailboxListOptions = {}): Promise<MailboxListResult> { const params = new URLSearchParams({ branch: branchId, ...(options.direction === undefined ? {} : { direction: options.direction }), ...(options.limit === undefined ? {} : { limit: String(options.limit) }), ...(options.before === undefined ? {} : { before: options.before }), ...(options.pendingOnly ? { pending: "1" } : {}) }); return this.#json(`/sessions/${sessionId}/mailbox?${params}`); }
  mailboxResult(sessionId: string, branchId: string, messageId: string): Promise<MailboxMessageResult> { return this.#json(`/sessions/${sessionId}/mailbox/${encodeURIComponent(messageId)}/result?branch=${branchId}`); }
  acknowledgeMailbox(sessionId: string, branchId: string, messageId: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/mailbox/${messageId}/ack?branch=${branchId}`); }
  cancelAgent(sessionId: string, branchId: string, target: string, reason?: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/agents/${encodeURIComponent(target)}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason }); }

  importDocument(sessionId: string, branchId: string, input: ImportDocumentInput): Promise<DocumentHandle> { return this.#post(`/sessions/${sessionId}/documents?branch=${branchId}`, input); }
  createInputSet(sessionId: string, branchId: string, input: CreateInputSetInput): Promise<InputSetHandle> { return this.#post(`/sessions/${sessionId}/input-sets?branch=${branchId}`, input); }
  async admitTextGeneration(sessionId: string, branchId: string, input: AiGenerationInput): Promise<AiGenerationHandle> {
    const model = typeof input.model === "string" ? input.model : await this.#compatibleModel(input.model);
    return this.#post(`/sessions/${sessionId}/ai/generations?branch=${branchId}`, { ...input, kind: "text", ...(model === undefined ? {} : { model }) });
  }
  async admitObjectGeneration(sessionId: string, branchId: string, input: AiObjectGenerationInput): Promise<AiGenerationHandle> {
    const model = typeof input.model === "string" ? input.model : await this.#compatibleModel(input.model);
    return this.#post(`/sessions/${sessionId}/ai/generations?branch=${branchId}`, { ...input, kind: "object", ...(model === undefined ? {} : { model }) });
  }
  generation(sessionId: string, branchId: string, generationId: string): Promise<AiGenerationHandle> {
    return this.#json(`/sessions/${sessionId}/ai/generations/${generationId}?branch=${branchId}`);
  }
  generationResult(sessionId: string, branchId: string, generationId: string): Promise<AiGenerationResult> {
    return this.#json(`/sessions/${sessionId}/ai/generations/${generationId}/result?branch=${branchId}`);
  }
  findGeneration(sessionId: string, branchId: string, idempotencyKey: string): Promise<AiGenerationHandle | null> {
    return this.#json(`/sessions/${sessionId}/ai/generations/by-key?branch=${branchId}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
  }
  cancelGeneration(sessionId: string, branchId: string, generationId: string, reason?: string): Promise<AiGenerationHandle> {
    return this.#post(`/sessions/${sessionId}/ai/generations/${generationId}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason });
  }
  async generateText(sessionId: string, branchId: string, input: AiGenerationInput, options: { readonly timeoutMs?: number } = {}): Promise<AiGenerationResult> {
    assertWaitTimeout(options.timeoutMs, "AI generation");
    const handle = await this.admitTextGeneration(sessionId, branchId, input);
    return this.#waitForGeneration(sessionId, branchId, handle.generationId, options.timeoutMs);
  }
  async generateObject(sessionId: string, branchId: string, input: AiObjectGenerationInput, options: { readonly timeoutMs?: number } = {}): Promise<AiGenerationResult> {
    assertWaitTimeout(options.timeoutMs, "AI generation");
    const handle = await this.admitObjectGeneration(sessionId, branchId, input);
    return this.#waitForGeneration(sessionId, branchId, handle.generationId, options.timeoutMs);
  }

  createGoal(sessionId: string, branchId: string, input: CreateGoalInput | string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals?branch=${branchId}`, typeof input === "string" ? { description: input } : input); }
  goals(sessionId: string, branchId: string): Promise<GoalHandle[]> { return this.#json(`/sessions/${sessionId}/goals?branch=${branchId}`); }
  currentGoal(sessionId: string, branchId: string): Promise<GoalHandle | null> { return this.#json(`/sessions/${sessionId}/goals/current?branch=${branchId}`); }
  goal(sessionId: string, branchId: string, goalId: string): Promise<GoalHandle> { return this.#json(`/sessions/${sessionId}/goals/${goalId}?branch=${branchId}`); }
  goalEvaluations(sessionId: string, branchId: string, goalId: string, gateId?: string): Promise<GoalGateEvaluationRecord[]> { return this.#json(`/sessions/${sessionId}/goals/${goalId}/evaluations?branch=${branchId}${gateId ? `&gate=${encodeURIComponent(gateId)}` : ""}`); }
  requestGoalCompletion(sessionId: string, branchId: string, goalId: string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/completion?branch=${branchId}`); }
  continueGoal(sessionId: string, branchId: string, goalId: string, maxTurns?: number): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/continue?branch=${branchId}`, maxTurns === undefined ? {} : { maxTurns }); }
  pauseGoal(sessionId: string, branchId: string, goalId: string, reason?: string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/pause?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  resumeGoal(sessionId: string, branchId: string, goalId: string, reason?: string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/resume?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  clearGoal(sessionId: string, branchId: string, goalId: string, reason?: string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/clear?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  createHeartbeat(sessionId: string, branchId: string, input: CreateHeartbeatInput | number): Promise<HeartbeatHandle> { return this.#post(`/sessions/${sessionId}/heartbeats?branch=${branchId}`, typeof input === "number" ? { intervalMs: input } : input); }
  heartbeats(sessionId: string, branchId: string): Promise<HeartbeatRecord[]> { return this.#json(`/sessions/${sessionId}/heartbeats?branch=${branchId}`); }
  tickHeartbeat(heartbeatId: string, at?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/tick`, at === undefined ? {} : { at }); }
  pauseHeartbeat(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/pause`, reason === undefined ? {} : { reason }); }
  resumeHeartbeat(heartbeatId: string, nextTickAt?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/resume`, nextTickAt === undefined ? {} : { nextTickAt }); }
  cancelHeartbeat(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/clear`, reason === undefined ? {} : { reason }); }
  createSchedule(sessionId: string, branchId: string, input: CreateScheduleInput): Promise<ScheduleHandle> { return this.#post(`/sessions/${sessionId}/schedules?branch=${branchId}`, input); }
  schedules(sessionId: string, branchId: string): Promise<ScheduleRecord[]> { return this.#json(`/sessions/${sessionId}/schedules?branch=${branchId}`); }
  wakes(sessionId: string, branchId: string, statuses?: readonly WakeRecord["status"][]): Promise<WakeRecord[]> { return this.#json(`/sessions/${sessionId}/schedules/wakes?branch=${branchId}${statuses?.length ? `&status=${statuses.join(",")}` : ""}`); }
  tickSchedule(scheduleId: string, at?: string): Promise<ScheduleHandle> { return this.#post(`/schedules/${scheduleId}/tick`, at === undefined ? {} : { at }); }
  pauseSchedule(scheduleId: string, reason?: string): Promise<ScheduleHandle> { return this.#post(`/schedules/${scheduleId}/pause`, reason === undefined ? {} : { reason }); }
  resumeSchedule(scheduleId: string, nextTickAt?: string): Promise<ScheduleHandle> { return this.#post(`/schedules/${scheduleId}/resume`, nextTickAt === undefined ? {} : { nextTickAt }); }
  clearSchedule(scheduleId: string, reason?: string): Promise<ScheduleHandle> { return this.#post(`/schedules/${scheduleId}/clear`, reason === undefined ? {} : { reason }); }

  memoryCreate(sessionId: string, branchId: string, input: CreateMemoryInput | string): Promise<HarnessRecord> { return this.#post(`/sessions/${sessionId}/memory?branch=${branchId}`, typeof input === "string" ? { text: input } : input); }
  memorySearch(sessionId: string, branchId: string, query: string, options: MemorySearchOptions = {}): Promise<MemorySearchResult> { const params = new URLSearchParams({ branch: branchId, query, ...(options.limit === undefined ? {} : { limit: String(options.limit) }), ...(options.scopes === undefined ? {} : { scopes: options.scopes.join(",") }), ...(options.statuses === undefined ? {} : { statuses: options.statuses.join(",") }), ...(options.tags === undefined ? {} : { tags: options.tags.join(",") }), ...(options.linkedEntryIds === undefined ? {} : { linkedEntryIds: options.linkedEntryIds.join(",") }), ...(options.since === undefined ? {} : { since: options.since }) }); return this.#json(`/sessions/${sessionId}/memory?${params}`); }
  memoryList(sessionId: string, branchId: string): Promise<HarnessRecord[]> { return this.#json(`/sessions/${sessionId}/memory/list?branch=${branchId}`); }
  requestRefinement(sessionId: string, branchId: string, input: StartRefinementReviewInput = {}): Promise<RefinementReviewRecord> { return this.#post(`/sessions/${sessionId}/refinement-reviews?branch=${branchId}`, input); }
  refinementReviews(sessionId?: string, branchId?: string, status?: string): Promise<RefinementReviewRecord[]> { const query = new URLSearchParams(); if (branchId) query.set("branch", branchId); if (status) query.set("status", status); return this.#json(sessionId ? `/sessions/${sessionId}/refinement-reviews?${query}` : `/refinement-reviews${status ? `?status=${encodeURIComponent(status)}` : ""}`); }
  refinementReview(sessionId: string, branchId: string, reviewId: string): Promise<RefinementReviewRecord> { return this.#json(`/sessions/${sessionId}/refinement-reviews/${reviewId}?branch=${branchId}`); }
  learningStatus(sessionId: string, branchId: string): Promise<LearningStatusView> { return this.#json(`/sessions/${sessionId}/learning/status?branch=${encodeURIComponent(branchId)}`); }
  learningHistory(sessionId: string, branchId: string, limit = 50): Promise<LearningHistoryView> { return this.#json(`/sessions/${sessionId}/learning/history?branch=${encodeURIComponent(branchId)}&limit=${limit}`); }
  learningActivity(sessionId: string, branchId: string, activityId: string): Promise<LearningActivity> { return this.#json(`/sessions/${sessionId}/learning/activities/${encodeURIComponent(activityId)}?branch=${encodeURIComponent(branchId)}`); }
  pauseAutomaticLearning(): Promise<RefinementTriggerPolicyV1> { return this.setAutomaticRefinement(false); }
  resumeAutomaticLearning(): Promise<RefinementTriggerPolicyV1> { return this.setAutomaticRefinement(true); }
  userCorrection(sessionId: string, branchId: string, correction: string, correctedEventIds: readonly string[]): Promise<{ correctionId: string }> { return this.#post(`/sessions/${sessionId}/user-corrections?branch=${branchId}`, { correction, correctedEventIds }); }
  refinementPolicy(): Promise<RefinementTriggerPolicyV1> { return this.#json("/refinement-policy"); }
  setAutomaticRefinement(enabled: boolean): Promise<RefinementTriggerPolicyV1> { return this.#put("/refinement-policy", { enabled }); }
  /** Advanced diagnostic: submit an already-formed governed proposal JSON document. */
  refine(sessionId: string, branchId: string, input: ProposeRefinementInput): Promise<RefinementProposalRecord> { return this.#post(`/sessions/${sessionId}/refinements?branch=${branchId}`, input); }
  validateRefinement(sessionId: string, branchId: string, proposalId: string): Promise<RefinementProposalRecord> { return this.#post(`/sessions/${sessionId}/refinements/${proposalId}/validate?branch=${branchId}`); }
  activateRefinement(sessionId: string, branchId: string, proposalId: string, input: ActivateCandidateInput = {}): Promise<RefinementProposalRecord> { return this.#post(`/sessions/${sessionId}/refinements/${proposalId}/activate?branch=${branchId}`, input); }
  allocateRefinement(sessionId: string, branchId: string, proposalId: string, input: Partial<AllocateCandidateInput> = {}): Promise<CandidateAllocationRecord> { return this.#post(`/sessions/${sessionId}/refinements/${proposalId}/allocate?branch=${branchId}`, input); }
  observeRefinement(sessionId: string, branchId: string, proposalId: string, input: RecordObservationInput): Promise<EvaluationObservationRecord> { return this.#post(`/sessions/${sessionId}/refinements/${proposalId}/observations?branch=${branchId}`, input); }
  decideRefinement(sessionId: string, branchId: string, proposalId: string, input: DecideRefinementInput = {}): Promise<RefinementDecisionRecord> { return this.#post(`/sessions/${sessionId}/refinements/${proposalId}/decide?branch=${branchId}`, input); }
  approveRefinement(sessionId: string, branchId: string, proposalId: string, scope: "user"|"global", approvedBy = "user", note?: string): Promise<RefinementProposalRecord> { return this.#post(`/sessions/${sessionId}/refinements/${proposalId}/approve?branch=${branchId}`, { scope, approvedBy, ...(note === undefined ? {} : { note }) }); }
  approveRollback(sessionId: string, branchId: string, proposalId: string, input: ApproveRollbackInput = {}): Promise<RefinementProposalRecord> { return this.#post(`/sessions/${sessionId}/refinements/${proposalId}/approve-rollback?branch=${branchId}`, input); }
  rollback(sessionId: string, branchId: string, proposalId: string, reason: string): Promise<RefinementProposalRecord> { return this.#post(`/sessions/${sessionId}/refinements/${proposalId}/rollback?branch=${branchId}`, { reason }); }
  refinements(status?: string): Promise<RefinementProposalRecord[]> { return this.#json(`/harness/refinements${status ? `?status=${encodeURIComponent(status)}` : ""}`); }
  harnessList(): Promise<HarnessRecord[]> { return this.#json("/harness"); }
  harnessHistory(entryId: string): Promise<HarnessVersionRecord[]> { return this.#json(`/harness/${entryId}/history`); }
  listSkills(sessionId:string,branchId:string,includeUnavailable=false):Promise<SkillManagementView[]>{return this.#json(`/sessions/${sessionId}/skills?branch=${branchId}&includeUnavailable=${includeUnavailable}`);}
  getSkill(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#json(`/sessions/${sessionId}/skills/${encodeURIComponent(reference)}?branch=${branchId}`);}
  previewSkillImport(sessionId:string,branchId:string,directory:string):Promise<SkillImportPreview>{return this.#post(`/sessions/${sessionId}/skills/preview-import?branch=${branchId}`,{directory});}
  installSkill(sessionId:string,branchId:string,input:InstallLocalSkillInput):Promise<SkillManagementView>{return this.#post(`/sessions/${sessionId}/skills/import?branch=${branchId}`,input);}
  proposeSkill(sessionId:string,branchId:string,instructions:string,scope:"local"|"workspace"="workspace"):Promise<RefinementReviewRecord>{return this.#post(`/sessions/${sessionId}/skills/propose?branch=${branchId}`,{instructions,scope});}
  enableSkill(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#post(`/sessions/${sessionId}/skills/${encodeURIComponent(reference)}/enable?branch=${branchId}`,{});}
  disableSkill(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#post(`/sessions/${sessionId}/skills/${encodeURIComponent(reference)}/disable?branch=${branchId}`,{});}
  removeSkill(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#post(`/sessions/${sessionId}/skills/${encodeURIComponent(reference)}/remove?branch=${branchId}`,{});}
  invokeSkill(sessionId: string, branchId: string, entryId: string, input: JsonValue, options: InvokeSkillOptions = {}): Promise<SkillInvocationResult> { return this.#post(`/sessions/${sessionId}/skills/${encodeURIComponent(entryId)}/invoke?branch=${branchId}`, { input, options }); }
  testSkill(sessionId: string, branchId: string, entryId: string): Promise<SkillTestReport> { return this.#post(`/sessions/${sessionId}/skills/${encodeURIComponent(entryId)}/test?branch=${branchId}`, {}); }
  async spawnSpec(sessionId: string, branchId: string, entryId: string, input: SpawnSpecInput = {}): Promise<SpecSubagentHandle> {
    const model = await this.#compatibleModel(input.model);
    return this.#post(`/sessions/${sessionId}/specs/${entryId}/spawn?branch=${branchId}`, { ...input, ...(model === undefined ? {} : { model }) });
  }

  syncStatus(): Promise<SyncStatusView> { return this.#json("/sync/status"); }
  syncNow(): Promise<SyncCycleResult> { return this.#post("/sync"); }
  syncReconnect(): Promise<SyncCycleResult> { return this.#post("/sync/reconnect"); }
  syncPush(): Promise<SyncPushResult> { return this.#post("/sync/push"); }
  syncPull(): Promise<SyncPullResult> { return this.#post("/sync/pull"); }
  syncCheckpoint(): Promise<SyncCheckpointResult> { return this.#post("/sync/checkpoint"); }
  syncStats(): Promise<SyncTransportStats> { return this.#json("/sync/stats"); }
  syncConflicts(status?: "unresolved"|"resolved"): Promise<SyncConflictRecord[]> { return this.#json(`/sync/conflicts${status?`?status=${status}`:""}`); }
  resolveSyncConflict(conflictId:string,input:ResolveConflictInput):Promise<SyncConflictRecord>{return this.#post(`/sync/conflicts/${conflictId}/resolve`,input);}
  cloudWorkspaces(refresh=false):Promise<WorkspaceAnnouncement[]>{return this.#json(`/sync/workspaces${refresh?"?refresh=1":""}`);}
  dataManifest(operation:"export"|"delete",scopeKind:"workspace"|"session"|"profile",scopeId:string,requestedBy:string):Promise<DataManifestRecord>{return this.#post("/sync/manifests",{operation,scopeKind,scopeId,requestedBy});}
  exportData(destination:string,scopeKind:"workspace"|"session"|"profile",scopeId:string,requestedBy:string):Promise<DataManifestRecord>{return this.#post("/sync/export",{destination,scopeKind,scopeId,requestedBy});}
  deleteOwnedData(input:DeleteOwnedDataInput):Promise<PhysicalDeletionReceipt>{return this.#post("/sync/delete",input);}

  async #waitForGeneration(sessionId: string, branchId: string, generationId: string, timeoutMs = 120_000): Promise<AiGenerationResult> {
    return this.#waitForBranchResult(
      sessionId,
      branchId,
      (state) => {
        const generation = state.aiGenerations[generationId];
        return generation !== undefined &&
          ["succeeded", "failed", "cancelled", "unknown", "budget_exceeded"].includes(generation.status);
      },
      () => this.generationResult(sessionId, branchId, generationId),
      timeoutMs,
    );
  }

  async #waitForBranchResult<T>(
    sessionId: string,
    branchId: string,
    terminal: (state: AgentState) => boolean,
    finalRead: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    let state: AgentState | undefined;
    const timer = setTimeout(
      () => controller.abort(new DOMException("Protocol terminal wait timed out", "TimeoutError")),
      timeoutMs,
    );
    try {
      await this.watchBranch(sessionId, branchId, {
        onSnapshot: (snapshot) => {
          state = snapshot.state;
          if (terminal(state)) controller.abort();
        },
        onEvent: (event) => {
          if (!state) return;
          state = reduceAgentState(state, event);
          if (terminal(state)) controller.abort();
        },
      }, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return finalRead();
  }

  #put<T>(path: string, value?: unknown): Promise<T> { return this.#json(path, { method: "PUT", ...(value === undefined ? {} : { body: JSON.stringify(value), headers: { "content-type": "application/json" } }) }); }
  #post<T>(path: string, value?: unknown): Promise<T> { return this.#json(path, { method: "POST", ...(value === undefined ? {} : { body: JSON.stringify(value), headers: { "content-type": "application/json" } }) }); }
  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const request = await this.#request(path, init);
    try {
      const response = request.response;
      if (!response.ok) throw await protocolError(response);
      try { return await response.json() as T; }
      catch { throw new ProtocolClientError("INVALID_RESPONSE", "Protocol response was not valid JSON", response.status); }
    } finally {
      request.release();
    }
  }
  async #request(path: string, init: RequestInit = {}): Promise<{ response: Response; release: () => void }> {
    const controller = new AbortController();
    const external = init.signal;
    const abort = (): void => controller.abort(external?.reason);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#pendingRequests.delete(controller);
      external?.removeEventListener("abort", abort);
    };
    if (external?.aborted) abort();
    else external?.addEventListener("abort", abort, { once: true });
    this.#pendingRequests.add(controller);
    try {
      return { response: await this.transport.request(path, { ...init, signal: controller.signal }), release };
    } catch (error) {
      release();
      throw error;
    }
  }
}

function assertWaitTimeout(timeoutMs: number | undefined, operation: string): void {
  if (timeoutMs === undefined) return;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 ||
      timeoutMs > MAX_AGENT_INVOCATION_WAIT_MS) {
    throw new ProtocolClientError(
      "VALIDATION_ERROR",
      `${operation} wait timeout must be from 0 to ${MAX_AGENT_INVOCATION_WAIT_MS}ms`,
      400,
    );
  }
}

async function protocolError(response: Response): Promise<ProtocolClientError> {
  let body: unknown = null;
  try { body = await response.json(); } catch { body = await response.text().catch(() => ""); }
  const candidate = body && typeof body === "object" && "error" in body
    ? (body as { error?: unknown }).error
    : body;
  if (candidate && typeof candidate === "object") {
    const value = candidate as Record<string, unknown>;
    if (typeof value.code === "string" && typeof value.message === "string") {
      return new ProtocolClientError(value.code, value.message, response.status, value.details ?? null);
    }
  }
  return new ProtocolClientError("PROTOCOL_ERROR", `Protocol request failed with HTTP ${response.status}`, response.status, body);
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || milliseconds <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function readProtocolStream(
  body: ReadableStream<Uint8Array>,
  onItem: (eventName: string, data: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let itemsSinceYield = 0;
  const dispatch = async (): Promise<void> => {
    if (dataLines.length) {
      await onItem(eventName, dataLines.join("\n"));
      itemsSinceYield++;
      if (itemsSinceYield >= PROTOCOL_STREAM_ITEMS_PER_TURN) {
        itemsSinceYield = 0;
        await yieldProtocolStreamTurn(signal);
      }
    }
    eventName = "message";
    dataLines = [];
  };
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") await dispatch();
        else if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "");
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) break;
    }
    if (buffer.startsWith("event:")) eventName = buffer.slice(6).replace(/^ /, "");
    else if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    await dispatch();
  } finally {
    signal?.removeEventListener("abort", abort);
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

async function yieldProtocolStreamTurn(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 0);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
