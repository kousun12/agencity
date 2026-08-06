import type {
  AgentEvent, AgentState, BudgetLimits, EffectOutcome, GoalGateStatus, GoalStatus,
  HeartbeatStatus, MailboxMessageKind, ModelConfiguration, NewAgentEvent,
  RecursiveModelStatus, TaskStatus,
} from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
export interface StorageCapabilities { readonly offlineWrites: boolean; readonly distributedLeases: boolean; readonly analyticalSql: boolean; readonly notifications: boolean; }
export interface EventQuery { readonly branchId?: string; readonly afterCursor?: string; readonly untilCursor?: string; }
export interface OutboxRecord { readonly effectId: string; readonly sessionId: string; readonly branchId: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotencyKey: string; readonly idempotent: boolean; readonly status: "pending"|"running"|EffectOutcome; readonly attempt: number; readonly owner: string | null; readonly leaseExpiresAt: string | null; }
export interface ReadonlyStatement { readonly sql: string; readonly args: readonly (string|number|bigint|null|Uint8Array)[]; }

export interface SessionRecord { readonly sessionId: string; readonly workspaceId: string; readonly initialBranchId: string; readonly parentSessionId: string | null; readonly parentBranchId: string | null; readonly rootSessionId: string; readonly depth: number; readonly taskId: string | null; readonly status: TaskStatus | null; }
export interface TaskRecord { readonly taskId: string; readonly parentSessionId: string; readonly parentBranchId: string; readonly childSessionId: string; readonly childBranchId: string; readonly task: string; readonly completionCriteria: string | null; readonly model: ModelConfiguration; readonly budget: BudgetLimits; readonly status: TaskStatus; readonly cancellationRequested: boolean; readonly result?: JsonValue; readonly artifactIds: string[]; readonly error?: string; readonly reason?: string; readonly createdAt: string; readonly updatedAt: string; }
export interface MailboxRecord { readonly mailboxMessageId: string; readonly fromSessionId: string; readonly fromBranchId: string; readonly toSessionId: string; readonly toBranchId: string; readonly kind: MailboxMessageKind; readonly content: string; readonly taskId: string | null; readonly delivered: boolean; readonly acknowledged: boolean; readonly sentAt: string; readonly deliveredAt: string | null; readonly acknowledgedAt: string | null; }
export interface DocumentRecord { readonly documentId: string; readonly sessionId: string; readonly branchId: string; readonly name: string; readonly mediaType: string; readonly size: number; readonly digest: string; readonly chunkCount: number; readonly createdAt: string; }
export interface DocumentChunkRecord { readonly chunkId: string; readonly documentId: string; readonly ordinal: number; readonly content: string; readonly size: number; readonly digest: string; }
export interface InputSetRecord { readonly inputSetId: string; readonly sessionId: string; readonly branchId: string; readonly name: string | null; readonly chunkIds: string[]; readonly metadata?: JsonValue; readonly createdAt: string; }
export interface GoalRecord { readonly goalId: string; readonly sessionId: string; readonly branchId: string; readonly description: string; readonly completionCriteria: string | null; readonly maxTurns: number | null; readonly status: GoalStatus; readonly completionRequestId: string | null; readonly completionWorkspaceId: string | null; readonly completionWorkspaceCursor: string | null; readonly completionPinRecorded: boolean; readonly reason?: string; readonly createdAt: string; readonly updatedAt: string; }
export interface GoalGateRecord { readonly gateId: string; readonly goalId: string; readonly name: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotent: boolean; readonly required: boolean; readonly status: GoalGateStatus; readonly effectId?: string; readonly output?: JsonValue; readonly error?: string; }
export interface HeartbeatRecord { readonly heartbeatId: string; readonly sessionId: string; readonly branchId: string; readonly intervalMs: number; readonly nextTickAt: string; readonly goalId: string | null; readonly payload?: JsonValue; readonly status: HeartbeatStatus; readonly tick: number; readonly lastFiredAt: string | null; }
export interface RecursiveModelRecord { readonly handleId: string; readonly taskId: string; readonly parentSessionId: string; readonly parentBranchId: string; readonly childSessionId: string; readonly childBranchId: string; readonly model: ModelConfiguration; readonly inputSetId: string | null; readonly status: RecursiveModelStatus; readonly resultMessageId?: string; readonly error?: string; readonly createdAt: string; readonly updatedAt: string; }

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

export interface AgentStorage {
 readonly name: string; readonly capabilities: StorageCapabilities;
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
}

export function requireRecursiveStorage(storage: AgentStorage): AgentStorage & RecursiveStorageOperations {
  const required: Array<keyof RecursiveStorageOperations> = ["getSession", "listChildren", "getTask", "findTaskByChild", "listTasks", "getMailboxMessage", "listMailboxMessages", "getDocument", "getDocumentChunk", "readDocumentChunks", "getInputSet", "getGoal", "listGoalGates", "getHeartbeat", "listDueHeartbeats", "getRecursiveModel", "listRecursiveModels", "rebuildOperationalProjections"];
  for (const method of required) if (typeof storage[method] !== "function") throw new Error(`${storage.name} does not implement recursive session storage operation ${method}`);
  return storage as AgentStorage & RecursiveStorageOperations;
}
