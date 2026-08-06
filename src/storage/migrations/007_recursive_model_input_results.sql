-- FU-013: materialized recursive-call inputs and distinct terminal outcomes.
ALTER TABLE recursive_model_handles ADD COLUMN input_json TEXT;
ALTER TABLE recursive_model_handles ADD COLUMN input_provenance_json TEXT;
ALTER TABLE recursive_model_handles ADD COLUMN input_hash TEXT;
ALTER TABLE recursive_model_handles ADD COLUMN outcome TEXT;
ALTER TABLE recursive_model_handles ADD COLUMN result_json TEXT;
ALTER TABLE recursive_model_handles ADD COLUMN result_artifact_id TEXT;
