-- FU-014 autonomous goals, gate-evaluation cache, and durable wake scheduling.
ALTER TABLE goals ADD COLUMN completion_material_version TEXT;
ALTER TABLE goals ADD COLUMN completion_material_event_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE goal_gates ADD COLUMN current_evaluation_id TEXT;
ALTER TABLE heartbeats ADD COLUMN prompt TEXT;
ALTER TABLE heartbeats ADD COLUMN owner TEXT NOT NULL DEFAULT 'user';

CREATE TABLE IF NOT EXISTS goal_gate_evaluations(
 evaluation_id TEXT PRIMARY KEY,
 goal_id TEXT NOT NULL,
 gate_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 definition_hash TEXT NOT NULL,
 material_version TEXT NOT NULL,
 material_event_ids_json TEXT NOT NULL,
 status TEXT NOT NULL,
 effect_id TEXT,
 output_json TEXT,
 error TEXT,
 cached_from_evaluation_id TEXT,
 event_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_gate_evaluation_cache ON goal_gate_evaluations(gate_id,definition_hash,material_version,created_at);
CREATE INDEX IF NOT EXISTS goal_gate_evaluation_goal ON goal_gate_evaluations(goal_id,created_at);

CREATE TABLE IF NOT EXISTS schedules(
 schedule_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 branch_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 prompt TEXT NOT NULL,
 interval_ms INTEGER,
 next_tick_at TEXT NOT NULL,
 owner TEXT NOT NULL,
 goal_mode TEXT NOT NULL,
 status TEXT NOT NULL,
 tick INTEGER NOT NULL DEFAULT 0,
 last_fired_at TEXT,
 reason TEXT,
 created_event_id TEXT NOT NULL,
 last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_tick_at);
CREATE INDEX IF NOT EXISTS schedules_session ON schedules(session_id,branch_id,created_at);

CREATE TABLE IF NOT EXISTS wake_queue(
 wake_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 branch_id TEXT NOT NULL,
 source_type TEXT NOT NULL,
 source_id TEXT NOT NULL,
 tick INTEGER NOT NULL,
 scheduled_at TEXT NOT NULL,
 fired_at TEXT NOT NULL,
 prompt TEXT NOT NULL,
 goal_id TEXT,
 goal_mode TEXT NOT NULL,
 status TEXT NOT NULL,
 claim_id TEXT,
 claimed_at TEXT,
 run_id TEXT,
 delivered_at TEXT,
 reason TEXT,
 created_event_id TEXT NOT NULL,
 last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wake_queue_status ON wake_queue(status,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS wake_queue_source_tick ON wake_queue(source_type,source_id,tick);

-- Old snapshots are derived from an earlier reducer shape.
DELETE FROM snapshots;
