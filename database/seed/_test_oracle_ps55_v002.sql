-- ============================================================
-- Test seed (materialised): register PS55.V002 + PS55.GET_ABMQ501
-- for oracle-direct verification.
--
-- Discovered via scripts/list-oracle-ps55.ts + scripts/probe-pkg-view-param-1.ts:
--   PS55 has 25 views (V002..V146) and 2 callables:
--     - GET_ABMQ501           — FUNCTION returning TABLE (pipelined, 4 IN args)
--     - PKG_VIEW_PARAM_1.GET_PARAM — packaged scalar function, 0 IN args, RETURN VARCHAR2
--   (PKG_VIEW_PARAM_1.SET_PARAM is a setter — not registered.)
--
-- Apply (against the AuthZ DB):
--   docker exec -i docker-compose-postgres-1 \
--     psql -U nexus_admin -d nexus_authz \
--     < database/seed/_test_oracle_ps55_v002.sql
--
-- Smoke tests:
--   # View (rowset)
--   curl -X POST http://localhost:13001/api/data-query/oracle-direct \
--     -H 'Content-Type: application/json' \
--     -H 'X-User-Id: admin' \
--     -H 'X-User-Groups: DATA_STEWARD' \
--     -d '{"data_source_id":"ds:tiptop_oracle","resource_id":"view:ps55.v002","limit":5}'
--
--   # Pipelined function (needs valid PS55 ERP values for the 4 args)
--   curl -X POST http://localhost:13001/api/data-query/oracle-direct \
--     -H 'Content-Type: application/json' \
--     -H 'X-User-Id: admin' \
--     -H 'X-User-Groups: DATA_STEWARD' \
--     -d '{"data_source_id":"ds:tiptop_oracle",
--          "resource_id":"function:ps55.get_abmq501",
--          "params":{"L_ITEM":"<item>","L_DATE":"2026-01-01","ALTERNATE":"","L_BMAACTI":"Y"},
--          "limit":5}'
--
--   # Packaged scalar function (no args)
--   curl -X POST http://localhost:13001/api/data-query/oracle-direct \
--     -H 'Content-Type: application/json' \
--     -H 'X-User-Id: adam_ou' \
--     -H 'X-User-Groups: SYSADMIN' \
--     -d '{"data_source_id":"ds:tiptop_oracle",
--          "resource_id":"function:ps55.pkg_view_param_1.get_param"}'
--
-- Idempotent: rerun safe — uses ON CONFLICT DO UPDATE.
-- Cleanup:    see _test_oracle_ps55_v002_revert.sql (sibling).
-- ============================================================

-- 1. db_schema parent
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'db_schema:tiptop_oracle.ps55',
  'db_schema',
  NULL,
  'tiptop_oracle / PS55',
  jsonb_build_object(
    'data_source_id', 'ds:tiptop_oracle',
    'schema_name', 'PS55',
    'default_policy_inherits', 'data_source',
    'created_by', 'oracle_direct_spike'
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes = authz_resource.attributes || EXCLUDED.attributes,
      is_active  = TRUE,
      updated_at = now();

-- 2. PS55.V002 — 12-column view (INA01, INB03, INB04, ...)
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'view:ps55.v002',
  'view',
  'db_schema:tiptop_oracle.ps55',
  'PS55.V002',
  jsonb_build_object(
    'data_source_id',     'ds:tiptop_oracle',
    'available_targets',  jsonb_build_array('oracle_direct'),
    'oracle_owner',       'PS55',
    'oracle_object',      'V002',
    'oracle_kind',        'view',
    'created_by',         'oracle_direct_spike'
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes   = authz_resource.attributes || EXCLUDED.attributes,
      display_name = EXCLUDED.display_name,
      parent_id    = COALESCE(authz_resource.parent_id, EXCLUDED.parent_id),
      is_active    = TRUE,
      updated_at   = now();

-- 3. PS55.GET_ABMQ501 — pipelined function returning TABLE
--    Args (all IN): L_ITEM VARCHAR2, L_DATE DATE, ALTERNATE VARCHAR2, L_BMAACTI VARCHAR2
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'function:ps55.get_abmq501',
  'function',
  'db_schema:tiptop_oracle.ps55',
  'PS55.GET_ABMQ501(L_ITEM, L_DATE, ALTERNATE, L_BMAACTI) PIPELINED',
  jsonb_build_object(
    'data_source_id',     'ds:tiptop_oracle',
    'available_targets',  jsonb_build_array('oracle_direct'),
    'oracle_owner',       'PS55',
    'oracle_object',      'GET_ABMQ501',
    'oracle_kind',        'function_table',
    'arguments',          'L_ITEM VARCHAR2, L_DATE DATE, ALTERNATE VARCHAR2, L_BMAACTI VARCHAR2',
    'created_by',         'oracle_direct_spike'
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes   = authz_resource.attributes || EXCLUDED.attributes,
      display_name = EXCLUDED.display_name,
      parent_id    = COALESCE(authz_resource.parent_id, EXCLUDED.parent_id),
      is_active    = TRUE,
      updated_at   = now();

-- 4. PS55.PKG_VIEW_PARAM_1.GET_PARAM — packaged scalar function (no IN args)
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'function:ps55.pkg_view_param_1.get_param',
  'function',
  'db_schema:tiptop_oracle.ps55',
  'PS55.PKG_VIEW_PARAM_1.GET_PARAM() RETURN VARCHAR2',
  jsonb_build_object(
    'data_source_id',     'ds:tiptop_oracle',
    'available_targets',  jsonb_build_array('oracle_direct'),
    'oracle_owner',       'PS55',
    'oracle_package',     'PKG_VIEW_PARAM_1',
    'oracle_object',      'GET_PARAM',
    'oracle_kind',        'function_scalar',
    'arguments',          '',
    'return_type',        'VARCHAR2',
    'created_by',         'oracle_direct_spike'
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes   = authz_resource.attributes || EXCLUDED.attributes,
      display_name = EXCLUDED.display_name,
      parent_id    = COALESCE(authz_resource.parent_id, EXCLUDED.parent_id),
      is_active    = TRUE,
      updated_at   = now();

-- 5. Grants — DATA_STEWARD
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect)
VALUES
  ('DATA_STEWARD', 'read',    'view:ps55.v002',                          'allow'),
  ('DATA_STEWARD', 'execute', 'function:ps55.get_abmq501',               'allow'),
  ('DATA_STEWARD', 'execute', 'function:ps55.pkg_view_param_1.get_param', 'allow')
ON CONFLICT (role_id, action_id, resource_id) DO UPDATE
  SET effect = 'allow', is_active = TRUE;

-- 6. Verify
SELECT resource_id,
       resource_type,
       attributes->>'oracle_owner'     AS owner,
       attributes->>'oracle_package'   AS package,
       attributes->>'oracle_object'    AS object,
       attributes->>'oracle_kind'      AS kind,
       attributes->'available_targets' AS targets
  FROM authz_resource
 WHERE resource_id IN (
   'db_schema:tiptop_oracle.ps55',
   'view:ps55.v002',
   'function:ps55.get_abmq501',
   'function:ps55.pkg_view_param_1.get_param'
 )
 ORDER BY resource_id;
