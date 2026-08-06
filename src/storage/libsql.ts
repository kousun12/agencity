import { createClient, type Client, type InValue, type Row, type Transaction } from "@libsql/client";
import type { AgentEvent, AgentState, EventPayloads, EventType, NewAgentEvent } from "../domain/index.ts";
import { ConflictError, NotFoundError, ValidationError, newId, projectEvents, reduceAgentState, validateNewEvent } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type { AgentStorage, EventQuery, OutboxRecord, ReadonlyStatement, StorageCapabilities } from "./contract.ts";
import { containsBrokeredSecret } from "../security/index.ts";

const cursorOf = (sequence: number) => sequence.toString().padStart(20, "0");
const sequenceOf = (cursor: string) => { const n = Number(cursor); if (!Number.isSafeInteger(n) || n < 0) throw new ValidationError(`Invalid cursor: ${cursor}`); return n; };
function json(value: unknown): string { return JSON.stringify(value); }
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
    const path = new URL("./migrations/001_initial.sql", import.meta.url);
    const sql = await Bun.file(path).text();
    await this.#client.executeMultiple(sql);
    await this.#client.execute({ sql: "INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(1,?,?)", args: ["initial", new Date().toISOString()] });
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
      if (event.branchId !== payload.initialBranchId) {
        throw new ValidationError("SessionCreated branch must equal initialBranchId");
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
    const history = await this.#loadBranchEvents(tx, event.sessionId, event.branchId);
    if (!history.length) throw new NotFoundError("session branch", `${event.sessionId}/${event.branchId}`);
    reduceAgentState(projectEvents(history), event);
  }

  async #applyOperationalRows(tx: Transaction, event: AgentEvent): Promise<void> {
    if (event.type === "SessionCreated") { const p = event.payload as EventPayloads["SessionCreated"]; await tx.execute({ sql: "INSERT OR IGNORE INTO sessions(session_id,workspace_id,initial_branch_id,created_event_id) VALUES(?,?,?,?)", args: [event.sessionId,p.workspaceId,p.initialBranchId,event.id] }); await tx.execute({ sql: "INSERT OR IGNORE INTO branches(session_id,branch_id,parent_branch_id,fork_cursor,name,created_event_id) VALUES(?,?,NULL,NULL,NULL,?)", args: [event.sessionId,p.initialBranchId,event.id] }); }
    if (event.type === "BranchCreated") { const p = event.payload as EventPayloads["BranchCreated"]; await tx.execute({ sql: "INSERT INTO branches(session_id,branch_id,parent_branch_id,fork_cursor,name,created_event_id) VALUES(?,?,?,?,?,?)", args: [event.sessionId,p.branchId,p.parentBranchId,p.forkCursor,p.name ?? null,event.id] }); }
    if (event.type === "ContextMaterialized") { const p = event.payload as EventPayloads["ContextMaterialized"]; await tx.execute({ sql: "INSERT INTO context_records(context_id,session_id,branch_id,event_id,content_hash,records_json,context_json,created_at) VALUES(?,?,?,?,?,?,?,?)", args: [p.contextId,event.sessionId,event.branchId,event.id,p.contentHash,json(p.records),json(p.context),event.committedAt] }); }
    if (event.type === "EffectRequested") { const p = event.payload as EventPayloads["EffectRequested"]; await tx.execute({ sql: "INSERT INTO outbox(effect_id,session_id,branch_id,executor,operation,input_json,idempotency_key,idempotent,status,requested_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", args: [p.effectId,event.sessionId,event.branchId,p.executor,p.operation,json(p.input),p.idempotencyKey,p.idempotent ? 1 : 0,"pending",event.id,event.committedAt,event.committedAt] }); }
    if (event.type === "EffectAttemptStarted") { const p = event.payload as EventPayloads["EffectAttemptStarted"]; await tx.execute({ sql: "UPDATE outbox SET status='running',attempt=?,updated_at=? WHERE effect_id=? AND status IN ('pending','running')", args: [p.attempt,event.committedAt,p.effectId] }); }
    if (event.type === "EffectOutcomeRecorded") { const p = event.payload as EventPayloads["EffectOutcomeRecorded"]; await tx.execute({ sql: "UPDATE outbox SET status=?,attempt=?,owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=?", args: [p.outcome,p.attempt,event.committedAt,p.effectId] }); }
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
  async loadSnapshot(sessionId:string,branchId:string):Promise<AgentState|null>{const r=await this.#client.execute({sql:"SELECT state_json FROM snapshots WHERE session_id=? AND branch_id=?",args:[sessionId,branchId]});return r.rows[0]?JSON.parse(String(r.rows[0].state_json)) as AgentState:null;}
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
