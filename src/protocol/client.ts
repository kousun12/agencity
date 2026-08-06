import type { AgentEvent, AgentState } from "../domain/index.ts";
import type { ModelProviderDescriptor } from "../executors/index.ts";
import type {
  CreateGoalInput, CreateHeartbeatInput, CreateScheduleInput, CreateInputSetInput, DocumentHandle, GoalHandle,
  HeartbeatHandle, ImportDocumentInput, InputSetHandle, RecursiveModelHandle, ScheduleHandle, SendMessageInput,
  SpawnAgentInput, StartRecursiveModelInput, SubagentHandle, CreateMemoryInput,
  ProposeRefinementInput, ActivateCandidateInput, AllocateCandidateInput, RecordObservationInput, DecideRefinementInput, ApproveRollbackInput,
  InvokeSkillOptions, SpawnSpecInput, SpecSubagentHandle, EffectProgressNotification,
  StartAgentRunInput, AgentRunResult, AgentRunUserResponse, FamilyListResult, MailboxListOptions, MailboxListResult, MailboxMessageHandle,
} from "../runtime/index.ts";
import type { CandidateAllocationRecord, EvaluationObservationRecord, HarnessRecord, HarnessVersionRecord, MemorySearchOptions, MemorySearchResult, RefinementDecisionRecord, RefinementProposalRecord, SkillInvocationResult, SkillTestReport, JsonValue } from "../domain/index.ts";
import type { DataManifestRecord, GoalGateEvaluationRecord, HeartbeatRecord, ScheduleRecord, SyncConflictRecord, TaskRecord, WakeRecord } from "../storage/index.ts";
import type { DeleteOwnedDataInput, PhysicalDeletionReceipt, ResolveConflictInput, SyncCheckpointResult, SyncCycleResult, SyncPullResult, SyncPushResult, SyncStatusView, SyncTransportStats, WorkspaceAnnouncement } from "../sync/index.ts";

export interface AgentStreamHandlers {
  readonly onEvent: (event: AgentEvent) => void;
  readonly onProgress?: (progress: EffectProgressNotification) => void;
}

