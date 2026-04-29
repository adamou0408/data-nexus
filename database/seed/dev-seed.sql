-- ============================================================
-- Phison Electronics — Development Seed Data
-- Realistic test personas, resources, permissions, and ABAC policies
--
-- Aligned to V083 5-role model (see docs/role-permission-matrix.md):
--   SYSADMIN · AUTHZ_ADMIN · DATA_STEWARD · BI_USER · ETL_SVC
-- ============================================================

-- ============================================================
-- 1. LDAP Groups — one per role, mirrors realm-role naming
--    (DBA_TEAM dropped 2026-04-29 with V083; DATA_STEWARDS added.)
-- ============================================================
INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn, attributes) VALUES
    ('group:AUTHZ_ADMINS',  'ldap_group', 'AuthZ Administrators',     'cn=AUTHZ_ADMINS,ou=groups,dc=phison,dc=com',  '{"dept": "IT"}'),
    ('group:DATA_STEWARDS', 'ldap_group', 'Data Stewards',            'cn=DATA_STEWARDS,ou=groups,dc=phison,dc=com', '{"dept": "Data"}'),
    ('group:BI_TEAM',       'ldap_group', 'BI / Data Analytics Team', 'cn=BI_TEAM,ou=groups,dc=phison,dc=com',       '{"dept": "BI"}'),
    ('group:SYSADMINS',     'ldap_group', '系統管理員群組 (SYSADMIN god-mode holders)', 'cn=SYSADMINS,ou=groups,dc=phison,dc=com', '{"dept": "IT"}')
ON CONFLICT (subject_id) DO NOTHING;

-- ============================================================
-- 2. Test Users — 4 personas (one per local role) + 1 service account
--    Mirrors Keycloak realm test users; dev fallback for X-User-Id mode
--    when Keycloak is offline.
-- ============================================================
INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn, attributes) VALUES
    ('user:adam_ou',           'user', 'Adam Ou (Tech Lead, Phison Data Nexus)', '', '{"role_hint": "tech_lead"}'),
    ('user:auth_admin_test',   'user', 'AuthZ Admin (test)',  'uid=auth_admin_test,ou=people,dc=phison,dc=com', '{"demo_purpose": "AUTHZ_ADMIN role validation"}'),
    ('user:steward_test',      'user', 'Data Steward (test)', 'uid=steward_test,ou=people,dc=phison,dc=com',    '{"demo_purpose": "DATA_STEWARD role validation"}'),
    ('user:tsai_bi',           'user', 'Tsai (BI Analyst)',   'uid=tsai_bi,ou=people,dc=phison,dc=com',         '{"employee_id": "P2024070", "demo_purpose": "BI_USER role validation"}'),
    ('svc:etl_pipeline',       'service_account', 'ETL Pipeline', 'uid=etl_pipeline,ou=people,dc=phison,dc=com', '{"service": "data-pipeline"}')
ON CONFLICT (subject_id) DO NOTHING;

-- ============================================================
-- 3. Role Assignments — V083 5-role matrix
-- ============================================================
INSERT INTO authz_subject_role (subject_id, role_id, granted_by) VALUES
    ('user:adam_ou',          'SYSADMIN',     'manual'),
    ('user:auth_admin_test',  'AUTHZ_ADMIN',  'ldap_sync'),
    ('user:steward_test',     'DATA_STEWARD', 'ldap_sync'),
    ('user:tsai_bi',          'BI_USER',      'ldap_sync'),
    ('svc:etl_pipeline',      'ETL_SVC',      'system'),
    ('group:AUTHZ_ADMINS',    'AUTHZ_ADMIN',  'ldap_sync'),
    ('group:DATA_STEWARDS',   'DATA_STEWARD', 'ldap_sync'),
    ('group:BI_TEAM',         'BI_USER',      'ldap_sync'),
    ('group:SYSADMINS',       'SYSADMIN',     'ldap_sync')
ON CONFLICT (subject_id, role_id) DO NOTHING;

