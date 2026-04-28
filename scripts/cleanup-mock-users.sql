-- ============================================================
-- Cleanup mock users / groups / role-grants / policies
-- ============================================================
-- Source: Adam 2026-04-28 — "B + 一個權限被限定住的測試腳色"
--         AskUserQuestion follow-up answer C) "保 tsai_bi + 完全刪 bi_column_masks policy"
--
-- Keep (3 users + 1 service account + 4 groups + 1 SYSADMIN role):
--   - user:adam_ou       (你, SYSADMIN role)
--   - user:sys_admin     (DBA_TEAM + AUTHZ_ADMINS member)
--   - user:tsai_bi       (BI_USER role, BI_TEAM member — 限定 BI 測試帳號)
--   - svc:etl_pipeline   (Path C 服務帳號 demo)
--   - group:AUTHZ_ADMINS (sys_admin member)
--   - group:BI_TEAM      (tsai_bi member)
--   - group:DBA_TEAM     (sys_admin member)
--   - group:SYSADMINS    (governance placeholder, empty 但保留)
--
-- Delete:
--   - 16 mock users (Wang/Chen/Su/Lin/Kuo/Huang/Lee/Zhang/Smith/Wu/Zhou/Liu/
--                    Tseng/Hsu/Yang/Chang)
--   - 16 mock LDAP groups (PE_*/PM_*/QA_ALL/SALES_*/FAE_*/RD_*/OP_SSD/FW=
--                          covered by RD_FW/FINANCE_TEAM/VP_OFFICE)
--   - 17 mock policies (12 L1 region/data-scope + 5 L2 column_masks)
--   - role_permission grants for unused roles (PE/PM/OP/QA/SALES/FAE/RD/FW/
--     FINANCE/VP — kept for the role table itself in case Adam reuses, but
--     no permissions remain pointing to deleted modules)
-- ============================================================

BEGIN;

-- 1. Build delete sets
CREATE TEMP TABLE _keep_subjects AS
VALUES ('user:adam_ou'), ('user:sys_admin'), ('user:tsai_bi'),
       ('svc:etl_pipeline'),
       ('group:AUTHZ_ADMINS'), ('group:BI_TEAM'),
       ('group:DBA_TEAM'), ('group:SYSADMINS');

CREATE TEMP TABLE _delete_subjects AS
SELECT subject_id FROM authz_subject
 WHERE subject_id NOT IN (SELECT column1 FROM _keep_subjects);

-- 2. Sanity: should be exactly 32 deletes (16 users + 16 groups)
DO $$
DECLARE
  n_total int; n_users int; n_groups int;
BEGIN
  SELECT count(*) INTO n_total FROM _delete_subjects;
  SELECT count(*) INTO n_users FROM _delete_subjects ds
   JOIN authz_subject s ON s.subject_id=ds.subject_id WHERE s.subject_type='user';
  SELECT count(*) INTO n_groups FROM _delete_subjects ds
   JOIN authz_subject s ON s.subject_id=ds.subject_id WHERE s.subject_type='ldap_group';
  IF n_total <> 32 OR n_users <> 16 OR n_groups <> 16 THEN
    RAISE EXCEPTION 'cleanup aborted: expected 32 deletes (16u+16g), got % (% u, % g)',
                    n_total, n_users, n_groups;
  END IF;
END $$;

-- 3. FK guard: confirm no kept-resource depends on a deleted subject
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM authz_data_source
   WHERE owner_subject IN (SELECT subject_id FROM _delete_subjects);
  IF n > 0 THEN RAISE EXCEPTION 'aborted: % data_source(s) owned by to-delete subject', n; END IF;

  SELECT count(*) INTO n FROM authz_ai_provider
   WHERE owner_subject IN (SELECT subject_id FROM _delete_subjects);
  IF n > 0 THEN RAISE EXCEPTION 'aborted: % ai_provider(s) owned by to-delete subject', n; END IF;

  SELECT count(*) INTO n FROM authz_resource
   WHERE owner_subject_id IN (SELECT subject_id FROM _delete_subjects)
      OR blessed_by IN (SELECT subject_id FROM _delete_subjects);
  IF n > 0 THEN RAISE EXCEPTION 'aborted: % resource(s) owned/blessed by to-delete subject', n; END IF;
