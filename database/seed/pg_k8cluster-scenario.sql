-- ============================================================
-- pg_k8cluster Scenario: Tiptop ERP Module Mapping
-- Run AFTER: 1) ds:pg_k8cluster registered, 2) Discover completed
-- ============================================================

-- 1. Create tiptop module hierarchy
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
VALUES
  ('module:tiptop',            'module', NULL,             'Tiptop ERP System',       '{"data_source_id": "ds:pg_k8cluster"}'),
  ('module:tiptop_approval',   'module', 'module:tiptop', 'Approval / Authorization','{"data_source_id": "ds:pg_k8cluster", "table_prefix": "azf"}'),
  ('module:tiptop_inventory',  'module', 'module:tiptop', 'Inventory Master',        '{"data_source_id": "ds:pg_k8cluster", "table_prefix": "ima"}'),
  ('module:tiptop_reports',    'module', 'module:tiptop', 'Custom Reports',          '{"data_source_id": "ds:pg_k8cluster", "table_prefix": "cimzr,csfzr,cxmzr"}'),
  ('module:tiptop_views',      'module', 'module:tiptop', 'Standard Views',          '{"data_source_id": "ds:pg_k8cluster", "table_prefix": "v0"}'),
  ('module:tiptop_config',     'module', 'module:tiptop', 'System Configuration',    '{"data_source_id": "ds:pg_k8cluster", "table_prefix": "tiptop_config"}')
ON CONFLICT (resource_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_id = EXCLUDED.parent_id,
  attributes = authz_resource.attributes || EXCLUDED.attributes,
  updated_at = now();

-- 2. Map discovered tables to modules (only if parent_id is NULL)
UPDATE authz_resource SET parent_id = 'module:tiptop_approval', updated_at = now()
WHERE resource_id LIKE 'table:azf_%' AND parent_id IS NULL AND is_active = TRUE;

UPDATE authz_resource SET parent_id = 'module:tiptop_inventory', updated_at = now()
WHERE resource_id LIKE 'table:ima_%' AND parent_id IS NULL AND is_active = TRUE;

UPDATE authz_resource SET parent_id = 'module:tiptop_reports', updated_at = now()
WHERE resource_type = 'table' AND parent_id IS NULL AND is_active = TRUE
  AND (resource_id LIKE 'table:cimzr%' OR resource_id LIKE 'table:csfzr%' OR resource_id LIKE 'table:cxmzr%');

UPDATE authz_resource SET parent_id = 'module:tiptop_views', updated_at = now()
WHERE resource_id LIKE 'table:v0%' AND parent_id IS NULL AND is_active = TRUE;

UPDATE authz_resource SET parent_id = 'module:tiptop_config', updated_at = now()
WHERE resource_id LIKE 'table:tiptop_config%' AND parent_id IS NULL AND is_active = TRUE;

-- 3. Update pool profiles to use ds:pg_k8cluster + allowed_modules
-- PE engineers: readonly on reports + inventory
UPDATE authz_db_pool_profile SET
  data_source_id = 'ds:pg_k8cluster',
  allowed_schemas = '{tiptop}',
  allowed_modules = ARRAY['module:tiptop_reports', 'module:tiptop_inventory'],
  allowed_tables = NULL,
  updated_at = now()
WHERE profile_id = 'pool:pe_readonly';

-- Sales team: readonly on approval + views
UPDATE authz_db_pool_profile SET
  data_source_id = 'ds:pg_k8cluster',
  allowed_schemas = '{tiptop}',
  allowed_modules = ARRAY['module:tiptop_approval', 'module:tiptop_views'],
  allowed_tables = NULL,
  updated_at = now()
WHERE profile_id = 'pool:sales_readonly';

-- BI analysts: readonly on ALL modules
UPDATE authz_db_pool_profile SET
  data_source_id = 'ds:pg_k8cluster',
  allowed_schemas = '{tiptop}',
  allowed_modules = ARRAY['module:tiptop_approval', 'module:tiptop_inventory', 'module:tiptop_reports', 'module:tiptop_views', 'module:tiptop_config'],
  allowed_tables = NULL,
  updated_at = now()
WHERE profile_id = 'pool:bi_readonly';

-- ETL service: readwrite on reports + inventory
UPDATE authz_db_pool_profile SET
  data_source_id = 'ds:pg_k8cluster',
  allowed_schemas = '{tiptop}',
  allowed_modules = ARRAY['module:tiptop_reports', 'module:tiptop_inventory'],
  allowed_tables = NULL,
  updated_at = now()
WHERE profile_id = 'pool:etl_readwrite';

-- Admin: full access
UPDATE authz_db_pool_profile SET
  data_source_id = 'ds:pg_k8cluster',
  allowed_schemas = '{tiptop}',
  allowed_modules = NULL,
  allowed_tables = NULL,
  updated_at = now()
WHERE profile_id = 'pool:admin_full';

-- 4. Add RBAC permissions for tiptop modules
-- PE role can read tiptop reports and inventory
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect)
VALUES
  ('PE', 'read', 'module:tiptop_reports', 'allow'),
  ('PE', 'read', 'module:tiptop_inventory', 'allow'),
  ('SALES', 'read', 'module:tiptop_approval', 'allow'),
  ('SALES', 'read', 'module:tiptop_views', 'allow'),
  ('BI_USER', 'read', 'module:tiptop', 'allow'),
  ('QA', 'read', 'module:tiptop_reports', 'allow'),
  ('ADMIN', 'read', 'module:tiptop', 'allow'),
  ('VP', 'read', 'module:tiptop', 'allow')
ON CONFLICT (role_id, action_id, resource_id) DO NOTHING;

-- Done
SELECT 'pg_k8cluster scenario applied successfully' AS result;
