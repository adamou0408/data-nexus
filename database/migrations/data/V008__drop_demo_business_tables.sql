-- ============================================================
-- ARCH-02 — Drop demo / mock business tables from nexus_data
--
-- Context:
--   The 14 tables/views/hypertables below were seeded as POC fixtures
--   pre-2026-04 to demonstrate Path C RLS, TimescaleDB hypertables,
--   continuous aggregates, and BU-06/BU-08 e2e flows. They never
--   represented real Phison business data.
--
--   Going forward, Path C demos retarget the real Phison Greenplum
--   warehouse (`ds:pg_k8`, schema `tiptop`). Mock tables are no longer
--   needed and confuse onboarding.
--
-- Coverage (CASCADE handles dependencies):
--   - RLS POLICIES from data/V002 + data/V004 (lot_pe_*, lot_sales_*,
--     lot_bi_*, lot_etl_*, lot_admin_*, order_*, lot_pathc_pe,
--     order_pathc_sales)
--   - Continuous aggregates `yield_daily_trend`, `lot_daily_flow`
--     (created in data/V006 — drop those first to release the
--     hypertable dependency cleanly)
--   - Hypertables `lot_status_history`, `yield_events`
--   - Triggers and indexes attached to dropped tables
--   - Views `v_lot_status_pe`, `v_lot_status_sales`
--
-- Idempotent: every DROP uses IF EXISTS.
-- ============================================================

-- 1. Drop continuous aggregates first (they reference hypertables) ----
DROP MATERIALIZED VIEW IF EXISTS public.yield_daily_trend CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.lot_daily_flow    CASCADE;

-- 2. Drop views (depend on lot_status / sales_order) -----------------
DROP VIEW IF EXISTS public.v_lot_status_pe    CASCADE;
DROP VIEW IF EXISTS public.v_lot_status_sales CASCADE;

-- 3. Drop hypertables / regular tables (CASCADE handles policies) ----
DROP TABLE IF EXISTS public.lot_status_history   CASCADE;
DROP TABLE IF EXISTS public.yield_events         CASCADE;
DROP TABLE IF EXISTS public.lot_status           CASCADE;
DROP TABLE IF EXISTS public.sales_order          CASCADE;
DROP TABLE IF EXISTS public.cp_ft_result         CASCADE;
DROP TABLE IF EXISTS public.wip_inventory        CASCADE;
DROP TABLE IF EXISTS public.reliability_report   CASCADE;
DROP TABLE IF EXISTS public.rma_record           CASCADE;
DROP TABLE IF EXISTS public.price_book           CASCADE;
DROP TABLE IF EXISTS public.npi_gate_checklist   CASCADE;

-- ============================================================
-- Audit note: TimescaleDB metadata (timescaledb_information.hypertables,
-- continuous_aggregates) auto-cleans when the underlying table drops.
-- No manual _timescaledb_internal cleanup needed.
-- ============================================================
