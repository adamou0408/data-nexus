-- V028: Phase 5 Seed Data — Policy Assignments, Role Clearance, Column Classifications
-- Provides test data for EdgePolicy dual-source evaluator, clearance system, and classification features.

-- ============================================================
-- 1. Policy Assignments (EdgePolicy-style)
-- ============================================================
-- Covers all 6 assignment types + 1 exception case

INSERT INTO authz_policy_assignment (policy_id, assignment_type, assignment_value, is_exception)
VALUES
  -- pe_ssd_data_scope → only PE role
  ((SELECT policy_id FROM authz_policy WHERE policy_name = 'pe_ssd_data_scope'), 'role', 'PE', FALSE),
  -- pe_ssd_data_scope → department = PE
  ((SELECT policy_id FROM authz_policy WHERE policy_name = 'pe_ssd_data_scope'), 'department', 'PE', FALSE),
  -- pe_column_masks → job_level_below 8 (below VP level gets masked)
  ((SELECT policy_id FROM authz_policy WHERE policy_name = 'pe_column_masks'), 'job_level_below', '8', FALSE),
  -- pe_column_masks → VP is exempt from masking
  ((SELECT policy_id FROM authz_policy WHERE policy_name = 'pe_column_masks'), 'role', 'VP', TRUE),
  -- sales_tw_region → SALES_TW group
  ((SELECT policy_id FROM authz_policy WHERE policy_name = 'sales_tw_region'), 'group', 'SALES_TW', FALSE),
  -- pe_column_masks → specific user exemption
  ((SELECT policy_id FROM authz_policy WHERE policy_name = 'pe_column_masks'), 'user', 'user:chang_vp', TRUE);

-- ============================================================
-- 2. Role Clearance Values
-- ============================================================
-- Sets security_clearance and job_level for each role

UPDATE authz_role SET security_clearance = 'RESTRICTED',   job_level = 10 WHERE role_id = 'ADMIN';
UPDATE authz_role SET security_clearance = 'RESTRICTED',   job_level = 9  WHERE role_id = 'AUTHZ_ADMIN';
UPDATE authz_role SET security_clearance = 'CONFIDENTIAL', job_level = 8  WHERE role_id = 'VP';
UPDATE authz_role SET security_clearance = 'CONFIDENTIAL', job_level = 7  WHERE role_id = 'FINANCE';
UPDATE authz_role SET security_clearance = 'INTERNAL',     job_level = 5  WHERE role_id IN ('PE', 'PM', 'OP');
UPDATE authz_role SET security_clearance = 'INTERNAL',     job_level = 4  WHERE role_id IN ('QA', 'RD', 'FW');
UPDATE authz_role SET security_clearance = 'PUBLIC',       job_level = 3  WHERE role_id IN ('SALES', 'FAE');
UPDATE authz_role SET security_clearance = 'PUBLIC',       job_level = 2  WHERE role_id IN ('BI_USER', 'ETL_SVC');
UPDATE authz_role SET security_clearance = 'RESTRICTED',   job_level = 9  WHERE role_id = 'DBA';
UPDATE authz_role SET security_clearance = 'INTERNAL',     job_level = 6  WHERE role_id = 'AUTHZ_AUDITOR';

-- ============================================================
-- 3. Column Classifications
-- ============================================================
-- Classifies sensitive columns via attributes JSONB
-- classification_id references authz_data_classification (seeded in V027):
--   1 = PUBLIC, 2 = INTERNAL, 3 = CONFIDENTIAL, 4 = RESTRICTED

-- Financial columns → RESTRICTED (level 4)
UPDATE authz_resource
SET attributes = attributes || '{"classification_id": "4"}'::jsonb
WHERE resource_id IN ('column:lot_status.cost', 'column:price_book.margin')
  AND is_active = TRUE;

-- Price columns → CONFIDENTIAL (level 3)
UPDATE authz_resource
SET attributes = attributes || '{"classification_id": "3"}'::jsonb
WHERE resource_id = 'column:lot_status.unit_price'
  AND is_active = TRUE;

-- Customer info → INTERNAL (level 2)
UPDATE authz_resource
SET attributes = attributes || '{"classification_id": "2"}'::jsonb
WHERE resource_id = 'column:lot_status.customer'
  AND is_active = TRUE;
