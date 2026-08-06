-- Slice 2 review hardening: completion requests durably pin their workspace.
ALTER TABLE goals ADD COLUMN completion_workspace_id TEXT;
ALTER TABLE goals ADD COLUMN completion_workspace_cursor TEXT;
ALTER TABLE goals ADD COLUMN completion_pin_recorded INTEGER NOT NULL DEFAULT 0;
-- Current-version snapshots made before pin projection existed are disposable.
DELETE FROM snapshots;
