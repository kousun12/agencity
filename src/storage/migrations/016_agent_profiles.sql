CREATE TABLE agent_profile_versions (
  profile_version_id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  role TEXT NOT NULL,
  purpose TEXT NOT NULL,
  instructions TEXT NOT NULL,
  exact_agent_prompt TEXT NOT NULL,
  prompt_contract_id TEXT NOT NULL,
  prompt_digest TEXT NOT NULL,
  created_by_json TEXT NOT NULL,
  source_spec_entry_id TEXT,
  source_spec_version_id TEXT,
  reason TEXT NOT NULL,
  evidence_event_ids_json TEXT NOT NULL,
  supersedes_profile_version_id TEXT REFERENCES agent_profile_versions(profile_version_id),
  restores_profile_version_id TEXT REFERENCES agent_profile_versions(profile_version_id),
  source_proposal_id TEXT,
  review_decision_id TEXT,
  created_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  created_at TEXT NOT NULL,
  UNIQUE(agent_session_id, revision),
  CHECK((source_spec_entry_id IS NULL) = (source_spec_version_id IS NULL))
);

CREATE TABLE workspace_agent_profiles (
  agent_session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
  active_profile_version_id TEXT NOT NULL REFERENCES agent_profile_versions(profile_version_id),
  activated_event_id TEXT NOT NULL REFERENCES events(id),
  updated_at TEXT NOT NULL
);

CREATE INDEX agent_profile_versions_session_revision
  ON agent_profile_versions(agent_session_id, revision);

ALTER TABLE recursive_model_handles ADD COLUMN profile_pin_json TEXT;
ALTER TABLE context_records ADD COLUMN prompt_provenance_json TEXT;
