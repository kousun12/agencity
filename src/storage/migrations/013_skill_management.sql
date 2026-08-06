-- FU-017: rebuildable projection of canonical workspace skill availability actions.
CREATE TABLE IF NOT EXISTS skill_availability_actions(
 event_id TEXT PRIMARY KEY,
 entry_id TEXT NOT NULL,
 version_id TEXT NOT NULL,
 digest TEXT NOT NULL,
 availability TEXT NOT NULL CHECK(availability IN ('enabled','disabled','removed')),
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_availability_current ON skill_availability_actions(entry_id,created_at,event_id);