END $$;

-- 4. Delete dependent rows referencing subjects (in FK-safe order)
DELETE FROM authz_subject_role
 WHERE subject_id IN (SELECT subject_id FROM _delete_subjects);

DELETE FROM authz_group_member
 WHERE group_id IN (SELECT subject_id FROM _delete_subjects)
    OR user_id IN (SELECT subject_id FROM _delete_subjects);

DELETE FROM authz_db_pool_assignment
 WHERE subject_id IN (SELECT subject_id FROM _delete_subjects);

-- 5. Delete subject rows themselves
DELETE FROM authz_subject
 WHERE subject_id IN (SELECT subject_id FROM _delete_subjects);

-- 6. Delete mock policies (L1 region/data-scope + L2 column_masks)
DELETE FROM authz_policy WHERE policy_name IN (
  'fae_cn_region', 'fae_tw_region',
  'fw_ssd_data_scope', 'op_ssd_data_scope',
  'pe_emmc_data_scope', 'pe_sd_data_scope', 'pe_ssd_data_scope',
  'pm_emmc_data_scope', 'pm_ssd_data_scope',
  'sales_cn_region', 'sales_tw_region', 'sales_us_region',
  'bi_column_masks', 'fae_column_masks', 'op_column_masks',
  'pe_column_masks', 'qa_column_masks'
);

-- 7. Delete role_permission grants for unused roles (roles themselves kept
--    in authz_role for future re-population)
DELETE FROM authz_role_permission
 WHERE role_id IN ('PE','PM','OP','QA','SALES','FAE','RD','FW','FINANCE','VP');

-- 8. Audit row (constitution §9.7 AI identity columns)
INSERT INTO authz_audit_log (
    access_path, subject_id, action_id, resource_id, decision,
    context, actor_type, agent_id, model_id, consent_given, timestamp
) VALUES (
    'B', 'user:adam_ou', 'cleanup_mock_users', 'authz_subject', 'allow',
    jsonb_build_object(
        'method', 'sql_direct',
        'users_deleted', 16,
        'groups_deleted', 16,
        'policies_deleted', 17,
        'role_perm_grants_deleted_role_ids', ARRAY['PE','PM','OP','QA','SALES','FAE','RD','FW','FINANCE','VP'],
        'kept', jsonb_build_object(
            'users', ARRAY['user:adam_ou','user:sys_admin','user:tsai_bi'],
            'service_accounts', ARRAY['svc:etl_pipeline'],
            'groups', ARRAY['group:AUTHZ_ADMINS','group:BI_TEAM','group:DBA_TEAM','group:SYSADMINS']
        ),
        'consent', 'AskUserQuestion answer B + follow-up C 2026-04-28',
        'seed_file_actions', 'dev-seed.sql users/groups pruned; ldap LDIF pruned'
    ),
    'ai_agent', 'claude-investigator-v1', 'claude-opus-4-7', TRUE, now()
);

COMMIT;

-- 9. Verify post-state
SELECT 'subjects_total' AS k, count(*)::text AS v FROM authz_subject
UNION ALL SELECT 'users_remaining', count(*)::text
  FROM authz_subject WHERE subject_type='user'
UNION ALL SELECT 'service_accounts_remaining', count(*)::text
  FROM authz_subject WHERE subject_type='service_account'
UNION ALL SELECT 'groups_remaining', count(*)::text
  FROM authz_subject WHERE subject_type='ldap_group'
UNION ALL SELECT 'subject_role_rows', count(*)::text FROM authz_subject_role
UNION ALL SELECT 'group_member_rows', count(*)::text FROM authz_group_member
UNION ALL SELECT 'pool_assignments', count(*)::text FROM authz_db_pool_assignment
UNION ALL SELECT 'active_policies', count(*)::text FROM authz_policy WHERE status='active'
UNION ALL SELECT 'role_permissions', count(*)::text FROM authz_role_permission
UNION ALL SELECT 'orphan_subject_role', count(*)::text
  FROM authz_subject_role sr LEFT JOIN authz_subject s ON s.subject_id=sr.subject_id
  WHERE s.subject_id IS NULL;
