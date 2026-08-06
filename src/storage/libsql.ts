import { createClient, type Client, type InValue, type Row, type Transaction } from "@libsql/client";
import type { AgentEvent, AgentState, EventPayloads, EventType, NewAgentEvent } from "../domain/index.ts";
import { ConflictError, NotFoundError, ValidationError, newId, projectEvents, reduceAgentState, validateNewEvent } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type {
  AgentStorage, DocumentChunkRecord, DocumentRecord, EventQuery, GoalGateRecord, GoalRecord,
  HeartbeatRecord, InputSetRecord, MailboxRecord, OutboxRecord, ReadonlyStatement,
  RecursiveModelRecord, SessionRecord, StorageCapabilities, TaskRecord,
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
  return { cursor: cursorOf(Number(row.sequence)), id: String(row.id), sessionId: String(row.session_id), branchId: String(row.branch_id),
    causationId: row.causation_id === null ? null : String(row.causation_id), correlationId: row.correlation_id === null ? null : String(row.correlation_id),
    type: String(row.type) as EventType, schemaVersion: Number(row.schema_version), committedAt: String(row.committed_at), producer: String(row.producer),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key), payload: JSON.parse(String(row.payload_json)) as never };
}
function rowToOutbox(row: Row): OutboxRecord { return { effectId: String(row.effect_id), sessionId: String(row.session_id), branchId: String(row.branch_id), executor: String(row.executor), operation: String(row.operation), input: JSON.parse(String(row.input_json)) as JsonValue, idempotencyKey: String(row.idempotency_key), idempotent: Number(row.idempotent) === 1, status: String(row.status) as OutboxRecord["status"], attempt: Number(row.attempt), owner: row.owner === null ? null : String(row.owner), leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at) }; }
function optionalJson(row: Row, key: string): JsonValue | undefined { const value = row[key]; return value === null || value === undefined ? undefined : JSON.parse(String(value)) as JsonValue; }
function rowToSession(row: Row): SessionRecord { return { sessionId: String(row.session_id), workspaceId: String(row.workspace_id), initialBranchId: String(row.initial_branch_id), parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id), parentBranchId: row.parent_branch_id === null ? null : String(row.parent_branch_id), rootSessionId: row.root_session_id === null ? String(row.session_id) : String(row.root_session_id), depth: Number(row.depth), taskId: row.task_id === null ? null : String(row.task_id), status: row.task_status === null || row.task_status === undefined ? null : String(row.task_status) as SessionRecord["status"] }; }
function rowToTask(row: Row): TaskRecord { const result = optionalJson(row, "result_json"); return { taskId: String(row.task_id), parentSessionId: String(row.parent_session_id), parentBranchId: String(row.parent_branch_id), childSessionId: String(row.child_session_id), childBranchId: String(row.child_branch_id), task: String(row.task_text), completionCriteria: row.completion_criteria === null ? null : String(row.completion_criteria), model: JSON.parse(String(row.model_json)), budget: JSON.parse(String(row.budget_json)), status: String(row.status) as TaskRecord["status"], cancellationRequested: Number(row.cancellation_requested) === 1, ...(result === undefined ? {} : { result }), artifactIds: JSON.parse(String(row.artifact_ids_json)) as string[], ...(row.error === null ? {} : { error: String(row.error) }), ...(row.reason === null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToMailbox(row: Row): MailboxRecord { return { mailboxMessageId: String(row.mailbox_message_id), fromSessionId: String(row.from_session_id), fromBranchId: String(row.from_branch_id), toSessionId: String(row.to_session_id), toBranchId: String(row.to_branch_id), kind: String(row.kind) as MailboxRecord["kind"], content: String(row.content), taskId: row.task_id === null ? null : String(row.task_id), delivered: row.delivered_event_id !== null, acknowledged: row.acknowledged_event_id !== null, sentAt: String(row.sent_at), deliveredAt: row.delivered_at === null ? null : String(row.delivered_at), acknowledgedAt: row.acknowledged_at === null ? null : String(row.acknowledged_at) }; }
function rowToDocument(row: Row): DocumentRecord { return { documentId: String(row.document_id), sessionId: String(row.session_id), branchId: String(row.branch_id), name: String(row.name), mediaType: String(row.media_type), size: Number(row.size), digest: String(row.digest), chunkCount: Number(row.chunk_count), createdAt: String(row.created_at) }; }
function rowToDocumentChunk(row: Row): DocumentChunkRecord { return { chunkId: String(row.chunk_id), documentId: String(row.document_id), ordinal: Number(row.ordinal), content: String(row.content), size: Number(row.size), digest: String(row.digest) }; }
function rowToGoal(row: Row): GoalRecord { return { goalId: String(row.goal_id), sessionId: String(row.session_id), branchId: String(row.branch_id), description: String(row.description), completionCriteria: row.completion_criteria === null ? null : String(row.completion_criteria), maxTurns: row.max_turns === null ? null : Number(row.max_turns), status: String(row.status) as GoalRecord["status"], completionRequestId: row.completion_request_id === null ? null : String(row.completion_request_id), completionWorkspaceId: row.completion_workspace_id === null || row.completion_workspace_id === undefined ? null : String(row.completion_workspace_id), completionWorkspaceCursor: row.completion_workspace_cursor === null || row.completion_workspace_cursor === undefined ? null : String(row.completion_workspace_cursor), completionPinRecorded: Number(row.completion_pin_recorded ?? 0) === 1, ...(row.reason === null ? {} : { reason: String(row.reason) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToGoalGate(row: Row): GoalGateRecord { const output = optionalJson(row, "output_json"); return { gateId: String(row.gate_id), goalId: String(row.goal_id), name: String(row.name), executor: String(row.executor), operation: String(row.operation), input: JSON.parse(String(row.input_json)) as JsonValue, idempotent: Number(row.idempotent) === 1, required: Number(row.required) === 1, status: String(row.status) as GoalGateRecord["status"], ...(row.effect_id === null ? {} : { effectId: String(row.effect_id) }), ...(output === undefined ? {} : { output }), ...(row.error === null ? {} : { error: String(row.error) }) }; }
function rowToHeartbeat(row: Row): HeartbeatRecord { const payload = optionalJson(row, "payload_json"); return { heartbeatId: String(row.heartbeat_id), sessionId: String(row.session_id), branchId: String(row.branch_id), intervalMs: Number(row.interval_ms), nextTickAt: String(row.next_tick_at), goalId: row.goal_id === null ? null : String(row.goal_id), ...(payload === undefined ? {} : { payload }), status: String(row.status) as HeartbeatRecord["status"], tick: Number(row.tick), lastFiredAt: row.last_fired_at === null ? null : String(row.last_fired_at) }; }
function rowToRecursiveModel(row: Row): RecursiveModelRecord { return { handleId: String(row.handle_id), taskId: String(row.task_id), parentSessionId: String(row.parent_session_id), parentBranchId: String(row.parent_branch_id), childSessionId: String(row.child_session_id), childBranchId: String(row.child_branch_id), model: JSON.parse(String(row.model_json)), inputSetId: row.input_set_id === null ? null : String(row.input_set_id), status: String(row.status) as RecursiveModelRecord["status"], ...(row.result_message_id === null ? {} : { resultMessageId: String(row.result_message_id) }), ...(row.error === null ? {} : { error: String(row.error) }), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }

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

export interface LibSqlStorageOptions { readonly url: string; readonly authToken?: string; readonly syncUrl?: string; }
export class LibSqlStorage implements AgentStorage {
  readonly name = "libsql";
  readonly capabilities: StorageCapabilities = { offlineWrites: true, distributedLeases: false, analyticalSql: true, notifications: true };
  readonly #client: Client;
  readonly #config: LibSqlStorageOptions;
  readonly #listeners = new Set<(events: readonly AgentEvent[]) => void>();
  readonly #writes = new LocalWriteQueue();
  constructor(options: LibSqlStorageOptions | string) {
    this.#config = typeof options === "string" ? { url: options } : options;
    this.#client = createClient(this.#config);
  }
  async migrate(): Promise<void> {
    // Migration files are immutable. Apply each once so ALTER statements remain
    // safe when a runtime reopens an existing local database.
    await this.#client.execute("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const migrations = [
      { version: 1, name: "initial", url: new URL("./migrations/001_initial.sql", import.meta.url) },
      { version: 2, name: "recursive-sessions", url: new URL("./migrations/002_recursive_sessions.sql", import.meta.url) },
      { version: 3, name: "slice2-review-hardening", url: new URL("./migrations/003_slice2_review_hardening.sql", import.meta.url) },
    ];
    for (const migration of migrations) {
      const applied = await this.#client.execute({ sql: "SELECT version FROM schema_migrations WHERE version=?", args: [migration.version] });
      if (applied.rows.length) continue;
      await this.#client.executeMultiple(await Bun.file(migration.url).text());
      await this.#client.execute({ sql: "INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)", args: [migration.version, migration.name, new Date().toISOString()] });
    }
  }
  close(): void { this.#client.close(); }
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
    if (candidate.idempotencyKey) {
      const found = await tx.execute({ sql: "SELECT * FROM events WHERE session_id=? AND type=? AND idempotency_key=?", args: [candidate.sessionId, candidate.type, candidate.idempotencyKey] });
      const row = found.rows[0];
      if (row) {
        const existing = rowToEvent(row);
        if (json(existing.payload) !== json(candidate.payload) || existing.branchId !== candidate.branchId) throw new ConflictError("Idempotency key reused with a different event", { idempotencyKey: candidate.idempotencyKey });
        return existing;
      }
    }
    const id = candidate.id ?? newId(), committedAt = candidate.committedAt ?? new Date().toISOString();
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
    };
    await this.#validateCanonicalAppend(tx, pending);
    const result = await tx.execute({ sql: `INSERT INTO events(id,session_id,branch_id,causation_id,correlation_id,type,schema_version,committed_at,producer,idempotency_key,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id,candidate.sessionId,candidate.branchId,candidate.causationId ?? null,candidate.correlationId ?? null,candidate.type,candidate.schemaVersion ?? 1,committedAt,candidate.producer,candidate.idempotencyKey ?? null,json(candidate.payload)] });
    const event: AgentEvent = { cursor: cursorOf(Number(result.lastInsertRowid)), id, sessionId: candidate.sessionId, branchId: candidate.branchId, causationId: candidate.causationId ?? null, correlationId: candidate.correlationId ?? null, type: candidate.type, schemaVersion: candidate.schemaVersion ?? 1, committedAt, producer: candidate.producer, idempotencyKey: candidate.idempotencyKey ?? null, payload: candidate.payload as never };
    await this.#applyOperationalRows(tx, event);
    return event;
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
      const deliveredMeaning = { mailboxMessageId: payload.mailboxMessageId, fromSessionId: payload.fromSessionId, fromBranchId: payload.fromBranchId, toSessionId: payload.toSessionId, toBranchId: payload.toBranchId, kind: payload.kind, content: payload.content, ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }) };
      if (!sentPayload || !Bun.deepEquals(sentPayload, deliveredMeaning)) throw new ValidationError("Mailbox delivery does not match its sent event");
    }
    if (event.type === "MailboxMessageAcknowledged") {
      const payload = event.payload as EventPayloads["MailboxMessageAcknowledged"];
      const message = await tx.execute({ sql: "SELECT from_session_id,to_session_id,delivered_event_id FROM mailbox_messages WHERE mailbox_message_id=?", args: [payload.mailboxMessageId] });
      const row = message.rows[0];
      if (!row || row.delivered_event_id === null || payload.acknowledgedBySessionId !== String(row.to_session_id) || ![String(row.from_session_id), String(row.to_session_id)].includes(event.sessionId)) throw new ValidationError("Mailbox acknowledgement does not match its delivery");
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
    const history = await this.#loadBranchEvents(tx, event.sessionId, event.branchId);
    if (!history.length) throw new NotFoundError("session branch", `${event.sessionId}/${event.branchId}`);
    reduceAgentState(projectEvents(history), event);
  }

  async #applyOperationalRows(tx: Transaction, event: AgentEvent): Promise<void> {
    if (event.type === "SessionCreated") {
      const p = event.payload as EventPayloads["SessionCreated"];
      await tx.execute({ sql: "INSERT OR IGNORE INTO sessions(session_id,workspace_id,initial_branch_id,created_event_id,parent_session_id,parent_branch_id,root_session_id,depth,task_id) VALUES(?,?,?,?,?,?,?,?,?)", args: [event.sessionId,p.workspaceId,p.initialBranchId,event.id,p.parentSessionId ?? null,p.parentBranchId ?? null,p.rootSessionId ?? event.sessionId,p.depth ?? 0,p.taskId ?? null] });
      await tx.execute({ sql: "INSERT OR IGNORE INTO branches(session_id,branch_id,parent_branch_id,fork_cursor,name,created_event_id) VALUES(?,?,NULL,NULL,NULL,?)", args: [event.sessionId,p.initialBranchId,event.id] });
    }
    if (event.type === "BranchCreated") { const p = event.payload as EventPayloads["BranchCreated"]; await tx.execute({ sql: "INSERT INTO branches(session_id,branch_id,parent_branch_id,fork_cursor,name,created_event_id) VALUES(?,?,?,?,?,?)", args: [event.sessionId,p.branchId,p.parentBranchId,p.forkCursor,p.name ?? null,event.id] }); }
    if (event.type === "ContextMaterialized") { const p = event.payload as EventPayloads["ContextMaterialized"]; await tx.execute({ sql: "INSERT INTO context_records(context_id,session_id,branch_id,event_id,content_hash,records_json,context_json,created_at) VALUES(?,?,?,?,?,?,?,?)", args: [p.contextId,event.sessionId,event.branchId,event.id,p.contentHash,json(p.records),json(p.context),event.committedAt] }); }
    if (event.type === "EffectRequested") { const p = event.payload as EventPayloads["EffectRequested"]; await tx.execute({ sql: "INSERT INTO outbox(effect_id,session_id,branch_id,executor,operation,input_json,idempotency_key,idempotent,status,requested_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", args: [p.effectId,event.sessionId,event.branchId,p.executor,p.operation,json(p.input),p.idempotencyKey,p.idempotent ? 1 : 0,"pending",event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "EffectAttemptStarted") { const p = event.payload as EventPayloads["EffectAttemptStarted"]; await tx.execute({ sql: "UPDATE outbox SET status='running',attempt=?,updated_at=? WHERE effect_id=? AND status IN ('pending','running')", args: [p.attempt,event.committedAt,p.effectId] }); }
    if (event.type === "EffectOutcomeRecorded") { const p = event.payload as EventPayloads["EffectOutcomeRecorded"]; await tx.execute({ sql: "UPDATE outbox SET status=?,attempt=?,owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=?", args: [p.outcome,p.attempt,event.committedAt,p.effectId] }); }
    if (event.type === "TaskCreated") {
      const p = event.payload as EventPayloads["TaskCreated"];
      await tx.execute({ sql: "INSERT INTO tasks(task_id,parent_session_id,parent_branch_id,child_session_id,child_branch_id,task_text,completion_criteria,model_json,budget_json,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)", args: [p.taskId,p.parentSessionId,p.parentBranchId,p.childSessionId,p.childBranchId,p.task,p.completionCriteria ?? null,json(p.model),json(p.budget),event.id,event.id,event.committedAt,event.committedAt] });
    }
    if (event.type === "SubagentAdmitted") { const p = event.payload as EventPayloads["SubagentAdmitted"]; await tx.execute({ sql: "UPDATE tasks SET status='admitted',last_event_id=?,updated_at=? WHERE task_id=?", args: [event.id,event.committedAt,p.taskId] }); }
    if (event.type === "SubagentCancellationRequested") { const p = event.payload as EventPayloads["SubagentCancellationRequested"]; await tx.execute({ sql: "UPDATE tasks SET cancellation_requested=1,reason=COALESCE(?,reason),last_event_id=?,updated_at=? WHERE task_id=?", args: [p.reason ?? null,event.id,event.committedAt,p.taskId] }); }
    if (event.type === "TaskStatusChanged") {
      const p = event.payload as EventPayloads["TaskStatusChanged"];
      await tx.execute({ sql: "UPDATE tasks SET status=?,result_json=COALESCE(?,result_json),artifact_ids_json=COALESCE(?,artifact_ids_json),error=COALESCE(?,error),reason=COALESCE(?,reason),last_event_id=?,updated_at=? WHERE task_id=?", args: [p.status,p.result === undefined ? null : json(p.result),p.artifactIds === undefined ? null : json(p.artifactIds),p.error ?? null,p.reason ?? null,event.id,event.committedAt,p.taskId] });
    }
    if (event.type === "MailboxMessageSent") {
      const p = event.payload as EventPayloads["MailboxMessageSent"];
      await tx.execute({ sql: "INSERT INTO mailbox_messages(mailbox_message_id,from_session_id,from_branch_id,to_session_id,to_branch_id,kind,content,task_id,sent_event_id,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [p.mailboxMessageId,p.fromSessionId,p.fromBranchId,p.toSessionId,p.toBranchId,p.kind,p.content,p.taskId ?? null,event.id,event.committedAt] });
    }
    if (event.type === "MailboxMessageDelivered") { const p = event.payload as EventPayloads["MailboxMessageDelivered"]; await tx.execute({ sql: "UPDATE mailbox_messages SET delivered_event_id=?,delivered_at=? WHERE mailbox_message_id=?", args: [event.id,event.committedAt,p.mailboxMessageId] }); }
    if (event.type === "MailboxMessageAcknowledged") { const p = event.payload as EventPayloads["MailboxMessageAcknowledged"]; await tx.execute({ sql: "UPDATE mailbox_messages SET acknowledged_event_id=?,acknowledged_at=? WHERE mailbox_message_id=?", args: [event.id,p.acknowledgedAt,p.mailboxMessageId] }); }
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
    if (event.type === "GoalCreated") { const p = event.payload as EventPayloads["GoalCreated"]; await tx.execute({ sql: "INSERT INTO goals(goal_id,session_id,branch_id,description,completion_criteria,max_turns,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?,?,?)", args: [p.goalId,event.sessionId,event.branchId,p.description,p.completionCriteria ?? null,p.maxTurns ?? null,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "GoalCompletionRequested") { const p = event.payload as EventPayloads["GoalCompletionRequested"]; await tx.execute({ sql: "UPDATE goals SET status='completion_requested',completion_request_id=?,completion_workspace_id=?,completion_workspace_cursor=?,completion_pin_recorded=?,last_event_id=?,updated_at=? WHERE goal_id=?", args: [p.requestId,p.workspaceId ?? null,p.workspaceCursor ?? null,p.workspaceId !== undefined && Object.prototype.hasOwnProperty.call(p, "workspaceCursor") ? 1 : 0,event.id,event.committedAt,p.goalId] }); }
    if (event.type === "GoalStatusChanged") { const p = event.payload as EventPayloads["GoalStatusChanged"]; await tx.execute({ sql: "UPDATE goals SET status=?,reason=?,last_event_id=?,updated_at=? WHERE goal_id=?", args: [p.status,p.reason ?? null,event.id,event.committedAt,p.goalId] }); }
    if (event.type === "GoalGateAdded") { const p = event.payload as EventPayloads["GoalGateAdded"]; await tx.execute({ sql: "INSERT INTO goal_gates(gate_id,goal_id,name,executor,operation,input_json,idempotent,required,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,?)", args: [p.gateId,p.goalId,p.name,p.executor,p.operation,json(p.input),p.idempotent ? 1 : 0,p.required ? 1 : 0,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "GoalGateStatusChanged") { const p = event.payload as EventPayloads["GoalGateStatusChanged"]; await tx.execute({ sql: "UPDATE goal_gates SET status=?,effect_id=COALESCE(?,effect_id),output_json=?,error=?,last_event_id=?,updated_at=? WHERE gate_id=?", args: [p.status,p.effectId ?? null,p.output === undefined ? null : json(p.output),p.error ?? null,event.id,event.committedAt,p.gateId] }); }
    if (event.type === "HeartbeatCreated") { const p = event.payload as EventPayloads["HeartbeatCreated"]; await tx.execute({ sql: "INSERT INTO heartbeats(heartbeat_id,session_id,branch_id,interval_ms,next_tick_at,goal_id,payload_json,status,tick,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',0,?,?,?,?)", args: [p.heartbeatId,event.sessionId,event.branchId,p.intervalMs,p.nextTickAt,p.goalId ?? null,p.payload === undefined ? null : json(p.payload),event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "HeartbeatTicked") { const p = event.payload as EventPayloads["HeartbeatTicked"]; await tx.execute({ sql: "UPDATE heartbeats SET tick=?,last_fired_at=?,next_tick_at=?,last_event_id=?,updated_at=? WHERE heartbeat_id=?", args: [p.tick,p.firedAt,p.nextTickAt,event.id,event.committedAt,p.heartbeatId] }); }
    if (event.type === "HeartbeatStatusChanged") { const p = event.payload as EventPayloads["HeartbeatStatusChanged"]; await tx.execute({ sql: "UPDATE heartbeats SET status=?,next_tick_at=COALESCE(?,next_tick_at),last_event_id=?,updated_at=? WHERE heartbeat_id=?", args: [p.status,p.nextTickAt ?? null,event.id,event.committedAt,p.heartbeatId] }); }
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
    if (event.type === "RecursiveModelStarted") { const p = event.payload as EventPayloads["RecursiveModelStarted"]; await tx.execute({ sql: "INSERT INTO recursive_model_handles(handle_id,task_id,parent_session_id,parent_branch_id,child_session_id,child_branch_id,model_json,input_set_id,status,created_event_id,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?,?)", args: [p.handleId,p.taskId,p.parentSessionId,p.parentBranchId,p.childSessionId,p.childBranchId,json(p.model),p.inputSetId ?? null,event.id,event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "RecursiveModelStatusChanged") { const p = event.payload as EventPayloads["RecursiveModelStatusChanged"]; await tx.execute({ sql: "UPDATE recursive_model_handles SET status=?,result_message_id=COALESCE(?,result_message_id),error=COALESCE(?,error),last_event_id=?,updated_at=? WHERE handle_id=?", args: [p.status,p.resultMessageId ?? null,p.error ?? null,event.id,event.committedAt,p.handleId] }); }
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
  async loadSnapshot(sessionId:string,branchId:string):Promise<AgentState|null>{const r=await this.#client.execute({sql:"SELECT reducer_version,state_json FROM snapshots WHERE session_id=? AND branch_id=?",args:[sessionId,branchId]});if(!r.rows[0]||Number(r.rows[0].reducer_version)!==2)return null;return JSON.parse(String(r.rows[0].state_json)) as AgentState;}
  async deleteSnapshots(sessionId?:string):Promise<void>{if(sessionId)await this.#client.execute({sql:"DELETE FROM snapshots WHERE session_id=?",args:[sessionId]});else await this.#client.execute("DELETE FROM snapshots");}
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
  async getHeartbeat(heartbeatId: string): Promise<HeartbeatRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM heartbeats WHERE heartbeat_id=?", args: [heartbeatId] }); return result.rows[0] ? rowToHeartbeat(result.rows[0]) : null; }
  async listDueHeartbeats(at: string): Promise<HeartbeatRecord[]> { const result = await this.#client.execute({ sql: "SELECT * FROM heartbeats WHERE status='active' AND next_tick_at<=? ORDER BY next_tick_at,heartbeat_id", args: [at] }); return result.rows.map(rowToHeartbeat); }
  async getRecursiveModel(handleId: string): Promise<RecursiveModelRecord | null> { const result = await this.#client.execute({ sql: "SELECT * FROM recursive_model_handles WHERE handle_id=?", args: [handleId] }); return result.rows[0] ? rowToRecursiveModel(result.rows[0]) : null; }
  async listRecursiveModels(statuses?: readonly RecursiveModelRecord["status"][]): Promise<RecursiveModelRecord[]> {
    const args: InValue[] = []; let sql = "SELECT * FROM recursive_model_handles";
    if (statuses?.length) { sql += ` WHERE status IN (${statuses.map(() => "?").join(",")})`; args.push(...statuses); }
    const result = await this.#client.execute({ sql: `${sql} ORDER BY created_at,handle_id`, args }); return result.rows.map(rowToRecursiveModel);
  }

  async rebuildOperationalProjections(): Promise<void> {
    await this.#writes.run(async () => {
      const tx = await this.#client.transaction("write");
      try {
        for (const table of ["input_set_chunks","input_sets","document_chunks","documents","terminal_notices","mailbox_messages","goal_gates","goals","heartbeats","recursive_model_handles","tasks","branches","sessions"]) await tx.execute(`DELETE FROM ${table}`);
        const rows = await tx.execute("SELECT * FROM events ORDER BY sequence");
        const selected = new Set(["SessionCreated","BranchCreated","TaskCreated","SubagentAdmitted","TaskStatusChanged","SubagentCancellationRequested","MailboxMessageSent","MailboxMessageDelivered","MailboxMessageAcknowledged","TaskTerminalNoticeSent","TaskTerminalNoticeDelivered","DocumentImported","DocumentChunkAdded","InputSetCreated","GoalCreated","GoalCompletionRequested","GoalGateAdded","GoalGateStatusChanged","GoalStatusChanged","HeartbeatCreated","HeartbeatTicked","HeartbeatStatusChanged","RecursiveModelStarted","RecursiveModelStatusChanged"]);
        for (const row of rows.rows) { const event = rowToEvent(row); if (selected.has(event.type)) await this.#applyOperationalRows(tx,event); }
        await tx.commit();
      } catch (error) { if (!tx.closed) await tx.rollback(); throw error; } finally { tx.close(); }
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
const privateTables = /\b(schema_migrations|outbox|snapshots|sqlite_(?:schema|master|temp_schema|temp_master|sequence))\b/i;
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
