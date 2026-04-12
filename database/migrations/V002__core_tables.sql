-- ============================================================
-- V002: Core Tables (Shared Across All Paths)
-- ============================================================

-- SUBJECTS: LDAP groups are the primary subject (not individuals)
CREATE TABLE authz_subject (
    subject_id      TEXT PRIMARY KEY,
    subject_type    TEXT NOT NULL CHECK (subject_type IN ('ldap_group', 'user', 'service_account')),
    display_name    TEXT NOT NULL,
    ldap_dn         TEXT,
    attributes      JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RESOURCES: what is being protected (unified hierarchy)
CREATE TABLE authz_resource (
    resource_id     TEXT PRIMARY KEY,
    resource_type   TEXT NOT NULL CHECK (resource_type IN (
        'module', 'page', 'table', 'column', 'function', 'ai_tool',
        'web_page', 'web_api',
        'db_schema', 'db_table', 'db_pool'
    )),
    parent_id       TEXT REFERENCES authz_resource(resource_id),
    display_name    TEXT NOT NULL,
    attributes      JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ACTIONS: what can be done (shared vocabulary)
CREATE TABLE authz_action (
    action_id       TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    description     TEXT,
    applicable_paths TEXT[] NOT NULL DEFAULT '{A,B,C}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO authz_action (action_id, display_name, description, applicable_paths) VALUES
    ('read',    'Read',      'View data or page',                         '{A,B,C}'),
    ('write',   'Write',     'Create or modify data',                     '{A,B,C}'),
    ('delete',  'Delete',    'Remove data',                               '{A,B}'),
    ('approve', 'Approve',   'Approve workflow step (NPI gate, lot hold)','{A,B}'),
    ('export',  'Export',    'Export data to file',                        '{A,B}'),
    ('hold',    'Hold',      'Hold a lot',                                '{A}'),
    ('release', 'Release',   'Release a held lot',                        '{A}'),
    ('execute', 'Execute',   'Execute function or AI tool',               '{A}'),
    ('connect', 'Connect',   'Establish DB connection',                   '{C}');

-- ROLES: RBAC layer (shared across all paths)
CREATE TABLE authz_role (
    role_id         TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    description     TEXT,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ROLE-ACTION-RESOURCE mapping (L0 functional permissions)
CREATE TABLE authz_role_permission (
    id              BIGSERIAL PRIMARY KEY,
    role_id         TEXT NOT NULL REFERENCES authz_role(role_id),
    action_id       TEXT NOT NULL REFERENCES authz_action(action_id),
    resource_id     TEXT NOT NULL REFERENCES authz_resource(resource_id),
    effect          authz_effect NOT NULL DEFAULT 'allow',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (role_id, action_id, resource_id)
);

-- SUBJECT-ROLE assignment
CREATE TABLE authz_subject_role (
    id              BIGSERIAL PRIMARY KEY,
    subject_id      TEXT NOT NULL REFERENCES authz_subject(subject_id),
    role_id         TEXT NOT NULL REFERENCES authz_role(role_id),
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until     TIMESTAMPTZ,
    granted_by      TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_id, role_id)
);
