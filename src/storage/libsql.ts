import { createClient, type Client, type InValue, type Row, type Transaction } from "@libsql/client";
import type { AgentEvent, AgentState, EventPayloads, EventType, NewAgentEvent } from "../domain/index.ts";
import { CapabilityUnavailableError, ConflictError, ExecutionOwnershipConflictError, NotFoundError, ValidationError, newId, projectEvents, reduceAgentState, validateNewEvent } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type {
  AgentStorage, DocumentChunkRecord, DocumentRecord, EventQuery, GoalGateEvaluationRecord, GoalGateRecord, GoalRecord,
  HeartbeatRecord, InputSetRecord, MailboxRecord, OutboxRecord, ReadonlyStatement,
  RecursiveModelRecord, ScheduleRecord, SessionRecord, StorageCapabilities, TaskRecord, WakeRecord,
  ProcessExecutionLeaseClaim, ProcessExecutionLeaseProof, ProcessExecutionLeaseRecord,
  ProcessExecutionLeaseRenewal, ProcessExecutionLeaseScope,
  DataManifestRecord, SessionErasureResult, SyncBranchMappingRecord, SyncConflictRecord, SyncIngestReceiptRecord,
  SyncOriginWatermarkRecord, SyncQuarantineRecord, WorkspaceReplicaStatusRecord,
} from "./contract.ts";
import { containsBrokeredSecret } from "../security/index.ts";

