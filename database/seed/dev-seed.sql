-- ============================================================
-- Phison Electronics — Development Seed Data
-- Realistic test personas, resources, permissions, and ABAC policies
-- ============================================================

-- ============================================================
-- 1. LDAP Groups (minimal — Adam pruned 2026-04-28 to keep just the 4
--    governance-relevant groups; 16 mock product/region groups removed)
-- ============================================================
INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn, attributes) VALUES
    ('group:AUTHZ_ADMINS','ldap_group', 'AuthZ Administrators',     'cn=AUTHZ_ADMINS,ou=groups,dc=phison,dc=com', '{"dept": "IT"}'),
    ('group:BI_TEAM',     'ldap_group', 'BI / Data Analytics Team', 'cn=BI_TEAM,ou=groups,dc=phison,dc=com',      '{"dept": "BI"}'),
    ('group:DBA_TEAM',    'ldap_group', 'DBA Team',                 'cn=DBA_TEAM,ou=groups,dc=phison,dc=com',     '{"dept": "IT"}'),
    ('group:SYSADMINS',   'ldap_group', '系統管理員群組 (SYSADMIN god-mode holders)', 'cn=SYSADMINS,ou=groups,dc=phison,dc=com', '{"dept": "IT"}');

-- ============================================================
-- 2. Test Users (minimal — Adam pruned 2026-04-28 to 3 users + 1 service
--    account; 16 mock employees removed)
-- ============================================================
INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn, attributes) VALUES
    ('user:adam_ou',      'user', 'Adam Ou (Tech Lead, Phison Data Nexus)', '', '{"role_hint": "tech_lead"}'),
    ('user:sys_admin',    'user', 'SysAdmin',          'uid=sys_admin,ou=people,dc=phison,dc=com',    '{"employee_id": "P2024099"}'),
    ('user:tsai_bi',      'user', 'Tsai (BI Analyst)', 'uid=tsai_bi,ou=people,dc=phison,dc=com',      '{"employee_id": "P2024070", "demo_purpose": "restricted BI test role"}'),
    ('svc:etl_pipeline',  'service_account', 'ETL Pipeline', 'uid=etl_pipeline,ou=people,dc=phison,dc=com', '{"service": "data-pipeline"}');

-- ============================================================
-- 3. Role Assignments (minimal — only the 4 kept subjects)
-- ============================================================
INSERT INTO authz_subject_role (subject_id, role_id, granted_by) VALUES
    ('user:adam_ou',      'SYSADMIN',    'manual'),
    ('user:sys_admin',    'ADMIN',       'ldap_sync'),
    ('user:sys_admin',    'AUTHZ_ADMIN', 'ldap_sync'),
    ('user:tsai_bi',      'BI_USER',     'ldap_sync'),
    ('svc:etl_pipeline',  'ETL_SVC',     'system'),
    ('group:AUTHZ_ADMINS','AUTHZ_ADMIN', 'ldap_sync'),
    ('group:BI_TEAM',     'BI_USER',     'ldap_sync'),
    ('group:DBA_TEAM',    'DBA',         'ldap_sync'),
    ('group:SYSADMINS',   'SYSADMIN',    'ldap_sync');

-- ============================================================
-- 4. Resources — web pages only (Path B)
-- ============================================================
-- Mock module hierarchy (mrp/quality/sales/engineering/analytics + their
-- tables/columns) was removed 2026-04-27 per Adam — bottom-up direction now
-- starts from real user-onboarded data sources (e.g. ds:pg_k8). Module rows
-- are created via dashboard "Create Module" + Discover-driven mapping.
-- The deleted module/table/column inserts live in git history (see
-- commit a5782c0 and earlier dev-seed.sql revisions).
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name) VALUES
    ('web_page:home',                   'web_page', NULL,                        'Homepage'),
    ('web_page:admin_dashboard',        'web_page', NULL,                        'Admin Dashboard'),
    ('web_page:authz_admin',            'web_page', NULL,                        'AuthZ Admin Panel');

-- Set homepage as public
UPDATE authz_resource SET attributes = '{"auth_required": false}' WHERE resource_id = 'web_page:home';

