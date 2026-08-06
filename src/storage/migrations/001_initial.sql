PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 session_id TEXT NOT NULL,
 branch_id TEXT NOT NULL,
 causation_id TEXT,
 correlation_id TEXT,
 type TEXT NOT NULL,
 schema_version INTEGER NOT NULL,
 committed_at TEXT NOT NULL,
 producer TEXT NOT NULL,
 idempotency_key TEXT,
 payload_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency ON events(session_id,type,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_session_sequence ON events(session_id,sequence);
CREATE INDEX IF NOT EXISTS events_branch_sequence ON events(session_id,branch_id,sequence);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'canonical events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'canonical events are append-only'); END;

-- sessions and branches are rebuildable routing projections.
CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, initial_branch_id TEXT NOT NULL, created_event_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branches(
 session_id TEXT NOT NULL, branch_id TEXT NOT NULL, parent_branch_id TEXT, fork_cursor TEXT, name TEXT, created_event_id TEXT NOT NULL,
 PRIMARY KEY(session_id,branch_id)
);
-- Snapshots/projections are disposable and rebuilt exclusively from events.
CREATE TABLE IF NOT EXISTS snapshots(session_id TEXT NOT NULL, branch_id TEXT NOT NULL, cursor TEXT NOT NULL, reducer_version INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(session_id,branch_id));
-- Context records are immutable derived records with exact event provenance.
CREATE TABLE IF NOT EXISTS context_records(context_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, records_json TEXT NOT NULL, context_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS context_no_update BEFORE UPDATE ON context_records BEGIN SELECT RAISE(ABORT,'context records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS context_no_delete BEFORE DELETE ON context_records BEGIN SELECT RAISE(ABORT,'context records are immutable'); END;
-- Outbox is mutable operational state; terminal truth is the Effect* event history.
CREATE TABLE IF NOT EXISTS outbox(
 effect_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT NOT NULL, executor TEXT NOT NULL, operation TEXT NOT NULL,
 input_json TEXT NOT NULL, idempotency_key TEXT NOT NULL, idempotent INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','unknown')),
 attempt INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_expires_at TEXT, requested_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,created_at);
CREATE VIEW IF NOT EXISTS failed_tool_calls AS
 SELECT e.session_id, json_extract(e.payload_json,'$.executor') AS tool_name,
        json_extract(o.payload_json,'$.error') AS error_code, count(*) AS occurrences
 FROM events e JOIN events o ON json_extract(e.payload_json,'$.effectId')=json_extract(o.payload_json,'$.effectId')
 WHERE e.type='EffectRequested' AND o.type='EffectOutcomeRecorded' AND json_extract(o.payload_json,'$.outcome')='failed'
 GROUP BY e.session_id,tool_name,error_code;
