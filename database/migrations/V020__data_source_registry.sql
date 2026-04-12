-- ============================================================
-- V020: Data Source Registry
-- Admin can register external business databases.
-- Pool profiles link to data sources for dynamic connection.
-- ============================================================

-- ─── Data Source table ───
CREATE TABLE authz_data_source (
    source_id           TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL,
    description         TEXT,
    -- Connection info
    db_type             TEXT NOT NULL DEFAULT 'postgresql',
    host                TEXT NOT NULL,
    port                INTEGER NOT NULL DEFAULT 5432,
    database_name       TEXT NOT NULL,
    schemas             TEXT[] NOT NULL DEFAULT '{public}',
    -- Connector credentials (authz-api uses these to discover schema + run queries)
    -- TECH_DEBT: POC stores password in plaintext. Production must use AES-256 encryption.
    connector_user      TEXT NOT NULL,
    connector_password  TEXT NOT NULL,
    -- Metadata
    owner_subject       TEXT REFERENCES authz_subject(subject_id),
    registered_by       TEXT NOT NULL,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_synced_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE authz_data_source IS 'Registry of business databases managed by the AuthZ platform. Each data source can have pool profiles and resources linked to it.';
COMMENT ON COLUMN authz_data_source.connector_password IS 'TECH_DEBT: plaintext in POC. Must encrypt with AES-256 in production.';

-- ─── Link pool profiles to data sources ───
ALTER TABLE authz_db_pool_profile
    ADD COLUMN data_source_id TEXT REFERENCES authz_data_source(source_id);

COMMENT ON COLUMN authz_db_pool_profile.data_source_id IS 'Which data source this pool profile connects to. NULL for legacy profiles.';

-- ─── Index for quick lookups ───
CREATE INDEX idx_data_source_active ON authz_data_source(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_pool_profile_ds ON authz_db_pool_profile(data_source_id) WHERE data_source_id IS NOT NULL;
