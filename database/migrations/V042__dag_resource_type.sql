-- ============================================================
-- V042: Add 'dag' to authz_resource.resource_type constraint
--
-- DAGs are stored as authz_resource rows:
--   resource_id   = 'dag:<slug>'
--   display_name  = user-visible title
--   attributes    = { nodes:[], edges:[], data_source_id, authored_by, version }
--
-- Nodes and edges live inside attributes JSONB — no separate table —
-- keeping the unified node model (spec §3.2) and reusing existing
-- authz_resource audit + grant infrastructure.
-- ============================================================

ALTER TABLE authz_resource DROP CONSTRAINT IF EXISTS authz_resource_resource_type_check;

ALTER TABLE authz_resource ADD CONSTRAINT authz_resource_resource_type_check
  CHECK (resource_type IN (
    'module', 'page', 'table', 'view', 'column', 'function',
    'ai_tool', 'web_page', 'web_api', 'db_schema', 'db_table', 'db_pool',
    'dag'
  ));

COMMENT ON COLUMN authz_resource.attributes IS
  'Type-specific metadata. For resource_type=dag: { nodes, edges, data_source_id, version }';
