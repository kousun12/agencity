import type {
  AgentEvent, AgentState, BudgetLimits, EffectOutcome, GoalGateStatus, GoalStatus,
  HeartbeatStatus, MailboxMessageKind, ModelConfiguration, NewAgentEvent,
  RecursiveModelOutcome, RecursiveModelStatus, TaskStatus,
} from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
export interface StorageCapabilities {
  readonly offlineWrites: boolean;
  /** Fences competing processes against one local canonical workspace store. */
  readonly sameDeviceProcessFencing: boolean;
  /** Coordinates owners across devices/placements. Local LibSQL truthfully reports false. */
  readonly distributedLeases: boolean;
  readonly analyticalSql: boolean;
  readonly notifications: boolean;
}
export interface EventQuery { readonly branchId?: string; readonly afterCursor?: string; readonly untilCursor?: string; }
export interface OutboxRecord { readonly effectId: string; readonly sessionId: string; readonly branchId: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotencyKey: string; readonly idempotent: boolean; readonly status: "pending"|"running"|EffectOutcome; readonly attempt: number; readonly owner: string | null; readonly leaseExpiresAt: string | null; }

export type ProcessExecutionLeaseScope =
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "root"; readonly rootSessionId: string };

/** Retained operational row. A new acquisition increments fenceToken; renewals do not. */
export interface ProcessExecutionLeaseRecord {
  readonly scope: ProcessExecutionLeaseScope;
  readonly workspaceId: string;
  readonly ownerDeviceId: string;
  readonly ownerProcessId: string;
  readonly fenceToken: number;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly leaseExpiresAt: string;
  readonly releasedAt: string | null;
}

export interface ProcessExecutionLeaseClaim {
  readonly scope: ProcessExecutionLeaseScope;
  readonly ownerDeviceId: string;
  readonly ownerProcessId: string;
  /** Caller-supplied time makes expiry decisions deterministic in tests and services. */
  readonly now: string;
  readonly leaseMs: number;
}

export interface ProcessExecutionLeaseProof {
  readonly scope: ProcessExecutionLeaseScope;
  readonly ownerDeviceId: string;
  readonly ownerProcessId: string;
  readonly fenceToken: number;
  readonly now: string;
}

export interface ProcessExecutionLeaseRenewal extends ProcessExecutionLeaseProof {
  readonly leaseMs: number;
}

export interface ProcessExecutionLeaseStorageOperations {
  getProcessExecutionLease(scope: ProcessExecutionLeaseScope): Promise<ProcessExecutionLeaseRecord | null>;
  claimProcessExecutionLease(input: ProcessExecutionLeaseClaim): Promise<ProcessExecutionLeaseRecord>;
  renewProcessExecutionLease(input: ProcessExecutionLeaseRenewal): Promise<ProcessExecutionLeaseRecord>;
  releaseProcessExecutionLease(input: ProcessExecutionLeaseProof): Promise<ProcessExecutionLeaseRecord>;
}
export interface ReadonlyStatement { readonly sql: string; readonly args: readonly (string|number|bigint|null|Uint8Array)[]; }

