-- ============================================================
-- V083: 5-role consolidation (SYSADMIN / AUTHZ_ADMIN / DATA_STEWARD / BI_USER / ETL_SVC)
-- Design SSOT: docs/role-permission-matrix.md
--
-- Diff vs. V013 baseline:
--   • Add DATA_STEWARD (Ingest + Catalog + curator-side Govern: BizTerms, AIProviders, FeedbackInbox)
--   • Drop ADMIN  → split into AUTHZ_ADMIN (governance) + DATA_STEWARD (data ops)
--   • Drop DBA    → was dead role (group binding existed, no permission rows)
--   • Move ai_provider:* configure from AUTHZ_ADMIN → DATA_STEWARD (curator concern)
--   • Add ai_provider:* use to DATA_STEWARD + BI_USER (configure stays steward-only)
--   • SYSADMIN god-mode (V066/V067) untouched
--
-- Scope: this migration only touches authz_role / authz_subject_role /
-- authz_role_permission rows that reference resources created by other
-- migrations (i.e., ai_provider:*). Dev-resource grants (web_page:*,
-- web_api:*) live in database/seed/dev-seed.sql and are updated separately.
--
-- (subject_id, role_id) UNIQUE collision: dev-seed's user:sys_admin had
-- BOTH ADMIN and AUTHZ_ADMIN rows. The DELETE-then-UPDATE pattern below
-- resolves that idempotently. Same logic applies to any future subject
-- carrying both roles.
-- ============================================================

BEGIN;

-- ── 1. Insert DATA_STEWARD role ──
INSERT INTO authz_role (role_id, display_name, description, is_system)
VALUES ('DATA_STEWARD', '資料管家', 'Data steward — owns Ingest + Catalog + curator surfaces (Business Terms, AI Providers, Feedback Inbox)', TRUE)
ON CONFLICT (role_id) DO NOTHING;

-- ── 2. Migrate subject_role assignments ──
-- 2a. Subjects already holding AUTHZ_ADMIN: just delete their redundant ADMIN row
DELETE FROM authz_subject_role sr
 WHERE sr.role_id = 'ADMIN'
   AND EXISTS (SELECT 1 FROM authz_subject_role x
                WHERE x.subject_id = sr.subject_id
                  AND x.role_id    = 'AUTHZ_ADMIN');

-- 2b. Remaining ADMIN-only subjects: rename to AUTHZ_ADMIN
UPDATE authz_subject_role SET role_id = 'AUTHZ_ADMIN' WHERE role_id = 'ADMIN';

-- 2c. Drop DBA assignments (group:DBA_TEAM keeps its subject row, just no role binding)
DELETE FROM authz_subject_role WHERE role_id = 'DBA';

-- ── 3. Drop legacy permission rows (ADMIN/DBA) ──
DELETE FROM authz_role_permission WHERE role_id IN ('ADMIN', 'DBA');

-- ── 4. AI Provider grants — move configure to steward, broaden use ──
-- V052 originally granted ai_provider:* configure+use to AUTHZ_ADMIN. Per
-- the V083 matrix the curator owns AI provider config; AUTHZ_ADMIN keeps
-- only 'use' (everyone authenticated can invoke AI tools).
DELETE FROM authz_role_permission
 WHERE role_id = 'AUTHZ_ADMIN'
   AND resource_id = 'ai_provider:*';

INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    ('DATA_STEWARD', 'configure', 'ai_provider:*', 'allow'),
    ('DATA_STEWARD', 'use',       'ai_provider:*', 'allow'),
    ('AUTHZ_ADMIN',  'use',       'ai_provider:*', 'allow'),
    ('BI_USER',      'use',       'ai_provider:*', 'allow')
ON CONFLICT (role_id, action_id, resource_id) DO NOTHING;

-- ── 5. Drop the now-unreferenced legacy roles ──
DELETE FROM authz_role WHERE role_id IN ('ADMIN', 'DBA');

COMMIT;
