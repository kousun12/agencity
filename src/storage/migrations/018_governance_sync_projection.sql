CREATE TABLE governed_refinement_proposals_v2 (
  proposal_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'proposed','deterministically_rejected','validated','reviewing',
    'reviewed_rejected','review_failed','review_unknown','reviewed_approved',
    'apply_conflict','apply_failed','applied'
  )),
  proposal_fingerprint TEXT NOT NULL,
  proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
  validation_json TEXT CHECK(validation_json IS NULL OR json_valid(validation_json)),
  frozen_input_json TEXT CHECK(frozen_input_json IS NULL OR json_valid(frozen_input_json)),
  frozen_input_digest TEXT,
  review_id TEXT,
  review_handle_id TEXT,
  reviewer_session_id TEXT,
  reviewer_branch_id TEXT,
  review_decision_id TEXT,
  decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
  applied_version_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(applied_version_ids_json)),
  terminal_reason TEXT,
  terminal_notice_event_id TEXT,
  created_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  last_event_id TEXT NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id)
) STRICT;

INSERT INTO governed_refinement_proposals_v2
SELECT * FROM governed_refinement_proposals;

DROP TABLE governed_refinement_proposals;
ALTER TABLE governed_refinement_proposals_v2 RENAME TO governed_refinement_proposals;

CREATE UNIQUE INDEX governed_refinement_fingerprint
  ON governed_refinement_proposals(session_id, branch_id, proposal_fingerprint);
CREATE UNIQUE INDEX governed_refinement_review
  ON governed_refinement_proposals(review_id) WHERE review_id IS NOT NULL;
CREATE INDEX governed_refinement_status
  ON governed_refinement_proposals(status, updated_at, proposal_id);
