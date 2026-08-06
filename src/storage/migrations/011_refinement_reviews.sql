-- FU-016 durable trajectory refinement review orchestration.
CREATE TABLE IF NOT EXISTS refinement_reviews(
  review_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('manual','automatic','skill_creation')),
  requested_scope TEXT NOT NULL CHECK(requested_scope IN ('local','workspace','user','global')),
  requested_scope_key TEXT NOT NULL,
  allowed_kinds_json TEXT NOT NULL CHECK(json_valid(allowed_kinds_json)),
  trigger_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  trigger_fingerprint TEXT NOT NULL,
  trigger_key TEXT,
  nonterminal_key TEXT,
  evidence_event_ids_json TEXT NOT NULL CHECK(json_valid(evidence_event_ids_json)),
  source_event_ids_json TEXT NOT NULL CHECK(json_valid(source_event_ids_json)),
  source_snapshot_hash TEXT NOT NULL,
  source_through_cursor TEXT NOT NULL,
  instructions TEXT,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  status TEXT NOT NULL CHECK(status IN ('requested','running','no_change','candidate','revision_required','failed','cancelled','unknown')),
  handle_id TEXT,
  child_session_id TEXT,
  child_branch_id TEXT,
  decision_fingerprint TEXT,
  proposal_id TEXT,
  reason TEXT,
  created_event_id TEXT NOT NULL UNIQUE,
  last_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id),
  FOREIGN KEY(handle_id) REFERENCES recursive_model_handles(handle_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS refinement_review_fingerprint ON refinement_reviews(session_id,branch_id,fingerprint);
CREATE INDEX IF NOT EXISTS refinement_review_status ON refinement_reviews(status,updated_at,review_id);
CREATE INDEX IF NOT EXISTS refinement_review_trigger_key ON refinement_reviews(session_id,branch_id,trigger_key,created_at);

CREATE TABLE IF NOT EXISTS refinement_trigger_consumptions(
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  last_consumed_evidence_cursor TEXT NOT NULL,
  review_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id,branch_id,trigger_key),
  FOREIGN KEY(review_id) REFERENCES refinement_reviews(review_id)
) STRICT;

CREATE TABLE IF NOT EXISTS user_corrections(
  correction_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  corrected_event_ids_json TEXT NOT NULL CHECK(json_valid(corrected_event_ids_json)),
  correction_text TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

ALTER TABLE refinement_proposals ADD COLUMN source_review_id TEXT;
ALTER TABLE refinement_proposals ADD COLUMN proposal_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS refinement_proposal_source_review ON refinement_proposals(source_review_id) WHERE source_review_id IS NOT NULL;
