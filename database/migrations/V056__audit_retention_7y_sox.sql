-- ============================================================
-- V056: Audit retention 2y → 7y (SOX-like compliance)
--
-- Phase 0 of permission-default-allow pilot
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-0.3).
--
-- Background:
--   V030 originally set retention = 2 years. After Adam confirmed the audit
--   audience includes external SOX-style auditors (TW 主管機關), the floor
--   moves to 7 years to match the regulator's evidence window.
--
-- Compression policy stays 30d trigger; segment-by stays
-- (access_path, subject_id) — those are the dominant filter columns in
-- both the dashboard query and the SOX export query
-- (GET /api/browse/audit-logs?subject=&start_time=&end_time=).
--
-- Capacity headroom (measured by P0-F benchmark 2026-04-27):
--   Per-row size with 4 indexes: 359 B uncompressed, 28 B compressed.
--   Combined compression ratio = 12.71× (better than the 5-10× the
--   pre-benchmark estimate assumed).
--   7-year storage extrapolation (30d hot uncompressed + 2525d cold):
--     100k reads/day → ~7.8 GB total
--     500k reads/day → ~39 GB
--     1M reads/day   → ~78 GB
--   The earlier "<10 GB at 1M reads/day" speculation was wrong by 8× —
--   storage budget is operationally fine but plan capacity around the
--   measured numbers, not the optimistic ones.
--   See `.claude/plans/v3-phase-1/migration-drafts/_p0f_bench_setup.sql`
--   to reproduce the measurement.
-- ============================================================

-- ─── 1. Replace retention policy: 2y → 7y ───
-- TimescaleDB requires drop-then-add to change interval.
SELECT remove_retention_policy('authz_audit_log', if_exists => TRUE);
SELECT add_retention_policy('authz_audit_log', INTERVAL '7 years');

-- ─── 2. Refresh table comment so it doesn't lie ───
COMMENT ON TABLE authz_audit_log IS
    'TimescaleDB hypertable: authorization audit log. 7-day chunks, 30-day compression, 7-year retention (SOX).';

-- ─── 3. Sanity: confirm new policy is registered ───
-- TimescaleDB internals: `proc_name = 'policy_retention'` is the job name in
-- TimescaleDB 2.x (verified on 2.26.3 in dev 2026-04-27). If a future TSDB
-- upgrade renames the proc, this DO block will RAISE EXCEPTION with NULL
-- interval — that's the right failure mode (forces a deliberate fix).
DO $$
DECLARE
    v_interval INTERVAL;
BEGIN
    SELECT (config->>'drop_after')::INTERVAL INTO v_interval
    FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention'
      AND hypertable_name = 'authz_audit_log';

    IF v_interval IS NULL THEN
        RAISE EXCEPTION 'V056: retention policy not registered on authz_audit_log';
    END IF;

    IF v_interval < INTERVAL '7 years' THEN
        RAISE EXCEPTION 'V056: retention interval is %, expected ≥ 7 years', v_interval;
    END IF;

    RAISE NOTICE 'V056: authz_audit_log retention = % (OK)', v_interval;
END $$;
