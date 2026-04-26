-- ============================================================
-- P0-F audit volume benchmark — bench hypertable setup
--
-- Mirrors authz_audit_log schema 1:1 (V030 + V056) so compression
-- behaviour matches production. Uses _bench suffix so the row counts
-- never pollute real audit data.
--
-- Synthetic data sized for compression-ratio measurement, not 7y volume:
--   - 100k rows (≈ 1 day at 100k reads/day, or ≈ 1h at 1M reads/day)
--   - 500 distinct subjects (production target cardinality)
--   - 60 distinct resources (Path A pages + Path B routes + Path C tables)
--   - 8-day timestamp spread → forces ≥ 2 chunks (7d chunk_time_interval)
--   - Decision/path mix matches observed dev distribution:
--     B/allow 35%, B/deny 33%, A/allow 27%, A/deny 5%
--   - Context JSONB shapes copied from real Path A / Path B emit sites
--
-- Distribution uses (g % 100) instead of random() so the planner can't
-- coalesce calls — earlier random()-LATERAL pattern collapsed every row
-- into bucket 0 (B/allow + table:lot_status).
--
-- Cleanup: _p0f_bench_teardown.sql (drops the hypertable entirely).
-- ============================================================

-- ─── 1. Bench hypertable (schema mirrors authz_audit_log) ───
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

-- ─── 2. Synthetic row generator ───
-- Bucket layout (g % 100):
--   0-34  (35%) → B/allow
--   35-67 (33%) → B/deny
--   68-94 (27%) → A/allow
--   95-99  (5%) → A/deny
INSERT INTO authz_audit_log_bench (
    timestamp, access_path, subject_id, action_id, resource_id, decision, context
)
SELECT
    -- 8-day backdated spread (g % 8 → day bucket, deterministic seconds within day)
    -- Forces ≥ 2 chunks since 7d chunk_time_interval splits at week boundary.
    now() - ((g % 8) * INTERVAL '1 day') - (((g * 73) % 86400) * INTERVAL '1 second'),
    CASE WHEN b < 68 THEN 'B' ELSE 'A' END::CHAR(1) AS path,
    'user_' || lpad((g % 500 + 1)::text, 4, '0'),
    (ARRAY['read','read','read','write','update','delete','configure'])[1 + (g % 7)],
    CASE g % 60
        WHEN 0 THEN 'table:lot_status'
        WHEN 1 THEN 'table:wafer_test'
        WHEN 2 THEN 'table:product_catalog'
        WHEN 3 THEN 'table:fab_inventory'
        WHEN 4 THEN 'table:shipment_log'
        WHEN 5 THEN 'table:supplier_master'
        WHEN 6 THEN 'table:yield_summary'
        WHEN 7 THEN 'table:bin_distribution'
        WHEN 8 THEN 'table:lot_history'
        WHEN 9 THEN 'table:test_program'
        ELSE 'table:tbl_' || lpad(((g % 50) + 10)::text, 3, '0')
    END AS res,
    CASE
        WHEN b < 35 THEN 'allow'
        WHEN b < 68 THEN 'deny'
        WHEN b < 95 THEN 'allow'
        ELSE 'deny'
    END::authz_effect AS dec,
    CASE
        -- B/allow: minimal context (~30 chars)
        WHEN b < 35 THEN
            jsonb_build_object('method', (ARRAY['GET','POST','PUT','DELETE'])[1+(g%4)])
        -- B/deny variants (~80-150 chars)
        WHEN b < 45 THEN
            jsonb_build_object('reason','unauthenticated','method','GET','route','/api/browse/datasources')
        WHEN b < 58 THEN
            jsonb_build_object('reason','authz_check_failed','method','POST','route','/api/admin/policy/upsert')
        WHEN b < 68 THEN
            jsonb_build_object(
                'reason','role_check_failed',
                'required_roles', jsonb_build_array('AUTHZ_ADMIN','AUTHZ_OWNER'),
                'user_roles', jsonb_build_array('VIEWER'),
                'method','GET',
                'route','/api/audit/export'
            )
        -- A/allow: real config-exec emit shape (~147 chars)
        WHEN b < 95 THEN
            jsonb_build_object(
                'table','lot_status',
                'page_id','wafer_yield_overview',
                'row_count', g % 100,
                'source_id','ds:pg_k8',
                'total_count', (g * 7) % 5000,
                'filtered_count', g % 100
            )
        -- A/deny (~80 chars)
        ELSE
            jsonb_build_object('page_id','wafer_yield_overview','reason','no_resource_binding')
    END AS ctx
FROM (
    SELECT g, (g * 1009) % 100 AS b
    FROM generate_series(1, 100000) g
) base;

-- ─── 3. Sanity ───
SELECT count(*) AS total_rows,
       count(DISTINCT subject_id) AS distinct_subjects,
       count(DISTINCT resource_id) AS distinct_resources,
       count(DISTINCT action_id) AS distinct_actions,
       min(timestamp)::date AS earliest,
       max(timestamp)::date AS latest
FROM authz_audit_log_bench;

SELECT access_path, decision, count(*) AS rows
FROM authz_audit_log_bench
GROUP BY 1,2 ORDER BY 1,2;

SELECT chunk_name, range_start, range_end, is_compressed
FROM timescaledb_information.chunks
WHERE hypertable_name = 'authz_audit_log_bench'
ORDER BY range_start;
