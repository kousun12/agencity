-- Slice 2 recursive-session routing and rebuildable operational projections.
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN parent_branch_id TEXT;
ALTER TABLE sessions ADD COLUMN root_session_id TEXT;
ALTER TABLE sessions ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN task_id TEXT;
UPDATE sessions SET root_session_id=session_id WHERE root_session_id IS NULL;
-- Reducer v2 adds recursive-session fields; v1 snapshot JSON is disposable.
DELETE FROM snapshots;
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session_id, depth, session_id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_task ON sessions(task_id) WHERE task_id IS NOT NULL;

-- Current task status is rebuilt from Task*/Subagent* events.
CREATE TABLE IF NOT EXISTS tasks(
 task_id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, parent_branch_id TEXT NOT NULL,
 child_session_id TEXT NOT NULL UNIQUE, child_branch_id TEXT NOT NULL, task_text TEXT NOT NULL,
 completion_criteria TEXT, model_json TEXT NOT NULL, budget_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','admitted','running','completed','failed','cancelled')),
 cancellation_requested INTEGER NOT NULL DEFAULT 0, result_json TEXT, artifact_ids_json TEXT NOT NULL DEFAULT '[]',
 error TEXT, reason TEXT, created_event_id TEXT NOT NULL, last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_session_id,parent_branch_id,created_at);

-- Mailbox rows are delivery projections; the paired events remain canonical.
CREATE TABLE IF NOT EXISTS mailbox_messages(
 mailbox_message_id TEXT PRIMARY KEY, from_session_id TEXT NOT NULL, from_branch_id TEXT NOT NULL,
 to_session_id TEXT NOT NULL, to_branch_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
 task_id TEXT, sent_event_id TEXT NOT NULL, delivered_event_id TEXT, acknowledged_event_id TEXT,
 sent_at TEXT NOT NULL, delivered_at TEXT, acknowledged_at TEXT
);
CREATE INDEX IF NOT EXISTS mailbox_inbound ON mailbox_messages(to_session_id,delivered_at,sent_at);
CREATE INDEX IF NOT EXISTS mailbox_outbound ON mailbox_messages(from_session_id,sent_at);
CREATE TABLE IF NOT EXISTS terminal_notices(
 notice_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, child_session_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('completed','failed','cancelled')), result_json TEXT,
 artifact_ids_json TEXT NOT NULL DEFAULT '[]', error TEXT, reason TEXT, sent_event_id TEXT NOT NULL,
 delivered_event_id TEXT, sent_at TEXT NOT NULL, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS terminal_notices_parent ON terminal_notices(parent_session_id,sent_at);

-- Imported document content is immutable canonical event data; these rows make ordered range reads cheap.
CREATE TABLE IF NOT EXISTS documents(
 document_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT NOT NULL, name TEXT NOT NULL,
 media_type TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, chunk_count INTEGER NOT NULL,
 imported_event_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_chunks(
 chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ordinal INTEGER NOT NULL, content TEXT NOT NULL,
 size INTEGER NOT NULL, digest TEXT NOT NULL, event_id TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(document_id,ordinal)
);
CREATE INDEX IF NOT EXISTS document_chunks_ordered ON document_chunks(document_id,ordinal);
CREATE TABLE IF NOT EXISTS input_sets(
 input_set_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT NOT NULL, name TEXT,
 metadata_json TEXT, event_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS input_set_chunks(
 input_set_id TEXT NOT NULL, chunk_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 PRIMARY KEY(input_set_id,ordinal), UNIQUE(input_set_id,chunk_id)
);

-- Goal/gate, heartbeat, and recursive model rows are current-state projections.
CREATE TABLE IF NOT EXISTS goals(
 goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT NOT NULL, description TEXT NOT NULL,
 completion_criteria TEXT, max_turns INTEGER, status TEXT NOT NULL,
 completion_request_id TEXT, reason TEXT, created_event_id TEXT NOT NULL, last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_session ON goals(session_id,branch_id,created_at);
CREATE TABLE IF NOT EXISTS goal_gates(
 gate_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, name TEXT NOT NULL, executor TEXT NOT NULL,
 operation TEXT NOT NULL, input_json TEXT NOT NULL, idempotent INTEGER NOT NULL, required INTEGER NOT NULL,
 status TEXT NOT NULL, effect_id TEXT, output_json TEXT, error TEXT,
 created_event_id TEXT NOT NULL, last_event_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_gates_goal ON goal_gates(goal_id,created_at);
CREATE TABLE IF NOT EXISTS heartbeats(
 heartbeat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT NOT NULL, interval_ms INTEGER NOT NULL,
 next_tick_at TEXT NOT NULL, goal_id TEXT, payload_json TEXT, status TEXT NOT NULL, tick INTEGER NOT NULL DEFAULT 0,
 last_fired_at TEXT, created_event_id TEXT NOT NULL, last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS heartbeats_due ON heartbeats(status,next_tick_at);
CREATE TABLE IF NOT EXISTS recursive_model_handles(
 handle_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, parent_branch_id TEXT NOT NULL,
 child_session_id TEXT NOT NULL UNIQUE, child_branch_id TEXT NOT NULL, model_json TEXT NOT NULL, input_set_id TEXT,
 status TEXT NOT NULL, result_message_id TEXT, error TEXT, created_event_id TEXT NOT NULL, last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recursive_models_parent ON recursive_model_handles(parent_session_id,parent_branch_id,created_at);
