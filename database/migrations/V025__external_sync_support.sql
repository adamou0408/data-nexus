-- ============================================================
-- V025: External DB Sync Support
-- ============================================================
-- Extends sync_log for external DB grant tracking
-- and adds last_grant_sync_at to data_source table.

-- 1. Expand allowed sync_type values
ALTER TABLE authz_sync_log DROP CONSTRAINT IF EXISTS authz_sync_log_sync_type_check;
ALTER TABLE authz_sync_log ADD CONSTRAINT authz_sync_log_sync_type_check
  CHECK (sync_type IN (
    'rls_policy', 'column_view', 'ui_metadata', 'web_acl',
    'db_grant', 'pgbouncer_config', 'agent_scope',
    'external_db_grant', 'external_credential_sync'
  ));

-- 2. Add data_source_id to sync_log for traceability
ALTER TABLE authz_sync_log
  ADD COLUMN IF NOT EXISTS data_source_id TEXT REFERENCES authz_data_source(source_id);

-- 3. Track last external grant sync per data source
ALTER TABLE authz_data_source
  ADD COLUMN IF NOT EXISTS last_grant_sync_at TIMESTAMPTZ;