-- ============================================================
-- 4. Resources — web pages (Path B)
-- ============================================================
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name) VALUES
    ('web_page:home',                   'web_page', NULL, 'Homepage'),
    ('web_page:admin_dashboard',        'web_page', NULL, 'Admin Dashboard'),
    ('web_page:authz_admin',            'web_page', NULL, 'AuthZ Admin Panel')
ON CONFLICT (resource_id) DO NOTHING;

-- Set homepage as public
UPDATE authz_resource SET attributes = '{"auth_required": false}' WHERE resource_id = 'web_page:home';

-- ============================================================
-- 5. L0 Permissions — admin web pages (V083 matrix)
--   AUTHZ_ADMIN owns Govern → web_page:authz_admin
--   DATA_STEWARD owns Ingest + Catalog → web_page:admin_dashboard
-- ============================================================
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    ('AUTHZ_ADMIN',  'read',  'web_page:authz_admin',     'allow'),
    ('AUTHZ_ADMIN',  'write', 'web_page:authz_admin',     'allow'),
    ('DATA_STEWARD', 'read',  'web_page:admin_dashboard', 'allow'),
    ('DATA_STEWARD', 'write', 'web_page:admin_dashboard', 'allow')
ON CONFLICT (role_id, action_id, resource_id) DO NOTHING;

-- ============================================================
-- 6. Web API resources + role grants (Path B)
-- ============================================================
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name) VALUES
    ('web_api:resolve',         'web_api', 'web_page:home',           'Resolve API'),
    ('web_api:check',           'web_api', 'web_page:home',           'Check API'),
    ('web_api:filter',          'web_api', 'web_page:home',           'Filter API'),
    ('web_api:matrix',          'web_api', 'web_page:admin_dashboard','Permission Matrix API'),
    ('web_api:pool_manage',     'web_api', 'web_page:admin_dashboard','Pool Management API'),
    ('web_api:audit_log',       'web_api', 'web_page:admin_dashboard','Audit Log API')
ON CONFLICT (resource_id) DO NOTHING;

-- API permissions per V083 matrix
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    -- All authenticated user-facing roles can call resolve
    ('BI_USER',      'read', 'web_api:resolve', 'allow'),
    ('AUTHZ_ADMIN',  'read', 'web_api:resolve', 'allow'),
    ('DATA_STEWARD', 'read', 'web_api:resolve', 'allow'),
    -- Permission Matrix API — AUTHZ_ADMIN only
    ('AUTHZ_ADMIN',  'read',  'web_api:matrix',      'allow'),
    ('AUTHZ_ADMIN',  'write', 'web_api:matrix',      'allow'),
    -- Pool / data-source management — DATA_STEWARD only
    ('DATA_STEWARD', 'read',  'web_api:pool_manage', 'allow'),
    ('DATA_STEWARD', 'write', 'web_api:pool_manage', 'allow'),
    -- Audit Log — AUTHZ_ADMIN read+write, DATA_STEWARD read-only
    ('AUTHZ_ADMIN',  'read',  'web_api:audit_log', 'allow'),
    ('AUTHZ_ADMIN',  'write', 'web_api:audit_log', 'allow'),
    ('DATA_STEWARD', 'read',  'web_api:audit_log', 'allow')
ON CONFLICT (role_id, action_id, resource_id) DO NOTHING;

-- ============================================================
-- 7. Group Membership (user ↔ group, synced from LDAP)
-- ============================================================
INSERT INTO authz_group_member (group_id, user_id, source) VALUES
    ('group:AUTHZ_ADMINS',  'user:auth_admin_test', 'ldap_sync'),
    ('group:DATA_STEWARDS', 'user:steward_test',    'ldap_sync'),
    ('group:BI_TEAM',       'user:tsai_bi',         'ldap_sync'),
    ('group:SYSADMINS',     'user:adam_ou',         'manual')
ON CONFLICT (group_id, user_id) DO NOTHING;

-- ============================================================
-- Sections removed 2026-04-28 (徹底 prune per Adam):
--   - Path C pool profiles / assignments / credentials
--     (Adam manages pg_k8_read+ via dashboard pointing at real ds:pg_k8)
--   - ds:local data source registration
--     (real data sources onboarded via dashboard / discovery)
-- See git history for the pre-prune version.
-- ============================================================
