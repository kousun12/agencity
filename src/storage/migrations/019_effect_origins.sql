ALTER TABLE outbox
  ADD COLUMN origin_json TEXT NOT NULL DEFAULT 'null';
