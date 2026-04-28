-- ============================================================
-- V077: NPI dogfood personas (Adam-multi-role)
--
-- The V076 vertical introduced the npi_advance_* composite_actions
-- but no real subject in this dev DB has the PE / QA / VP roles
-- bound. Without those, the workflow chain can't be exercised
-- end-to-end — the role-step check refuses to record a decision.
--
-- These four personas exist purely so the same human (Adam) can
-- file → approve → approve → approve a single request by switching
-- the X-User-Id header. Every approval_record row for these
-- subjects gets dogfood_self_chained=TRUE so production audit
-- reports can filter the loop out.
--
--   user:adam_npi_pm   — files the request
--   user:adam_npi_pe   — chain step 0 (PE)
--   user:adam_npi_qa   — chain step 1 (QA)
--   user:adam_npi_vp   — chain step 2 (VP)
--
-- These are NOT real Phison directory entries; LDAP sync will
-- never produce them, so they coexist safely with the upstream
-- identity feed.
-- ============================================================

BEGIN;

INSERT INTO authz_subject (subject_id, subject_type, display_name, attributes)
VALUES
    ('user:adam_npi_pm', 'user', 'Adam (dogfood: PM/requester)',
     jsonb_build_object('dogfood', TRUE, 'real_user', 'adam_ou', 'persona', 'PM')),
    ('user:adam_npi_pe', 'user', 'Adam (dogfood: PE step 0)',
     jsonb_build_object('dogfood', TRUE, 'real_user', 'adam_ou', 'persona', 'PE')),
    ('user:adam_npi_qa', 'user', 'Adam (dogfood: QA step 1)',
     jsonb_build_object('dogfood', TRUE, 'real_user', 'adam_ou', 'persona', 'QA')),
    ('user:adam_npi_vp', 'user', 'Adam (dogfood: VP step 2)',
     jsonb_build_object('dogfood', TRUE, 'real_user', 'adam_ou', 'persona', 'VP'))
ON CONFLICT (subject_id) DO UPDATE
   SET display_name = EXCLUDED.display_name,
       attributes   = EXCLUDED.attributes;

INSERT INTO authz_subject_role (subject_id, role_id, granted_by, is_active)
VALUES
    ('user:adam_npi_pe', 'PE', 'V077:dogfood_seed', TRUE),
    ('user:adam_npi_qa', 'QA', 'V077:dogfood_seed', TRUE),
    ('user:adam_npi_vp', 'VP', 'V077:dogfood_seed', TRUE)
ON CONFLICT (subject_id, role_id) DO UPDATE
   SET is_active   = TRUE,
       valid_until = NULL;

COMMIT;
