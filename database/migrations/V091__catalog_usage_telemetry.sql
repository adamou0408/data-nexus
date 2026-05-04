-- ============================================================
-- V091: Catalog usage telemetry
--
-- Tracks frame opens & dwell time inside the unified Catalog
-- Workspace so admins can see:
--   1) which targets get opened most (high-value functions)
--   2) which high-frequency targets bounce fast (UX friction)
--
-- Idempotent: safe to re-run. All DDL guarded with IF NOT EXISTS,
-- hypertable conversion guarded against _timescaledb_catalog,
-- policies passed if_not_exists => true.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ─── 1. Event table ───
CREATE TABLE IF NOT EXISTS catalog_usage_event (
    event_id     BIGSERIAL,
    ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
    subject_id   TEXT        NOT NULL,
    preset       TEXT        NOT NULL,
    frame_kind   TEXT        NOT NULL,
    target_id    TEXT,
    action       TEXT        NOT NULL CHECK (action IN ('open', 'close')),
    dwell_ms     INTEGER,
    trigger      TEXT,
    session_id   TEXT,
    context      JSONB
);

-- ─── 2. Convert to hypertable (only on first run) ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM _timescaledb_catalog.hypertable
     WHERE table_name = 'catalog_usage_event'
  ) THEN
    PERFORM create_hypertable('catalog_usage_event', 'ts',
      chunk_time_interval => INTERVAL '7 days',
      migrate_data => false);
  END IF;
END$$;

-- ─── 3. Indexes ───
CREATE INDEX IF NOT EXISTS ix_cue_target  ON catalog_usage_event(preset, target_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_cue_subject ON catalog_usage_event(subject_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_cue_kind    ON catalog_usage_event(preset, frame_kind, ts DESC);

-- ─── 4. Compression (after 30d) ───
-- ALTER TABLE ... SET re-applies the same options on re-run; effectively idempotent.
ALTER TABLE catalog_usage_event SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'preset, frame_kind',
    timescaledb.compress_orderby = 'ts DESC'
);

SELECT add_compression_policy('catalog_usage_event', INTERVAL '30 days', if_not_exists => true);

-- ─── 5. Retention (drop chunks > 365d) ───
SELECT add_retention_policy('catalog_usage_event', INTERVAL '365 days', if_not_exists => true);

-- ─── 6. Continuous aggregate: daily rollup ───
-- NOTE: TimescaleDB does NOT accept IF NOT EXISTS on CREATE MATERIALIZED VIEW
-- with continuous mode in older versions; guard via timescaledb_information.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.continuous_aggregates
     WHERE view_name = 'catalog_usage_daily'
  ) THEN
    EXECUTE $cagg$
      CREATE MATERIALIZED VIEW catalog_usage_daily
      WITH (timescaledb.continuous) AS
      SELECT time_bucket('1 day', ts) AS bucket,
             preset, frame_kind, target_id,
             COUNT(*) FILTER (WHERE action='open')::bigint                          AS open_count,
             COUNT(DISTINCT subject_id) FILTER (WHERE action='open')::bigint        AS distinct_users,
             COUNT(DISTINCT session_id) FILTER (WHERE action='open')::bigint        AS distinct_sessions,
             AVG(dwell_ms) FILTER (WHERE action='close' AND dwell_ms IS NOT NULL)   AS avg_dwell_ms,
             -- bounce_count: closes shorter than 3s — read as "user opened the
             -- frame, glanced, and bailed". 3s is a UX heuristic, not measured.
             COUNT(*) FILTER (WHERE action='close' AND dwell_ms < 3000)::bigint     AS bounce_count
        FROM catalog_usage_event
       GROUP BY 1, 2, 3, 4
       WITH NO DATA
    $cagg$;
  END IF;
END$$;

SELECT add_continuous_aggregate_policy('catalog_usage_daily',
    start_offset    => INTERVAL '8 days',
    end_offset      => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists   => true
);

-- ─── 7. Comments ───
COMMENT ON TABLE catalog_usage_event IS
  'TimescaleDB hypertable: Catalog Workspace frame open/close telemetry. 7-day chunks, 30-day compression, 365-day retention.';
COMMENT ON MATERIALIZED VIEW catalog_usage_daily IS
  'Continuous aggregate: daily per-(preset, frame_kind, target_id) usage rollup. Refreshed hourly.';
