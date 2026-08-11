-- Replaceable same-device console scratch checkpoints. This table is a local
-- operational cache: it is not canonical, synchronized, exported, or rebuilt.
CREATE TABLE console_scratch_cache(
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(typeof(schema_version)='integer' AND schema_version >= 1),
  checkpoint_json TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
  row_integrity_digest TEXT NOT NULL CHECK(length(row_integrity_digest)=64),
  checkpoint_byte_length INTEGER NOT NULL CHECK(typeof(checkpoint_byte_length)='integer' AND checkpoint_byte_length >= 0),
  encoded_row_bytes INTEGER NOT NULL CHECK(typeof(encoded_row_bytes)='integer' AND encoded_row_bytes >= 0),
  source_cell_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_cursor INTEGER NOT NULL CHECK(typeof(source_cursor)='integer' AND source_cursor >= 1),
  saved_names_json TEXT NOT NULL,
  skipped_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(session_id,branch_id)
);

CREATE INDEX console_scratch_cache_workspace_lru
  ON console_scratch_cache(workspace_id,accessed_at,session_id,branch_id);
CREATE INDEX console_scratch_cache_expiry
  ON console_scratch_cache(expires_at);