export interface SessionRecord { readonly sessionId: string; readonly workspaceId: string; readonly initialBranchId: string; readonly parentSessionId: string | null; readonly parentBranchId: string | null; readonly rootSessionId: string; readonly depth: number; readonly taskId: string | null; readonly status: TaskStatus | null; readonly executionOwnerDeviceId: string | null; }
export interface TaskRecord { readonly taskId: string; readonly parentSessionId: string; readonly parentBranchId: string; readonly childSessionId: string; readonly childBranchId: string; readonly task: string; readonly completionCriteria: string | null; readonly model: ModelConfiguration; readonly budget: BudgetLimits; readonly status: TaskStatus; readonly cancellationRequested: boolean; readonly result?: JsonValue; readonly artifactIds: string[]; readonly error?: string; readonly reason?: string; readonly createdAt: string; readonly updatedAt: string; }
export interface MailboxRecord { readonly mailboxMessageId: string; readonly fromSessionId: string; readonly fromBranchId: string; readonly toSessionId: string; readonly toBranchId: string; readonly kind: MailboxMessageKind; readonly content: string; readonly taskId: string | null; readonly artifactIds: string[]; readonly intentKey: string | null; readonly followUp: boolean; readonly replyToMessageId: string | null; readonly senderRelationship: import("../domain/index.ts").FamilyRelationship | null; readonly receiptStatus: import("../domain/index.ts").MailboxReceiptStatus; readonly delivered: boolean; readonly deliveredToContext: boolean; readonly acknowledged: boolean; readonly followUpRunId: string | null; readonly error: string | null; readonly sentAt: string; readonly deliveredAt: string | null; readonly contextDeliveredAt: string | null; readonly acknowledgedAt: string | null; }
export interface DocumentRecord { readonly documentId: string; readonly sessionId: string; readonly branchId: string; readonly name: string; readonly mediaType: string; readonly size: number; readonly digest: string; readonly chunkCount: number; readonly createdAt: string; }
export interface DocumentChunkRecord { readonly chunkId: string; readonly documentId: string; readonly ordinal: number; readonly content: string; readonly size: number; readonly digest: string; }
export interface InputSetRecord { readonly inputSetId: string; readonly sessionId: string; readonly branchId: string; readonly name: string | null; readonly chunkIds: string[]; readonly metadata?: JsonValue; readonly createdAt: string; }
export interface GoalRecord { readonly goalId: string; readonly sessionId: string; readonly branchId: string; readonly description: string; readonly completionCriteria: string | null; readonly maxTurns: number | null; readonly status: GoalStatus; readonly completionRequestId: string | null; readonly completionWorkspaceId: string | null; readonly completionWorkspaceCursor: string | null; readonly completionPinRecorded: boolean; readonly reason?: string; readonly createdAt: string; readonly updatedAt: string; }
export interface GoalGateRecord { readonly gateId: string; readonly goalId: string; readonly name: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotent: boolean; readonly required: boolean; readonly status: GoalGateStatus; readonly effectId?: string; readonly output?: JsonValue; readonly error?: string; }
export interface HeartbeatRecord { readonly heartbeatId: string; readonly sessionId: string; readonly branchId: string; readonly intervalMs: number; readonly nextTickAt: string; readonly goalId: string | null; readonly payload?: JsonValue; readonly status: HeartbeatStatus; readonly tick: number; readonly lastFiredAt: string | null; }
export interface RecursiveModelRecord { readonly handleId: string; readonly taskId: string; readonly parentSessionId: string; readonly parentBranchId: string; readonly childSessionId: string; readonly childBranchId: string; readonly model: ModelConfiguration; readonly inputSetId: string | null; readonly input?: JsonValue; readonly inputProvenance?: JsonValue; readonly inputHash?: string; readonly status: RecursiveModelStatus; readonly outcome?: RecursiveModelOutcome; readonly resultMessageId?: string; readonly result?: JsonValue; readonly resultArtifactId?: string; readonly error?: string; readonly createdAt: string; readonly updatedAt: string; }

/** Rebuildable Slice 2 projection reads. Optional for pre-Slice-2 third-party adapters. */
export interface RecursiveStorageOperations {
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listChildren(parentSessionId: string): Promise<SessionRecord[]>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  findTaskByChild(childSessionId: string): Promise<TaskRecord | null>;
  listTasks(parentSessionId: string, parentBranchId?: string): Promise<TaskRecord[]>;
  getMailboxMessage(messageId: string): Promise<MailboxRecord | null>;
  listMailboxMessages(sessionId: string, direction?: "inbound" | "outbound" | "all"): Promise<MailboxRecord[]>;
  getDocument(documentId: string): Promise<DocumentRecord | null>;
  getDocumentChunk(chunkId: string): Promise<DocumentChunkRecord | null>;
  readDocumentChunks(documentId: string, options?: { readonly start?: number; readonly limit?: number; readonly chunkIds?: readonly string[] }): Promise<DocumentChunkRecord[]>;
  getInputSet(inputSetId: string): Promise<InputSetRecord | null>;
  getGoal(goalId: string): Promise<GoalRecord | null>;
  listGoalGates(goalId: string): Promise<GoalGateRecord[]>;
  getHeartbeat(heartbeatId: string): Promise<HeartbeatRecord | null>;
  listDueHeartbeats(at: string): Promise<HeartbeatRecord[]>;
  getRecursiveModel(handleId: string): Promise<RecursiveModelRecord | null>;
  listRecursiveModels(statuses?: readonly RecursiveModelStatus[]): Promise<RecursiveModelRecord[]>;
  rebuildOperationalProjections(): Promise<void>;
}


