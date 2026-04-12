-- ============================================================
-- V005: Sync & Audit Tables + Indexes
-- ============================================================

-- SYNC LOG: tracks what was generated for each enforcement point
CREATE TABLE authz_sync_log (
    sync_id         BIGSERIAL PRIMARY KEY,
    sync_type       TEXT NOT NULL CHECK (sync_type IN (
        'rls_policy', 'column_view', 'ui_metadata', 'web_acl',
        'db_grant', 'pgbouncer_config', 'agent_scope'
    )),
    source_policy_id BIGINT,
    target_name     TEXT NOT NULL,
    generated_sql   TEXT,
    generated_config TEXT,
    sync_status     sync_status NOT NULL DEFAULT 'pending',
    error_message   TEXT,
    synced_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AUDIT LOG: every access decision, all paths (partitioned)
-- v2.4 FIX: PK must include partition key column (timestamp) for partitioned tables
CREATE TABLE authz_audit_log (
    audit_id        BIGSERIAL,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    access_path     CHAR(1) NOT NULL CHECK (access_path IN ('A', 'B', 'C')),
    subject_id      TEXT NOT NULL,
    action_id       TEXT NOT NULL,
    resource_id     TEXT NOT NULL,
    decision        authz_effect NOT NULL,
    policy_ids      BIGINT[],
    context         JSONB,
    duration_ms     INTEGER,
    PRIMARY KEY (audit_id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Create monthly partitions
CREATE TABLE authz_audit_log_2026_04 PARTITION OF authz_audit_log
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE authz_audit_log_2026_05 PARTITION OF authz_audit_log
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE authz_audit_log_2026_06 PARTITION OF authz_audit_log
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_policy_active ON authz_policy(status) WHERE status = 'active';
CREATE INDEX idx_policy_granularity ON authz_policy(granularity);
CREATE INDEX idx_policy_paths ON authz_policy USING gin(applicable_paths);
CREATE INDEX idx_subject_role_active ON authz_subject_role(subject_id) WHERE is_active = TRUE;
CREATE INDEX idx_role_perm_role ON authz_role_permission(role_id) WHERE is_active = TRUE;
CREATE INDEX idx_role_perm_resource ON authz_role_permission(resource_id) WHERE is_active = TRUE;
CREATE INDEX idx_resource_parent ON authz_resource(parent_id);
CREATE INDEX idx_resource_type ON authz_resource(resource_type);
CREATE INDEX idx_pool_assign_subject ON authz_db_pool_assignment(subject_id) WHERE is_active = TRUE;
CREATE INDEX idx_audit_path ON authz_audit_log(access_path, timestamp DESC);
CREATE INDEX idx_audit_subject ON authz_audit_log(subject_id, timestamp DESC);
CREATE INDEX idx_audit_resource ON authz_audit_log(resource_id, timestamp DESC);
CREATE INDEX idx_sync_status ON authz_sync_log(sync_status) WHERE sync_status = 'pending';