-- ============================================================
-- 5. L0 Permissions — admin web pages only
-- ============================================================
-- Mock-module grants (PE/PM/OP/QA/SALES/FAE/RD/FW/FINANCE/VP/BI_USER/ETL_SVC
-- on module:mrp/quality/sales/engineering/analytics/* and their column
-- masks/denies) were removed 2026-04-27. Real permissions now come from
-- dashboard module mapping after Discover scan on real data sources.
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    -- ═══ ADMIN: web_page admin dashboard ═══
    ('ADMIN', 'read',  'web_page:admin_dashboard',      'allow'),
    ('ADMIN', 'write', 'web_page:admin_dashboard',      'allow'),
    -- ═══ AUTHZ_ADMIN: AuthZ admin panel ═══
    ('AUTHZ_ADMIN', 'read',  'web_page:authz_admin',    'allow'),
    ('AUTHZ_ADMIN', 'write', 'web_page:authz_admin',    'allow');

-- ============================================================
-- 6. Web API resources + role grants (Path B)
-- ============================================================
-- 17 mock policies (L1 product/region scopes + L2 column_masks) and 3
-- composite_actions (lot_hold/release/npi_gate) were removed 2026-04-28
-- per Adam — they targeted mock modules already deleted on 2026-04-27.
-- Real policies now come from dashboard policy editor on real resources.
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name) VALUES
    ('web_api:resolve',         'web_api', 'web_page:home',           'Resolve API'),
    ('web_api:check',           'web_api', 'web_page:home',           'Check API'),
    ('web_api:filter',          'web_api', 'web_page:home',           'Filter API'),
    ('web_api:matrix',          'web_api', 'web_page:admin_dashboard','Permission Matrix API'),
    ('web_api:pool_manage',     'web_api', 'web_page:admin_dashboard','Pool Management API'),
    ('web_api:audit_log',       'web_api', 'web_page:admin_dashboard','Audit Log API');

-- API permissions (only for kept roles: ADMIN / AUTHZ_ADMIN / BI_USER)
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    -- All authenticated kept roles can call resolve
    ('BI_USER',     'read', 'web_api:resolve', 'allow'),
    ('ADMIN',       'read', 'web_api:resolve', 'allow'),
    ('AUTHZ_ADMIN', 'read', 'web_api:resolve', 'allow'),
    -- Admin-only APIs
    ('ADMIN',       'read',  'web_api:matrix',      'allow'),
    ('ADMIN',       'write', 'web_api:matrix',      'allow'),
    ('ADMIN',       'read',  'web_api:pool_manage',  'allow'),
    ('ADMIN',       'write', 'web_api:pool_manage',  'allow'),
    ('ADMIN',       'read',  'web_api:audit_log',    'allow'),
    ('AUTHZ_ADMIN', 'read',  'web_api:matrix',      'allow'),
    ('AUTHZ_ADMIN', 'write', 'web_api:matrix',      'allow'),
    ('AUTHZ_ADMIN', 'read',  'web_api:pool_manage',  'allow'),
    ('AUTHZ_ADMIN', 'write', 'web_api:pool_manage',  'allow'),
    ('AUTHZ_ADMIN', 'read',  'web_api:audit_log',    'allow');

-- ============================================================
-- 7. Group Membership (user ↔ group, synced from LDAP)
--    Pruned 2026-04-28 to match minimal subject set.
-- ============================================================
INSERT INTO authz_group_member (group_id, user_id, source) VALUES
    ('group:BI_TEAM',       'user:tsai_bi',       'ldap_sync'),
    ('group:DBA_TEAM',      'user:sys_admin',     'ldap_sync'),
    ('group:AUTHZ_ADMINS',  'user:sys_admin',     'ldap_sync');

-- ============================================================
-- Sections removed 2026-04-28 (徹底 prune per Adam):
--   - Path C pool profiles / assignments / credentials
--     (Adam manages pg_k8_read+ via dashboard pointing at real ds:pg_k8)
--   - ds:local data source registration
--     (real data sources onboarded via dashboard / discovery)
-- See git history for the pre-prune version.
-- ============================================================
