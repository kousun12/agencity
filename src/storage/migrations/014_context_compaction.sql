-- FU-019: immutable typed provenance beside the canonical ContextMaterialized event.
ALTER TABLE context_records ADD COLUMN derivation_json TEXT;
CREATE INDEX IF NOT EXISTS events_context_compaction ON events(session_id,branch_id,type,sequence)
  WHERE type IN ('ContextCompactionRequested','ContextCompactionFailed','ContextMaterialized');
