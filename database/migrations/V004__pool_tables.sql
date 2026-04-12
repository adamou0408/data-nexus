-- ============================================================
-- V004: Path C - DB Connection Pool Tables
-- ============================================================

-- DB POOL PROFILE: defines connection properties
CREATE TABLE authz_db_pool_profile (
    profile_id      TEXT PRIMARY KEY,
    pg_role         TEXT NOT NULL UNIQUE,
    allowed_schemas TEXT[] NOT NULL,
    allowed_tables  TEXT[],
    denied_columns  JSONB,
    connection_mode db_connection_mode NOT NULL,
    max_connections INTEGER NOT NULL DEFAULT 5,
    ip_whitelist    CIDR[],
    valid_hours     TEXT,
    rls_applies     BOOLEAN NOT NULL DEFAULT TRUE,
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- POOL ASSIGNMENT: which subjects can use which pool
CREATE TABLE authz_db_pool_assignment (
    id              BIGSERIAL PRIMARY KEY,
    subject_id      TEXT NOT NULL REFERENCES authz_subject(subject_id),
    profile_id      TEXT NOT NULL REFERENCES authz_db_pool_profile(profile_id),
    granted_by      TEXT NOT NULL,
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until     TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_id, profile_id)
);

-- POOL CREDENTIALS: managed centrally, used by pgbouncer auth_query
CREATE TABLE authz_pool_credentials (
    pg_role         TEXT PRIMARY KEY REFERENCES authz_db_pool_profile(pg_role),
    password_hash   TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_rotated    TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotate_interval INTERVAL NOT NULL DEFAULT '90 days'
);
