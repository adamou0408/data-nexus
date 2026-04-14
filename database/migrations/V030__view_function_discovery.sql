-- ============================================================
-- V030: Add 'view' to authz_resource.resource_type constraint
-- Enables discovery and authorization of PostgreSQL views
-- alongside existing table/column/function support.
-- ============================================================

ALTER TABLE authz_resource DROP CONSTRAINT IF EXISTS authz_resource_resource_type_check;

ALTER TABLE authz_resource ADD CONSTRAINT authz_resource_resource_type_check
  CHECK (resource_type IN (
    'module', 'page', 'table', 'view', 'column', 'function',
    'ai_tool', 'web_page', 'web_api', 'db_schema', 'db_table', 'db_pool'
  ));