export type SyncReplicaLifecycle = "local_only" | "offline" | "syncing" | "online" | "error" | "closed";
export interface SyncReplicaStatsRecord {
  readonly cdcOperations: number; readonly mainWalSize: number; readonly revertWalSize: number;
  readonly lastPullUnixTime: number | null; readonly lastPushUnixTime: number | null;
  readonly revision: string | null; readonly networkSentBytes: number; readonly networkReceivedBytes: number;
}
export interface WorkspaceReplicaStatusRecord {
  readonly replicaId: string; readonly replicaIncarnation: string | null;
  readonly workspaceId: string; readonly deviceId: string;
  /** Durable local placement evidence; never an authentication value. */
  readonly replicaUrl: string | null;
  readonly syncUrl: string | null; readonly credentialReference: string | null;
  readonly lifecycle: SyncReplicaLifecycle; readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null; readonly lastError: string | null;
  readonly lastStats: SyncReplicaStatsRecord | null;
  readonly stagedEnvelopes: number; readonly ingestedEnvelopes: number;
  readonly quarantinedEnvelopes: number; readonly updatedAt: string;
}
export interface SyncIngestReceiptRecord {
  readonly envelopeId: string; readonly digest: string; readonly originDeviceId: string;
  readonly originSequence: number; readonly eventId: string; readonly sourceBranchId: string;
  readonly mappedBranchId: string; readonly ingestedAt: string;
}
export interface SyncOriginWatermarkRecord {
  readonly replicaId: string; readonly originDeviceId: string;
  readonly stagedSequence: number; readonly ingestedSequence: number; readonly updatedAt: string;
}
export interface SyncQuarantineRecord {
  readonly envelopeId: string; readonly workspaceId: string; readonly originDeviceId: string | null;
  readonly originSequence: number | null; readonly reasonCode: string; readonly reason: string;
  readonly envelope: JsonValue; readonly digest: string | null;
  readonly status: "pending_dependency" | "quarantined" | "released";
  readonly firstSeenAt: string; readonly lastSeenAt: string;
}
export type SyncConflictKind = "duplicate_event" | "duplicate_intent" | "divergent_session" | "task_claim" | "rejected_mutation";
export interface SyncConflictRecord {
  readonly conflictId: string; readonly kind: SyncConflictKind; readonly workspaceId: string;
  readonly sessionId: string | null; readonly taskId: string | null; readonly eventIds: string[];
  readonly originDeviceIds: string[]; readonly details: JsonValue;
  readonly status: "unresolved" | "resolved"; readonly resolution?: JsonValue;
  readonly detectedAt: string; readonly resolvedAt: string | null;
}
export interface SyncBranchMappingRecord {
  readonly mappingId: string; readonly originDeviceId: string; readonly sessionId: string;
  readonly sourceBranchId: string; readonly forkEventId: string; readonly derivedBranchId: string;
  readonly lastSourceEventId: string | null; readonly createdAt: string;
}
export interface DataManifestRecord {
  readonly manifestId: string; readonly operation: "export" | "delete";
  readonly scopeKind: "workspace" | "session" | "profile"; readonly scopeId: string;
  readonly requestedBy: string; readonly owned: boolean; readonly resources: JsonValue;
  readonly replicaStatus: JsonValue; readonly status: "planned" | "completed" | "partial" | "blocked";
  readonly createdAt: string; readonly completedAt: string | null;
}

