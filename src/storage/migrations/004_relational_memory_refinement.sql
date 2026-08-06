-- Delivery Slice 3: continual harness projections and disposable candidate index.
-- Canonical truth remains in Harness*/Refinement*/Skill*/SubagentSpec* events.
ALTER TABLE context_records ADD COLUMN harness_provenance_json TEXT;

CREATE TABLE IF NOT EXISTS harness_entries(
 entry_id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('memory','prompt_note','skill','subagent_spec')),
 scope TEXT NOT NULL CHECK(scope IN ('local','workspace','user','global')),
 scope_key TEXT NOT NULL,
 name TEXT NOT NULL,
 current_version_id TEXT NOT NULL,
 active_version_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('candidate','active','retired','rejected','rolled_back')),
 created_event_id TEXT NOT NULL,
 last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS harness_entries_lookup ON harness_entries(kind,scope,scope_key,status,updated_at,entry_id);
CREATE UNIQUE INDEX IF NOT EXISTS harness_entry_name ON harness_entries(kind,scope,scope_key,name) WHERE status IN ('candidate','active');

CREATE TABLE IF NOT EXISTS harness_versions(
 version_id TEXT PRIMARY KEY,
 entry_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 kind TEXT NOT NULL,
 scope TEXT NOT NULL,
 scope_key TEXT NOT NULL,
 name TEXT NOT NULL,
 content_json TEXT NOT NULL,
 tags_json TEXT NOT NULL,
 confidence REAL NOT NULL,
 status TEXT NOT NULL,
 evidence_event_ids_json TEXT NOT NULL,
 conflict_entry_ids_json TEXT NOT NULL,
 supersedes_version_id TEXT,
 proposal_id TEXT,
 created_by TEXT NOT NULL,
 created_event_id TEXT NOT NULL,
 last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 last_confirmed_at TEXT NOT NULL,
 UNIQUE(entry_id,version)
);
CREATE INDEX IF NOT EXISTS harness_versions_entry ON harness_versions(entry_id,version);
CREATE INDEX IF NOT EXISTS harness_versions_proposal ON harness_versions(proposal_id,version_id);

CREATE TABLE IF NOT EXISTS refinement_proposals(
 proposal_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 branch_id TEXT NOT NULL,
 status TEXT NOT NULL,
 trigger_text TEXT NOT NULL,
 predicted_effect TEXT NOT NULL,
 edits_json TEXT NOT NULL,
 evidence_event_ids_json TEXT NOT NULL,
 evaluation_json TEXT NOT NULL,
 authority TEXT NOT NULL,
 validation_json TEXT,
 candidate_id TEXT,
 allocation_limit INTEGER,
 exposure_limit INTEGER,
 approved_scopes_json TEXT NOT NULL DEFAULT '[]',
 created_event_id TEXT NOT NULL,
 last_event_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refinement_status ON refinement_proposals(status,updated_at,proposal_id);
CREATE UNIQUE INDEX IF NOT EXISTS refinement_candidate ON refinement_proposals(candidate_id) WHERE candidate_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS candidate_allocations(
 allocation_id TEXT PRIMARY KEY,
 candidate_id TEXT NOT NULL,
 proposal_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 branch_id TEXT NOT NULL,
 task_id TEXT,
 ordinal INTEGER NOT NULL,
 exposed_at TEXT,
 created_event_id TEXT NOT NULL,
 exposed_event_id TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(candidate_id,ordinal),
 UNIQUE(candidate_id,session_id,branch_id,task_id)
);
CREATE INDEX IF NOT EXISTS allocations_candidate ON candidate_allocations(candidate_id,ordinal);

CREATE TABLE IF NOT EXISTS refinement_observations(
 observation_id TEXT PRIMARY KEY,
 candidate_id TEXT NOT NULL,
 proposal_id TEXT NOT NULL,
 allocation_id TEXT NOT NULL,
 evaluator TEXT NOT NULL,
 objective INTEGER NOT NULL,
 success INTEGER NOT NULL,
 metric_json TEXT NOT NULL,
 baseline_json TEXT,
 evidence_event_ids_json TEXT NOT NULL,
 notes TEXT,
 event_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_candidate ON refinement_observations(candidate_id,created_at,observation_id);

CREATE TABLE IF NOT EXISTS refinement_decisions(
 decision_id TEXT PRIMARY KEY,
 proposal_id TEXT NOT NULL,
 candidate_id TEXT NOT NULL,
 decision TEXT NOT NULL,
 rule TEXT NOT NULL,
 evaluator TEXT NOT NULL,
 baseline_json TEXT,
 observation_ids_json TEXT NOT NULL,
 event_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_proposal ON refinement_decisions(proposal_id,created_at,decision_id);

CREATE TABLE IF NOT EXISTS refinement_approvals(
 event_id TEXT PRIMARY KEY,
 proposal_id TEXT NOT NULL,
 approved_by TEXT NOT NULL,
 scope TEXT NOT NULL,
 note TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(proposal_id,scope)
);
CREATE TABLE IF NOT EXISTS refinement_rollback_approvals(
 event_id TEXT PRIMARY KEY,
 proposal_id TEXT NOT NULL,
 approved_by TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','admin')),
 note TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(proposal_id)
);
CREATE TABLE IF NOT EXISTS refinement_rollbacks(
 rollback_id TEXT PRIMARY KEY,
 proposal_id TEXT NOT NULL,
 candidate_id TEXT NOT NULL,
 version_ids_json TEXT NOT NULL,
 restored_version_ids_json TEXT NOT NULL,
 reason TEXT NOT NULL,
 event_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_executions(
 event_id TEXT PRIMARY KEY,
 entry_id TEXT NOT NULL,
 version_id TEXT NOT NULL,
 effect_id TEXT NOT NULL,
 execution_kind TEXT NOT NULL CHECK(execution_kind IN ('invoke','test')),
 passed INTEGER,
 report_json TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_executions_version ON skill_executions(version_id,created_at,event_id);
CREATE TABLE IF NOT EXISTS subagent_spec_invocations(
 event_id TEXT PRIMARY KEY,
 entry_id TEXT NOT NULL,
 version_id TEXT NOT NULL,
 task_id TEXT NOT NULL UNIQUE,
 child_session_id TEXT NOT NULL,
 child_branch_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);

-- This is candidate-generation state only. It is deliberately disposable and
-- can be regenerated from current harness projections without changing truth.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
 version_id UNINDEXED,
 entry_id UNINDEXED,
 content,
 tags,
 tokenize='unicode61 remove_diacritics 2'
);