const cursorOf = (sequence: number) => sequence.toString().padStart(20, "0");
const sequenceOf = (cursor: string) => { const n = Number(cursor); if (!Number.isSafeInteger(n) || n < 0) throw new ValidationError(`Invalid cursor: ${cursor}`); return n; };
function json(value: unknown): string { return JSON.stringify(value); }
function sha256(value: string): string { const hash = new Bun.CryptoHasher("sha256"); hash.update(value); return hash.digest("hex"); }
function valueToJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return String(value);
}
function rowToObject(row: Row): JsonValue { const result: Record<string, JsonValue> = {}; for (const key of Object.keys(row)) if (!/^\d+$/.test(key)) result[key] = valueToJson(row[key]); return result; }
function rowToEvent(row: Row): AgentEvent {
  const localSequence = Number(row.sequence);
  return { cursor: cursorOf(localSequence), id: String(row.id), sessionId: String(row.session_id), branchId: String(row.branch_id),
    causationId: row.causation_id === null ? null : String(row.causation_id), correlationId: row.correlation_id === null ? null : String(row.correlation_id),
    type: String(row.type) as EventType, schemaVersion: Number(row.schema_version), committedAt: String(row.committed_at), producer: String(row.producer),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key), payload: JSON.parse(String(row.payload_json)) as never,
    // Legacy rows predate Slice 4. Their stable event ID still deduplicates; the
    // fallback origin is never advertised as a real device identity.
    originDeviceId: row.origin_device_id === null || row.origin_device_id === undefined ? "legacy" : String(row.origin_device_id),
    originSequence: row.origin_sequence === null || row.origin_sequence === undefined ? localSequence : Number(row.origin_sequence),
    streamParentId: row.stream_parent_id === null || row.stream_parent_id === undefined ? null : String(row.stream_parent_id),
  };
}
function rowToOutbox(row: Row): OutboxRecord { return { effectId: String(row.effect_id), sessionId: String(row.session_id), branchId: String(row.branch_id), executor: String(row.executor), operation: String(row.operation), input: JSON.parse(String(row.input_json)) as JsonValue, idempotencyKey: String(row.idempotency_key), idempotent: Number(row.idempotent) === 1, status: String(row.status) as OutboxRecord["status"], attempt: Number(row.attempt), owner: row.owner === null ? null : String(row.owner), leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at) }; }
function leaseScopeParts(scope: ProcessExecutionLeaseScope): { scopeKind: "workspace" | "root"; scopeId: string } {
  const scopeKind = scope.kind;
  const scopeId = scopeKind === "workspace" ? scope.workspaceId : scope.rootSessionId;
  if (!scopeId.trim()) throw new ValidationError(`Execution lease ${scopeKind} scope ID is required`);
  return { scopeKind, scopeId };
}
function canonicalLeaseTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ValidationError("Execution lease time must be a valid timestamp");
  return parsed.toISOString();
}
function assertLeaseOwner(ownerDeviceId: string, ownerProcessId: string): void {
  if (!ownerDeviceId.trim()) throw new ValidationError("Execution lease owner device ID is required");
  if (!ownerProcessId.trim()) throw new ValidationError("Execution lease owner process ID is required");
}
function assertLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new ValidationError("Execution lease duration must be a positive safe integer");
  }
}
function assertFenceToken(fenceToken: number): void {
  if (!Number.isSafeInteger(fenceToken) || fenceToken < 1) {
    throw new ValidationError("Execution lease fence token must be a positive safe integer");
  }
}
function rowToProcessExecutionLease(row: Row): ProcessExecutionLeaseRecord {
  const scope = String(row.scope_kind) === "workspace"
    ? { kind: "workspace" as const, workspaceId: String(row.scope_id) }
    : { kind: "root" as const, rootSessionId: String(row.scope_id) };
  return {
    scope,
    workspaceId: String(row.workspace_id),
    ownerDeviceId: String(row.owner_device_id),
    ownerProcessId: String(row.owner_process_id),
    fenceToken: Number(row.fence_token),
    acquiredAt: String(row.acquired_at),
    renewedAt: String(row.renewed_at),
    leaseExpiresAt: String(row.lease_expires_at),
    releasedAt: row.released_at === null ? null : String(row.released_at),
  };
}
function optionalJson(row: Row, key: string): JsonValue | undefined { const value = row[key]; return value === null || value === undefined ? undefined : JSON.parse(String(value)) as JsonValue; }
function rowToSession(row: Row): SessionRecord { return { sessionId: String(row.session_id), workspaceId: String(row.workspace_id), initialBranchId: String(row.initial_branch_id), parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id), parentBranchId: row.parent_branch_id === null ? null : String(row.parent_branch_id), rootSessionId: row.root_session_id === null ? String(row.session_id) : String(row.root_session_id), depth: Number(row.depth), taskId: row.task_id === null ? null : String(row.task_id), status: row.task_status === null || row.task_status === undefined ? null : String(row.task_status) as SessionRecord["status"], executionOwnerDeviceId: row.execution_owner_device_id === null || row.execution_owner_device_id === undefined ? null : String(row.execution_owner_device_id) }; }
function rowToTask(row: Row): TaskRecord { const result = optionalJson(row, "result_json"); return { taskId: String(row.task_id), parentSessionId: String(row.parent_session_id), parentBranchId: String(row.parent_branch_id), childSessionId: String(row.child_session_id), childBranchId: String(row.child_branch_id), task: String(row.task_text), completionCriteria: row.completion_criteria === null ? null : String(row.completion_criteria), model: JSON.parse(String(row.model_json)), budget: JSON.parse(String(row.budget_json)), status: String(row.status) as TaskRecord["status"], cancellationRequested: Number(row.cancellation_requested) === 1, ...(result === undefined ? {} : { result }), artifactIds: JSON.parse(String(row.artifact_ids_json)) as string[], ...(row.error === null ? {} : { error: String(row.error) }), ...(row.reason === null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToMailbox(row: Row): MailboxRecord { const receiptStatus = (row.receipt_status === null || row.receipt_status === undefined ? (row.acknowledged_event_id !== null ? "acknowledged" : "delivered_to_context") : String(row.receipt_status)) as MailboxRecord["receiptStatus"]; return { mailboxMessageId: String(row.mailbox_message_id), fromSessionId: String(row.from_session_id), fromBranchId: String(row.from_branch_id), toSessionId: String(row.to_session_id), toBranchId: String(row.to_branch_id), kind: String(row.kind) as MailboxRecord["kind"], content: String(row.content), taskId: row.task_id === null ? null : String(row.task_id), artifactIds: row.artifact_ids_json === null || row.artifact_ids_json === undefined ? [] : JSON.parse(String(row.artifact_ids_json)) as string[], intentKey: row.intent_key === null || row.intent_key === undefined ? null : String(row.intent_key), followUp: Number(row.follow_up ?? 0) === 1, replyToMessageId: row.reply_to_message_id === null || row.reply_to_message_id === undefined ? null : String(row.reply_to_message_id), senderRelationship: row.sender_relationship === null || row.sender_relationship === undefined ? null : String(row.sender_relationship) as MailboxRecord["senderRelationship"], receiptStatus, delivered: row.delivered_event_id !== null, deliveredToContext: row.context_event_id !== null && row.context_event_id !== undefined || receiptStatus === "delivered_to_context" || receiptStatus === "acknowledged", acknowledged: row.acknowledged_event_id !== null, followUpRunId: row.follow_up_run_id === null || row.follow_up_run_id === undefined ? null : String(row.follow_up_run_id), error: row.delivery_error === null || row.delivery_error === undefined ? null : String(row.delivery_error), sentAt: String(row.sent_at), deliveredAt: row.delivered_at === null ? null : String(row.delivered_at), contextDeliveredAt: row.context_delivered_at === null || row.context_delivered_at === undefined ? null : String(row.context_delivered_at), acknowledgedAt: row.acknowledged_at === null ? null : String(row.acknowledged_at) }; }
function rowToDocument(row: Row): DocumentRecord { return { documentId: String(row.document_id), sessionId: String(row.session_id), branchId: String(row.branch_id), name: String(row.name), mediaType: String(row.media_type), size: Number(row.size), digest: String(row.digest), chunkCount: Number(row.chunk_count), createdAt: String(row.created_at) }; }
function rowToDocumentChunk(row: Row): DocumentChunkRecord { return { chunkId: String(row.chunk_id), documentId: String(row.document_id), ordinal: Number(row.ordinal), content: String(row.content), size: Number(row.size), digest: String(row.digest) }; }
function rowToGoal(row: Row): GoalRecord { return { goalId: String(row.goal_id), sessionId: String(row.session_id), branchId: String(row.branch_id), description: String(row.description), completionCriteria: row.completion_criteria === null ? null : String(row.completion_criteria), maxTurns: row.max_turns === null ? null : Number(row.max_turns), status: String(row.status) as GoalRecord["status"], completionRequestId: row.completion_request_id === null ? null : String(row.completion_request_id), completionWorkspaceId: row.completion_workspace_id === null || row.completion_workspace_id === undefined ? null : String(row.completion_workspace_id), completionWorkspaceCursor: row.completion_workspace_cursor === null || row.completion_workspace_cursor === undefined ? null : String(row.completion_workspace_cursor), completionMaterialVersion: row.completion_material_version === null || row.completion_material_version === undefined ? null : String(row.completion_material_version), completionMaterialEventIds: row.completion_material_event_ids_json === null || row.completion_material_event_ids_json === undefined ? [] : JSON.parse(String(row.completion_material_event_ids_json)), completionPinRecorded: Number(row.completion_pin_recorded ?? 0) === 1, ...(row.reason === null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToGoalGate(row: Row): GoalGateRecord { const output = optionalJson(row, "output_json"); return { gateId: String(row.gate_id), goalId: String(row.goal_id), name: String(row.name), executor: String(row.executor), operation: String(row.operation), input: JSON.parse(String(row.input_json)) as JsonValue, idempotent: Number(row.idempotent) === 1, required: Number(row.required) === 1, status: String(row.status) as GoalGateRecord["status"], ...(row.effect_id === null ? {} : { effectId: String(row.effect_id) }), ...(output === undefined ? {} : { output }), ...(row.error === null ? {} : { error: String(row.error) }), ...(row.current_evaluation_id === null || row.current_evaluation_id === undefined ? {} : { currentEvaluationId: String(row.current_evaluation_id) }) }; }
function rowToGoalGateEvaluation(row: Row): GoalGateEvaluationRecord { const output = optionalJson(row, "output_json"); return { evaluationId: String(row.evaluation_id), goalId: String(row.goal_id), gateId: String(row.gate_id), requestId: String(row.request_id), definitionHash: String(row.definition_hash), materialVersion: String(row.material_version), materialEventIds: JSON.parse(String(row.material_event_ids_json)), status: String(row.status) as GoalGateEvaluationRecord["status"], ...(row.effect_id === null ? {} : { effectId: String(row.effect_id) }), ...(output === undefined ? {} : { output }), ...(row.error === null ? {} : { error: String(row.error) }), ...(row.cached_from_evaluation_id === null ? {} : { cachedFromEvaluationId: String(row.cached_from_evaluation_id) }), eventId: String(row.event_id), createdAt: String(row.created_at) }; }
function rowToHeartbeat(row: Row): HeartbeatRecord { const payload = optionalJson(row, "payload_json"); return { heartbeatId: String(row.heartbeat_id), sessionId: String(row.session_id), branchId: String(row.branch_id), intervalMs: Number(row.interval_ms), nextTickAt: String(row.next_tick_at), goalId: row.goal_id === null ? null : String(row.goal_id), prompt: row.prompt === null || row.prompt === undefined ? null : String(row.prompt), ...(payload === undefined ? {} : { payload }), owner: String(row.owner ?? "user") as HeartbeatRecord["owner"], status: String(row.status) as HeartbeatRecord["status"], tick: Number(row.tick), lastFiredAt: row.last_fired_at === null ? null : String(row.last_fired_at) }; }
function rowToSchedule(row: Row): ScheduleRecord { return { scheduleId: String(row.schedule_id), sessionId: String(row.session_id), branchId: String(row.branch_id), kind: String(row.kind) as ScheduleRecord["kind"], prompt: String(row.prompt), intervalMs: row.interval_ms === null ? null : Number(row.interval_ms), nextTickAt: String(row.next_tick_at), owner: String(row.owner) as ScheduleRecord["owner"], goalMode: String(row.goal_mode) as ScheduleRecord["goalMode"], status: String(row.status) as ScheduleRecord["status"], tick: Number(row.tick), lastFiredAt: row.last_fired_at === null ? null : String(row.last_fired_at), ...(row.reason === null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToWake(row: Row): WakeRecord { return { wakeId: String(row.wake_id), sessionId: String(row.session_id), branchId: String(row.branch_id), sourceType: String(row.source_type) as WakeRecord["sourceType"], sourceId: String(row.source_id), tick: Number(row.tick), scheduledAt: String(row.scheduled_at), firedAt: String(row.fired_at), prompt: String(row.prompt), goalId: row.goal_id === null ? null : String(row.goal_id), goalMode: String(row.goal_mode) as WakeRecord["goalMode"], status: String(row.status) as WakeRecord["status"], claimId: row.claim_id === null ? null : String(row.claim_id), claimedAt: row.claimed_at === null ? null : String(row.claimed_at), runId: row.run_id === null ? null : String(row.run_id), deliveredAt: row.delivered_at === null ? null : String(row.delivered_at), ...(row.reason === null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToRecursiveModel(row: Row): RecursiveModelRecord { const input = optionalJson(row, "input_json"); const inputProvenance = optionalJson(row, "input_provenance_json"); const result = optionalJson(row, "result_json"); return { handleId: String(row.handle_id), taskId: String(row.task_id), parentSessionId: String(row.parent_session_id), parentBranchId: String(row.parent_branch_id), childSessionId: String(row.child_session_id), childBranchId: String(row.child_branch_id), model: JSON.parse(String(row.model_json)), inputSetId: row.input_set_id === null ? null : String(row.input_set_id), ...(input === undefined ? {} : { input }), ...(inputProvenance === undefined ? {} : { inputProvenance }), ...(row.input_hash === null || row.input_hash === undefined ? {} : { inputHash: String(row.input_hash) }), status: String(row.status) as RecursiveModelRecord["status"], ...(row.outcome === null || row.outcome === undefined ? {} : { outcome: String(row.outcome) as NonNullable<RecursiveModelRecord["outcome"]> }), ...(row.result_message_id === null ? {} : { resultMessageId: String(row.result_message_id) }), ...(result === undefined ? {} : { result }), ...(row.result_artifact_id === null || row.result_artifact_id === undefined ? {} : { resultArtifactId: String(row.result_artifact_id) }), ...(row.error === null ? {} : { error: String(row.error) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToReplicaStatus(row: Row): WorkspaceReplicaStatusRecord { return {
  replicaId:String(row.replica_id), replicaIncarnation:row.replica_incarnation===null?null:String(row.replica_incarnation),
  workspaceId:String(row.workspace_id), deviceId:String(row.device_id),
  replicaUrl:row.replica_url===null||row.replica_url===undefined?null:String(row.replica_url),
  syncUrl:row.sync_url===null?null:String(row.sync_url), credentialReference:row.credential_reference===null?null:String(row.credential_reference),
  lifecycle:String(row.lifecycle) as WorkspaceReplicaStatusRecord["lifecycle"], lastAttemptAt:row.last_attempt_at===null?null:String(row.last_attempt_at),
  lastSuccessAt:row.last_success_at===null?null:String(row.last_success_at), lastError:row.last_error===null?null:String(row.last_error),
  lastStats:row.last_stats_json===null?null:JSON.parse(String(row.last_stats_json)),
  stagedEnvelopes:Number(row.staged_envelopes), ingestedEnvelopes:Number(row.ingested_envelopes), quarantinedEnvelopes:Number(row.quarantined_envelopes), updatedAt:String(row.updated_at),
}; }
function rowToReceipt(row: Row): SyncIngestReceiptRecord { return { envelopeId:String(row.envelope_id),digest:String(row.digest),originDeviceId:String(row.origin_device_id),originSequence:Number(row.origin_sequence),eventId:String(row.event_id),sourceBranchId:String(row.source_branch_id),mappedBranchId:String(row.mapped_branch_id),ingestedAt:String(row.ingested_at) }; }
function rowToOriginWatermark(row: Row): SyncOriginWatermarkRecord { return { replicaId:String(row.replica_id),originDeviceId:String(row.origin_device_id),stagedSequence:Number(row.staged_sequence),ingestedSequence:Number(row.ingested_sequence),updatedAt:String(row.updated_at) }; }
function rowToQuarantine(row: Row): SyncQuarantineRecord { return { envelopeId:String(row.envelope_id),workspaceId:String(row.workspace_id),originDeviceId:row.origin_device_id===null?null:String(row.origin_device_id),originSequence:row.origin_sequence===null?null:Number(row.origin_sequence),reasonCode:String(row.reason_code),reason:String(row.reason),envelope:JSON.parse(String(row.envelope_json)) as JsonValue,digest:row.digest===null?null:String(row.digest),status:String(row.status) as SyncQuarantineRecord["status"],firstSeenAt:String(row.first_seen_at),lastSeenAt:String(row.last_seen_at) }; }
function rowToMapping(row: Row): SyncBranchMappingRecord { return { mappingId:String(row.mapping_id),originDeviceId:String(row.origin_device_id),sessionId:String(row.session_id),sourceBranchId:String(row.source_branch_id),forkEventId:String(row.fork_event_id),derivedBranchId:String(row.derived_branch_id),lastSourceEventId:row.last_source_event_id===null?null:String(row.last_source_event_id),createdAt:String(row.created_at) }; }
function rowToSyncConflict(row: Row): SyncConflictRecord { const resolution=row.resolution_json===null?undefined:JSON.parse(String(row.resolution_json)) as JsonValue; return { conflictId:String(row.conflict_id),kind:String(row.kind) as SyncConflictRecord["kind"],workspaceId:String(row.workspace_id),sessionId:row.session_id===null?null:String(row.session_id),taskId:row.task_id===null?null:String(row.task_id),eventIds:JSON.parse(String(row.event_ids_json)) as string[],originDeviceIds:JSON.parse(String(row.origin_device_ids_json)) as string[],details:JSON.parse(String(row.details_json)) as JsonValue,status:String(row.status) as SyncConflictRecord["status"],...(resolution===undefined?{}:{resolution}),detectedAt:String(row.detected_at),resolvedAt:row.resolved_at===null?null:String(row.resolved_at) }; }
function rowToManifest(row: Row): DataManifestRecord { return { manifestId:String(row.manifest_id),operation:String(row.operation) as DataManifestRecord["operation"],scopeKind:String(row.scope_kind) as DataManifestRecord["scopeKind"],scopeId:String(row.scope_id),requestedBy:String(row.requested_by),owned:Number(row.owned)===1,resources:JSON.parse(String(row.resources_json)) as JsonValue,replicaStatus:JSON.parse(String(row.replica_status_json)) as JsonValue,status:String(row.status) as DataManifestRecord["status"],createdAt:String(row.created_at),completedAt:row.completed_at===null?null:String(row.completed_at) }; }

class LocalWriteQueue {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try { return await operation(); }
    finally { release(); }
  }
}

export interface LibSqlStorageOptions {
  readonly url: string;
  /** Stable identity supplied by the separate profile database. */
  readonly deviceId?: string;
}
export class LibSqlStorage implements AgentStorage {
  readonly name = "libsql";
  readonly capabilities: StorageCapabilities = { offlineWrites: true, sameDeviceProcessFencing: true, distributedLeases: false, analyticalSql: true, notifications: true };
  readonly #client: Client;
  readonly #config: { readonly url:string };
  readonly #listeners = new Set<(events: readonly AgentEvent[]) => void>();
  readonly #writes = new LocalWriteQueue();
  readonly #deviceIdSupplied: boolean;
  #deviceId: string;
  #closed = false;
  constructor(options: LibSqlStorageOptions | string) {
    const supplied = typeof options === "string" ? { url: options } : options;
    const { deviceId, url } = supplied;
    this.#config = {url};
    this.#deviceIdSupplied = deviceId !== undefined;
    this.#deviceId = deviceId ?? newId();
    this.#client = createClient(this.#config);
  }
  get deviceId(): string { return this.#deviceId; }
  async migrate(): Promise<void> {
    // Migration files are immutable. Apply each once so ALTER statements remain
    // safe when a runtime reopens an existing local database.
    await this.#client.execute("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const migrations = [
      { version: 1, name: "initial", url: new URL("./migrations/001_initial.sql", import.meta.url) },
      { version: 2, name: "recursive-sessions", url: new URL("./migrations/002_recursive_sessions.sql", import.meta.url) },
      { version: 3, name: "slice2-review-hardening", url: new URL("./migrations/003_slice2_review_hardening.sql", import.meta.url) },
      { version: 4, name: "relational-memory-refinement", url: new URL("./migrations/004_relational_memory_refinement.sql", import.meta.url) },
      { version: 5, name: "turso-cloud-sync", url: new URL("./migrations/005_turso_cloud_sync.sql", import.meta.url) },
      { version: 6, name: "data-control-evidence", url: new URL("./migrations/006_data_control_evidence.sql", import.meta.url) },
      { version: 7, name: "recursive-model-input-results", url: new URL("./migrations/007_recursive_model_input_results.sql", import.meta.url) },
      { version: 8, name: "process-execution-leases", url: new URL("./migrations/008_process_execution_leases.sql", import.meta.url) },
      { version: 9, name: "retained-family-messaging", url: new URL("./migrations/009_retained_family_messaging.sql", import.meta.url) },
      { version: 10, name: "autonomous-goals-schedules", url: new URL("./migrations/010_autonomous_goals_schedules.sql", import.meta.url) },
    ];
    for (const migration of migrations) {
      const applied = await this.#client.execute({ sql: "SELECT version FROM schema_migrations WHERE version=?", args: [migration.version] });
      if (applied.rows.length) continue;
      await this.#client.executeMultiple(await Bun.file(migration.url).text());
      await this.#client.execute({ sql: "INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)", args: [migration.version, migration.name, new Date().toISOString()] });
    }
    // A directly-opened adapter still gets a restart-stable identity. Normal
    // Supervisor composition supplies the identity from ProfileStore instead.
    const clocks = await this.#client.execute("SELECT device_id FROM device_clocks ORDER BY rowid LIMIT 1");
    if (clocks.rows[0] && !this.#deviceIdSupplied) this.#deviceId = String(clocks.rows[0].device_id);
    await this.#client.execute({
      sql: "INSERT INTO device_clocks(device_id,next_sequence) SELECT ?,COALESCE(max(sequence),0)+1 FROM events WHERE true ON CONFLICT(device_id) DO NOTHING",
      args: [this.#deviceId],
    });
  }
  close(): void { if (this.#closed) return; this.#closed = true; this.#client.close(); }
  onCommitted(listener: (events: readonly AgentEvent[]) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async appendEvents(rawEvents: readonly NewAgentEvent[]): Promise<AgentEvent[]> {
    if (rawEvents.length === 0) return [];
    for (const event of rawEvents) validateNewEvent(event);
    // Local commands reject actual known credential values rather than
    // silently changing canonical payloads. Executor outputs/logs are redacted
    // by their runtime boundary before they reach this final guard.
    for (const event of rawEvents) {
      if (containsBrokeredSecret(event.payload as JsonValue)) {
        throw new ValidationError("Brokered credentials cannot enter canonical history");
      }
    }
    return this.#writes.run(async () => {
      const tx = await this.#client.transaction("write"); const committed: AgentEvent[] = [];
      try {
        for (const candidate of rawEvents) committed.push(await this.#appendOne(tx, candidate));
        await tx.commit();
      } catch (error) { if (!tx.closed) await tx.rollback(); throw error; } finally { tx.close(); }
      for (const listener of this.#listeners) listener(committed);
      return committed;
    });
  }
  async #appendOne(tx: Transaction, candidate: NewAgentEvent): Promise<AgentEvent> {
    const id = candidate.id ?? newId();
    const byId = await tx.execute({ sql: "SELECT * FROM events WHERE id=?", args: [id] });
    if (byId.rows[0]) {
      const existing = rowToEvent(byId.rows[0]);
      if (existing.sessionId !== candidate.sessionId || existing.branchId !== candidate.branchId ||
          existing.type !== candidate.type || json(existing.payload) !== json(candidate.payload)) {
        throw new ConflictError("Event ID reused with different durable meaning", { eventId: id });
      }
      return existing;
    }
    if (candidate.idempotencyKey) {
      const found = await tx.execute({ sql: "SELECT * FROM events WHERE session_id=? AND type=? AND idempotency_key=?", args: [candidate.sessionId, candidate.type, candidate.idempotencyKey] });
      const row = found.rows[0];
      if (row) {
        const existing = rowToEvent(row);
        if (json(existing.payload) !== json(candidate.payload) || existing.branchId !== candidate.branchId) throw new ConflictError("Idempotency key reused with a different event", { idempotencyKey: candidate.idempotencyKey });
        return existing;
      }
    }
    const replicated = candidate.originDeviceId !== undefined || candidate.originSequence !== undefined;
    if (replicated && (!candidate.originDeviceId || !Number.isSafeInteger(candidate.originSequence) || candidate.originSequence! < 1)) {
      throw new ValidationError("Replicated event origin requires a device ID and positive safe sequence");
    }
    const originDeviceId = candidate.originDeviceId ?? this.#deviceId;
    const originSequence = candidate.originSequence ?? await this.#nextOriginSequence(tx, originDeviceId);
    const committedAt = candidate.committedAt ?? new Date().toISOString();
    const streamParentId = candidate.streamParentId !== undefined
      ? candidate.streamParentId
      : await this.#findStreamParent(tx, candidate);
    const pending: AgentEvent = {
      cursor: "99999999999999999999",
      id,
      sessionId: candidate.sessionId,
      branchId: candidate.branchId,
      causationId: candidate.causationId ?? null,
      correlationId: candidate.correlationId ?? null,
      type: candidate.type,
      schemaVersion: candidate.schemaVersion ?? 1,
      committedAt,
      producer: candidate.producer,
      idempotencyKey: candidate.idempotencyKey ?? null,
      payload: candidate.payload as never,
      originDeviceId,
      originSequence,
      streamParentId,
    };
    await this.#validateCanonicalAppend(tx, pending);
    const result = await tx.execute({ sql: `INSERT INTO events(id,session_id,branch_id,causation_id,correlation_id,type,schema_version,committed_at,producer,idempotency_key,payload_json,origin_device_id,origin_sequence,stream_parent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id,candidate.sessionId,candidate.branchId,candidate.causationId ?? null,candidate.correlationId ?? null,candidate.type,candidate.schemaVersion ?? 1,committedAt,candidate.producer,candidate.idempotencyKey ?? null,json(candidate.payload),originDeviceId,originSequence,streamParentId] });
    const event: AgentEvent = { ...pending, cursor: cursorOf(Number(result.lastInsertRowid)) };
    await this.#applyOperationalRows(tx, event);
    return event;
  }

  async #nextOriginSequence(tx: Transaction, deviceId: string): Promise<number> {
    await tx.execute({ sql: "INSERT INTO device_clocks(device_id,next_sequence) VALUES(?,1) ON CONFLICT(device_id) DO NOTHING", args: [deviceId] });
    const result = await tx.execute({ sql: "UPDATE device_clocks SET next_sequence=next_sequence+1 WHERE device_id=? RETURNING next_sequence-1 AS allocated", args: [deviceId] });
    const allocated = Number(result.rows[0]?.allocated);
    if (!Number.isSafeInteger(allocated) || allocated < 1) throw new ValidationError("Device origin sequence exhausted");
    return allocated;
  }

  async #findStreamParent(tx: Transaction, candidate: NewAgentEvent): Promise<string | null> {
    if (candidate.type === "SessionCreated") return null;
    if (candidate.type === "BranchCreated") {
      const forkCursor = (candidate.payload as EventPayloads["BranchCreated"]).forkCursor;
      const fork = await tx.execute({ sql: "SELECT id FROM events WHERE sequence=?", args: [sequenceOf(forkCursor)] });
      return fork.rows[0] ? String(fork.rows[0].id) : null;
    }
    const result = await tx.execute({
      sql: "SELECT id FROM events WHERE session_id=? AND branch_id=? ORDER BY sequence DESC LIMIT 1",
      args: [candidate.sessionId, candidate.branchId],
    });
    return result.rows[0] ? String(result.rows[0].id) : null;
  }

  /**
   * Validates local canonical commands against the projected state before the
   * insert. A future sync adapter may quarantine remote invalid history instead;
   * it must not bypass this local command path and poison ordinary projections.
   */
  async #validateCanonicalAppend(tx: Transaction, event: AgentEvent): Promise<void> {
    const session = await tx.execute({
      sql: "SELECT session_id FROM sessions WHERE session_id=?",
      args: [event.sessionId],
    });
    const sessionExists = session.rows.length > 0;

    if (event.type === "SessionCreated") {
      const payload = event.payload as EventPayloads["SessionCreated"];
      if (sessionExists) throw new ConflictError("Session already exists", { sessionId: event.sessionId });
      if (event.branchId !== payload.initialBranchId) throw new ValidationError("SessionCreated branch must equal initialBranchId");
      const hasParent = payload.parentSessionId !== undefined || payload.parentBranchId !== undefined || payload.taskId !== undefined;
      if (hasParent) {
        if (!payload.parentSessionId || !payload.parentBranchId || !payload.taskId || !payload.rootSessionId || payload.depth === undefined) {
          throw new ValidationError("Child SessionCreated requires complete ancestry and task fields");
        }
        const parent = await tx.execute({ sql: "SELECT * FROM sessions WHERE session_id=?", args: [payload.parentSessionId] });
        const parentRow = parent.rows[0];
        if (!parentRow) throw new NotFoundError("parent session", payload.parentSessionId);
        const parentBranch = await tx.execute({ sql: "SELECT branch_id FROM branches WHERE session_id=? AND branch_id=?", args: [payload.parentSessionId, payload.parentBranchId] });
        if (!parentBranch.rows.length) throw new NotFoundError("parent branch", `${payload.parentSessionId}/${payload.parentBranchId}`);
        const expectedRoot = parentRow.root_session_id === null ? String(parentRow.session_id) : String(parentRow.root_session_id);
        if (payload.rootSessionId !== expectedRoot || payload.depth !== Number(parentRow.depth) + 1) throw new ValidationError("Child session ancestry does not match its parent");
        const task = await tx.execute({ sql: "SELECT child_session_id,child_branch_id,parent_session_id,parent_branch_id FROM tasks WHERE task_id=?", args: [payload.taskId] });
        const taskRow = task.rows[0];
        if (!taskRow || String(taskRow.child_session_id) !== event.sessionId || String(taskRow.child_branch_id) !== event.branchId || String(taskRow.parent_session_id) !== payload.parentSessionId || String(taskRow.parent_branch_id) !== payload.parentBranchId) throw new ValidationError("Child session does not match its durable task admission");
      } else if (payload.rootSessionId !== undefined && payload.rootSessionId !== event.sessionId || payload.depth !== undefined && payload.depth !== 0) {
        throw new ValidationError("Root session ancestry is invalid");
      }
      reduceAgentState(undefined, event);
      return;
    }
    if (!sessionExists) throw new NotFoundError("session", event.sessionId);

    if (event.type === "BranchCreated") {
      const payload = event.payload as EventPayloads["BranchCreated"];
      if (event.branchId !== payload.branchId) {
        throw new ValidationError("BranchCreated event branch must equal payload branchId");
      }
      const target = await tx.execute({
        sql: "SELECT branch_id FROM branches WHERE session_id=? AND branch_id=?",
        args: [event.sessionId, event.branchId],
      });
      if (target.rows.length) {
        throw new ConflictError("Branch already exists", { sessionId: event.sessionId, branchId: event.branchId });
      }
      const parent = await tx.execute({
        sql: "SELECT branch_id FROM branches WHERE session_id=? AND branch_id=?",
        args: [event.sessionId, payload.parentBranchId],
      });
      if (!parent.rows.length) throw new NotFoundError("branch", `${event.sessionId}/${payload.parentBranchId}`);
      const history = await this.#loadBranchEvents(tx, event.sessionId, payload.parentBranchId, payload.forkCursor);
      if (!history.length || history.at(-1)?.cursor !== payload.forkCursor) {
        throw new ValidationError("Fork cursor is not in the parent branch history");
      }
      reduceAgentState(projectEvents(history), event);
      return;
    }

    const branch = await tx.execute({
      sql: "SELECT branch_id FROM branches WHERE session_id=? AND branch_id=?",
      args: [event.sessionId, event.branchId],
    });
    if (!branch.rows.length) throw new NotFoundError("branch", `${event.sessionId}/${event.branchId}`);
    if (event.type === "TaskCreated") {
      const payload = event.payload as EventPayloads["TaskCreated"];
      if (payload.parentSessionId !== event.sessionId || payload.parentBranchId !== event.branchId) throw new ValidationError("Task event must be appended to its parent branch");
      const child = await tx.execute({ sql: "SELECT session_id FROM sessions WHERE session_id=?", args: [payload.childSessionId] });
      if (child.rows.length) throw new ConflictError("Child session already exists", { childSessionId: payload.childSessionId });
    }
    if (event.type === "MailboxMessageSent") {
      const payload = event.payload as EventPayloads["MailboxMessageSent"];
      if (payload.fromSessionId !== event.sessionId || payload.fromBranchId !== event.branchId) throw new ValidationError("Mailbox send event must be appended by its sender");
      const target = await tx.execute({ sql: "SELECT branch_id FROM branches WHERE session_id=? AND branch_id=?", args: [payload.toSessionId, payload.toBranchId] });
      if (!target.rows.length) throw new NotFoundError("mailbox target", `${payload.toSessionId}/${payload.toBranchId}`);
    }
    if (event.type === "MailboxMessageDelivered") {
      const payload = event.payload as EventPayloads["MailboxMessageDelivered"];
      if (payload.toSessionId !== event.sessionId || payload.toBranchId !== event.branchId) throw new ValidationError("Mailbox delivery event must be appended to its recipient");
      const sent = await tx.execute({ sql: "SELECT e.id,e.payload_json FROM events e WHERE e.id=? AND e.type='MailboxMessageSent'", args: [payload.sentEventId] });
      const sentRow = sent.rows[0]; const sentPayload = sentRow ? JSON.parse(String(sentRow.payload_json)) as EventPayloads["MailboxMessageSent"] : null;
      const deliveredMeaning = { mailboxMessageId: payload.mailboxMessageId, fromSessionId: payload.fromSessionId, fromBranchId: payload.fromBranchId, toSessionId: payload.toSessionId, toBranchId: payload.toBranchId, kind: payload.kind, content: payload.content, ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }), ...(payload.artifactIds === undefined ? {} : { artifactIds: payload.artifactIds }), ...(payload.intentKey === undefined ? {} : { intentKey: payload.intentKey }), ...(payload.followUp === undefined ? {} : { followUp: payload.followUp }), ...(payload.replyToMessageId === undefined ? {} : { replyToMessageId: payload.replyToMessageId }) };
      if (!sentPayload || !Bun.deepEquals(sentPayload, deliveredMeaning)) throw new ValidationError("Mailbox delivery does not match its sent event");
    }
    if (event.type === "MailboxMessageContextDelivered") {
      const payload = event.payload as EventPayloads["MailboxMessageContextDelivered"];
      const message = await tx.execute({ sql: "SELECT from_session_id,from_branch_id,to_session_id,to_branch_id,delivered_event_id,sender_relationship FROM mailbox_messages WHERE mailbox_message_id=?", args: [payload.mailboxMessageId] });
      const row = message.rows[0];
      const atTarget = row && event.sessionId === String(row.to_session_id) && event.branchId === String(row.to_branch_id);
      const atSender = row && event.sessionId === String(row.from_session_id) && event.branchId === String(row.from_branch_id);
      const contextMessage = await tx.execute({ sql: "SELECT session_id,branch_id,payload_json FROM events WHERE id=? AND type='MessageAppended'", args: [payload.messageEventId] });
      const contextRow = contextMessage.rows[0];
      const contextPayload = contextRow ? JSON.parse(String(contextRow.payload_json)) as EventPayloads["MessageAppended"] : null;
      if (!row || row.delivered_event_id === null || (!atTarget && !atSender) ||
          (row.sender_relationship !== null && String(row.sender_relationship) !== payload.relationship) ||
          !contextRow || String(contextRow.session_id) !== String(row.to_session_id) || String(contextRow.branch_id) !== String(row.to_branch_id) ||
          contextPayload?.mailbox?.mailboxMessageId !== payload.mailboxMessageId) {
        throw new ValidationError("Mailbox context delivery does not match its accepted message and target context event");
      }
    }
    if (event.type === "MailboxMessageDeliveryFailed") {
      const payload = event.payload as EventPayloads["MailboxMessageDeliveryFailed"];
      const message = await tx.execute({ sql: "SELECT from_session_id,from_branch_id,receipt_status FROM mailbox_messages WHERE mailbox_message_id=?", args: [payload.mailboxMessageId] });
      const row = message.rows[0];
      if (!row || event.sessionId !== String(row.from_session_id) || event.branchId !== String(row.from_branch_id) || String(row.receipt_status) !== "queued") throw new ValidationError("Mailbox delivery failure must match its queued sender receipt");
    }
    if (event.type === "MailboxMessageAcknowledged") {
      const payload = event.payload as EventPayloads["MailboxMessageAcknowledged"];
      const message = await tx.execute({ sql: "SELECT from_session_id,to_session_id,delivered_event_id,context_event_id,intent_key FROM mailbox_messages WHERE mailbox_message_id=?", args: [payload.mailboxMessageId] });
      const row = message.rows[0];
      const legacyContextDelivery = row && row.intent_key === null && row.delivered_event_id !== null;
      if (!row || (row.context_event_id === null && !legacyContextDelivery) || payload.acknowledgedBySessionId !== String(row.to_session_id) || ![String(row.from_session_id), String(row.to_session_id)].includes(event.sessionId)) throw new ValidationError("Mailbox acknowledgement does not match its context delivery");
    }
    if (event.type === "TaskTerminalNoticeSent") {
      const payload = event.payload as EventPayloads["TaskTerminalNoticeSent"];
      const task = await tx.execute({ sql: "SELECT parent_session_id,child_session_id FROM tasks WHERE task_id=?", args: [payload.taskId] }); const taskRow = task.rows[0];
      if (event.sessionId !== payload.childSessionId || !taskRow || String(taskRow.child_session_id) !== payload.childSessionId || String(taskRow.parent_session_id) !== payload.parentSessionId) throw new ValidationError("Terminal notice must match its child task");
    }
    if (event.type === "TaskTerminalNoticeDelivered") {
      const payload = event.payload as EventPayloads["TaskTerminalNoticeDelivered"];
      if (event.sessionId !== payload.parentSessionId) throw new ValidationError("Terminal notice must be delivered on the parent session");
      const notice = await tx.execute({ sql: "SELECT payload_json FROM events WHERE id=? AND type='TaskTerminalNoticeSent'", args: [payload.sentEventId] });
      const sentPayload = notice.rows[0] ? JSON.parse(String(notice.rows[0].payload_json)) as EventPayloads["TaskTerminalNoticeSent"] : null;
      const deliveredMeaning = { noticeId: payload.noticeId, taskId: payload.taskId, parentSessionId: payload.parentSessionId, childSessionId: payload.childSessionId, status: payload.status, ...(payload.result === undefined ? {} : { result: payload.result }), ...(payload.artifactIds === undefined ? {} : { artifactIds: payload.artifactIds }), ...(payload.error === undefined ? {} : { error: payload.error }), ...(payload.reason === undefined ? {} : { reason: payload.reason }) };
      if (!sentPayload || !Bun.deepEquals(sentPayload, deliveredMeaning)) throw new ValidationError("Terminal notice delivery does not match its sent event");
    }
    if (event.type === "DocumentImported") {
      const payload = event.payload as EventPayloads["DocumentImported"];
      if (payload.chunkCount === 0 && (payload.size !== 0 || payload.digest !== sha256(""))) throw new ValidationError("Empty document metadata has an invalid size or digest");
    }
    if (event.type === "DocumentChunkAdded") {
      const payload = event.payload as EventPayloads["DocumentChunkAdded"];
      const document = await tx.execute({ sql: "SELECT size,digest,chunk_count FROM documents WHERE document_id=?", args: [payload.documentId] }); const documentRow = document.rows[0];
      if (!documentRow || payload.ordinal >= Number(documentRow.chunk_count) || new TextEncoder().encode(payload.content).byteLength !== payload.size || sha256(payload.content) !== payload.digest) throw new ValidationError("Document chunk integrity metadata is invalid");
      if (payload.ordinal === Number(documentRow.chunk_count) - 1) {
        const previous = await tx.execute({ sql: "SELECT ordinal,content FROM document_chunks WHERE document_id=? ORDER BY ordinal", args: [payload.documentId] });
        // Canonical validation runs before the current event's projection row is
        // inserted, so include the terminal chunk candidate exactly once here.
        const all = [
          ...previous.rows.map((row) => ({ ordinal: Number(row.ordinal), content: String(row.content) })),
          { ordinal: payload.ordinal, content: payload.content },
        ].sort((left, right) => left.ordinal - right.ordinal);
        if (all.length !== Number(documentRow.chunk_count) || all.some((chunk,index) => chunk.ordinal !== index)) throw new ValidationError("Document chunks are incomplete or unordered");
        const content = all.map((chunk) => chunk.content).join("");
        if (new TextEncoder().encode(content).byteLength !== Number(documentRow.size) || sha256(content) !== String(documentRow.digest)) throw new ValidationError("Document chunks do not match imported document integrity metadata");
      }
    }
    if (event.type === "RecursiveModelStarted") {
      const payload = event.payload as EventPayloads["RecursiveModelStarted"];
      const task = await tx.execute({ sql: "SELECT task_id,child_session_id,child_branch_id,parent_branch_id,model_json FROM tasks WHERE task_id=?", args: [payload.taskId] }); const taskRow = task.rows[0];
      const inputSet = payload.inputSetId === undefined ? { rows: [{}] } : await tx.execute({ sql: "SELECT input_set_id FROM input_sets WHERE input_set_id=?", args: [payload.inputSetId] });
      if (!taskRow || String(taskRow.child_session_id) !== payload.childSessionId || String(taskRow.child_branch_id) !== payload.childBranchId || String(taskRow.parent_branch_id) !== payload.parentBranchId || payload.parentSessionId !== event.sessionId || !Bun.deepEquals(JSON.parse(String(taskRow.model_json)), payload.model) || !inputSet.rows.length) throw new ValidationError("Recursive model handle does not match its child task and input set");
    }
    if (event.type === "HarnessVersionCreated") {
      const payload = event.payload as EventPayloads["HarnessVersionCreated"];
      const content = payload.content as { kind?: string };
      if (content.kind !== payload.kind) throw new ValidationError("Harness content kind must match the entry kind");
      const existingVersion = await tx.execute({ sql: "SELECT version_id FROM harness_versions WHERE version_id=?", args: [payload.versionId] });
      if (existingVersion.rows.length) throw new ConflictError("Harness version ID already exists", { versionId: payload.versionId });
      const entry = await tx.execute({ sql: "SELECT * FROM harness_entries WHERE entry_id=?", args: [payload.entryId] });
      const row = entry.rows[0];
      const conflictingName = await tx.execute({
        sql: "SELECT entry_id FROM harness_entries WHERE kind=? AND scope=? AND scope_key=? AND name=? AND status IN ('active','candidate') AND entry_id<>?",
        args: [payload.kind,payload.scope,payload.scopeKey,payload.name,payload.entryId],
      });
      if (conflictingName.rows.length) throw new ConflictError("Harness name is already active in this scope", {
        kind: payload.kind, scope: payload.scope, scopeKey: payload.scopeKey, name: payload.name,
        conflictingEntryId: String(conflictingName.rows[0]!.entry_id),
      });
      if (payload.version === 1) {
        if (row || payload.supersedesVersionId !== undefined) throw new ConflictError("First harness version cannot replace an existing entry", { entryId: payload.entryId });
      } else {
        if (!row || payload.supersedesVersionId !== String(row.current_version_id) || payload.version !== Number((await tx.execute({ sql: "SELECT max(version) AS version FROM harness_versions WHERE entry_id=?", args: [payload.entryId] })).rows[0]?.version ?? 0) + 1) {
          throw new ConflictError("Harness replacement failed compare-and-swap", { entryId: payload.entryId, expectedVersionId: payload.supersedesVersionId ?? null });
        }
        if (payload.kind !== String(row.kind) || payload.scope !== String(row.scope) || payload.scopeKey !== String(row.scope_key)) throw new ValidationError("A harness replacement cannot change kind or scope");
      }
      for (const evidenceId of payload.evidenceEventIds) {
        if (!(await tx.execute({ sql: "SELECT id FROM events WHERE id=?", args: [evidenceId] })).rows.length) throw new ValidationError(`Harness evidence event does not exist: ${evidenceId}`);
      }
      for (const conflictId of payload.conflictEntryIds) {
        if (!(await tx.execute({ sql: "SELECT entry_id FROM harness_entries WHERE entry_id=?", args: [conflictId] })).rows.length) throw new ValidationError(`Conflicting harness entry does not exist: ${conflictId}`);
      }
    }
    if (event.type === "HarnessVersionStatusChanged") {
      const payload = event.payload as EventPayloads["HarnessVersionStatusChanged"];
      const found = await tx.execute({ sql: "SELECT v.status,e.current_version_id FROM harness_versions v JOIN harness_entries e ON e.entry_id=v.entry_id WHERE v.version_id=? AND v.entry_id=?", args: [payload.versionId,payload.entryId] });
      const row = found.rows[0];
      if (!row || String(row.current_version_id) !== payload.versionId) throw new ConflictError("Harness status change requires the current version", { entryId: payload.entryId, versionId: payload.versionId });
      const from = String(row.status);
      const allowed = from !== payload.status && !["rejected","rolled_back"].includes(from) && !(from === "retired" && payload.status !== "active");
      if (!allowed) throw new ValidationError(`Invalid harness status transition: ${from} -> ${payload.status}`);
    }
    if (event.type === "RefinementValidated" || event.type === "RefinementCandidateActivated" || event.type === "RefinementCandidateAllocated" || event.type === "RefinementCandidateExposed" || event.type === "RefinementObservationRecorded" || event.type === "RefinementDecided" || event.type === "RefinementApproved" || event.type === "RefinementRollbackApproved" || event.type === "RefinementRolledBack") {
      const payload = event.payload as { proposalId: string };
      if (!(await tx.execute({ sql: "SELECT proposal_id FROM refinement_proposals WHERE proposal_id=?", args: [payload.proposalId] })).rows.length) throw new ValidationError("Refinement event references a missing proposal");
    }
    if (event.type === "SubagentSpecInvoked") {
      const payload = event.payload as EventPayloads["SubagentSpecInvoked"];
      const version = await tx.execute({ sql: "SELECT kind FROM harness_versions WHERE version_id=? AND entry_id=?", args: [payload.versionId,payload.entryId] });
      const task = await tx.execute({ sql: "SELECT child_session_id,child_branch_id FROM tasks WHERE task_id=?", args: [payload.taskId] });
      if (String(version.rows[0]?.kind) !== "subagent_spec" || String(task.rows[0]?.child_session_id) !== payload.childSessionId || String(task.rows[0]?.child_branch_id) !== payload.childBranchId) throw new ValidationError("Subagent specification invocation is not pinned to its admitted task");
    }
    const history = await this.#loadBranchEvents(tx, event.sessionId, event.branchId);
    if (!history.length) throw new NotFoundError("session branch", `${event.sessionId}/${event.branchId}`);
    reduceAgentState(projectEvents(history), event);
  }

  async #applyOperationalRows(tx: Transaction, event: AgentEvent): Promise<void> {
    if (event.type === "SessionCreated") {
      const p = event.payload as EventPayloads["SessionCreated"];
      await tx.execute({ sql: "INSERT OR IGNORE INTO sessions(session_id,workspace_id,initial_branch_id,created_event_id,parent_session_id,parent_branch_id,root_session_id,depth,task_id,execution_owner_device_id) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [event.sessionId,p.workspaceId,p.initialBranchId,event.id,p.parentSessionId ?? null,p.parentBranchId ?? null,p.rootSessionId ?? event.sessionId,p.depth ?? 0,p.taskId ?? null,event.originDeviceId] });
      await tx.execute({ sql: "INSERT OR IGNORE INTO branches(session_id,branch_id,parent_branch_id,fork_cursor,name,created_event_id) VALUES(?,?,NULL,NULL,?,?)", args: [event.sessionId,p.initialBranchId,p.initialBranchName ?? null,event.id] });
    }
    const ownerResult = await tx.execute({ sql:"SELECT execution_owner_device_id FROM sessions WHERE session_id=?", args:[event.sessionId] });
    const executionOwner = ownerResult.rows[0]?.execution_owner_device_id;
    const executionOwned = executionOwner === null || executionOwner === undefined || String(executionOwner) === "legacy" || String(executionOwner) === this.#deviceId;
    if (event.type === "BranchCreated") { const p = event.payload as EventPayloads["BranchCreated"]; await tx.execute({ sql: "INSERT INTO branches(session_id,branch_id,parent_branch_id,fork_cursor,name,created_event_id) VALUES(?,?,?,?,?,?)", args: [event.sessionId,p.branchId,p.parentBranchId,p.forkCursor,p.name ?? null,event.id] }); }
    if (event.type === "BranchNamed") { const p = event.payload as EventPayloads["BranchNamed"]; await tx.execute({ sql: "UPDATE branches SET name=? WHERE session_id=? AND branch_id=?", args: [p.name,event.sessionId,event.branchId] }); }
    if (event.type === "ContextMaterialized") { const p = event.payload as EventPayloads["ContextMaterialized"]; await tx.execute({ sql: "INSERT INTO context_records(context_id,session_id,branch_id,event_id,content_hash,records_json,context_json,created_at,harness_provenance_json) VALUES(?,?,?,?,?,?,?,?,?)", args: [p.contextId,event.sessionId,event.branchId,event.id,p.contentHash,json(p.records),json(p.context),event.committedAt,p.harnessProvenance === undefined ? null : json(p.harnessProvenance)] }); }
    if (event.type === "EffectRequested" && executionOwned) { const p = event.payload as EventPayloads["EffectRequested"]; await tx.execute({ sql: "INSERT INTO outbox(effect_id,session_id,branch_id,executor,operation,input_json,idempotency_key,idempotent,status,requested_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", args: [p.effectId,event.sessionId,event.branchId,p.executor,p.operation,json(p.input),p.idempotencyKey,p.idempotent ? 1 : 0,"pending",event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "EffectAttemptStarted" && executionOwned) { const p = event.payload as EventPayloads["EffectAttemptStarted"]; await tx.execute({ sql: "UPDATE outbox SET status='running',attempt=?,updated_at=? WHERE effect_id=? AND status IN ('pending','running')", args: [p.attempt,event.committedAt,p.effectId] }); }
    if (event.type === "EffectOutcomeRecorded" && executionOwned) { const p = event.payload as EventPayloads["EffectOutcomeRecorded"]; await tx.execute({ sql: "UPDATE outbox SET status=?,attempt=?,owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=?", args: [p.outcome,p.attempt,event.committedAt,p.effectId] }); }
    if (event.type === "TaskCreated") {
      const p = event.payload as EventPayloads["TaskCreated"];
      await tx.execute({ sql: "INSERT INTO tasks(task_id,parent_session_id,parent_branch_id,child_session_id,child_branch_id,task_text,completion_criteria,model_json,budget_json,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)", args: [p.taskId,p.parentSessionId,p.parentBranchId,p.childSessionId,p.childBranchId,p.task,p.completionCriteria ?? null,json(p.model),json(p.budget),event.id,event.id,event.committedAt,event.committedAt] });
    }
    if (event.type === "SubagentAdmitted") { const p = event.payload as EventPayloads["SubagentAdmitted"]; await tx.execute({ sql: "UPDATE tasks SET status='admitted',last_event_id=?,updated_at=? WHERE task_id=?", args: [event.id,event.committedAt,p.taskId] }); }
    if (event.type === "SubagentCancellationRequested") { const p = event.payload as EventPayloads["SubagentCancellationRequested"]; await tx.execute({ sql: "UPDATE tasks SET cancellation_requested=1,reason=COALESCE(?,reason),last_event_id=?,updated_at=? WHERE task_id=?", args: [p.reason ?? null,event.id,event.committedAt,p.taskId] }); }
    if (event.type === "TaskStatusChanged") {
      const p = event.payload as EventPayloads["TaskStatusChanged"];
      await tx.execute({ sql: "UPDATE tasks SET status=?,result_json=COALESCE(?,result_json),artifact_ids_json=COALESCE(?,artifact_ids_json),error=COALESCE(?,error),reason=COALESCE(?,reason),last_event_id=?,updated_at=? WHERE task_id=? AND parent_branch_id=?", args: [p.status,p.result === undefined ? null : json(p.result),p.artifactIds === undefined ? null : json(p.artifactIds),p.error ?? null,p.reason ?? null,event.id,event.committedAt,p.taskId,event.branchId] });
    }
    if (event.type === "MailboxMessageSent") {
      const p = event.payload as EventPayloads["MailboxMessageSent"];
      await tx.execute({ sql: "INSERT INTO mailbox_messages(mailbox_message_id,from_session_id,from_branch_id,to_session_id,to_branch_id,kind,content,task_id,sent_event_id,sent_at,artifact_ids_json,intent_key,follow_up,reply_to_message_id,receipt_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [p.mailboxMessageId,p.fromSessionId,p.fromBranchId,p.toSessionId,p.toBranchId,p.kind,p.content,p.taskId ?? null,event.id,event.committedAt,json(p.artifactIds ?? []),p.intentKey ?? null,p.followUp ? 1 : 0,p.replyToMessageId ?? null,p.intentKey === undefined ? "delivered_to_context" : "queued"] });
    }
    if (event.type === "MailboxMessageDelivered") { const p = event.payload as EventPayloads["MailboxMessageDelivered"]; await tx.execute({ sql: "UPDATE mailbox_messages SET delivered_event_id=?,delivered_at=?,sender_relationship=COALESCE(?,sender_relationship) WHERE mailbox_message_id=?", args: [event.id,event.committedAt,p.senderRelationship ?? null,p.mailboxMessageId] }); }
    if (event.type === "MailboxMessageContextDelivered") { const p = event.payload as EventPayloads["MailboxMessageContextDelivered"]; await tx.execute({ sql: "UPDATE mailbox_messages SET context_event_id=COALESCE(context_event_id,?),context_message_event_id=COALESCE(context_message_event_id,?),context_delivered_at=COALESCE(context_delivered_at,?),sender_relationship=COALESCE(sender_relationship,?),follow_up_run_id=COALESCE(?,follow_up_run_id),receipt_status=CASE WHEN receipt_status='acknowledged' THEN receipt_status ELSE 'delivered_to_context' END WHERE mailbox_message_id=?", args: [event.id,p.messageEventId,p.deliveredAt,p.relationship,p.runId ?? null,p.mailboxMessageId] }); }
    if (event.type === "MailboxMessageDeliveryFailed") { const p = event.payload as EventPayloads["MailboxMessageDeliveryFailed"]; await tx.execute({ sql: "UPDATE mailbox_messages SET receipt_status='failed',delivery_error=? WHERE mailbox_message_id=? AND receipt_status='queued'", args: [p.error,p.mailboxMessageId] }); }
    if (event.type === "MailboxMessageAcknowledged") { const p = event.payload as EventPayloads["MailboxMessageAcknowledged"]; await tx.execute({ sql: "UPDATE mailbox_messages SET acknowledged_event_id=?,acknowledged_at=?,receipt_status='acknowledged' WHERE mailbox_message_id=?", args: [event.id,p.acknowledgedAt,p.mailboxMessageId] }); }
    if (event.type === "TaskTerminalNoticeSent") {
      const p = event.payload as EventPayloads["TaskTerminalNoticeSent"];
      await tx.execute({ sql: "INSERT INTO terminal_notices(notice_id,task_id,parent_session_id,child_session_id,status,result_json,artifact_ids_json,error,reason,sent_event_id,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [p.noticeId,p.taskId,p.parentSessionId,p.childSessionId,p.status,p.result === undefined ? null : json(p.result),json(p.artifactIds ?? []),p.error ?? null,p.reason ?? null,event.id,event.committedAt] });
    }
    if (event.type === "TaskTerminalNoticeDelivered") { const p = event.payload as EventPayloads["TaskTerminalNoticeDelivered"]; await tx.execute({ sql: "UPDATE terminal_notices SET delivered_event_id=?,delivered_at=? WHERE notice_id=?", args: [event.id,event.committedAt,p.noticeId] }); }
    if (event.type === "DocumentImported") { const p = event.payload as EventPayloads["DocumentImported"]; await tx.execute({ sql: "INSERT INTO documents(document_id,session_id,branch_id,name,media_type,size,digest,chunk_count,imported_event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [p.documentId,event.sessionId,event.branchId,p.name,p.mediaType,p.size,p.digest,p.chunkCount,event.id,event.committedAt] }); }
    if (event.type === "DocumentChunkAdded") { const p = event.payload as EventPayloads["DocumentChunkAdded"]; await tx.execute({ sql: "INSERT INTO document_chunks(chunk_id,document_id,ordinal,content,size,digest,event_id,created_at) VALUES(?,?,?,?,?,?,?,?)", args: [p.chunkId,p.documentId,p.ordinal,p.content,p.size,p.digest,event.id,event.committedAt] }); }
    if (event.type === "InputSetCreated") {
      const p = event.payload as EventPayloads["InputSetCreated"];
      await tx.execute({ sql: "INSERT INTO input_sets(input_set_id,session_id,branch_id,name,metadata_json,event_id,created_at) VALUES(?,?,?,?,?,?,?)", args: [p.inputSetId,event.sessionId,event.branchId,p.name ?? null,p.metadata === undefined ? null : json(p.metadata),event.id,event.committedAt] });
      for (const [ordinal, chunkId] of p.chunkIds.entries()) await tx.execute({ sql: "INSERT INTO input_set_chunks(input_set_id,chunk_id,ordinal) VALUES(?,?,?)", args: [p.inputSetId,chunkId,ordinal] });
    }
    if (event.type === "GoalCreated" && executionOwned) { const p = event.payload as EventPayloads["GoalCreated"]; await tx.execute({ sql: "INSERT INTO goals(goal_id,session_id,branch_id,description,completion_criteria,max_turns,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?,?,?)", args: [p.goalId,event.sessionId,event.branchId,p.description,p.completionCriteria ?? null,p.maxTurns ?? null,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "GoalCompletionRequested" && executionOwned) { const p = event.payload as EventPayloads["GoalCompletionRequested"]; await tx.execute({ sql: "UPDATE goals SET status='completion_requested',completion_request_id=?,completion_workspace_id=?,completion_workspace_cursor=?,completion_material_version=?,completion_material_event_ids_json=?,completion_pin_recorded=?,last_event_id=?,updated_at=? WHERE goal_id=?", args: [p.requestId,p.workspaceId ?? null,p.workspaceCursor ?? null,p.materialVersion ?? null,json(p.materialEventIds ?? []),p.materialVersion !== undefined || (p.workspaceId !== undefined && Object.prototype.hasOwnProperty.call(p, "workspaceCursor")) ? 1 : 0,event.id,event.committedAt,p.goalId] }); }
    if (event.type === "GoalStatusChanged" && executionOwned) { const p = event.payload as EventPayloads["GoalStatusChanged"]; await tx.execute({ sql: "UPDATE goals SET status=?,reason=?,last_event_id=?,updated_at=? WHERE goal_id=?", args: [p.status,p.reason ?? null,event.id,event.committedAt,p.goalId] }); }
    if (event.type === "GoalGateAdded" && executionOwned) { const p = event.payload as EventPayloads["GoalGateAdded"]; await tx.execute({ sql: "INSERT INTO goal_gates(gate_id,goal_id,name,executor,operation,input_json,idempotent,required,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,?)", args: [p.gateId,p.goalId,p.name,p.executor,p.operation,json(p.input),p.idempotent ? 1 : 0,p.required ? 1 : 0,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "GoalGateStatusChanged" && executionOwned) { const p = event.payload as EventPayloads["GoalGateStatusChanged"]; await tx.execute({ sql: "UPDATE goal_gates SET status=?,effect_id=COALESCE(?,effect_id),output_json=?,error=?,last_event_id=?,updated_at=? WHERE gate_id=?", args: [p.status,p.effectId ?? null,p.output === undefined ? null : json(p.output),p.error ?? null,event.id,event.committedAt,p.gateId] }); }
    if (event.type === "GoalGateEvaluationRecorded" && executionOwned) { const p = event.payload as EventPayloads["GoalGateEvaluationRecorded"]; await tx.execute({ sql: "INSERT INTO goal_gate_evaluations(evaluation_id,goal_id,gate_id,request_id,definition_hash,material_version,material_event_ids_json,status,effect_id,output_json,error,cached_from_evaluation_id,event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [p.evaluationId,p.goalId,p.gateId,p.requestId,p.definitionHash,p.materialVersion,json(p.materialEventIds),p.status,p.effectId ?? null,p.output === undefined ? null : json(p.output),p.error ?? null,p.cachedFromEvaluationId ?? null,event.id,event.committedAt] }); await tx.execute({ sql: "UPDATE goal_gates SET status=?,effect_id=COALESCE(?,effect_id),output_json=?,error=?,current_evaluation_id=?,last_event_id=?,updated_at=? WHERE gate_id=?", args: [p.status,p.effectId ?? null,p.output === undefined ? null : json(p.output),p.error ?? null,p.evaluationId,event.id,event.committedAt,p.gateId] }); }
    if (event.type === "HeartbeatCreated" && executionOwned) { const p = event.payload as EventPayloads["HeartbeatCreated"]; await tx.execute({ sql: "INSERT INTO heartbeats(heartbeat_id,session_id,branch_id,interval_ms,next_tick_at,goal_id,prompt,payload_json,owner,status,tick,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',0,?,?,?,?)", args: [p.heartbeatId,event.sessionId,event.branchId,p.intervalMs,p.nextTickAt,p.goalId ?? null,p.prompt ?? null,p.payload === undefined ? null : json(p.payload),p.owner ?? "user",event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "HeartbeatTicked" && executionOwned) { const p = event.payload as EventPayloads["HeartbeatTicked"]; await tx.execute({ sql: "UPDATE heartbeats SET tick=?,last_fired_at=?,next_tick_at=?,last_event_id=?,updated_at=? WHERE heartbeat_id=?", args: [p.tick,p.firedAt,p.nextTickAt,event.id,event.committedAt,p.heartbeatId] }); }
    if (event.type === "HeartbeatStatusChanged" && executionOwned) { const p = event.payload as EventPayloads["HeartbeatStatusChanged"]; await tx.execute({ sql: "UPDATE heartbeats SET status=?,next_tick_at=COALESCE(?,next_tick_at),last_event_id=?,updated_at=? WHERE heartbeat_id=?", args: [p.status,p.nextTickAt ?? null,event.id,event.committedAt,p.heartbeatId] }); }
    if (event.type === "ScheduleCreated" && executionOwned) { const p = event.payload as EventPayloads["ScheduleCreated"]; await tx.execute({ sql: "INSERT INTO schedules(schedule_id,session_id,branch_id,kind,prompt,interval_ms,next_tick_at,owner,goal_mode,status,tick,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',0,?,?,?,?)", args: [p.scheduleId,event.sessionId,event.branchId,p.kind,p.prompt,p.intervalMs ?? null,p.nextTickAt,p.owner,p.goalMode,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "ScheduleTicked" && executionOwned) { const p = event.payload as EventPayloads["ScheduleTicked"]; await tx.execute({ sql: "UPDATE schedules SET tick=?,last_fired_at=?,next_tick_at=COALESCE(?,next_tick_at),status=CASE WHEN ? IS NULL THEN 'completed' ELSE status END,last_event_id=?,updated_at=? WHERE schedule_id=?", args: [p.tick,p.firedAt,p.nextTickAt,p.nextTickAt,event.id,event.committedAt,p.scheduleId] }); }
    if (event.type === "ScheduleStatusChanged" && executionOwned) { const p = event.payload as EventPayloads["ScheduleStatusChanged"]; await tx.execute({ sql: "UPDATE schedules SET status=?,next_tick_at=COALESCE(?,next_tick_at),reason=?,last_event_id=?,updated_at=? WHERE schedule_id=?", args: [p.status,p.nextTickAt ?? null,p.reason ?? null,event.id,event.committedAt,p.scheduleId] }); }
    if (event.type === "WakeQueued" && executionOwned) { const p = event.payload as EventPayloads["WakeQueued"]; await tx.execute({ sql: "INSERT INTO wake_queue(wake_id,session_id,branch_id,source_type,source_id,tick,scheduled_at,fired_at,prompt,goal_id,goal_mode,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)", args: [p.wakeId,event.sessionId,event.branchId,p.sourceType,p.sourceId,p.tick,p.scheduledAt,p.firedAt,p.prompt,p.goalId ?? null,p.goalMode,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "WakeClaimed" && executionOwned) { const p = event.payload as EventPayloads["WakeClaimed"]; await tx.execute({ sql: "UPDATE wake_queue SET status='claimed',claim_id=?,claimed_at=?,last_event_id=?,updated_at=? WHERE wake_id=?", args: [p.claimId,p.claimedAt,event.id,event.committedAt,p.wakeId] }); }
    if (event.type === "WakeDelivered" && executionOwned) { const p = event.payload as EventPayloads["WakeDelivered"]; await tx.execute({ sql: "UPDATE wake_queue SET status='delivered',run_id=?,delivered_at=?,last_event_id=?,updated_at=? WHERE wake_id=?", args: [p.runId,p.deliveredAt,event.id,event.committedAt,p.wakeId] }); }
    if (event.type === "WakeDeliveryUnknown" && executionOwned) { const p = event.payload as EventPayloads["WakeDeliveryUnknown"]; await tx.execute({ sql: "UPDATE wake_queue SET status='unknown',reason=?,last_event_id=?,updated_at=? WHERE wake_id=?", args: [p.reason,event.id,event.committedAt,p.wakeId] }); }
    if (event.type === "DocumentImported") {
      const payload = event.payload as EventPayloads["DocumentImported"];
      if (payload.chunkCount === 0 && (payload.size !== 0 || payload.digest !== sha256(""))) throw new ValidationError("Empty document metadata has an invalid size or digest");
    }
    if (event.type === "DocumentChunkAdded") {
      const payload = event.payload as EventPayloads["DocumentChunkAdded"];
      const document = await tx.execute({ sql: "SELECT size,digest,chunk_count FROM documents WHERE document_id=?", args: [payload.documentId] }); const documentRow = document.rows[0];
      if (!documentRow || payload.ordinal >= Number(documentRow.chunk_count) || new TextEncoder().encode(payload.content).byteLength !== payload.size || sha256(payload.content) !== payload.digest) throw new ValidationError("Document chunk integrity metadata is invalid");
      if (payload.ordinal === Number(documentRow.chunk_count) - 1) {
        const previous = await tx.execute({ sql: "SELECT ordinal,content FROM document_chunks WHERE document_id=? ORDER BY ordinal", args: [payload.documentId] });
        const all = previous.rows.map((row) => ({ ordinal: Number(row.ordinal), content: String(row.content) })).sort((left,right) => left.ordinal-right.ordinal);
        if (all.length !== Number(documentRow.chunk_count) || all.some((chunk,index) => chunk.ordinal !== index)) throw new ValidationError("Document chunks are incomplete or unordered");
        const content = all.map((chunk) => chunk.content).join("");
        if (new TextEncoder().encode(content).byteLength !== Number(documentRow.size) || sha256(content) !== String(documentRow.digest)) throw new ValidationError("Document chunks do not match imported document integrity metadata");
      }
    }
    if (event.type === "RecursiveModelStarted" && executionOwned) { const p = event.payload as EventPayloads["RecursiveModelStarted"]; await tx.execute({ sql: "INSERT INTO recursive_model_handles(handle_id,task_id,parent_session_id,parent_branch_id,child_session_id,child_branch_id,model_json,input_set_id,input_json,input_provenance_json,input_hash,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?,?)", args: [p.handleId,p.taskId,p.parentSessionId,p.parentBranchId,p.childSessionId,p.childBranchId,json(p.model),p.inputSetId ?? null,p.input === undefined ? null : json(p.input),p.inputProvenance === undefined ? null : json(p.inputProvenance),p.inputHash ?? null,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "RecursiveModelStatusChanged" && executionOwned) { const p = event.payload as EventPayloads["RecursiveModelStatusChanged"]; await tx.execute({ sql: "UPDATE recursive_model_handles SET status=?,outcome=COALESCE(?,outcome),result_message_id=COALESCE(?,result_message_id),result_json=COALESCE(?,result_json),result_artifact_id=COALESCE(?,result_artifact_id),error=COALESCE(?,error),last_event_id=?,updated_at=? WHERE handle_id=?", args: [p.status,p.outcome ?? null,p.resultMessageId ?? null,p.result === undefined ? null : json(p.result),p.resultArtifactId ?? null,p.error ?? null,event.id,event.committedAt,p.handleId] }); }
    if (event.type === "HarnessVersionCreated") {
      const p = event.payload as EventPayloads["HarnessVersionCreated"];
      await tx.execute({ sql: "INSERT INTO harness_versions(version_id,entry_id,version,kind,scope,scope_key,name,content_json,tags_json,confidence,status,evidence_event_ids_json,conflict_entry_ids_json,supersedes_version_id,proposal_id,created_by,created_event_id,last_event_id,created_at,last_confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [p.versionId,p.entryId,p.version,p.kind,p.scope,p.scopeKey,p.name,json(p.content),json(p.tags),p.confidence,p.status,json(p.evidenceEventIds),json(p.conflictEntryIds),p.supersedesVersionId ?? null,p.proposalId ?? null,p.createdBy,event.id,event.id,event.committedAt,p.lastConfirmedAt] });
      if (p.version === 1) await tx.execute({ sql: "INSERT INTO harness_entries(entry_id,kind,scope,scope_key,name,current_version_id,active_version_id,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", args: [p.entryId,p.kind,p.scope,p.scopeKey,p.name,p.versionId,p.status === "active" ? p.versionId : null,p.status,event.id,event.id,event.committedAt,event.committedAt] });
      else await tx.execute({ sql: "UPDATE harness_entries SET name=?,current_version_id=?,active_version_id=CASE WHEN ?='active' THEN ? ELSE active_version_id END,status=?,last_event_id=?,updated_at=? WHERE entry_id=?", args: [p.name,p.versionId,p.status,p.versionId,p.status,event.id,event.committedAt,p.entryId] });
      if (p.kind === "memory") {
        const content = p.content as { text?: string };
        await tx.execute({ sql: "INSERT INTO memory_fts(version_id,entry_id,content,tags) VALUES(?,?,?,?)", args: [p.versionId,p.entryId,content.text ?? "",p.tags.join(" ")] });
      }
    }
    if (event.type === "HarnessVersionStatusChanged") {
      const p = event.payload as EventPayloads["HarnessVersionStatusChanged"];
      await tx.execute({ sql: "UPDATE harness_versions SET status=?,last_event_id=? WHERE version_id=? AND entry_id=?", args: [p.status,event.id,p.versionId,p.entryId] });
      if (p.status === "active") {
        const old = await tx.execute({ sql: "SELECT active_version_id FROM harness_entries WHERE entry_id=?", args: [p.entryId] });
        const oldVersion = old.rows[0]?.active_version_id;
        if (oldVersion !== null && oldVersion !== undefined && String(oldVersion) !== p.versionId) await tx.execute({ sql: "UPDATE harness_versions SET status='retired',last_event_id=? WHERE version_id=?", args: [event.id,String(oldVersion)] });
        await tx.execute({ sql: "UPDATE harness_entries SET current_version_id=?,active_version_id=?,status='active',last_event_id=?,updated_at=? WHERE entry_id=?", args: [p.versionId,p.versionId,event.id,event.committedAt,p.entryId] });
      } else if (p.status === "rolled_back") {
        const previous = await tx.execute({ sql: "SELECT supersedes_version_id FROM harness_versions WHERE version_id=?", args: [p.versionId] });
        const restored = previous.rows[0]?.supersedes_version_id;
        if (restored) {
          await tx.execute({ sql: "UPDATE harness_versions SET status='active',last_event_id=? WHERE version_id=?", args: [event.id,String(restored)] });
          await tx.execute({ sql: "UPDATE harness_entries SET current_version_id=?,active_version_id=?,status='active',last_event_id=?,updated_at=? WHERE entry_id=?", args: [String(restored),String(restored),event.id,event.committedAt,p.entryId] });
        } else await tx.execute({ sql: "UPDATE harness_entries SET status='rolled_back',active_version_id=NULL,last_event_id=?,updated_at=? WHERE entry_id=?", args: [event.id,event.committedAt,p.entryId] });
      } else if (p.status === "rejected") {
        const previous = await tx.execute({ sql: "SELECT supersedes_version_id FROM harness_versions WHERE version_id=?", args: [p.versionId] });
        const restored = previous.rows[0]?.supersedes_version_id;
        if (restored) await tx.execute({ sql: "UPDATE harness_entries SET current_version_id=?,active_version_id=?,status='active',last_event_id=?,updated_at=? WHERE entry_id=?", args: [String(restored),String(restored),event.id,event.committedAt,p.entryId] });
        else await tx.execute({ sql: "UPDATE harness_entries SET status='rejected',active_version_id=NULL,last_event_id=?,updated_at=? WHERE entry_id=?", args: [event.id,event.committedAt,p.entryId] });
      } else await tx.execute({ sql: "UPDATE harness_entries SET status=?,active_version_id=CASE WHEN ?='retired' THEN NULL ELSE active_version_id END,last_event_id=?,updated_at=? WHERE entry_id=?", args: [p.status,p.status,event.id,event.committedAt,p.entryId] });
    }
    if (event.type === "RefinementProposed") { const p = event.payload as EventPayloads["RefinementProposed"]; await tx.execute({ sql: "INSERT INTO refinement_proposals(proposal_id,session_id,branch_id,status,trigger_text,predicted_effect,edits_json,evidence_event_ids_json,evaluation_json,authority,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,'proposed',?,?,?,?,?,?,?,?,?,?)", args: [p.proposalId,event.sessionId,event.branchId,p.trigger,p.predictedEffect,json(p.edits),json(p.evidenceEventIds),json(p.evaluation),p.authority,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "RefinementValidated") { const p = event.payload as EventPayloads["RefinementValidated"]; await tx.execute({ sql: "UPDATE refinement_proposals SET status=?,validation_json=?,last_event_id=?,updated_at=? WHERE proposal_id=? AND status='proposed'", args: [p.valid ? "validated" : "revision_required",json(p.validation),event.id,event.committedAt,p.proposalId] }); }
    if (event.type === "RefinementCandidateActivated") { const p = event.payload as EventPayloads["RefinementCandidateActivated"]; await tx.execute({ sql: "UPDATE refinement_proposals SET status='candidate',candidate_id=?,allocation_limit=?,exposure_limit=?,last_event_id=?,updated_at=? WHERE proposal_id=?", args: [p.candidateId,p.allocationLimit,p.exposureLimit,event.id,event.committedAt,p.proposalId] }); }
    if (event.type === "RefinementCandidateAllocated") { const p = event.payload as EventPayloads["RefinementCandidateAllocated"]; await tx.execute({ sql: "INSERT INTO candidate_allocations(allocation_id,candidate_id,proposal_id,session_id,branch_id,task_id,ordinal,created_event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)", args: [p.allocationId,p.candidateId,p.proposalId,p.targetSessionId,p.targetBranchId,p.taskId ?? null,p.ordinal,event.id,event.committedAt] }); }
    if (event.type === "RefinementCandidateExposed") { const p = event.payload as EventPayloads["RefinementCandidateExposed"]; await tx.execute({ sql: "UPDATE candidate_allocations SET exposed_at=?,exposed_event_id=? WHERE allocation_id=? AND candidate_id=?", args: [event.committedAt,event.id,p.allocationId,p.candidateId] }); }
    if (event.type === "RefinementObservationRecorded") { const p = event.payload as EventPayloads["RefinementObservationRecorded"]; await tx.execute({ sql: "INSERT INTO refinement_observations(observation_id,candidate_id,proposal_id,allocation_id,evaluator,objective,success,metric_json,baseline_json,evidence_event_ids_json,notes,event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [p.observationId,p.candidateId,p.proposalId,p.allocationId,p.evaluator,p.objective ? 1 : 0,p.success ? 1 : 0,json(p.metric),p.baseline === undefined ? null : json(p.baseline),json(p.evidenceEventIds),p.notes ?? null,event.id,event.committedAt] }); }
    if (event.type === "RefinementDecided") { const p = event.payload as EventPayloads["RefinementDecided"]; await tx.execute({ sql: "INSERT INTO refinement_decisions(decision_id,proposal_id,candidate_id,decision,rule,evaluator,baseline_json,observation_ids_json,event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [p.decisionId,p.proposalId,p.candidateId,p.decision,p.rule,p.evaluator,p.baseline === undefined ? null : json(p.baseline),json(p.observationIds),event.id,event.committedAt] }); await tx.execute({ sql: "UPDATE refinement_proposals SET status=?,last_event_id=?,updated_at=? WHERE proposal_id=?", args: [p.decision === "promote" ? "promoted" : p.decision === "reject" ? "rejected" : "revision_required",event.id,event.committedAt,p.proposalId] }); }
    if (event.type === "RefinementApproved") { const p = event.payload as EventPayloads["RefinementApproved"]; await tx.execute({ sql: "INSERT INTO refinement_approvals(event_id,proposal_id,approved_by,scope,note,created_at) VALUES(?,?,?,?,?,?)", args: [event.id,p.proposalId,p.approvedBy,p.scope,p.note ?? null,event.committedAt] }); const scopes = await tx.execute({ sql: "SELECT scope FROM refinement_approvals WHERE proposal_id=? ORDER BY scope", args: [p.proposalId] }); await tx.execute({ sql: "UPDATE refinement_proposals SET approved_scopes_json=?,last_event_id=?,updated_at=? WHERE proposal_id=?", args: [json(scopes.rows.map((row) => String(row.scope))),event.id,event.committedAt,p.proposalId] }); }
    if (event.type === "RefinementRollbackApproved") { const p = event.payload as EventPayloads["RefinementRollbackApproved"]; await tx.execute({ sql: "INSERT INTO refinement_rollback_approvals(event_id,proposal_id,approved_by,role,note,created_at) VALUES(?,?,?,?,?,?)", args: [event.id,p.proposalId,p.approvedBy,p.role,p.note ?? null,event.committedAt] }); }
    if (event.type === "RefinementRolledBack") { const p = event.payload as EventPayloads["RefinementRolledBack"]; await tx.execute({ sql: "INSERT INTO refinement_rollbacks(rollback_id,proposal_id,candidate_id,version_ids_json,restored_version_ids_json,reason,event_id,created_at) VALUES(?,?,?,?,?,?,?,?)", args: [p.rollbackId,p.proposalId,p.candidateId,json(p.versionIds),json(p.restoredVersionIds),p.reason,event.id,event.committedAt] }); await tx.execute({ sql: "UPDATE refinement_proposals SET status='rolled_back',last_event_id=?,updated_at=? WHERE proposal_id=?", args: [event.id,event.committedAt,p.proposalId] }); }
    if (event.type === "SkillInvocationRecorded") { const p = event.payload as EventPayloads["SkillInvocationRecorded"]; await tx.execute({ sql: "INSERT INTO skill_executions(event_id,entry_id,version_id,effect_id,execution_kind,created_at) VALUES(?,?,?,?,'invoke',?)", args: [event.id,p.entryId,p.versionId,p.effectId,event.committedAt] }); }
    if (event.type === "SkillTestRecorded") { const p = event.payload as EventPayloads["SkillTestRecorded"]; await tx.execute({ sql: "INSERT INTO skill_executions(event_id,entry_id,version_id,effect_id,execution_kind,passed,report_json,created_at) VALUES(?,?,?,?,'test',?,?,?)", args: [event.id,p.entryId,p.versionId,p.effectId,p.passed ? 1 : 0,json(p.report),event.committedAt] }); }
    if (event.type === "SubagentSpecInvoked") { const p = event.payload as EventPayloads["SubagentSpecInvoked"]; await tx.execute({ sql: "INSERT INTO subagent_spec_invocations(event_id,entry_id,version_id,task_id,child_session_id,child_branch_id,created_at) VALUES(?,?,?,?,?,?,?)", args: [event.id,p.entryId,p.versionId,p.taskId,p.childSessionId,p.childBranchId,event.committedAt] }); }
    if (event.type === "SyncConflictResolved") { const p = event.payload as EventPayloads["SyncConflictResolved"]; const resolution = { action:p.action,resolvedBy:p.resolvedBy,...(p.chosenEventId===undefined?{}:{chosenEventId:p.chosenEventId}),...(p.note===undefined?{}:{note:p.note}) }; await tx.execute({ sql:"UPDATE sync_reconciliations SET status='resolved',resolution_json=?,resolved_at=? WHERE conflict_id=? AND status='unresolved'", args:[json(resolution),p.resolvedAt,p.conflictId] }); }
  }

  async #lineage(
    executor: Client | Transaction,
    sessionId: string,
    branchId: string,
  ): Promise<Array<{ branchId: string; upper: number | null }>> {
    const result = await executor.execute({
      sql: "SELECT branch_id,parent_branch_id,fork_cursor FROM branches WHERE session_id=?",
      args: [sessionId],
    });
    const map = new Map(result.rows.map((row) => [
      String(row.branch_id),
      {
        parent: row.parent_branch_id === null ? null : String(row.parent_branch_id),
        fork: row.fork_cursor === null ? null : sequenceOf(String(row.fork_cursor)),
      },
    ]));
    if (!map.has(branchId)) return [];
    const lineage: Array<{ branchId: string; fork: number | null }> = [];
    let current: string | null = branchId;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current)) throw new ConflictError("Cyclic branch ancestry", { sessionId, branchId: current });
      visited.add(current);
      const entry = map.get(current);
      if (!entry) throw new ConflictError("Broken branch ancestry", { sessionId, branchId: current });
      lineage.push({ branchId: current, fork: entry.fork });
      current = entry.parent;
    }
    lineage.reverse();

    // A branch may fork from an event inherited from any ancestor. Every
    // ancestor must therefore be clamped to the earliest fork cursor below it,
    // not merely to its immediate child's creation cursor.
    const resultLineage: Array<{ branchId: string; upper: number | null }> = new Array(lineage.length);
    let descendantUpper: number | null = null;
    for (let index = lineage.length - 1; index >= 0; index--) {
      const entry = lineage[index]!;
      resultLineage[index] = { branchId: entry.branchId, upper: descendantUpper };
      if (entry.fork !== null) {
        descendantUpper = descendantUpper === null ? entry.fork : Math.min(descendantUpper, entry.fork);
      }
    }
    return resultLineage;
  }

  async #loadBranchEvents(
    executor: Client | Transaction,
    sessionId: string,
    branchId: string,
    untilCursor?: string,
  ): Promise<AgentEvent[]> {
    const lineage = await this.#lineage(executor, sessionId, branchId);
    const events: AgentEvent[] = [];
    for (const part of lineage) {
      const args: InValue[] = [sessionId, part.branchId];
      let sql = "SELECT * FROM events WHERE session_id=? AND branch_id=?";
      if (part.upper !== null) { sql += " AND sequence<=?"; args.push(part.upper); }
      const result = await executor.execute({ sql: `${sql} ORDER BY sequence`, args });
      events.push(...result.rows.map(rowToEvent));
    }
    const until = untilCursor === undefined ? Number.MAX_SAFE_INTEGER : sequenceOf(untilCursor);
    return events
      .filter((event) => sequenceOf(event.cursor) <= until)
      .sort((left, right) => sequenceOf(left.cursor) - sequenceOf(right.cursor));
  }

  async loadEvents(sessionId: string, query: EventQuery = {}): Promise<AgentEvent[]> {
    if (!query.branchId) {
      const clauses = ["session_id=?"];
      const args: InValue[] = [sessionId];
      if (query.afterCursor) { clauses.push("sequence>?"); args.push(sequenceOf(query.afterCursor)); }
      if (query.untilCursor) { clauses.push("sequence<=?"); args.push(sequenceOf(query.untilCursor)); }
      const result = await this.#client.execute({
        sql: `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY sequence`,
        args,
      });
      return result.rows.map(rowToEvent);
    }
    const events = await this.#loadBranchEvents(this.#client, sessionId, query.branchId, query.untilCursor);
    const after = query.afterCursor ? sequenceOf(query.afterCursor) : -1;
    return events.filter((event) => sequenceOf(event.cursor) > after);
  }
  async getEvent(eventId: string): Promise<AgentEvent|null> { const r=await this.#client.execute({sql:"SELECT * FROM events WHERE id=?",args:[eventId]}); return r.rows[0]?rowToEvent(r.rows[0]):null; }
  async getLatestCursor(sessionId: string, branchId: string): Promise<string|null> { const events=await this.loadEvents(sessionId,{branchId}); return events.at(-1)?.cursor ?? null; }
  async listBranches():Promise<Array<{sessionId:string;branchId:string}>>{const r=await this.#client.execute("SELECT session_id,branch_id FROM branches ORDER BY session_id,branch_id");return r.rows.map(row=>({sessionId:String(row.session_id),branchId:String(row.branch_id)}));}
  async saveSnapshot(state: AgentState): Promise<void> { await this.#client.execute({sql:"INSERT INTO snapshots(session_id,branch_id,cursor,reducer_version,state_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,branch_id) DO UPDATE SET cursor=excluded.cursor,reducer_version=excluded.reducer_version,state_json=excluded.state_json,updated_at=excluded.updated_at",args:[state.sessionId,state.branch.id,state.cursor,state.reducerVersion,json(state),new Date().toISOString()]}); }
  async loadSnapshot(sessionId:string,branchId:string):Promise<AgentState|null>{const r=await this.#client.execute({sql:"SELECT reducer_version,state_json FROM snapshots WHERE session_id=? AND branch_id=?",args:[sessionId,branchId]});if(!r.rows[0]||Number(r.rows[0].reducer_version)!==3)return null;return JSON.parse(String(r.rows[0].state_json)) as AgentState;}
  async deleteSnapshots(sessionId?:string):Promise<void>{if(sessionId)await this.#client.execute({sql:"DELETE FROM snapshots WHERE session_id=?",args:[sessionId]});else await this.#client.execute("DELETE FROM snapshots");}

  async getProcessExecutionLease(scope: ProcessExecutionLeaseScope): Promise<ProcessExecutionLeaseRecord | null> {
    const { scopeKind, scopeId } = leaseScopeParts(scope);
    const result = await this.#client.execute({
      sql: "SELECT * FROM process_execution_leases WHERE scope_kind=? AND scope_id=?",
      args: [scopeKind, scopeId],
    });
    return result.rows[0] ? rowToProcessExecutionLease(result.rows[0]) : null;
  }

  async claimProcessExecutionLease(input: ProcessExecutionLeaseClaim): Promise<ProcessExecutionLeaseRecord> {
    const parts = leaseScopeParts(input.scope);
    assertLeaseOwner(input.ownerDeviceId, input.ownerProcessId);
    assertLeaseMs(input.leaseMs);
    const now = canonicalLeaseTime(input.now);
    const leaseExpiresAt = this.#leaseExpiry(now, input.leaseMs);
    return this.#writes.run(() => this.#withLeaseTransaction(async (tx) => {
      const workspaceId = await this.#leaseWorkspace(tx, input.scope, input.ownerDeviceId);
      const blocker = parts.scopeKind === "workspace"
        ? await tx.execute({
          sql: `SELECT * FROM process_execution_leases
            WHERE workspace_id=? AND NOT(scope_kind=? AND scope_id=?)
              AND released_at IS NULL AND lease_expires_at>?
            ORDER BY scope_kind,scope_id LIMIT 1`,
          args: [workspaceId, parts.scopeKind, parts.scopeId, now],
        })
        : await tx.execute({
          sql: `SELECT * FROM process_execution_leases
            WHERE workspace_id=? AND scope_kind='workspace'
              AND released_at IS NULL AND lease_expires_at>?
            LIMIT 1`,
          args: [workspaceId, now],
        });
      if (blocker.rows[0]) {
        this.#throwLeaseConflict("claim", parts, "overlapping_scope_owned", blocker.rows[0]);
      }

      const selected = await tx.execute({
        sql: "SELECT * FROM process_execution_leases WHERE scope_kind=? AND scope_id=?",
        args: [parts.scopeKind, parts.scopeId],
      });
      const current = selected.rows[0];
      if (current && current.released_at === null && String(current.lease_expires_at) > now) {
        if (String(current.owner_device_id) === input.ownerDeviceId &&
            String(current.owner_process_id) === input.ownerProcessId) {
          return rowToProcessExecutionLease(current);
        }
        this.#throwLeaseConflict("claim", parts, "active_owner", current);
      }

      if (!current) {
        await tx.execute({
          sql: `INSERT INTO process_execution_leases(
            scope_kind,scope_id,workspace_id,owner_device_id,owner_process_id,fence_token,
            acquired_at,renewed_at,lease_expires_at,released_at
          ) VALUES(?,?,?,?,?,1,?,?,?,NULL)`,
          args: [parts.scopeKind, parts.scopeId, workspaceId, input.ownerDeviceId, input.ownerProcessId, now, now, leaseExpiresAt],
        });
      } else {
        const fenceToken = Number(current.fence_token);
        if (!Number.isSafeInteger(fenceToken) || fenceToken >= Number.MAX_SAFE_INTEGER) {
          throw new ValidationError("Execution lease fence token is exhausted", {
            scopeKind: parts.scopeKind, scopeId: parts.scopeId,
          });
        }
        const changed = await tx.execute({
          sql: `UPDATE process_execution_leases SET
            workspace_id=?,owner_device_id=?,owner_process_id=?,fence_token=fence_token+1,
            acquired_at=?,renewed_at=?,lease_expires_at=?,released_at=NULL
            WHERE scope_kind=? AND scope_id=? AND fence_token=?
              AND (released_at IS NOT NULL OR lease_expires_at<=?)`,
          args: [workspaceId, input.ownerDeviceId, input.ownerProcessId, now, now, leaseExpiresAt,
            parts.scopeKind, parts.scopeId, fenceToken, now],
        });
        if (changed.rowsAffected !== 1) {
          const raced = await tx.execute({
            sql: "SELECT * FROM process_execution_leases WHERE scope_kind=? AND scope_id=?",
            args: [parts.scopeKind, parts.scopeId],
          });
          this.#throwLeaseConflict("claim", parts, "compare_and_swap_lost", raced.rows[0]);
        }
      }
      const claimed = await tx.execute({
        sql: "SELECT * FROM process_execution_leases WHERE scope_kind=? AND scope_id=?",
        args: [parts.scopeKind, parts.scopeId],
      });
      return rowToProcessExecutionLease(claimed.rows[0]!);
    }));
  }

  async renewProcessExecutionLease(input: ProcessExecutionLeaseRenewal): Promise<ProcessExecutionLeaseRecord> {
    const parts = leaseScopeParts(input.scope);
    assertLeaseOwner(input.ownerDeviceId, input.ownerProcessId);
    assertFenceToken(input.fenceToken);
    assertLeaseMs(input.leaseMs);
    const now = canonicalLeaseTime(input.now);
    const leaseExpiresAt = this.#leaseExpiry(now, input.leaseMs);
    return this.#writes.run(() => this.#withLeaseTransaction(async (tx) => {
      await this.#leaseWorkspace(tx, input.scope, input.ownerDeviceId);
      const changed = await tx.execute({
        sql: `UPDATE process_execution_leases SET renewed_at=?,lease_expires_at=?
          WHERE scope_kind=? AND scope_id=? AND owner_device_id=? AND owner_process_id=?
            AND fence_token=? AND released_at IS NULL AND lease_expires_at>?`,
        args: [now, leaseExpiresAt, parts.scopeKind, parts.scopeId, input.ownerDeviceId,
          input.ownerProcessId, input.fenceToken, now],
      });
      if (changed.rowsAffected !== 1) {
        const selected = await tx.execute({
          sql: "SELECT * FROM process_execution_leases WHERE scope_kind=? AND scope_id=?",
          args: [parts.scopeKind, parts.scopeId],
        });
        this.#throwLeaseConflict("renew", parts, "stale_fence_owner_or_expiry", selected.rows[0]);
      }
      const renewed = await tx.execute({
        sql: "SELECT * FROM process_execution_leases WHERE scope_kind=? AND scope_id=?",
        args: [parts.scopeKind, parts.scopeId],
      });
      return rowToProcessExecutionLease(renewed.rows[0]!);
    }));
  }

  async releaseProcessExecutionLease(input: ProcessExecutionLeaseProof): Promise<ProcessExecutionLeaseRecord> {
    const parts = leaseScopeParts(input.scope);
    assertLeaseOwner(input.ownerDeviceId, input.ownerProcessId);
    assertFenceToken(input.fenceToken);
    const now = canonicalLeaseTime(input.now);
    return this.#writes.run(() => this.#withLeaseTransaction(async (tx) => {
      await this.#leaseWorkspace(tx, input.scope, input.ownerDeviceId);
      const changed = await tx.execute({
        sql: `UPDATE process_execution_leases SET released_at=?
          WHERE scope_kind=? AND scope_id=? AND owner_device_id=? AND owner_process_id=?
            AND fence_token=? AND released_at IS NULL AND lease_expires_at>?`,
        args: [now, parts.scopeKind, parts.scopeId, input.ownerDeviceId, input.ownerProcessId,
          input.fenceToken, now],
      });
      if (changed.rowsAffected !== 1) {
        const selected = await tx.execute({
          sql: "SELECT * FROM process_execution_leases WHERE scope_kind=? AND scope_id=?",
          args: [parts.scopeKind, parts.scopeId],
        });
        this.#throwLeaseConflict("release", parts, "stale_fence_owner_or_expiry", selected.rows[0]);
      }
      const released = await tx.execute({
        sql: "SELECT * FROM process_execution_leases WHERE scope_kind=? AND scope_id=?",
        args: [parts.scopeKind, parts.scopeId],
      });
      return rowToProcessExecutionLease(released.rows[0]!);
    }));
  }

  #leaseExpiry(now: string, leaseMs: number): string {
    const expires = new Date(new Date(now).getTime() + leaseMs);
    if (!Number.isFinite(expires.getTime())) throw new ValidationError("Execution lease expiry is outside the supported date range");
    return expires.toISOString();
  }

  async #leaseWorkspace(tx: Transaction, scope: ProcessExecutionLeaseScope, ownerDeviceId: string): Promise<string> {
    if (scope.kind === "workspace") return scope.workspaceId;
    const selected = await tx.execute({
      sql: "SELECT session_id,root_session_id,workspace_id,execution_owner_device_id FROM sessions WHERE session_id=?",
      args: [scope.rootSessionId],
    });
    const root = selected.rows[0];
    if (!root) throw new NotFoundError("root session", scope.rootSessionId);
    if (String(root.root_session_id ?? root.session_id) !== scope.rootSessionId) {
      throw new ValidationError("Execution lease root scope must identify a root session", {
        rootSessionId: scope.rootSessionId,
        actualRootSessionId: String(root.root_session_id),
      });
    }
    const executionOwner = root.execution_owner_device_id;
    if (executionOwner !== null && executionOwner !== undefined && String(executionOwner) !== "legacy" &&
        String(executionOwner) !== ownerDeviceId) {
      throw new ExecutionOwnershipConflictError(
        "Root session belongs to another device and automatic ownership failover is unavailable",
        {
          reason: "device_owner_mismatch",
          scopeKind: "root",
          scopeId: scope.rootSessionId,
          requestedOwnerDeviceId: ownerDeviceId,
          currentOwnerDeviceId: String(executionOwner),
          distributedLeases: false,
        },
      );
    }
    return String(root.workspace_id);
  }

  #throwLeaseConflict(
    action: "claim" | "renew" | "release",
    scope: { readonly scopeKind: "workspace" | "root"; readonly scopeId: string },
    reason: string,
    row?: Row,
  ): never {
    throw new ExecutionOwnershipConflictError(`Cannot ${action} process execution lease: ownership conflict`, {
      reason,
      action,
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId,
      ...(row === undefined ? {} : {
        currentOwnerDeviceId: String(row.owner_device_id),
        currentOwnerProcessId: String(row.owner_process_id),
        currentFenceToken: Number(row.fence_token),
        currentLeaseExpiresAt: String(row.lease_expires_at),
        currentReleasedAt: row.released_at === null ? null : String(row.released_at),
      }),
    });
  }

  async #withLeaseTransaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      let tx: Transaction | undefined;
      try {
        tx = await this.#client.transaction("write");
        const result = await operation(tx);
        await tx.commit();
        return result;
      } catch (error) {
        if (tx && !tx.closed) await tx.rollback();
        if (!isSqliteBusy(error) || retry >= 100) throw error;
        await Bun.sleep(Math.min(10, retry + 1));
      } finally {
        tx?.close();
      }
    }
  }

  async claimOutbox(owner: string, limit = 1, leaseMs = 30_000): Promise<OutboxRecord[]> {
    return this.#writes.run(async () => {
      const tx = await this.#client.transaction("write");
      const claimed: OutboxRecord[] = [];
      try {
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
        const result = await tx.execute({
          sql: "SELECT * FROM outbox WHERE status='pending' ORDER BY created_at LIMIT ?",
          args: [limit],
        });
        for (const row of result.rows) {
          const updated = await tx.execute({
            sql: "UPDATE outbox SET status='running',owner=?,lease_expires_at=?,updated_at=? WHERE effect_id=? AND status='pending'",
            args: [owner, leaseExpiresAt, now.toISOString(), String(row.effect_id)],
          });
          if (updated.rowsAffected === 1) {
            claimed.push({ ...rowToOutbox(row), status: "running", owner, leaseExpiresAt });
          }
        }
        await tx.commit();
      } catch (error) {
        if (!tx.closed) await tx.rollback();
        throw error;
      } finally { tx.close(); }
      return claimed;
    });
  }
  async claimEffect(effectId: string, owner: string, leaseMs = 30_000): Promise<OutboxRecord | null> {
    return this.#writes.run(() => this.#claimEffect(effectId, owner, leaseMs));
  }
  async #claimEffect(effectId: string, owner: string, leaseMs: number): Promise<OutboxRecord | null> {
    for (let retry = 0; ; retry++) {
      let tx: Transaction | undefined;
      try {
        tx = await this.#client.transaction("write");
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
        const result = await tx.execute({
          sql: "SELECT * FROM outbox WHERE effect_id=? AND status='pending'",
          args: [effectId],
        });
        const row = result.rows[0];
        if (!row) { await tx.commit(); return null; }
        const updated = await tx.execute({
          sql: "UPDATE outbox SET status='running',owner=?,lease_expires_at=?,updated_at=? WHERE effect_id=? AND status='pending'",
          args: [owner, leaseExpiresAt, now.toISOString(), effectId],
        });
        await tx.commit();
        return updated.rowsAffected === 1
          ? { ...rowToOutbox(row), status: "running", owner, leaseExpiresAt }
          : null;
      } catch (error) {
        if (tx && !tx.closed) await tx.rollback();
        if (!isSqliteBusy(error) || retry >= 20) throw error;
        await Bun.sleep(Math.min(25, retry + 1));
      } finally {
        tx?.close();
      }
    }
  }
  async getOutbox(effectId:string):Promise<OutboxRecord|null>{const r=await this.#client.execute({sql:"SELECT * FROM outbox WHERE effect_id=?",args:[effectId]});return r.rows[0]?rowToOutbox(r.rows[0]):null;}
  async listOutbox(statuses?:readonly OutboxRecord["status"][]):Promise<OutboxRecord[]>{let sql="SELECT * FROM outbox",args:InValue[]=[];if(statuses?.length){sql+=` WHERE status IN (${statuses.map(()=>"?").join(",")})`;args=[...statuses];}const r=await this.#client.execute({sql:sql+" ORDER BY created_at",args});return r.rows.map(rowToOutbox);}
  async resetOutbox(effectId: string): Promise<void> {
    await this.#writes.run(async () => {
      await this.#client.execute({
        sql: "UPDATE outbox SET status='pending',owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND status='running'",
        args: [new Date().toISOString(), effectId],
      });
    });
  }
  async getSession(sessionId: string): Promise<SessionRecord | null> { const result = await this.#client.execute({ sql: "SELECT s.*,t.status AS task_status FROM sessions s LEFT JOIN tasks t ON t.task_id=s.task_id WHERE s.session_id=?", args: [sessionId] }); return result.rows[0] ? rowToSession(result.rows[0]) : null; }
  async listChildren(parentSessionId: string): Promise<SessionRecord[]> { const result = await this.#client.execute({ sql: "SELECT s.*,t.status AS task_status FROM sessions s LEFT JOIN tasks t ON t.task_id=s.task_id WHERE s.parent_session_id=? ORDER BY s.depth,s.session_id", args: [parentSessionId] }); return result.rows.map(rowToSession); }
  async getTask(taskId: string): Promise<TaskRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM tasks WHERE task_id=?", args: [taskId] }); return result.rows[0] ? rowToTask(result.rows[0]) : null; }
  async findTaskByChild(childSessionId: string): Promise<TaskRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM tasks WHERE child_session_id=?", args: [childSessionId] }); return result.rows[0] ? rowToTask(result.rows[0]) : null; }
  async listTasks(parentSessionId: string, parentBranchId?: string): Promise<TaskRecord[]> {
    const result = parentBranchId === undefined
      ? await this.#client.execute({ sql: "SELECT * FROM tasks WHERE parent_session_id=? ORDER BY created_at,task_id", args: [parentSessionId] })
      : await this.#client.execute({ sql: "SELECT * FROM tasks WHERE parent_session_id=? AND parent_branch_id=? ORDER BY created_at,task_id", args: [parentSessionId,parentBranchId] });
    return result.rows.map(rowToTask);
  }
  async getMailboxMessage(messageId: string): Promise<MailboxRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM mailbox_messages WHERE mailbox_message_id=?", args: [messageId] }); return result.rows[0] ? rowToMailbox(result.rows[0]) : null; }
  async listMailboxMessages(sessionId: string, direction: "inbound" | "outbound" | "all" = "all"): Promise<MailboxRecord[]> {
    const where = direction === "inbound" ? "to_session_id=?" : direction === "outbound" ? "from_session_id=?" : "(from_session_id=? OR to_session_id=?)";
    const args: InValue[] = direction === "all" ? [sessionId,sessionId] : [sessionId];
    const result = await this.#client.execute({ sql: `SELECT * FROM mailbox_messages WHERE ${where} ORDER BY sent_at,mailbox_message_id`, args });
    return result.rows.map(rowToMailbox);
  }
  async getDocument(documentId: string): Promise<DocumentRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM documents WHERE document_id=?", args: [documentId] }); return result.rows[0] ? rowToDocument(result.rows[0]) : null; }
  async getDocumentChunk(chunkId: string): Promise<DocumentChunkRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM document_chunks WHERE chunk_id=?", args: [chunkId] }); return result.rows[0] ? rowToDocumentChunk(result.rows[0]) : null; }
  async readDocumentChunks(documentId: string, options: { readonly start?: number; readonly limit?: number; readonly chunkIds?: readonly string[] } = {}): Promise<DocumentChunkRecord[]> {
    const start = options.start ?? 0; const limit = Math.min(options.limit ?? 100, 1000);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1) throw new ValidationError("Invalid document chunk range");
    if (options.chunkIds) {
      if (options.chunkIds.length === 0) return [];
      const result = await this.#client.execute({ sql: `SELECT * FROM document_chunks WHERE document_id=? AND chunk_id IN (${options.chunkIds.map(() => "?").join(",")}) ORDER BY ordinal LIMIT ?`, args: [documentId,...options.chunkIds,limit] });
      return result.rows.map(rowToDocumentChunk);
    }
    const result = await this.#client.execute({ sql: "SELECT * FROM document_chunks WHERE document_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?", args: [documentId,start,limit] });
    return result.rows.map(rowToDocumentChunk);
  }
  async getInputSet(inputSetId: string): Promise<InputSetRecord | null> {
    const result = await this.#client.execute({ sql: "SELECT * FROM input_sets WHERE input_set_id=?", args: [inputSetId] }); const row = result.rows[0]; if (!row) return null;
    const chunks = await this.#client.execute({ sql: "SELECT chunk_id FROM input_set_chunks WHERE input_set_id=? ORDER BY ordinal", args: [inputSetId] });
    const metadata = optionalJson(row,"metadata_json");
    return { inputSetId: String(row.input_set_id), sessionId: String(row.session_id), branchId: String(row.branch_id), name: row.name === null ? null : String(row.name), chunkIds: chunks.rows.map((chunk) => String(chunk.chunk_id)), ...(metadata === undefined ? {} : { metadata }), createdAt: String(row.created_at) };
  }
  async getGoal(goalId: string): Promise<GoalRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM goals WHERE goal_id=?", args: [goalId] }); return result.rows[0] ? rowToGoal(result.rows[0]) : null; }
  async listGoalGates(goalId: string): Promise<GoalGateRecord[]> { const result = await this.#client.execute({ sql: "SELECT * FROM goal_gates WHERE goal_id=? ORDER BY created_at,gate_id", args: [goalId] }); return result.rows.map(rowToGoalGate); }
  async listGoalGateEvaluations(goalId: string, gateId?: string): Promise<GoalGateEvaluationRecord[]> { const result = await this.#client.execute(gateId === undefined ? { sql: "SELECT * FROM goal_gate_evaluations WHERE goal_id=? ORDER BY created_at,evaluation_id", args: [goalId] } : { sql: "SELECT * FROM goal_gate_evaluations WHERE goal_id=? AND gate_id=? ORDER BY created_at,evaluation_id", args: [goalId,gateId] }); return result.rows.map(rowToGoalGateEvaluation); }
  async getHeartbeat(heartbeatId: string): Promise<HeartbeatRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM heartbeats WHERE heartbeat_id=?", args: [heartbeatId] }); return result.rows[0] ? rowToHeartbeat(result.rows[0]) : null; }
  async listHeartbeats(sessionId: string, branchId?: string): Promise<HeartbeatRecord[]> { const result = await this.#client.execute(branchId === undefined ? { sql: "SELECT * FROM heartbeats WHERE session_id=? ORDER BY created_at,heartbeat_id", args: [sessionId] } : { sql: "SELECT * FROM heartbeats WHERE session_id=? AND branch_id=? ORDER BY created_at,heartbeat_id", args: [sessionId,branchId] }); return result.rows.map(rowToHeartbeat); }
  async listDueHeartbeats(at: string): Promise<HeartbeatRecord[]> { const result = await this.#client.execute({ sql: "SELECT * FROM heartbeats WHERE status='active' AND next_tick_at<=? ORDER BY next_tick_at,heartbeat_id", args: [at] }); return result.rows.map(rowToHeartbeat); }
  async getSchedule(scheduleId: string): Promise<ScheduleRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM schedules WHERE schedule_id=?", args: [scheduleId] }); return result.rows[0] ? rowToSchedule(result.rows[0]) : null; }
  async listSchedules(sessionId: string, branchId?: string): Promise<ScheduleRecord[]> { const result = await this.#client.execute(branchId === undefined ? { sql: "SELECT * FROM schedules WHERE session_id=? ORDER BY created_at,schedule_id", args: [sessionId] } : { sql: "SELECT * FROM schedules WHERE session_id=? AND branch_id=? ORDER BY created_at,schedule_id", args: [sessionId,branchId] }); return result.rows.map(rowToSchedule); }
  async listDueSchedules(at: string): Promise<ScheduleRecord[]> { const result = await this.#client.execute({ sql: "SELECT * FROM schedules WHERE status='active' AND next_tick_at<=? ORDER BY next_tick_at,schedule_id", args: [at] }); return result.rows.map(rowToSchedule); }
  async getWake(wakeId: string): Promise<WakeRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM wake_queue WHERE wake_id=?", args: [wakeId] }); return result.rows[0] ? rowToWake(result.rows[0]) : null; }
  async listWakes(sessionId: string, branchId?: string, statuses?: readonly WakeRecord["status"][]): Promise<WakeRecord[]> { const args: InValue[] = [sessionId]; let sql = "SELECT * FROM wake_queue WHERE session_id=?"; if (branchId !== undefined) { sql += " AND branch_id=?"; args.push(branchId); } if (statuses?.length) { sql += ` AND status IN (${statuses.map(() => "?").join(",")})`; args.push(...statuses); } const result = await this.#client.execute({ sql: `${sql} ORDER BY created_at,wake_id`, args }); return result.rows.map(rowToWake); }
  async getRecursiveModel(handleId: string): Promise<RecursiveModelRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM recursive_model_handles WHERE handle_id=?", args: [handleId] }); return result.rows[0] ? rowToRecursiveModel(result.rows[0]) : null; }
  async listRecursiveModels(statuses?: readonly RecursiveModelRecord["status"][]): Promise<RecursiveModelRecord[]> {
    const args: InValue[] = []; let sql = "SELECT * FROM recursive_model_handles";
    if (statuses?.length) { sql += ` WHERE status IN (${statuses.map(() => "?").join(",")})`; args.push(...statuses); }
    const result = await this.#client.execute({ sql: `${sql} ORDER BY created_at,handle_id`, args }); return result.rows.map(rowToRecursiveModel);
  }

  async rebuildMemoryCandidateIndex(): Promise<void> {
    await this.#writes.run(async () => {
      const tx = await this.#client.transaction("write");
      try {
        await tx.execute("DELETE FROM memory_fts");
        const rows = await tx.execute("SELECT version_id,entry_id,content_json,tags_json FROM harness_versions WHERE kind='memory' ORDER BY version_id");
        for (const row of rows.rows) {
          const content = JSON.parse(String(row.content_json)) as { text?: string };
          const tags = JSON.parse(String(row.tags_json)) as string[];
          await tx.execute({ sql: "INSERT INTO memory_fts(version_id,entry_id,content,tags) VALUES(?,?,?,?)", args: [String(row.version_id),String(row.entry_id),content.text ?? "",tags.join(" ")] });
        }
        await tx.commit();
      } catch (error) { if (!tx.closed) await tx.rollback(); throw error; } finally { tx.close(); }
    });
  }

  async rebuildOperationalProjections(): Promise<void> {
    await this.#writes.run(async () => {
      const tx = await this.#client.transaction("write");
      try {
        for (const table of ["memory_fts","subagent_spec_invocations","skill_executions","refinement_rollbacks","refinement_rollback_approvals","refinement_approvals","refinement_decisions","refinement_observations","candidate_allocations","refinement_proposals","harness_versions","harness_entries","input_set_chunks","input_sets","document_chunks","documents","terminal_notices","mailbox_messages","goal_gate_evaluations","goal_gates","goals","wake_queue","schedules","heartbeats","recursive_model_handles","tasks","branches","sessions"]) await tx.execute(`DELETE FROM ${table}`);
        const rows = await tx.execute("SELECT * FROM events ORDER BY sequence");
        const selected = new Set(["SessionCreated","BranchCreated","BranchNamed","TaskCreated","SubagentAdmitted","TaskStatusChanged","SubagentCancellationRequested","MailboxMessageSent","MailboxMessageDelivered","MailboxMessageContextDelivered","MailboxMessageDeliveryFailed","MailboxMessageAcknowledged","TaskTerminalNoticeSent","TaskTerminalNoticeDelivered","DocumentImported","DocumentChunkAdded","InputSetCreated","GoalCreated","GoalCompletionRequested","GoalGateAdded","GoalGateStatusChanged","GoalGateEvaluationRecorded","GoalStatusChanged","HeartbeatCreated","HeartbeatTicked","HeartbeatStatusChanged","ScheduleCreated","ScheduleTicked","ScheduleStatusChanged","WakeQueued","WakeClaimed","WakeDelivered","WakeDeliveryUnknown","RecursiveModelStarted","RecursiveModelStatusChanged","HarnessVersionCreated","HarnessVersionStatusChanged","RefinementProposed","RefinementValidated","RefinementCandidateActivated","RefinementCandidateAllocated","RefinementCandidateExposed","RefinementObservationRecorded","RefinementDecided","RefinementApproved","RefinementRollbackApproved","RefinementRolledBack","SkillInvocationRecorded","SkillTestRecorded","SubagentSpecInvoked","SyncConflictResolved"]);
        for (const row of rows.rows) { const event = rowToEvent(row); if (selected.has(event.type)) await this.#applyOperationalRows(tx,event); }
        await tx.commit();
      } catch (error) { if (!tx.closed) await tx.rollback(); throw error; } finally { tx.close(); }
    });
  }

  async listOriginEvents(deviceId: string, afterOriginSequence = 0): Promise<AgentEvent[]> {
    if (!Number.isSafeInteger(afterOriginSequence) || afterOriginSequence < 0) throw new ValidationError("Invalid origin sequence cursor");
    const result = await this.#client.execute({
      sql: "SELECT * FROM events WHERE (origin_device_id=? AND origin_sequence>?) OR (origin_device_id IS NULL AND sequence>?) ORDER BY COALESCE(origin_sequence,sequence),sequence",
      args: [deviceId,afterOriginSequence,afterOriginSequence],
    });
    return result.rows.map(rowToEvent).map((event) => event.originDeviceId === "legacy" ? { ...event, originDeviceId: deviceId } : event);
  }
  async appendReplicatedEvent(event: NewAgentEvent): Promise<AgentEvent> {
    if (!event.id || !event.originDeviceId || event.originSequence === undefined || event.streamParentId === undefined) throw new ValidationError("Replicated append requires complete envelope identity");
    const [committed] = await this.appendEvents([event]);
    if (!committed) throw new Error("Replicated event was not committed");
    return committed;
  }
  async findEventByIntent(sessionId: string, type: string, idempotencyKey: string): Promise<AgentEvent | null> {
    const result = await this.#client.execute({ sql:"SELECT * FROM events WHERE session_id=? AND type=? AND idempotency_key=?", args:[sessionId,type,idempotencyKey] });
    return result.rows[0] ? rowToEvent(result.rows[0]) : null;
  }
  async findEventByOriginSequence(originDeviceId:string,originSequence:number):Promise<AgentEvent|null>{const result=await this.#client.execute({sql:"SELECT * FROM events WHERE origin_device_id=? AND origin_sequence=? LIMIT 1",args:[originDeviceId,originSequence]});return result.rows[0]?rowToEvent(result.rows[0]):null;}
  async findTaskClaimEvents(taskId:string):Promise<AgentEvent[]>{const r=await this.#client.execute({sql:"SELECT * FROM events WHERE type='TaskStatusChanged' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.status')='running' ORDER BY sequence",args:[taskId]});return r.rows.map(rowToEvent);}
  async getDirectBranchTip(sessionId: string, branchId: string): Promise<AgentEvent | null> {
    const result = await this.#client.execute({ sql:"SELECT * FROM events WHERE session_id=? AND branch_id=? ORDER BY sequence DESC LIMIT 1", args:[sessionId,branchId] });
    return result.rows[0] ? rowToEvent(result.rows[0]) : null;
  }
  async getEventCursor(eventId: string): Promise<string | null> {
    const result=await this.#client.execute({sql:"SELECT sequence FROM events WHERE id=?",args:[eventId]});
    return result.rows[0] ? cursorOf(Number(result.rows[0].sequence)) : null;
  }
  async getReplicaStatus(replicaId: string): Promise<WorkspaceReplicaStatusRecord | null> { const r=await this.#client.execute({sql:"SELECT * FROM workspace_replica_status WHERE replica_id=?",args:[replicaId]});return r.rows[0]?rowToReplicaStatus(r.rows[0]):null; }
  async listReplicaStatuses(workspaceId: string): Promise<WorkspaceReplicaStatusRecord[]> { const r=await this.#client.execute({sql:"SELECT * FROM workspace_replica_status WHERE workspace_id=? ORDER BY updated_at,replica_id",args:[workspaceId]});return r.rows.map(rowToReplicaStatus); }
  async putReplicaStatus(s: WorkspaceReplicaStatusRecord): Promise<void> { await this.#writes.run(async()=>{await this.#client.execute({sql:`INSERT INTO workspace_replica_status(replica_id,replica_incarnation,workspace_id,device_id,replica_url,sync_url,credential_reference,lifecycle,last_attempt_at,last_success_at,last_error,last_stats_json,staged_envelopes,ingested_envelopes,quarantined_envelopes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(replica_id) DO UPDATE SET replica_incarnation=excluded.replica_incarnation,workspace_id=excluded.workspace_id,device_id=excluded.device_id,replica_url=COALESCE(excluded.replica_url,workspace_replica_status.replica_url),sync_url=COALESCE(excluded.sync_url,workspace_replica_status.sync_url),credential_reference=COALESCE(excluded.credential_reference,workspace_replica_status.credential_reference),lifecycle=excluded.lifecycle,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,last_error=excluded.last_error,last_stats_json=excluded.last_stats_json,staged_envelopes=excluded.staged_envelopes,ingested_envelopes=excluded.ingested_envelopes,quarantined_envelopes=excluded.quarantined_envelopes,updated_at=excluded.updated_at`,args:[s.replicaId,s.replicaIncarnation,s.workspaceId,s.deviceId,s.replicaUrl,s.syncUrl,s.credentialReference,s.lifecycle,s.lastAttemptAt,s.lastSuccessAt,s.lastError,s.lastStats===null?null:json(s.lastStats),s.stagedEnvelopes,s.ingestedEnvelopes,s.quarantinedEnvelopes,s.updatedAt]});}); }
  async getSyncReceipt(envelopeId:string):Promise<SyncIngestReceiptRecord|null>{const r=await this.#client.execute({sql:"SELECT * FROM sync_ingest_receipts WHERE envelope_id=?",args:[envelopeId]});return r.rows[0]?rowToReceipt(r.rows[0]):null;}
  async getSyncReceiptForEvent(eventId:string):Promise<SyncIngestReceiptRecord|null>{const r=await this.#client.execute({sql:"SELECT * FROM sync_ingest_receipts WHERE event_id=? ORDER BY ingested_at,envelope_id LIMIT 1",args:[eventId]});return r.rows[0]?rowToReceipt(r.rows[0]):null;}
  async putSyncReceipt(x:SyncIngestReceiptRecord):Promise<void>{await this.#writes.run(async()=>{await this.#client.execute({sql:"INSERT INTO sync_ingest_receipts(envelope_id,digest,origin_device_id,origin_sequence,event_id,source_branch_id,mapped_branch_id,ingested_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(envelope_id) DO NOTHING",args:[x.envelopeId,x.digest,x.originDeviceId,x.originSequence,x.eventId,x.sourceBranchId,x.mappedBranchId,x.ingestedAt]});});}
  async listSyncOriginWatermarks(replicaId:string):Promise<SyncOriginWatermarkRecord[]>{const r=await this.#client.execute({sql:"SELECT * FROM sync_origin_watermarks WHERE replica_id=? ORDER BY origin_device_id",args:[replicaId]});return r.rows.map(rowToOriginWatermark);}
  async putSyncOriginWatermark(x:SyncOriginWatermarkRecord):Promise<void>{await this.#writes.run(async()=>{await this.#client.execute({sql:"INSERT INTO sync_origin_watermarks(replica_id,origin_device_id,staged_sequence,ingested_sequence,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(replica_id,origin_device_id) DO UPDATE SET staged_sequence=MAX(sync_origin_watermarks.staged_sequence,excluded.staged_sequence),ingested_sequence=MAX(sync_origin_watermarks.ingested_sequence,excluded.ingested_sequence),updated_at=excluded.updated_at",args:[x.replicaId,x.originDeviceId,x.stagedSequence,x.ingestedSequence,x.updatedAt]});});}
  async resetSyncStaging(replicaId:string):Promise<void>{await this.#writes.run(async()=>{await this.#client.execute({sql:"UPDATE sync_origin_watermarks SET staged_sequence=0,updated_at=? WHERE replica_id=?",args:[new Date().toISOString(),replicaId]});});}
  async getSyncQuarantine(envelopeId:string):Promise<SyncQuarantineRecord|null>{const r=await this.#client.execute({sql:"SELECT * FROM sync_quarantine WHERE envelope_id=?",args:[envelopeId]});return r.rows[0]?rowToQuarantine(r.rows[0]):null;}
  async listSyncQuarantine():Promise<SyncQuarantineRecord[]>{const r=await this.#client.execute("SELECT * FROM sync_quarantine ORDER BY first_seen_at,envelope_id");return r.rows.map(rowToQuarantine);}
  async putSyncQuarantine(x:SyncQuarantineRecord):Promise<void>{await this.#writes.run(async()=>{await this.#client.execute({sql:`INSERT INTO sync_quarantine(envelope_id,workspace_id,origin_device_id,origin_sequence,reason_code,reason,envelope_json,digest,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(envelope_id) DO UPDATE SET reason_code=excluded.reason_code,reason=excluded.reason,envelope_json=excluded.envelope_json,digest=excluded.digest,status=excluded.status,last_seen_at=excluded.last_seen_at`,args:[x.envelopeId,x.workspaceId,x.originDeviceId,x.originSequence,x.reasonCode,x.reason,json(x.envelope),x.digest,x.status,x.firstSeenAt,x.lastSeenAt]});});}
  async getBranchMapping(originDeviceId:string,sessionId:string,sourceBranchId:string,sourceParentEventId:string):Promise<SyncBranchMappingRecord|null>{const r=await this.#client.execute({sql:"SELECT * FROM sync_branch_mappings WHERE origin_device_id=? AND session_id=? AND source_branch_id=? AND last_source_event_id=? ORDER BY created_at LIMIT 1",args:[originDeviceId,sessionId,sourceBranchId,sourceParentEventId]});return r.rows[0]?rowToMapping(r.rows[0]):null;}
  async putBranchMapping(x:SyncBranchMappingRecord):Promise<void>{await this.#writes.run(async()=>{await this.#client.execute({sql:"INSERT INTO sync_branch_mappings(mapping_id,origin_device_id,session_id,source_branch_id,fork_event_id,derived_branch_id,last_source_event_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(mapping_id) DO NOTHING",args:[x.mappingId,x.originDeviceId,x.sessionId,x.sourceBranchId,x.forkEventId,x.derivedBranchId,x.lastSourceEventId,x.createdAt]});});}
  async advanceBranchMapping(mappingId:string,lastSourceEventId:string):Promise<void>{await this.#writes.run(async()=>{await this.#client.execute({sql:"UPDATE sync_branch_mappings SET last_source_event_id=? WHERE mapping_id=?",args:[lastSourceEventId,mappingId]});});}
  async listSyncConflicts(status?:"unresolved"|"resolved"):Promise<SyncConflictRecord[]>{const r=status?await this.#client.execute({sql:"SELECT * FROM sync_reconciliations WHERE status=? ORDER BY detected_at,conflict_id",args:[status]}):await this.#client.execute("SELECT * FROM sync_reconciliations ORDER BY detected_at,conflict_id");return r.rows.map(rowToSyncConflict);}
  async putSyncConflict(x:SyncConflictRecord):Promise<void>{await this.#writes.run(async()=>{await this.#client.execute({sql:"INSERT INTO sync_reconciliations(conflict_id,kind,workspace_id,session_id,task_id,event_ids_json,origin_device_ids_json,details_json,status,resolution_json,detected_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conflict_id) DO NOTHING",args:[x.conflictId,x.kind,x.workspaceId,x.sessionId,x.taskId,json(x.eventIds),json(x.originDeviceIds),json(x.details),x.status,x.resolution===undefined?null:json(x.resolution),x.detectedAt,x.resolvedAt]});const resolution=await this.#client.execute({sql:"SELECT payload_json FROM events WHERE type='SyncConflictResolved' AND json_extract(payload_json,'$.conflictId')=? ORDER BY sequence DESC LIMIT 1",args:[x.conflictId]});if(resolution.rows[0]){const payload=JSON.parse(String(resolution.rows[0].payload_json)) as EventPayloads["SyncConflictResolved"];const metadata={action:payload.action,resolvedBy:payload.resolvedBy,...(payload.chosenEventId===undefined?{}:{chosenEventId:payload.chosenEventId}),...(payload.note===undefined?{}:{note:payload.note})};await this.#client.execute({sql:"UPDATE sync_reconciliations SET status='resolved',resolution_json=?,resolved_at=? WHERE conflict_id=? AND status='unresolved'",args:[json(metadata),payload.resolvedAt,x.conflictId]});}});}
  async resolveSyncConflict(conflictId:string,resolution:JsonValue,resolvedAt:string):Promise<SyncConflictRecord>{return this.#writes.run(async()=>{const changed=await this.#client.execute({sql:"UPDATE sync_reconciliations SET status='resolved',resolution_json=?,resolved_at=? WHERE conflict_id=? AND status='unresolved'",args:[json(resolution),resolvedAt,conflictId]});if(changed.rowsAffected!==1)throw new ConflictError("Sync conflict is missing or already resolved",{conflictId});const r=await this.#client.execute({sql:"SELECT * FROM sync_reconciliations WHERE conflict_id=?",args:[conflictId]});return rowToSyncConflict(r.rows[0]!);});}
  async putDataManifest(x:DataManifestRecord):Promise<void>{await this.#writes.run(async()=>{await this.#client.execute({sql:"INSERT INTO data_manifests(manifest_id,operation,scope_kind,scope_id,requested_by,owned,resources_json,replica_status_json,status,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",args:[x.manifestId,x.operation,x.scopeKind,x.scopeId,x.requestedBy,x.owned?1:0,json(x.resources),json(x.replicaStatus),x.status,x.createdAt,x.completedAt]});});}
  async getDataManifest(manifestId:string):Promise<DataManifestRecord|null>{const r=await this.#client.execute({sql:"SELECT * FROM data_manifests WHERE manifest_id=?",args:[manifestId]});return r.rows[0]?rowToManifest(r.rows[0]):null;}
  async completeDataManifest(manifestId:string,status:"completed"|"partial"|"blocked",resources:JsonValue,completedAt:string):Promise<DataManifestRecord>{return this.#writes.run(async()=>{const changed=await this.#client.execute({sql:"UPDATE data_manifests SET status=?,resources_json=?,completed_at=? WHERE manifest_id=? AND status='planned'",args:[status,json(resources),completedAt,manifestId]});if(changed.rowsAffected!==1)throw new ConflictError("Data manifest is not pending completion",{manifestId});const r=await this.#client.execute({sql:"SELECT * FROM data_manifests WHERE manifest_id=?",args:[manifestId]});return rowToManifest(r.rows[0]!);});}

  /**
   * Physically erases one independent local session. Cross-session graphs,
   * harness/refinement state, and replicated sessions are deliberately refused:
   * pretending to erase those granularities would leave canonical references.
   * The immutable-table guards are removed and recreated inside one write
   * transaction, so retained history is never exposed without append-only guards.
   */
  async assertIndependentSessionErasable(sessionId: string): Promise<void> {
    if (!sessionId.trim()) throw new ValidationError("Session ID is required");
    await this.#writes.run(async () => { await this.#assertIndependentSessionErasable(sessionId); });
  }
  async #assertIndependentSessionErasable(sessionId: string): Promise<void> {
    const sessionResult = await this.#client.execute({ sql: "SELECT * FROM sessions WHERE session_id=?", args: [sessionId] });
    const session = sessionResult.rows[0];
    if (!session) throw new NotFoundError("session", sessionId);
    const linked = await this.#client.execute({
      sql: `SELECT
        (SELECT count(*) FROM sessions WHERE parent_session_id=? OR (session_id=? AND parent_session_id IS NOT NULL)) AS session_links,
        (SELECT count(*) FROM tasks WHERE parent_session_id=? OR child_session_id=?) AS task_links,
        (SELECT count(*) FROM mailbox_messages WHERE from_session_id=? OR to_session_id=?) AS mailbox_links,
        (SELECT count(*) FROM terminal_notices WHERE parent_session_id=? OR child_session_id=?) AS notice_links,
        (SELECT count(*) FROM recursive_model_handles WHERE parent_session_id=? OR child_session_id=?) AS model_links,
        (SELECT count(*) FROM candidate_allocations WHERE session_id=?) AS allocation_links,
        (SELECT count(*) FROM sync_branch_mappings WHERE session_id=?) AS branch_mapping_links,
        (SELECT count(*) FROM sync_reconciliations WHERE session_id=?) AS reconciliation_links,
        (SELECT count(*) FROM sync_ingest_receipts r JOIN events e ON e.id=r.event_id WHERE e.session_id=?) AS replica_links,
        (SELECT count(*) FROM sync_quarantine q
           WHERE (
             EXISTS (SELECT 1 FROM json_tree(q.envelope_json) value WHERE value.atom=?) OR
             EXISTS (SELECT 1 FROM json_tree(q.envelope_json) value WHERE value.atom IN (SELECT branch_id FROM branches WHERE session_id=?)) OR
             EXISTS (SELECT 1 FROM json_tree(q.envelope_json) value WHERE value.atom IN (SELECT id FROM events WHERE session_id=?))
           ) AND COALESCE(json_extract(q.envelope_json,'$.body.sessionId'),'')<>?) AS retained_quarantine_links,
        (SELECT count(*) FROM events retained
           WHERE retained.session_id<>? AND (
             retained.causation_id IN (SELECT id FROM events WHERE session_id=?) OR
             retained.correlation_id IN (SELECT id FROM events WHERE session_id=?) OR
             retained.stream_parent_id IN (SELECT id FROM events WHERE session_id=?) OR
             EXISTS (SELECT 1 FROM json_tree(retained.payload_json) value WHERE value.atom=?) OR
             EXISTS (SELECT 1 FROM json_tree(retained.payload_json) value WHERE value.atom IN (SELECT branch_id FROM branches WHERE session_id=?)) OR
             EXISTS (SELECT 1 FROM json_tree(retained.payload_json) value WHERE value.atom IN (SELECT id FROM events WHERE session_id=?))
           )) AS retained_event_links`,
      args: [sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId],
    });
    const links = linked.rows[0]!;
    if (Object.values(links).some((value) => Number(value) > 0)) {
      throw new CapabilityUnavailableError("physical deletion of linked or replicated session scope", this.name);
    }
    const unsupportedTypes = [
      "HarnessVersionCreated", "HarnessVersionStatusChanged", "RefinementProposed", "RefinementValidated",
      "RefinementCandidateActivated", "RefinementCandidateAllocated", "RefinementCandidateExposed",
      "RefinementObservationRecorded", "RefinementDecided", "RefinementApproved",
      "RefinementRollbackApproved", "RefinementRolledBack", "SkillInvocationRecorded", "SkillTestRecorded",
      "SubagentSpecInvoked", "SyncConflictResolved",
    ];
    const unsupported = await this.#client.execute({
      sql: `SELECT type FROM events WHERE session_id=? AND type IN (${unsupportedTypes.map(() => "?").join(",")}) LIMIT 1`,
      args: [sessionId, ...unsupportedTypes],
    });
    if (unsupported.rows.length) {
      throw new CapabilityUnavailableError("physical deletion of session-scoped harness or reconciliation history", this.name);
    }
  }
  async eraseIndependentSession(sessionId: string): Promise<SessionErasureResult> {
    if (!sessionId.trim()) throw new ValidationError("Session ID is required");
    return this.#writes.run(async () => {
      // Recheck after the external CAS pass so any intervening durable link
      // refuses relational erasure rather than leaving a hidden dangling row.
      await this.#assertIndependentSessionErasable(sessionId);

      const tx = await this.#client.transaction("write");
      const counts: Record<string, number> = {};
      const remove = async (table: string, sql: string, args: InValue[] = []): Promise<void> => {
        const result = await tx.execute({ sql, args });
        counts[table] = (counts[table] ?? 0) + result.rowsAffected;
      };
      try {
        // These two guards are the only immutable-row guards touched. DDL and
        // erasure are transaction-local; rollback restores both rows and guards.
        await tx.execute("DROP TRIGGER events_no_delete");
        await tx.execute("DROP TRIGGER context_no_delete");
        await remove("goal_gate_evaluations", "DELETE FROM goal_gate_evaluations WHERE goal_id IN (SELECT goal_id FROM goals WHERE session_id=?)", [sessionId]);
        await remove("goal_gates", "DELETE FROM goal_gates WHERE goal_id IN (SELECT goal_id FROM goals WHERE session_id=?)", [sessionId]);
        await remove("input_set_chunks", "DELETE FROM input_set_chunks WHERE input_set_id IN (SELECT input_set_id FROM input_sets WHERE session_id=?)", [sessionId]);
        await remove("document_chunks", "DELETE FROM document_chunks WHERE document_id IN (SELECT document_id FROM documents WHERE session_id=?)", [sessionId]);
        await remove("sync_quarantine", "DELETE FROM sync_quarantine WHERE json_extract(envelope_json,'$.body.sessionId')=?", [sessionId]);
        await remove("process_execution_leases", "DELETE FROM process_execution_leases WHERE scope_kind='root' AND scope_id=?", [sessionId]);
        for (const table of ["wake_queue", "schedules", "heartbeats", "goals", "input_sets", "documents", "outbox", "snapshots", "context_records", "branches"]) {
          await remove(table, `DELETE FROM ${table} WHERE session_id=?`, [sessionId]);
        }
        await remove("sessions", "DELETE FROM sessions WHERE session_id=?", [sessionId]);
        await remove("events", "DELETE FROM events WHERE session_id=?", [sessionId]);
        await tx.execute("CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'canonical events are append-only'); END");
        await tx.execute("CREATE TRIGGER context_no_delete BEFORE DELETE ON context_records BEGIN SELECT RAISE(ABORT,'context records are immutable'); END");
        await tx.commit();
      } catch (error) {
        if (!tx.closed) await tx.rollback();
        throw error;
      } finally { tx.close(); }
      return { sessionId, deletedEvents: counts.events ?? 0, deletedRows: counts };
    });
  }

  async readonlyQuery(statement: ReadonlyStatement): Promise<JsonValue[]> {
    assertReadonlySql(statement.sql);
    const client = createClient(this.#config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A dedicated query-only client can be closed on timeout without
      // disabling or poisoning the supervisor's canonical write connection.
      await client.execute("PRAGMA query_only=ON");
      const sql = boundedReadonlySql(statement.sql);
      const execution = client.execute({ sql, args: [...statement.args] });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ValidationError(
          `Console SQL exceeded the ${MAX_ANALYTICAL_QUERY_MS}ms time limit`,
        )), MAX_ANALYTICAL_QUERY_MS);
      });
      const result = await Promise.race([execution, timeout]);
      if (result.rows.length > MAX_ANALYTICAL_ROWS) {
        throw new ValidationError(`Console SQL exceeded the ${MAX_ANALYTICAL_ROWS}-row limit`);
      }
      return result.rows.map(rowToObject);
    } finally {
      if (timer) clearTimeout(timer);
      client.close();
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (("code" in error && error.code === "SQLITE_BUSY") ||
      (error instanceof Error && /database is locked/i.test(error.message)));
}

export const MAX_ANALYTICAL_ROWS = 1_000;
export const MAX_ANALYTICAL_QUERY_MS = 2_000;
const MAX_ANALYTICAL_SQL_BYTES = 64 * 1024;
const forbidden = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const privateTables = /\b(schema_migrations|outbox|snapshots|process_execution_leases|device_clocks|workspace_replica_status|sync_ingest_receipts|sync_origin_watermarks|sync_quarantine|sync_branch_mappings|sync_reconciliations|data_manifests|sqlite_(?:schema|master|temp_schema|temp_master|sequence))\b/i;
const dangerousFunctions = /\b(load_extension|writefile|readfile)\s*\(/i;

export function assertReadonlySql(sql: string): void {
  if (new TextEncoder().encode(sql).byteLength > MAX_ANALYTICAL_SQL_BYTES) {
    throw new ValidationError("Console SQL exceeds the statement size limit");
  }
  const stripped = stripSqlComments(sql).trim();
  const allowedStart = /^(?:SELECT\b|WITH\b|EXPLAIN\s+(?:QUERY\s+PLAN\s+)?(?:SELECT|WITH)\b|PRAGMA\s+(?:table_info|index_list|foreign_key_list)\s*\()/i;
  if (!stripped || !allowedStart.test(stripped) || forbidden.test(stripped) || privateTables.test(stripped) ||
      dangerousFunctions.test(stripped) || hasMultipleStatements(stripped)) {
    throw new ValidationError("Console SQL is read-only or references a private runtime table");
  }
}

function boundedReadonlySql(sql: string): string {
  const stripped = stripSqlComments(sql).trim().replace(/;\s*$/, "");
  if (/^(?:SELECT|WITH)\b/i.test(stripped)) {
    return `SELECT * FROM (${stripped}) AS agencity_bounded_query LIMIT ${MAX_ANALYTICAL_ROWS + 1}`;
  }
  return stripped;
}

function stripSqlComments(sql: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (quote) {
      result += char;
      if ((quote === "]" && char === "]") || (quote !== "]" && char === quote)) {
        if (quote !== "]" && sql[index + 1] === quote) result += sql[++index]!;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; result += char; continue; }
    if (char === "[") { quote = "]"; result += char; continue; }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index++;
      result += "\n";
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index++;
      index++;
      result += " ";
      continue;
    }
    result += char;
  }
  if (quote) throw new ValidationError("Unterminated SQL quote");
  return result;
}

function hasMultipleStatements(sql: string): boolean {
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (quote) {
      if ((quote === "]" && char === "]") || (quote !== "]" && char === quote)) {
        if (quote !== "]" && sql[index + 1] === quote) index++;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "[") { quote = "]"; continue; }
    if (char === ";" && sql.slice(index + 1).trim() !== "") return true;
  }
  return false;
}