/** Result of the deliberately narrow, administrative physical session erasure path. */
export interface SessionErasureResult {
  readonly sessionId: string;
  readonly deletedEvents: number;
  readonly deletedRows: Readonly<Record<string, number>>;
}

/**
 * Optional local administrative operation. It is intentionally absent from the
 * ordinary domain contract and every remote relational RPC surface.
 */
export interface PhysicalDataControlStorageOperations {
  /** Non-mutating refusal check used before deleting external CAS objects. */
  assertIndependentSessionErasable(sessionId: string): Promise<void>;
  eraseIndependentSession(sessionId: string): Promise<SessionErasureResult>;
}

/** Private administrative operations used by the optional synchronization service. */
export interface SyncStorageOperations {
  readonly deviceId: string;
  listOriginEvents(deviceId: string, afterOriginSequence?: number): Promise<AgentEvent[]>;
  appendReplicatedEvent(event: NewAgentEvent): Promise<AgentEvent>;
  findEventByIntent(sessionId: string, type: string, idempotencyKey: string): Promise<AgentEvent | null>;
  findEventByOriginSequence(originDeviceId: string, originSequence: number): Promise<AgentEvent | null>;
  findTaskClaimEvents(taskId: string): Promise<AgentEvent[]>;
  getDirectBranchTip(sessionId: string, branchId: string): Promise<AgentEvent | null>;
  getEventCursor(eventId: string): Promise<string | null>;
  getReplicaStatus(replicaId: string): Promise<WorkspaceReplicaStatusRecord | null>;
  /** Enumerates every durable replica identity for a workspace, including inactive configurations. */
  listReplicaStatuses(workspaceId: string): Promise<WorkspaceReplicaStatusRecord[]>;
  putReplicaStatus(status: WorkspaceReplicaStatusRecord): Promise<void>;
  getSyncReceipt(envelopeId: string): Promise<SyncIngestReceiptRecord | null>;
  getSyncReceiptForEvent(eventId: string): Promise<SyncIngestReceiptRecord | null>;
  putSyncReceipt(receipt: SyncIngestReceiptRecord): Promise<void>;
  listSyncOriginWatermarks(replicaId: string): Promise<SyncOriginWatermarkRecord[]>;
  putSyncOriginWatermark(watermark: SyncOriginWatermarkRecord): Promise<void>;
  /** Clears only the local staging frontier after a replica file incarnation changes. */
  resetSyncStaging(replicaId: string): Promise<void>;
  getSyncQuarantine(envelopeId: string): Promise<SyncQuarantineRecord | null>;
  listSyncQuarantine(): Promise<SyncQuarantineRecord[]>;
  putSyncQuarantine(record: SyncQuarantineRecord): Promise<void>;
  getBranchMapping(originDeviceId: string, sessionId: string, sourceBranchId: string, sourceParentEventId: string): Promise<SyncBranchMappingRecord | null>;
  putBranchMapping(mapping: SyncBranchMappingRecord): Promise<void>;
  advanceBranchMapping(mappingId: string, lastSourceEventId: string): Promise<void>;
  listSyncConflicts(status?: "unresolved" | "resolved"): Promise<SyncConflictRecord[]>;
  putSyncConflict(conflict: SyncConflictRecord): Promise<void>;
  resolveSyncConflict(conflictId: string, resolution: JsonValue, resolvedAt: string): Promise<SyncConflictRecord>;
  putDataManifest(manifest: DataManifestRecord): Promise<void>;
  getDataManifest(manifestId: string): Promise<DataManifestRecord | null>;
  completeDataManifest(manifestId: string, status: "completed" | "partial" | "blocked", resources: JsonValue, completedAt: string): Promise<DataManifestRecord>;
}

