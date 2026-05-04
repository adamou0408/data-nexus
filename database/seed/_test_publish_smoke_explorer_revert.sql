-- ============================================================
-- EXPLORER-MODE-V01 smoke teardown — revert
-- `_test_publish_smoke_explorer.sql`.
--
-- Two sections, mirror image of the seed:
--   §1  Run against `ds:pg_k8`     — drops the toy fn_aging_by_order.
--   §2  Run against `nexus_authz`  — soft-deactivates the DAG row,
--                                    the function resource, and any
--                                    page mirror + grant left over from
--                                    a prior /publish run.
--
-- Why soft-deactivate (is_active=FALSE) instead of DELETE on
-- `authz_resource`: per docs/constitution.md Article 8, agent test
-- rows are removable, but the cascade FK from authz_ui_page +
-- authz_role_permission may still reference these RIDs. Soft delete
-- keeps the audit trail intact and avoids surprise FK breaks.
--
-- Re-runnable. Safe to call even when the seed never ran.
-- ============================================================


-- ════════════════════════════════════════════════════════════════
-- §1.  Run against `ds:pg_k8`.
-- ════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS tiptop.fn_aging_by_order(text);


-- ════════════════════════════════════════════════════════════════
-- §2.  Run against `nexus_authz`.
-- ════════════════════════════════════════════════════════════════

-- 2a. Soft-delete the DAG resource.
UPDATE authz_resource
   SET is_active = FALSE, updated_at = now()
 WHERE resource_id = 'dag:_test_publish_smoke_explorer';

-- 2b. Soft-delete the toy fn's authz_resource entry.
UPDATE authz_resource
   SET is_active = FALSE, updated_at = now()
 WHERE resource_id = 'function:tiptop.fn_aging_by_order';

-- 2c. Soft-delete leftover published page artifacts (only present if
-- the curator already hit /publish at least once on this DAG). Each
-- statement is independent — missing rows are no-ops.
UPDATE authz_ui_page
   SET is_active = FALSE
 WHERE page_id = 'test_publish_smoke_explorer';

UPDATE authz_resource
   SET is_active = FALSE, updated_at = now()
 WHERE resource_id = 'page:test_publish_smoke_explorer';

UPDATE authz_resource
   SET is_active = FALSE, updated_at = now()
 WHERE resource_id = 'published_dag:dag:_test_publish_smoke_explorer';

-- 2d. Revoke the BI_USER read grant on the bless gate (idempotent).
UPDATE authz_role_permission
   SET is_active = FALSE
 WHERE resource_id = 'published_dag:dag:_test_publish_smoke_explorer';

-- 2e. Verification.
SELECT resource_id, is_active
  FROM authz_resource
 WHERE resource_id IN (
   'dag:_test_publish_smoke_explorer',
   'function:tiptop.fn_aging_by_order',
   'page:test_publish_smoke_explorer',
   'published_dag:dag:_test_publish_smoke_explorer'
 );

SELECT refresh_module_tree_stats();
