-- ============================================================
-- V088: cleanup _test_* DAG residue (Permission Slimming · 路 1)
--
-- ── Problem ──
--   Five rows in authz_role_permission grant BI_USER / DATA_STEWARD read
--   on four published_dag:dag:_test_* resources. They are V086 DAG_PUBLISH
--   smoke-test artifacts (created 2026-04-30) — the names carry _test_
--   prefix, no cascade dependents, no audit hits in 48h. They inflate
--   role_permission table noise without representing any real grant.
--
-- ── Scope ──
--   1. DELETE 5 role_permission rows targeting _test_* DAGs.
--   2. DELETE 4 ui_page rows that mirror them (V086 publish auto-creates a
--      ui_page entry per published_dag — drop together to satisfy FK).
--   3. DELETE 4 _test_* DAG entries from authz_resource.
--   4. Admin audit row records the cleanup as system action.
--
-- ── Out of scope (deliberately) ──
--   The other duplication patterns spotted during permission audit
--   (ai_provider:* use across 3 roles, web_api:resolve read across 3
--   roles, NPI gate signers PE/QA/VP × {read,approve}) are real business
--   logic. They will be collapsed by 路 2 (role pack template), not by
--   this cleanup migration. 路 1 = remove garbage, 路 2 = condense pattern.
--
-- ── Reversal ──
--   Pre-state captured in admin audit details JSONB. To restore: re-run
--   V086 dag_publish smoke tests and they will recreate via the normal
--   publish flow.
-- ============================================================

BEGIN;

-- Sanity gate: refuse to run if the world doesn't match expectations.
-- Using an anonymous DO block so a mismatch raises (and rolls back).
DO $$
DECLARE
  rp_count   int;
  res_count  int;
  page_count int;
BEGIN
  SELECT COUNT(*) INTO rp_count
    FROM authz_role_permission
   WHERE resource_id LIKE 'published_dag:dag:_test_%';
  SELECT COUNT(*) INTO res_count
    FROM authz_resource
   WHERE resource_id LIKE 'published_dag:dag:_test_%';
  SELECT COUNT(*) INTO page_count
    FROM authz_ui_page
   WHERE resource_id LIKE 'published_dag:dag:_test_%';
  IF rp_count <> 5 OR res_count <> 4 OR page_count <> 4 THEN
    RAISE EXCEPTION
      'V088 abort: expected 5 rp + 4 res + 4 ui_page, found %, %, %',
      rp_count, res_count, page_count;
  END IF;
END$$;

-- 1. Capture what we're about to delete (for the audit details).
CREATE TEMP TABLE _v088_deleted_rp ON COMMIT DROP AS
  SELECT role_id, resource_id, action_id
    FROM authz_role_permission
   WHERE resource_id LIKE 'published_dag:dag:_test_%';

CREATE TEMP TABLE _v088_deleted_res ON COMMIT DROP AS
  SELECT resource_id, resource_type, parent_id
    FROM authz_resource
   WHERE resource_id LIKE 'published_dag:dag:_test_%';

CREATE TEMP TABLE _v088_deleted_pages ON COMMIT DROP AS
  SELECT page_id, resource_id, published_dag_id
    FROM authz_ui_page
   WHERE resource_id LIKE 'published_dag:dag:_test_%';

-- 2. Delete role_permission first (FK direction: rp → resource).
DELETE FROM authz_role_permission
 WHERE resource_id LIKE 'published_dag:dag:_test_%';

-- 3. Delete ui_page (also FKs to authz_resource via resource_id +
--    published_dag_id; both columns satisfied by the same condition).
DELETE FROM authz_ui_page
 WHERE resource_id LIKE 'published_dag:dag:_test_%';

-- 4. Delete resource rows.
DELETE FROM authz_resource
 WHERE resource_id LIKE 'published_dag:dag:_test_%';

-- 4. Audit trail — V049 §9.7 actor_type='system' / consent_given='human_explicit'
--    (the human running the migration is the consenting actor).
INSERT INTO authz_admin_audit_log (
  user_id, action, resource_type, resource_id, details,
  actor_type, consent_given
)
SELECT
  'system:migration',
  'CLEANUP_TEST_DAG_RESIDUE',
  'role_permission',
  'V088',
  jsonb_build_object(
    'migration', 'V088',
    'reason', 'V086 dag_publish smoke-test residue',
    'role_permissions_deleted', (SELECT COUNT(*) FROM _v088_deleted_rp),
    'resources_deleted',        (SELECT COUNT(*) FROM _v088_deleted_res),
    'ui_pages_deleted',         (SELECT COUNT(*) FROM _v088_deleted_pages),
    'role_permissions_pre',     (SELECT jsonb_agg(row_to_json(t)) FROM _v088_deleted_rp t),
    'resources_pre',            (SELECT jsonb_agg(row_to_json(t)) FROM _v088_deleted_res t),
    'ui_pages_pre',             (SELECT jsonb_agg(row_to_json(t)) FROM _v088_deleted_pages t)
  ),
  'system',
  'human_explicit';

COMMIT;
