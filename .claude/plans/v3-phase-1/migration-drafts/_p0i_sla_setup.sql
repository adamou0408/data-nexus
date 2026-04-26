-- ============================================================
-- P0-I AC-0.4 SLA verification — 1M-row bench hypertable
--
-- AC-0.4: given (subject_id, time_range) the audit-logs API must
-- return within ≤2s. The route SQL (browse-read.ts:576) is:
--   SELECT * FROM authz_audit_log
--     WHERE subject_id = $1
--       AND timestamp BETWEEN $2 AND $3
--     ORDER BY timestamp DESC LIMIT $N
--
-- This bench hypertable mirrors authz_audit_log so the planner sees
-- identical indexes (idx_audit_subject btree(subject_id, timestamp DESC))
-- and the same chunk_time_interval (7d). Reuses _bench suffix +
-- constitution-compliant teardown.
--
-- Volume: 1M rows × 35 days = ~28.5k rows/day.
--   1000 distinct subjects → avg 1000 rows / subject / 30d window.
-- ============================================================

DROP TABLE IF EXISTS authz_audit_log_bench CASCADE;

CREATE TABLE authz_audit_log_bench (
    audit_id    BIGSERIAL,
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
    access_path CHAR(1)     NOT NULL CHECK (access_path IN ('A','B','C')),
    subject_id  TEXT        NOT NULL,
    action_id   TEXT        NOT NULL,
    resource_id TEXT        NOT NULL,
    decision    authz_effect NOT NULL,
    policy_ids  BIGINT[],
    context     JSONB,
    duration_ms INTEGER
);

SELECT create_hypertable(
    'authz_audit_log_bench', 'timestamp',
    chunk_time_interval => INTERVAL '7 days'
);

CREATE INDEX ON authz_audit_log_bench (timestamp DESC);
CREATE INDEX ON authz_audit_log_bench (access_path, timestamp DESC);
CREATE INDEX ON authz_audit_log_bench (subject_id, timestamp DESC);
CREATE INDEX ON authz_audit_log_bench (resource_id, timestamp DESC);

ALTER TABLE authz_audit_log_bench SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'access_path,subject_id',
    timescaledb.compress_orderby = 'timestamp DESC'
);

-- 1M rows × 1000 subjects × 35 days
INSERT INTO authz_audit_log_bench (
    timestamp, access_path, subject_id, action_id, resource_id, decision, context
)
SELECT
    -- 35-day spread: g % 35 → day bucket; (g * 73) % 86400 → second within day
    now() - ((g % 35) * INTERVAL '1 day') - (((g * 73) % 86400) * INTERVAL '1 second'),
    CASE WHEN b < 68 THEN 'B' ELSE 'A' END::CHAR(1),
    'user_' || lpad((g % 1000 + 1)::text, 4, '0'),
    (ARRAY['read','read','read','write','update','delete','configure'])[1 + (g % 7)],
    CASE g % 60
        WHEN 0 THEN 'table:lot_status'
        WHEN 1 THEN 'table:wafer_test'
        WHEN 2 THEN 'table:product_catalog'
        WHEN 3 THEN 'table:fab_inventory'
        WHEN 4 THEN 'table:shipment_log'
        ELSE 'table:tbl_' || lpad(((g % 50) + 10)::text, 3, '0')
    END,
    CASE
        WHEN b < 35 THEN 'allow'
        WHEN b < 68 THEN 'deny'
        WHEN b < 95 THEN 'allow'
        ELSE 'deny'
    END::authz_effect,
    CASE
        WHEN b < 35 THEN
            jsonb_build_object('method', (ARRAY['GET','POST','PUT','DELETE'])[1+(g%4)])
        WHEN b < 68 THEN
            jsonb_build_object('reason','authz_check_failed','method','POST','route','/api/admin/policy/upsert')
        WHEN b < 95 THEN
            jsonb_build_object(
                'table','lot_status', 'page_id','wafer_yield_overview',
                'row_count', g % 100, 'source_id','ds:pg_k8',
                'total_count', (g * 7) % 5000, 'filtered_count', g % 100
            )
        ELSE
            jsonb_build_object('page_id','wafer_yield_overview','reason','no_resource_binding')
    END
FROM (
    SELECT g, (g * 1009) % 100 AS b
    FROM generate_series(1, 1000000) g
) base;

-- Update planner stats so EXPLAIN reflects real cardinality
ANALYZE authz_audit_log_bench;

-- Sanity
SELECT count(*) AS total_rows,
       count(DISTINCT subject_id) AS distinct_subjects,
       min(timestamp)::date AS earliest,
       max(timestamp)::date AS latest
FROM authz_audit_log_bench;

SELECT chunk_name, range_start, range_end, is_compressed
FROM timescaledb_information.chunks
WHERE hypertable_name = 'authz_audit_log_bench'
ORDER BY range_start;

-- Sample subject row count for SLA test
SELECT subject_id, count(*) AS rows_30d
FROM authz_audit_log_bench
WHERE subject_id = 'user_0123'
  AND timestamp BETWEEN now() - INTERVAL '30 days' AND now()
GROUP BY subject_id;
