-- ============================================================
-- V057 (DRAFT — needs docker-compose image swap before applying)
--
-- Path C audit pipeline foundation. Phase 0 of permission-default-allow
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-0.2).
--
-- Pre-req: deploy/docker-compose/docker-compose.yml postgres image must
-- be `timescale/timescaledb-ha:pg16` (bundles pgaudit + pg_cron). The
-- current `timescale/timescaledb:latest-pg16` does NOT ship either, so
-- CREATE EXTENSION will fail there. See companion file
-- `docker-compose-pgaudit-swap.md` for the compose diff and migration
-- ordering notes (compose change MUST land + container restart before
-- this V057 runs).
--
-- What this migration does:
--   1. Enable pgaudit + pg_cron extensions on nexus_authz
--   2. Create authz_audit_log_path_c hypertable (separate from V030
--      authz_audit_log so Path A/B and Path C scale independently)
--   3. Compression (30d) + retention (7y, matches V056) policies
--   4. Position the table for the V058 csvlog ingest cron job
--
-- What this migration does NOT do:
--   - configure pgaudit.log itself (that lives in postgresql.conf,
--     not SQL — see companion compose-swap notes)
--   - enable pg_cron jobs (V058 owns that)
-- ============================================================

-- ─── 1. Extensions ───
-- Both must be in shared_preload_libraries (set in postgresql.conf via
-- the compose `command:` override). CREATE EXTENSION below is the SQL
-- half; the lib-load half is a server config concern.
CREATE EXTENSION IF NOT EXISTS pgaudit;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ─── 2. Path C audit hypertable ───
-- Schema mirrors authz_audit_log (so a UNION across A/B/C is trivial in
-- the dashboard) but keeps Path C events on their own chunks. Reason:
-- Path C is the volume-heavy path (DB-native SELECTs from BI tools)
-- and we don't want it to crowd out the small but security-critical
-- Path B deny stream.
CREATE TABLE authz_audit_log_path_c (
    audit_id        BIGSERIAL,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    access_path     CHAR(1) NOT NULL DEFAULT 'C' CHECK (access_path = 'C'),
    subject_id      TEXT NOT NULL,
    action_id       TEXT NOT NULL,        -- pgaudit "command" (SELECT / EXECUTE / ...)
    resource_id     TEXT NOT NULL,        -- 'table:<schema>.<name>' or 'function:...'
    decision        authz_effect NOT NULL DEFAULT 'allow',  -- pgaudit only logs successful execs
    policy_ids      BIGINT[],
    context         JSONB,                -- raw pgaudit row + db user + session id
    duration_ms     INTEGER
);

SELECT create_hypertable('authz_audit_log_path_c', 'timestamp',
    chunk_time_interval => INTERVAL '7 days',
    migrate_data => false);

-- ─── 3. Indexes (mirror V030) ───
CREATE INDEX idx_audit_path_c_subject  ON authz_audit_log_path_c(subject_id, timestamp DESC);
CREATE INDEX idx_audit_path_c_resource ON authz_audit_log_path_c(resource_id, timestamp DESC);

-- ─── 4. Compression — segment by db user (≈ subject) ───
ALTER TABLE authz_audit_log_path_c SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'subject_id',
    timescaledb.compress_orderby = 'timestamp DESC'
);
SELECT add_compression_policy('authz_audit_log_path_c', INTERVAL '30 days');

-- ─── 5. Retention — match V056 (7y SOX) ───
SELECT add_retention_policy('authz_audit_log_path_c', INTERVAL '7 years');

-- ─── 6. Comments ───
COMMENT ON TABLE authz_audit_log_path_c IS
    'Path C (DB-native) audit log. Populated by V058 cron from pgaudit csvlog. 7d chunks, 30d compression, 7y retention.';
COMMENT ON EXTENSION pgaudit IS
    'Path C SELECT audit source — output goes to log_destination=csvlog, ingested by V058 cron.';
COMMENT ON EXTENSION pg_cron IS
    'Job scheduler — runs V058 csvlog ingest function every 1 minute.';
