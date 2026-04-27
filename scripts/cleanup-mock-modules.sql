-- ============================================================
-- Cleanup mock modules from dev-seed.sql + pg_k8cluster-scenario.sql
--                       + ui-config-seed.sql + composite_action seed
-- ============================================================
-- Source: Adam 2026-04-27 — "modules 有 mock 資料, 請幫我清除"
--         AskUserQuestion #1 answer A) "DB 刪 + 改 seed 檔移 mock 出去"
--         AskUserQuestion #2 answer A) "一起刪 + ui-config-seed.sql 也移 _demo/"
--         (FK from authz_ui_page + authz_composite_action forced scope expansion)
--
-- Scope:
--   - 25 modules + 5 child tables (resource_type='module|table' subtree pre-16:00)
--   - 79 role_permission grants tied to those resources
--   -  8 ui_page rows bound to mock modules (lot_explorer / lot_detail /
--      test_results / sales_orders / npi_checklist / quality_reports /
--      rma_records / price_book)
--   -  1 composite_action (npi_gate_approval → table:npi_gate_checklist)
--   Total: 118 rows
--
-- Untouched:
--   - module:pg_tiptop_v1 (Adam's real module created at 16:17)
--   - 12 tables (azf_file/cimzr*/csfzr*/etc) bulk-mapped under it via
--     dashboard CREATE_RESOURCE + BULK_MAP_RESOURCES
--   - 5 system ui_pages without resource_id (actions_home / audit_home /
--     modules_home / roles_home / subjects_home)
-- ============================================================

BEGIN;

-- 1. Identify the cleanup set (recursive subtree of pre-16:00 mock modules)
CREATE TEMP TABLE _mock_set AS
WITH RECURSIVE subtree AS (
  SELECT resource_id FROM authz_resource
   WHERE resource_type='module' AND created_at < '2026-04-27 16:00:00+00'
  UNION
  SELECT r.resource_id FROM authz_resource r
   JOIN subtree st ON r.parent_id = st.resource_id
)
SELECT resource_id FROM subtree;

-- 2. Sanity check: should be exactly 30 (25 modules + 5 child tables)
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _mock_set;
  IF n <> 30 THEN
    RAISE EXCEPTION 'cleanup aborted: expected 30 mock subtree rows, got %', n;
  END IF;
END $$;

-- 3. Sanity check FK dependents (must match expected before delete)
DO $$
DECLARE
  n_grants int; n_pages int; n_comp int;
BEGIN
  SELECT count(*) INTO n_grants FROM authz_role_permission
   WHERE resource_id IN (SELECT resource_id FROM _mock_set);
  SELECT count(*) INTO n_pages FROM authz_ui_page
   WHERE resource_id IN (SELECT resource_id FROM _mock_set);
  SELECT count(*) INTO n_comp FROM authz_composite_action
   WHERE target_resource IN (SELECT resource_id FROM _mock_set);
  IF n_grants <> 79 OR n_pages <> 8 OR n_comp <> 1 THEN
    RAISE EXCEPTION 'cleanup aborted: expected 79/8/1 grants/pages/comp, got %/%/%',
                    n_grants, n_pages, n_comp;
  END IF;
END $$;

-- 4. Delete role_permission grants tied to mock resources
DELETE FROM authz_role_permission
 WHERE resource_id IN (SELECT resource_id FROM _mock_set);

-- 5. Delete ui_page rows bound to mock modules (FK to authz_resource)
DELETE FROM authz_ui_page
 WHERE resource_id IN (SELECT resource_id FROM _mock_set);

-- 6. Delete composite_action rows targeting mock resources
DELETE FROM authz_composite_action
 WHERE target_resource IN (SELECT resource_id FROM _mock_set);

-- 7. Delete the resources themselves (children removed first by recursion order
--    in the temp table; PG will cascade self-FK on parent_id correctly because
--    we only have 2 levels and tables come last in the subtree order naturally;
--    if a NOT-VALID self-FK error appears, switch to two passes).
DELETE FROM authz_resource
 WHERE resource_id IN (SELECT resource_id FROM _mock_set);

-- 8. Audit row (constitution §9.7 AI identity columns)
INSERT INTO authz_audit_log (
    access_path, subject_id, action_id, resource_id, decision,
    context, actor_type, agent_id, model_id, consent_given, timestamp
) VALUES (
    'B', 'user:adam_ou', 'cleanup_mock_modules', 'authz_resource', 'allow',
    jsonb_build_object(
        'method', 'sql_direct',
        'modules_deleted', 25,
        'tables_deleted', 5,
        'grants_deleted', 79,
        'ui_pages_deleted', 8,
        'composite_actions_deleted', 1,
        'preserved', 'module:pg_tiptop_v1 + 12 user-mapped tables + 5 system ui_pages',
        'consent', 'AskUserQuestion answers A+A 2026-04-27',
        'seed_file_actions', 'dev-seed.sql edited inline; pg_k8cluster-scenario.sql + ui-config-seed.sql moved to _demo/'
    ),
    'ai_agent', 'claude-investigator-v1', 'claude-opus-4-7', TRUE, now()
);

COMMIT;

-- 9. Verify post-cleanup
SELECT 'modules_remaining' AS k, count(*)::text AS v
  FROM authz_resource WHERE resource_type='module'
UNION ALL SELECT 'mock_modules_remaining', count(*)::text
  FROM authz_resource WHERE resource_type='module' AND created_at < '2026-04-27 16:00:00+00'
UNION ALL SELECT 'pg_tiptop_v1_intact', count(*)::text
  FROM authz_resource WHERE resource_id='module:pg_tiptop_v1'
UNION ALL SELECT 'pg_tiptop_v1_children', count(*)::text
  FROM authz_resource WHERE parent_id='module:pg_tiptop_v1'
UNION ALL SELECT 'ui_pages_remaining', count(*)::text
  FROM authz_ui_page
UNION ALL SELECT 'composite_actions_remaining', count(*)::text
  FROM authz_composite_action
UNION ALL SELECT 'orphan_grants_check', count(*)::text
  FROM authz_role_permission rp LEFT JOIN authz_resource ar ON ar.resource_id=rp.resource_id
  WHERE ar.resource_id IS NULL;
