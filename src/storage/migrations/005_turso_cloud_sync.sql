-- Slice 4 workspace-local replication metadata. Canonical events remain in the
-- workspace database; only immutable envelopes are exchanged through a separate
-- Turso Sync envelope database, so logical last-push-wins conflicts cannot overwrite
-- canonical history or mutable projections.
ALTER TABLE events ADD COLUMN origin_device_id TEXT;
ALTER TABLE events ADD COLUMN origin_sequence INTEGER;
ALTER TABLE events ADD COLUMN stream_parent_id TEXT;
ALTER TABLE sessions ADD COLUMN execution_owner_device_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS events_origin_sequence
  ON events(origin_device_id, origin_sequence) WHERE origin_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_origin_branch
  ON events(origin_device_id, session_id, branch_id, origin_sequence);

-- Per-workspace Lamport-style device clocks are operational synchronization state.
CREATE TABLE IF NOT EXISTS device_clocks(
 device_id TEXT PRIMARY KEY,
 next_sequence INTEGER NOT NULL CHECK(next_sequence > 0)
);
-- One row per configured replica. No authentication token is retained here.
CREATE TABLE IF NOT EXISTS workspace_replica_status(
 replica_id TEXT PRIMARY KEY,
 replica_incarnation TEXT,
 workspace_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 sync_url TEXT,
 credential_reference TEXT,
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('local_only','offline','syncing','online','error','closed')),
 last_attempt_at TEXT,
 last_success_at TEXT,
 last_error TEXT,
 last_stats_json TEXT,
 staged_envelopes INTEGER NOT NULL DEFAULT 0,
 ingested_envelopes INTEGER NOT NULL DEFAULT 0,
 quarantined_envelopes INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
-- Durable local receipt/dedupe boundary for immutable transport envelopes.
CREATE TABLE IF NOT EXISTS sync_ingest_receipts(
 envelope_id TEXT PRIMARY KEY,
 digest TEXT NOT NULL,
 origin_device_id TEXT NOT NULL,
 origin_sequence INTEGER NOT NULL,
 event_id TEXT NOT NULL,
 source_branch_id TEXT NOT NULL,
 mapped_branch_id TEXT NOT NULL,
 ingested_at TEXT NOT NULL
);
-- Incremental stage/ingest frontiers are local operational hints. An ingest
-- frontier advances only across terminally handled envelopes, never past a
-- causal dependency that must be retried.
CREATE TABLE IF NOT EXISTS sync_origin_watermarks(
 replica_id TEXT NOT NULL,
 origin_device_id TEXT NOT NULL,
 staged_sequence INTEGER NOT NULL DEFAULT 0 CHECK(staged_sequence >= 0),
 ingested_sequence INTEGER NOT NULL DEFAULT 0 CHECK(ingested_sequence >= 0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(replica_id, origin_device_id)
);
-- Invalid or causally incomplete remote input never enters canonical history.
CREATE TABLE IF NOT EXISTS sync_quarantine(
 envelope_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 origin_device_id TEXT,
 origin_sequence INTEGER,
 reason_code TEXT NOT NULL,
 reason TEXT NOT NULL,
 envelope_json TEXT NOT NULL,
 digest TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending_dependency','quarantined','released')),
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL
);
-- Deterministically derived branch mapping for an offline divergent origin stream.
CREATE TABLE IF NOT EXISTS sync_branch_mappings(
 mapping_id TEXT PRIMARY KEY,
 origin_device_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 source_branch_id TEXT NOT NULL,
 fork_event_id TEXT NOT NULL,
 derived_branch_id TEXT NOT NULL,
 last_source_event_id TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(origin_device_id, session_id, source_branch_id, fork_event_id),
 UNIQUE(session_id, derived_branch_id)
);
-- Duplicate intents, divergent advancement, rejected mutation, and claims stay visible.
CREATE TABLE IF NOT EXISTS sync_reconciliations(
 conflict_id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('duplicate_event','duplicate_intent','divergent_session','task_claim','rejected_mutation')),
 workspace_id TEXT NOT NULL,
 session_id TEXT,
 task_id TEXT,
 event_ids_json TEXT NOT NULL,
 origin_device_ids_json TEXT NOT NULL,
 details_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('unresolved','resolved')),
 resolution_json TEXT,
 detected_at TEXT NOT NULL,
 resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS sync_reconciliations_status ON sync_reconciliations(status,kind,detected_at);
-- Ownership-approved export/deletion plans enumerate local and managed replicas.
CREATE TABLE IF NOT EXISTS data_manifests(
 manifest_id TEXT PRIMARY KEY,
 operation TEXT NOT NULL CHECK(operation IN ('export','delete')),
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace','session','profile')),
 scope_id TEXT NOT NULL,
 requested_by TEXT NOT NULL,
 owned INTEGER NOT NULL CHECK(owned IN (0,1)),
 resources_json TEXT NOT NULL,
 replica_status_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('planned','completed','partial','blocked')),
 created_at TEXT NOT NULL,
 completed_at TEXT
);
