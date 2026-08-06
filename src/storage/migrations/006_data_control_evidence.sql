-- Release-review hardening: retain the local placement for every historical replica
-- status row so data-control enumeration survives configuration changes.
ALTER TABLE workspace_replica_status ADD COLUMN replica_url TEXT;
