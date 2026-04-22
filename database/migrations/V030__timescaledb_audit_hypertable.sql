-- ============================================================
-- V030: TimescaleDB — Audit log hypertable + compression + retention
--
-- Converts authz_audit_log from manual monthly partitions to
-- TimescaleDB hypertable with automatic chunk management.
--
-- Benefits:
--   - Automatic chunk creation (no more manual monthly partitions)
--   - Transparent compression on older chunks (5-10x space savings)
--   - Retention policy auto-drops chunks older than threshold
--   - Continuous aggregates for dashboard queries
--   - All PG features intact: GRANT, RLS, indexes, pool roles
-- ============================================================

-- ─── 1. Enable TimescaleDB extension ───
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ─── 2. Migrate audit_log: manual partitions → hypertable ───

-- 2a. Preserve existing data
CREATE TABLE _audit_log_backup AS SELECT * FROM authz_audit_log;

-- 2b. Drop old partitioned table (cascade drops child partitions + indexes)
DROP TABLE authz_audit_log CASCADE;

-- 2c. Recreate as regular table (TimescaleDB will add chunking)
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
    duration_ms     INTEGER
);

-- 2d. Convert to hypertable (1 week chunks — good balance for audit data)
SELECT create_hypertable('authz_audit_log', 'timestamp',
    chunk_time_interval => INTERVAL '7 days',
    migrate_data => false
);

-- 2e. Restore data
INSERT INTO authz_audit_log SELECT * FROM _audit_log_backup;
DROP TABLE _audit_log_backup;

-- 2f. Recreate indexes (TimescaleDB automatically creates index on timestamp)
CREATE INDEX idx_audit_path ON authz_audit_log(access_path, timestamp DESC);
CREATE INDEX idx_audit_subject ON authz_audit_log(subject_id, timestamp DESC);
CREATE INDEX idx_audit_resource ON authz_audit_log(resource_id, timestamp DESC);

-- ─── 3. Compression policy ───
-- Compress chunks older than 30 days (audit data rarely queried after 1 month)
ALTER TABLE authz_audit_log SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'access_path, subject_id',
    timescaledb.compress_orderby = 'timestamp DESC'
);

SELECT add_compression_policy('authz_audit_log', INTERVAL '30 days');

-- ─── 4. Retention policy ───
-- Auto-drop chunks older than 2 years (configurable via ALTER)
SELECT add_retention_policy('authz_audit_log', INTERVAL '2 years');

-- ─── 5. Continuous aggregate: hourly audit summary ───
-- Pre-computed rollup for Overview dashboard and Grafana
CREATE MATERIALIZED VIEW audit_hourly_summary
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS bucket,
    access_path,
    decision,
    count(*) AS event_count,
    avg(duration_ms)::integer AS avg_duration_ms
FROM authz_audit_log
GROUP BY bucket, access_path, decision
WITH NO DATA;

-- Refresh policy: keep last 24h up-to-date, refresh every 30 min
SELECT add_continuous_aggregate_policy('audit_hourly_summary',
    start_offset    => INTERVAL '24 hours',
    end_offset      => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes'
);

-- ─── 6. Continuous aggregate: daily audit by subject ───
-- For admin audit tab: who did what, how many times per day
CREATE MATERIALIZED VIEW audit_daily_by_subject
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', timestamp) AS bucket,
    subject_id,
    access_path,
    decision,
    count(*) AS event_count
FROM authz_audit_log
GROUP BY bucket, subject_id, access_path, decision
WITH NO DATA;

SELECT add_continuous_aggregate_policy('audit_daily_by_subject',
    start_offset    => INTERVAL '3 days',
    end_offset      => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

-- ─── 7. Comments ───
COMMENT ON TABLE authz_audit_log IS
    'TimescaleDB hypertable: authorization audit log. 7-day chunks, 30-day compression, 2-year retention.';
COMMENT ON MATERIALIZED VIEW audit_hourly_summary IS
    'Continuous aggregate: hourly access decision counts by path and decision. For dashboards.';
COMMENT ON MATERIALIZED VIEW audit_daily_by_subject IS
    'Continuous aggregate: daily per-subject audit counts. For admin audit tab.';
