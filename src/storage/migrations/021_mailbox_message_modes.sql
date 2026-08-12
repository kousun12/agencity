ALTER TABLE mailbox_messages
  ADD COLUMN message_mode TEXT
  CHECK (message_mode IS NULL OR message_mode IN ('steer', 'queue'));
