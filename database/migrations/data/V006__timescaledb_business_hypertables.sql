-- ============================================================
-- Data V006: TimescaleDB — Business data time-series support
--
-- Enables TimescaleDB on nexus_data and creates:
--   1. lot_status_history — append-only lot state change events
--   2. yield_events       — append-only test result events
--   3. Continuous aggregates for yield trend dashboards
--
-- Design decisions:
--   - lot_status and cp_ft_result keep their current schema (PK-based, mutable)
--   - New *_history / *_events tables are append-only hypertables
--   - Triggers on base tables auto-insert into history tables
--   - This preserves existing queries while adding time-series capability
--   - All GRANT + RLS rules on base tables remain unaffected
-- ============================================================

-- ─── 1. Enable TimescaleDB extension on nexus_data ───
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ─── 2. lot_status_history: append-only state change log ───
CREATE TABLE lot_status_history (
    event_id     BIGSERIAL,
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
    lot_id       TEXT NOT NULL,
    product_line TEXT NOT NULL,
    chip_model   TEXT NOT NULL,
    site         TEXT NOT NULL,
    old_status   TEXT,
    new_status   TEXT NOT NULL,
    old_grade    TEXT,
    new_grade    TEXT,
    changed_by   TEXT
);

SELECT create_hypertable('lot_status_history', 'timestamp',
    chunk_time_interval => INTERVAL '7 days'
);

CREATE INDEX idx_lot_history_lot ON lot_status_history(lot_id, timestamp DESC);
CREATE INDEX idx_lot_history_product ON lot_status_history(product_line, timestamp DESC);

-- Compression: compress after 14 days
ALTER TABLE lot_status_history SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'product_line, site',
    timescaledb.compress_orderby = 'timestamp DESC'
);
SELECT add_compression_policy('lot_status_history', INTERVAL '14 days');

-- Retention: 3 years of history
SELECT add_retention_policy('lot_status_history', INTERVAL '3 years');

-- Trigger: auto-capture lot_status changes
CREATE OR REPLACE FUNCTION fn_lot_status_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO lot_status_history
        (lot_id, product_line, chip_model, site, old_status, new_status, old_grade, new_grade)
    VALUES (
        NEW.lot_id, NEW.product_line, NEW.chip_model, NEW.site,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
        NEW.status,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.grade ELSE NULL END,
        NEW.grade
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lot_status_history
    AFTER INSERT OR UPDATE ON lot_status
    FOR EACH ROW EXECUTE FUNCTION fn_lot_status_history();

COMMENT ON TABLE lot_status_history IS
    'TimescaleDB hypertable: append-only lot state change events. Auto-populated by trigger on lot_status.';

-- ─── 3. yield_events: append-only test result events ───
CREATE TABLE yield_events (
    event_id     BIGSERIAL,
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
    lot_id       TEXT NOT NULL,
    product_line TEXT NOT NULL,
    chip_model   TEXT NOT NULL,
    test_type    TEXT NOT NULL,          -- CP, FT
    pass_count   INTEGER NOT NULL,
    fail_count   INTEGER NOT NULL,
    yield_rate   NUMERIC(5,2) NOT NULL,
    test_program TEXT,
    tester_id    TEXT,
    site         TEXT NOT NULL DEFAULT 'HQ'
);

SELECT create_hypertable('yield_events', 'timestamp',
    chunk_time_interval => INTERVAL '7 days'
);

CREATE INDEX idx_yield_events_product ON yield_events(product_line, timestamp DESC);
CREATE INDEX idx_yield_events_lot ON yield_events(lot_id, timestamp DESC);
CREATE INDEX idx_yield_events_test ON yield_events(test_type, timestamp DESC);

-- Compression: compress after 14 days
ALTER TABLE yield_events SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'product_line, test_type',
    timescaledb.compress_orderby = 'timestamp DESC'
);
SELECT add_compression_policy('yield_events', INTERVAL '14 days');

-- Retention: 5 years of yield history (critical quality data)
SELECT add_retention_policy('yield_events', INTERVAL '5 years');

-- Trigger: auto-capture cp_ft_result inserts
CREATE OR REPLACE FUNCTION fn_yield_event_capture()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO yield_events
        (lot_id, product_line, chip_model, test_type, pass_count, fail_count, yield_rate, test_program, tester_id, site)
    VALUES (
        NEW.lot_id, NEW.product_line, NEW.chip_model, NEW.test_type,
        NEW.pass_count, NEW.fail_count, NEW.yield_rate, NEW.test_program, NEW.tester_id, NEW.site
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_yield_event_capture
    AFTER INSERT ON cp_ft_result
    FOR EACH ROW EXECUTE FUNCTION fn_yield_event_capture();

COMMENT ON TABLE yield_events IS
    'TimescaleDB hypertable: append-only test result events. Auto-populated by trigger on cp_ft_result.';

-- ─── 4. Continuous aggregate: daily yield trend ───
-- Pre-computed for PE/QA dashboards and Grafana
CREATE MATERIALIZED VIEW yield_daily_trend
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', timestamp) AS bucket,
    product_line,
    chip_model,
    test_type,
    sum(pass_count) AS total_pass,
    sum(fail_count) AS total_fail,
    round(sum(pass_count)::numeric / nullif(sum(pass_count) + sum(fail_count), 0) * 100, 2) AS yield_pct,
    count(*) AS test_count
FROM yield_events
GROUP BY bucket, product_line, chip_model, test_type
WITH NO DATA;

SELECT add_continuous_aggregate_policy('yield_daily_trend',
    start_offset    => INTERVAL '3 days',
    end_offset      => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

-- ─── 5. Continuous aggregate: daily lot flow ───
-- Pre-computed for OP dashboards: how many lots changed state per day
CREATE MATERIALIZED VIEW lot_daily_flow
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', timestamp) AS bucket,
    product_line,
    site,
    new_status,
    count(*) AS event_count
FROM lot_status_history
GROUP BY bucket, product_line, site, new_status
WITH NO DATA;

SELECT add_continuous_aggregate_policy('lot_daily_flow',
    start_offset    => INTERVAL '3 days',
    end_offset      => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

-- ─── 6. GRANT access to continuous aggregates for pool roles ───
-- Pool roles already have SELECT on base tables via authz_sync_db_grants().
-- Continuous aggregates need explicit GRANT.
-- Note: actual pool roles are created dynamically — this is a template.
-- Run after pool roles exist, or add to syncExternalGrants().
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'nexus_%_ro' LOOP
        EXECUTE format('GRANT SELECT ON yield_daily_trend TO %I', r.rolname);
        EXECUTE format('GRANT SELECT ON lot_daily_flow TO %I', r.rolname);
    END LOOP;
END;
$$;

-- ─── 7. Comments ───
COMMENT ON MATERIALIZED VIEW yield_daily_trend IS
    'Continuous aggregate: daily yield % by product_line/chip_model/test_type. For PE/QA dashboards.';
COMMENT ON MATERIALIZED VIEW lot_daily_flow IS
    'Continuous aggregate: daily lot state change counts by product_line/site. For OP dashboards.';
