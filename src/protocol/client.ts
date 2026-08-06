import type { AgentEvent, AgentState } from "../domain/index.ts";
import type {
  CreateGoalInput, CreateHeartbeatInput, CreateInputSetInput, DocumentHandle, GoalHandle,
  HeartbeatHandle, ImportDocumentInput, InputSetHandle, RecursiveModelHandle, SendMessageInput,
  SpawnAgentInput, StartRecursiveModelInput, SubagentHandle, CreateMemoryInput,
  ProposeRefinementInput, ActivateCandidateInput, AllocateCandidateInput, RecordObservationInput, DecideRefinementInput, ApproveRollbackInput,
  InvokeSkillOptions, SpawnSpecInput, SpecSubagentHandle,
} from "../runtime/index.ts";
import type { CandidateAllocationRecord, EvaluationObservationRecord, HarnessRecord, HarnessVersionRecord, MemorySearchOptions, MemorySearchResult, RefinementDecisionRecord, RefinementProposalRecord, SkillInvocationResult, SkillTestReport, JsonValue } from "../domain/index.ts";
import type { DataManifestRecord, SyncConflictRecord, TaskRecord } from "../storage/index.ts";
import type { DeleteOwnedDataInput, PhysicalDeletionReceipt, ResolveConflictInput, SyncCheckpointResult, SyncCycleResult, SyncPullResult, SyncPushResult, SyncStatusView, SyncTransportStats, WorkspaceAnnouncement } from "../sync/index.ts";

export class AgentClient {
  constructor(readonly baseUrl: string) {}
  createSession(workspaceId: string): Promise<{ sessionId: string; branchId: string }> { return this.#post("/sessions", { workspaceId }); }
  snapshot(sessionId: string, branchId: string): Promise<{ cursor: string; state: AgentState }> { return this.#json(`/sessions/${sessionId}/snapshot?branch=${branchId}`); }
  message(sessionId: string, branchId: string, content: string): Promise<AgentEvent> { return this.#post(`/sessions/${sessionId}/messages?branch=${branchId}`, { content }); }
  turn(sessionId: string, branchId: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/turns?branch=${branchId}`); }
  cell(sessionId: string, branchId: string, code: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/cells?branch=${branchId}`, { code }); }
  history(sessionId: string, branchId: string): Promise<AgentEvent[]> { return this.#json(`/sessions/${sessionId}/history?branch=${branchId}`); }
  resume(sessionId:string,branchId:string):Promise<{sessionId:string;branchId:string;cursor:string}>{return this.#post(`/sessions/${sessionId}/resume?branch=${branchId}`);}
  compact(sessionId:string,branchId:string):Promise<{contextId:string;sourceEventIds:string[];summary:string}>{return this.#post(`/sessions/${sessionId}/compact?branch=${branchId}`);}

  spawn(sessionId: string, branchId: string, input: SpawnAgentInput | string): Promise<SubagentHandle> { return this.#post(`/sessions/${sessionId}/agents?branch=${branchId}`, typeof input === "string" ? { task: input } : input); }
  spawnMany(sessionId: string, branchId: string, inputs: readonly (SpawnAgentInput | string)[]): Promise<SubagentHandle[]> { return this.#post(`/sessions/${sessionId}/agents/batch?branch=${branchId}`, { inputs }); }
  tasks(sessionId: string, branchId: string): Promise<TaskRecord[]> { return this.#json(`/sessions/${sessionId}/tasks?branch=${branchId}`); }
  cancelTask(sessionId: string, branchId: string, taskId: string, reason?: string): Promise<TaskRecord> { return this.#post(`/sessions/${sessionId}/tasks/${taskId}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  sendMailbox(sessionId: string, branchId: string, input: SendMessageInput): Promise<unknown> { return this.#post(`/sessions/${sessionId}/mailbox?branch=${branchId}`, input); }
  acknowledgeMailbox(sessionId: string, branchId: string, messageId: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/mailbox/${messageId}/ack?branch=${branchId}`); }

  importDocument(sessionId: string, branchId: string, input: ImportDocumentInput): Promise<DocumentHandle> { return this.#post(`/sessions/${sessionId}/documents?branch=${branchId}`, input); }
  createInputSet(sessionId: string, branchId: string, input: CreateInputSetInput): Promise<InputSetHandle> { return this.#post(`/sessions/${sessionId}/input-sets?branch=${branchId}`, input); }
  startModel(sessionId: string, branchId: string, input: StartRecursiveModelInput | string): Promise<RecursiveModelHandle> { return this.#post(`/sessions/${sessionId}/models?branch=${branchId}`, typeof input === "string" ? { prompt: input } : input); }
  model(handleId: string): Promise<RecursiveModelHandle> { return this.#json(`/models/${handleId}`); }
  cancelModel(handleId: string, reason?: string): Promise<RecursiveModelHandle> { return this.#post(`/models/${handleId}/cancel`, reason === undefined ? {} : { reason }); }

  createGoal(sessionId: string, branchId: string, input: CreateGoalInput | string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals?branch=${branchId}`, typeof input === "string" ? { description: input } : input); }
  requestGoalCompletion(sessionId: string, branchId: string, goalId: string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/completion?branch=${branchId}`); }
  continueGoal(sessionId: string, branchId: string, goalId: string, maxTurns?: number): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/continue?branch=${branchId}`, maxTurns === undefined ? {} : { maxTurns }); }
  createHeartbeat(sessionId: string, branchId: string, input: CreateHeartbeatInput | number): Promise<HeartbeatHandle> { return this.#post(`/sessions/${sessionId}/heartbeats?branch=${branchId}`, typeof input === "number" ? { intervalMs: input } : input); }
  tickHeartbeat(heartbeatId: string, at?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/tick`, at === undefined ? {} : { at }); }
  pauseHeartbeat(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/pause`, reason === undefined ? {} : { reason }); }
  cancelHeartbeat(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/cancel`, reason === undefined ? {} : { reason }); }

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
  async #json<T>(path: string, init?: RequestInit): Promise<T> { const response = await fetch(`${this.baseUrl}${path}`, init); const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body as T; }
}
