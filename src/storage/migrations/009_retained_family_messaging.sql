-- FU-012 retained nuclear-family messaging projections.
ALTER TABLE mailbox_messages ADD COLUMN artifact_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mailbox_messages ADD COLUMN intent_key TEXT;
ALTER TABLE mailbox_messages ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mailbox_messages ADD COLUMN reply_to_message_id TEXT;
ALTER TABLE mailbox_messages ADD COLUMN sender_relationship TEXT CHECK(sender_relationship IN ('parent','child','sibling'));
ALTER TABLE mailbox_messages ADD COLUMN receipt_status TEXT NOT NULL DEFAULT 'delivered_to_context' CHECK(receipt_status IN ('queued','delivered_to_context','acknowledged','failed'));
ALTER TABLE mailbox_messages ADD COLUMN context_event_id TEXT;
ALTER TABLE mailbox_messages ADD COLUMN context_message_event_id TEXT;
ALTER TABLE mailbox_messages ADD COLUMN context_delivered_at TEXT;
ALTER TABLE mailbox_messages ADD COLUMN follow_up_run_id TEXT;
ALTER TABLE mailbox_messages ADD COLUMN delivery_error TEXT;
UPDATE mailbox_messages SET receipt_status=CASE WHEN acknowledged_event_id IS NOT NULL THEN 'acknowledged' ELSE 'delivered_to_context' END;
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_sender_intent ON mailbox_messages(from_session_id,from_branch_id,intent_key) WHERE intent_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_pending_delivery ON mailbox_messages(to_session_id,receipt_status,sent_at,mailbox_message_id);
