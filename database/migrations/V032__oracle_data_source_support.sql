-- ============================================================
-- V032: Oracle Data Source Support
-- Extends authz_data_source for Oracle CDC pattern:
--   Oracle → CDC → PG replica in nexus_data schema
--   Oracle connection retained for function call proxy only
-- ============================================================

-- 1. CDC target schema — the PG schema in nexus_data where CDC writes Oracle tables
ALTER TABLE authz_data_source
  ADD COLUMN IF NOT EXISTS cdc_target_schema TEXT;

COMMENT ON COLUMN authz_data_source.cdc_target_schema
  IS 'PG schema in nexus_data where CDC writes Oracle replica tables. Only for db_type=oracle.';

-- 2. Oracle connection info — stored as JSONB for function call proxy
--    Structure: {host, port, service_name, user, password_enc}
ALTER TABLE authz_data_source
  ADD COLUMN IF NOT EXISTS oracle_connection JSONB;

COMMENT ON COLUMN authz_data_source.oracle_connection
  IS 'Oracle TNS connection: {host, port, service_name, user, password_enc}. Only for db_type=oracle.';

-- 3. Expand sync_type to track Oracle function call auditing
ALTER TABLE authz_sync_log DROP CONSTRAINT IF EXISTS authz_sync_log_sync_type_check;
ALTER TABLE authz_sync_log ADD CONSTRAINT authz_sync_log_sync_type_check
  CHECK (sync_type IN (
    'rls_policy', 'column_view', 'ui_metadata', 'web_acl',
    'db_grant', 'pgbouncer_config', 'agent_scope',
    'external_db_grant', 'external_credential_sync',
    'oracle_function_call'
  ));
