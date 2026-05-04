-- ============================================================
-- Test seed: register PS55 (Oracle) objects for oracle-direct verification.
--
-- Spike scope: 1 view + 1 scalar function in PS55 schema, queryable via
-- POST /api/data-query/oracle-direct against the existing tiptop_oracle DS.
--
-- Usage:
--   1. Replace placeholders before applying:
--        __VIEW_NAME__   — uppercase Oracle view name in PS55
--        __view_name__   — same value, lowercased (used in resource_id)
--        __FN_NAME__     — uppercase Oracle scalar function name in PS55
--        __fn_name__     — lowercased
--        __fn_arg_name__ — bind name (alnum + underscore, e.g. p_id)
--        __FN_ARG_TYPE__ — Oracle data type (e.g. NUMBER, VARCHAR2)
--        __FN_RETURN__   — Oracle return type (e.g. VARCHAR2)
--
--   2. Apply against the AuthZ DB (nexus_authz):
--        docker exec -i data-nexus-postgres-1 \
--          psql -U nexus_admin -d nexus_authz < database/seed/_test_oracle_ps55.sql
--
--   3. Smoke test (replace IDs with the chosen values):
--        # View (rowset)
--        curl -X POST http://localhost:13001/api/data-query/oracle-direct \
--          -H 'Content-Type: application/json' \
--          -H 'X-User-Id: admin' \
--          -H 'X-User-Groups: DATA_STEWARD' \
--          -d '{"data_source_id":"ds:tiptop_oracle","resource_id":"view:ps55.__view_name__","limit":5}'
--
--        # Scalar function
--        curl -X POST http://localhost:13001/api/data-query/oracle-direct \
--          -H 'Content-Type: application/json' \
--          -H 'X-User-Id: admin' \
--          -H 'X-User-Groups: DATA_STEWARD' \
--          -d '{"data_source_id":"ds:tiptop_oracle","resource_id":"function:ps55.__fn_name__","params":{"__fn_arg_name__":<value>}}'
--
-- Idempotent: rerun safe — uses ON CONFLICT DO UPDATE.
-- Cleanup:    see _test_oracle_ps55_revert.sql (sibling file).
-- ============================================================

-- 1. db_schema parent — lets policy cascade reach DS-level grants
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

-- 2. PS55 view — single-row read
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'view:ps55.__view_name__',
  'view',
  'db_schema:tiptop_oracle.ps55',
  'PS55.__VIEW_NAME__',
  jsonb_build_object(
    'data_source_id',     'ds:tiptop_oracle',
    'available_targets',  jsonb_build_array('oracle_direct'),
    'oracle_owner',       'PS55',
    'oracle_object',      '__VIEW_NAME__',
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

-- 3. PS55 scalar function — VARCHAR2-returning, single IN bind
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'function:ps55.__fn_name__',
  'function',
  'db_schema:tiptop_oracle.ps55',
  'PS55.__FN_NAME__(__fn_arg_name__ __FN_ARG_TYPE__) RETURN __FN_RETURN__',
  jsonb_build_object(
    'data_source_id',     'ds:tiptop_oracle',
    'available_targets',  jsonb_build_array('oracle_direct'),
    'oracle_owner',       'PS55',
    'oracle_object',      '__FN_NAME__',
    'oracle_kind',        'function_scalar',
    'arguments',          '__fn_arg_name__ __FN_ARG_TYPE__',
    'return_type',        '__FN_RETURN__',
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

-- 4. (OPTIONAL) PS55 pipelined / table function — uncomment + edit if you have one.
--    Use this when the function is declared to return a TABLE / collection type,
--    callable as `SELECT * FROM TABLE(PS55.fn(...))`. The route will wrap with
--    FETCH FIRST :limit ROWS ONLY automatically.
--
-- INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
-- VALUES (
--   'function:ps55.__tabfn_name__',
--   'function',
--   'db_schema:tiptop_oracle.ps55',
--   'PS55.__TABFN_NAME__(__tabfn_arg__ __TABFN_ARG_TYPE__)  PIPELINED',
--   jsonb_build_object(
--     'data_source_id',     'ds:tiptop_oracle',
--     'available_targets',  jsonb_build_array('oracle_direct'),
--     'oracle_owner',       'PS55',
--     'oracle_object',      '__TABFN_NAME__',
--     'oracle_kind',        'function_table',
--     'arguments',          '__tabfn_arg__ __TABFN_ARG_TYPE__',
--     'created_by',         'oracle_direct_spike'
--   ),
--   TRUE
-- )
-- ON CONFLICT (resource_id) DO UPDATE
--   SET attributes   = authz_resource.attributes || EXCLUDED.attributes,
--       display_name = EXCLUDED.display_name,
--       parent_id    = COALESCE(authz_resource.parent_id, EXCLUDED.parent_id),
--       is_active    = TRUE,
--       updated_at   = now();

-- 5. Grants — DATA_STEWARD can select view, execute function
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect)
VALUES
  ('DATA_STEWARD', 'read',    'view:ps55.__view_name__',   'allow'),
  ('DATA_STEWARD', 'execute', 'function:ps55.__fn_name__', 'allow')
  -- ('DATA_STEWARD', 'execute', 'function:ps55.__tabfn_name__', 'allow')
ON CONFLICT (role_id, action_id, resource_id) DO UPDATE
  SET effect = 'allow', is_active = TRUE;

-- 6. Verify rows landed
SELECT resource_id,
       resource_type,
       attributes->>'oracle_owner'     AS owner,
       attributes->>'oracle_object'    AS object,
       attributes->>'oracle_kind'      AS kind,
       attributes->'available_targets' AS targets
  FROM authz_resource
 WHERE resource_id IN (
   'db_schema:tiptop_oracle.ps55',
   'view:ps55.__view_name__',
   'function:ps55.__fn_name__'
 )
 ORDER BY resource_id;
