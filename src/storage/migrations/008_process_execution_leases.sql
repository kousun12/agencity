-- FU-015 tranche 1: local process execution ownership.
-- These rows are operational and deliberately never represented as sync envelopes.
CREATE TABLE process_execution_leases(
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace','root')),
  scope_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_device_id TEXT NOT NULL,
  owner_process_id TEXT NOT NULL,
  fence_token INTEGER NOT NULL CHECK(typeof(fence_token)='integer' AND fence_token >= 1),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY(scope_kind,scope_id),
  CHECK(
    (scope_kind='workspace' AND scope_id=workspace_id) OR
    (scope_kind='root' AND length(scope_id)>0)
  )
);
CREATE INDEX process_execution_leases_workspace
  ON process_execution_leases(workspace_id,scope_kind,lease_expires_at);