export class AgentClient {
  constructor(readonly baseUrl: string, readonly bearerToken?: string) {}
  health(): Promise<{ ok: boolean; authenticated?: boolean; workspaceId?: string; instanceId?: string; appVersion?: string; protocolMin?: number; protocolMax?: number; configHash?: string }> { return this.#json("/health"); }
  serviceStatus(): Promise<unknown> { return this.#json("/service/status"); }
  shutdownService(): Promise<unknown> { return this.#post("/service/shutdown"); }
  serviceAgents(): Promise<any[]> { return this.#json("/service/agents"); }
  productSessions(): Promise<any[]> { return this.#json("/product/sessions"); }
  productSelect(target?: string, branchId?: string): Promise<{ sessionId: string; branchId: string }> { return this.#post("/product/select", { ...(target === undefined ? {} : { target }), ...(branchId === undefined ? {} : { branchId }) }); }
  productRename(sessionId: string, branchId: string | undefined, name: string): Promise<unknown> { return this.#post("/product/rename", { sessionId, ...(branchId === undefined ? {} : { branchId }), name }); }
  productConfig(): Promise<{ defaultModel: string | null; credentialReferences: unknown[] }> { return this.#json("/product/config"); }
  productSetModel(model: string | null): Promise<unknown> { return this.#post("/product/config/model", { model }); }
  productCredentialReference(provider: string, reference: string, label: string): Promise<unknown> { return this.#post("/product/config/credential-reference", { provider, reference, label }); }
  stopSession(sessionId: string, branchId: string, reason?: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/stop?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  modelProviders(): Promise<ModelProviderDescriptor[]> { return this.#json("/model-providers"); }
  createSession(workspaceId: string, options: { model?: unknown; budget?: unknown; sessionName?: string; branchName?: string } = {}): Promise<{ sessionId: string; branchId: string }> { return this.#post("/sessions", { workspaceId, ...options }); }
  snapshot(sessionId: string, branchId: string): Promise<{ cursor: string; state: AgentState }> { return this.#json(`/sessions/${sessionId}/snapshot?branch=${branchId}`); }
  message(sessionId: string, branchId: string, content: string): Promise<AgentEvent> { return this.#post(`/sessions/${sessionId}/messages?branch=${branchId}`, { content }); }
  startRun(sessionId: string, branchId: string, input: StartAgentRunInput | string): Promise<AgentRunResult> { return this.#post(`/sessions/${sessionId}/runs?branch=${branchId}`, typeof input === "string" ? { task: input } : input); }
  run(sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> { return this.#json(`/sessions/${sessionId}/runs/${runId}?branch=${branchId}`); }
  resumeRun(sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> { return this.#post(`/sessions/${sessionId}/runs/${runId}/resume?branch=${branchId}`); }
  respondToRun(sessionId: string, branchId: string, runId: string, requestId: string, input: AgentRunUserResponse | string): Promise<AgentRunResult> { return this.#post(`/sessions/${sessionId}/runs/${runId}/input/${requestId}?branch=${branchId}`, typeof input === "string" ? { response: input } : input); }
  cancelRun(sessionId: string, branchId: string, runId: string, reason?: string): Promise<AgentRunResult> { return this.#post(`/sessions/${sessionId}/runs/${runId}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  /** Retained diagnostic one-turn chat. Product tasks use startRun. */
  turn(sessionId: string, branchId: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/turns?branch=${branchId}`); }
  cell(sessionId: string, branchId: string, code: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/cells?branch=${branchId}`, { code }); }
  history(sessionId: string, branchId: string): Promise<AgentEvent[]> { return this.#json(`/sessions/${sessionId}/history?branch=${branchId}`); }
  async stream(
    sessionId: string,
    branchId: string,
    afterCursor: string,
    handlers: AgentStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/sessions/${sessionId}/stream?branch=${encodeURIComponent(branchId)}&after=${encodeURIComponent(afterCursor)}`,
      { ...(signal === undefined ? {} : { signal }), ...this.#authInit() },
    );
    if (!response.ok) throw new Error(await response.text());
    if (!response.body) throw new Error("Protocol stream response has no body");
    let cursor = afterCursor;
    try {
      await readProtocolStream(response.body, (eventName, data) => {
        const value = JSON.parse(data) as AgentEvent | EffectProgressNotification;
        if (eventName === "progress") {
          handlers.onProgress?.(value as EffectProgressNotification);
          return;
        }
        const event = value as AgentEvent;
        if (BigInt(event.cursor) <= BigInt(cursor)) return;
        cursor = event.cursor;
        handlers.onEvent(event);
      }, signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  }
  resume(sessionId:string,branchId:string):Promise<{sessionId:string;branchId:string;cursor:string}>{return this.#post(`/sessions/${sessionId}/resume?branch=${branchId}`);}
  compact(sessionId:string,branchId:string):Promise<{contextId:string;sourceEventIds:string[];summary:string}>{return this.#post(`/sessions/${sessionId}/compact?branch=${branchId}`);}

  spawn(sessionId: string, branchId: string, input: SpawnAgentInput | string): Promise<SubagentHandle> { return this.#post(`/sessions/${sessionId}/agents?branch=${branchId}`, typeof input === "string" ? { task: input } : input); }
  spawnMany(sessionId: string, branchId: string, inputs: readonly (SpawnAgentInput | string)[]): Promise<SubagentHandle[]> { return this.#post(`/sessions/${sessionId}/agents/batch?branch=${branchId}`, { inputs }); }
  tasks(sessionId: string, branchId: string): Promise<TaskRecord[]> { return this.#json(`/sessions/${sessionId}/tasks?branch=${branchId}`); }
  cancelTask(sessionId: string, branchId: string, taskId: string, reason?: string): Promise<TaskRecord> { return this.#post(`/sessions/${sessionId}/tasks/${taskId}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  agents(sessionId: string, branchId: string): Promise<FamilyListResult> { return this.#json(`/sessions/${sessionId}/agents?branch=${branchId}`); }
  sendMailbox(sessionId: string, branchId: string, input: SendMessageInput): Promise<MailboxMessageHandle> { return this.#post(`/sessions/${sessionId}/mailbox?branch=${branchId}`, input); }
  mailbox(sessionId: string, branchId: string, options: MailboxListOptions = {}): Promise<MailboxListResult> { const params = new URLSearchParams({ branch: branchId, ...(options.direction === undefined ? {} : { direction: options.direction }), ...(options.limit === undefined ? {} : { limit: String(options.limit) }), ...(options.before === undefined ? {} : { before: options.before }), ...(options.pendingOnly ? { pending: "1" } : {}) }); return this.#json(`/sessions/${sessionId}/mailbox?${params}`); }
  acknowledgeMailbox(sessionId: string, branchId: string, messageId: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/mailbox/${messageId}/ack?branch=${branchId}`); }
  followUpAgent(sessionId: string, branchId: string, target: string, content: string, options: Omit<SendMessageInput, "target" | "content" | "followUp"> = {}): Promise<MailboxMessageHandle> { return this.#post(`/sessions/${sessionId}/agents/${encodeURIComponent(target)}/follow-up?branch=${branchId}`, { ...options, content }); }
  cancelAgent(sessionId: string, branchId: string, target: string, reason?: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/agents/${encodeURIComponent(target)}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason }); }

  importDocument(sessionId: string, branchId: string, input: ImportDocumentInput): Promise<DocumentHandle> { return this.#post(`/sessions/${sessionId}/documents?branch=${branchId}`, input); }
  createInputSet(sessionId: string, branchId: string, input: CreateInputSetInput): Promise<InputSetHandle> { return this.#post(`/sessions/${sessionId}/input-sets?branch=${branchId}`, input); }
  startModel(sessionId: string, branchId: string, input: StartRecursiveModelInput | string): Promise<RecursiveModelHandle> { return this.#post(`/sessions/${sessionId}/models?branch=${branchId}`, typeof input === "string" ? { prompt: input } : input); }
  model(handleId: string): Promise<RecursiveModelHandle> { return this.#json(`/models/${handleId}`); }
  cancelModel(handleId: string, reason?: string): Promise<RecursiveModelHandle> { return this.#post(`/models/${handleId}/cancel`, reason === undefined ? {} : { reason }); }

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
  invokeSkill(sessionId: string, branchId: string, entryId: string, input: JsonValue, options: InvokeSkillOptions = {}): Promise<SkillInvocationResult> { return this.#post(`/sessions/${sessionId}/skills/${entryId}/invoke?branch=${branchId}`, { input, options }); }
  testSkill(sessionId: string, branchId: string, entryId: string, versionId?: string): Promise<SkillTestReport> { return this.#post(`/sessions/${sessionId}/skills/${entryId}/test?branch=${branchId}`, versionId === undefined ? {} : { versionId }); }
  spawnSpec(sessionId: string, branchId: string, entryId: string, input: SpawnSpecInput = {}): Promise<SpecSubagentHandle> { return this.#post(`/sessions/${sessionId}/specs/${entryId}/spawn?branch=${branchId}`, input); }

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

  #post<T>(path: string, value?: unknown): Promise<T> { return this.#json(path, { method: "POST", ...(value === undefined ? {} : { body: JSON.stringify(value), headers: { "content-type": "application/json" } }) }); }
  #authInit(): RequestInit { return this.bearerToken ? { headers: { authorization: `Bearer ${this.bearerToken}` } } : {}; }
  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (this.bearerToken) headers.set("authorization", `Bearer ${this.bearerToken}`);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    return body as T;
  }
}

async function readProtocolStream(
  body: ReadableStream<Uint8Array>,
  onItem: (eventName: string, data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  const dispatch = (): void => {
    if (dataLines.length) onItem(eventName, dataLines.join("\n"));
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
        if (line === "") dispatch();
        else if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "");
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) break;
    }
    if (buffer.startsWith("event:")) eventName = buffer.slice(6).replace(/^ /, "");
    else if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    dispatch();
  } finally {
    reader.releaseLock();
  }
}
