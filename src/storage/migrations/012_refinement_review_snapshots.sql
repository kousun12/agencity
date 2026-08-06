-- FU-016 integration adds the frozen trajectory snapshot and the exact
-- automatic-trigger frontier to the review projection. Columns remain nullable
-- so a database that applied migration 011 before the integrated refiner can
-- still open and surface any legacy incomplete review visibly.
ALTER TABLE refinement_reviews ADD COLUMN trigger_evidence_through_cursor TEXT;
ALTER TABLE refinement_reviews ADD COLUMN snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json));
CREATE UNIQUE INDEX IF NOT EXISTS refinement_review_nonterminal_key
  ON refinement_reviews(nonterminal_key)
  WHERE nonterminal_key IS NOT NULL AND status IN ('requested','running');