export interface AgentStorage {
 readonly name: string; readonly capabilities: StorageCapabilities; readonly deviceId?: string;
 migrate(): Promise<void>; close(): void;
 appendEvents(events: readonly NewAgentEvent[]): Promise<AgentEvent[]>;
 loadEvents(sessionId: string, query?: EventQuery): Promise<AgentEvent[]>;
 getEvent(eventId: string): Promise<AgentEvent | null>;
 getLatestCursor(sessionId: string, branchId: string): Promise<string | null>;
 listBranches(): Promise<Array<{sessionId:string;branchId:string}>>;
 saveSnapshot(state: AgentState): Promise<void>;
 loadSnapshot(sessionId: string, branchId: string): Promise<AgentState | null>;
 deleteSnapshots(sessionId?: string): Promise<void>;
 claimOutbox(owner: string, limit?: number, leaseMs?: number): Promise<OutboxRecord[]>;
 claimEffect(effectId: string, owner: string, leaseMs?: number): Promise<OutboxRecord | null>;
 getOutbox(effectId: string): Promise<OutboxRecord | null>;
 listOutbox(statuses?: readonly OutboxRecord["status"][]): Promise<OutboxRecord[]>;
 resetOutbox(effectId: string): Promise<void>;
 readonlyQuery(statement: ReadonlyStatement): Promise<JsonValue[]>;
 onCommitted(listener: (events: readonly AgentEvent[]) => void): () => void;
 getProcessExecutionLease?: ProcessExecutionLeaseStorageOperations["getProcessExecutionLease"];
 claimProcessExecutionLease?: ProcessExecutionLeaseStorageOperations["claimProcessExecutionLease"];
 renewProcessExecutionLease?: ProcessExecutionLeaseStorageOperations["renewProcessExecutionLease"];
 releaseProcessExecutionLease?: ProcessExecutionLeaseStorageOperations["releaseProcessExecutionLease"];
 getSession?: RecursiveStorageOperations["getSession"];
 listChildren?: RecursiveStorageOperations["listChildren"];
 getTask?: RecursiveStorageOperations["getTask"];
 findTaskByChild?: RecursiveStorageOperations["findTaskByChild"];
 listTasks?: RecursiveStorageOperations["listTasks"];
 getMailboxMessage?: RecursiveStorageOperations["getMailboxMessage"];
 listMailboxMessages?: RecursiveStorageOperations["listMailboxMessages"];
 getDocument?: RecursiveStorageOperations["getDocument"];
 getDocumentChunk?: RecursiveStorageOperations["getDocumentChunk"];
 readDocumentChunks?: RecursiveStorageOperations["readDocumentChunks"];
 getInputSet?: RecursiveStorageOperations["getInputSet"];
 getGoal?: RecursiveStorageOperations["getGoal"];
 listGoalGates?: RecursiveStorageOperations["listGoalGates"];
 getHeartbeat?: RecursiveStorageOperations["getHeartbeat"];
 listDueHeartbeats?: RecursiveStorageOperations["listDueHeartbeats"];
 getRecursiveModel?: RecursiveStorageOperations["getRecursiveModel"];
 listRecursiveModels?: RecursiveStorageOperations["listRecursiveModels"];
 rebuildOperationalProjections?: RecursiveStorageOperations["rebuildOperationalProjections"];
 /** Rebuilds the disposable FTS5 candidate index from harness projections. */
 rebuildMemoryCandidateIndex?: () => Promise<void>;
 /** Local-only destructive administration; never exposed through generated code or relational RPC. */
 assertIndependentSessionErasable?: PhysicalDataControlStorageOperations["assertIndependentSessionErasable"];
 eraseIndependentSession?: PhysicalDataControlStorageOperations["eraseIndependentSession"];
}

export function requireRecursiveStorage(storage: AgentStorage): AgentStorage & RecursiveStorageOperations {
  const required: Array<keyof RecursiveStorageOperations> = ["getSession", "listChildren", "getTask", "findTaskByChild", "listTasks", "getMailboxMessage", "listMailboxMessages", "getDocument", "getDocumentChunk", "readDocumentChunks", "getInputSet", "getGoal", "listGoalGates", "getHeartbeat", "listDueHeartbeats", "getRecursiveModel", "listRecursiveModels", "rebuildOperationalProjections"];
  for (const method of required) if (typeof storage[method] !== "function") throw new Error(`${storage.name} does not implement recursive session storage operation ${method}`);
  return storage as AgentStorage & RecursiveStorageOperations;
}
