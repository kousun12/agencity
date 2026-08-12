CREATE TABLE ai_generations(
  generation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','object')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','unknown','budget_exceeded')),
  effect_id TEXT NOT NULL,
  execution_owned INTEGER NOT NULL CHECK(execution_owned IN (0,1)),
  request_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_event_id TEXT NOT NULL,
  last_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, branch_id, idempotency_key),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id),
  FOREIGN KEY(created_event_id) REFERENCES events(id),
  FOREIGN KEY(last_event_id) REFERENCES events(id)
);

CREATE INDEX ai_generations_session_branch_status
  ON ai_generations(session_id, branch_id, status, created_at);
