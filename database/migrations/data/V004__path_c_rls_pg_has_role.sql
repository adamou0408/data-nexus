-- ============================================================
-- Data V004: Fix Path C RLS — replace current_setting() with identity-only policies
-- ARCH-03: current_setting() is spoofable on direct DB connections.
-- Path C pool roles connect via pgbouncer (no session variables set).
-- Row filtering SSOT is authz_filter() in application layer (shared across A/B/C).
-- RLS here only ensures correct role identity, not data filtering.
-- ============================================================

-- ADR: Path C RLS Policy Design
-- - Path A: current_setting() set by API layer (trusted, not spoofable)
-- - Path C: pg_has_role() for identity verification only
-- - Row-level data filtering: authz_filter() WHERE clause (SSOT, all 3 paths)
-- - Column-level: column-level REVOKE (V015) + SSOT denied_columns

-- ─── 1. Drop current_setting-based policies for Path C roles ───
-- These policies were ineffective — pgbouncer doesn't set session variables,
-- so current_setting() returns NULL and the USING clause fails silently.
DROP POLICY IF EXISTS lot_pe_product_line ON lot_status;
DROP POLICY IF EXISTS order_sales_region ON sales_order;

-- ─── 2. Create identity-only policies for Path C roles ───
-- USING(TRUE) because row filtering is done at application layer via authz_filter()
-- The RLS ensures only the correct PG role can SELECT at all.

-- lot_status: PE read-only (already had a policy, replacing with identity-only)
CREATE POLICY lot_pathc_pe ON lot_status
    FOR SELECT TO nexus_pe_ro USING (TRUE);

-- sales_order: Sales read-only (replacing region-based policy with identity-only)
CREATE POLICY order_pathc_sales ON sales_order
    FOR SELECT TO nexus_sales_ro USING (TRUE);

-- NOTE: lot_sales_all, lot_bi_all, lot_etl_all, lot_admin_all,
--       order_bi_all, order_etl_all, order_admin_all already use USING(TRUE).
--       No changes needed for those.
