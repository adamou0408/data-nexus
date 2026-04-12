-- ============================================================
-- V019: Path C — Native PG Roles, RLS Policies, and Grant Sync
-- Creates actual PG roles, enables RLS on business tables,
-- and creates native PG policies so Path C connections
-- are enforced at the database level.
-- ============================================================

-- ─── 1. Create PG roles with passwords ───
-- Passwords match what's in authz_pool_credentials (dev only)
DO $$
BEGIN
    -- PE readonly
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_pe_ro') THEN
        CREATE ROLE nexus_pe_ro LOGIN PASSWORD 'dev_pe_pass';
    END IF;
    -- Sales readonly
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_sales_ro') THEN
        CREATE ROLE nexus_sales_ro LOGIN PASSWORD 'dev_sales_pass';
    END IF;
    -- BI readonly
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_bi_ro') THEN
        CREATE ROLE nexus_bi_ro LOGIN PASSWORD 'dev_bi_pass';
    END IF;
    -- ETL readwrite
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_etl_rw') THEN
        CREATE ROLE nexus_etl_rw LOGIN PASSWORD 'dev_etl_pass';
    END IF;
    -- Admin full
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_admin_full') THEN
        CREATE ROLE nexus_admin_full LOGIN PASSWORD 'dev_admin_pass';
    END IF;
END $$;

-- ─── 2. RLS-applicable roles: NOBYPASSRLS ───
ALTER ROLE nexus_pe_ro NOBYPASSRLS;
ALTER ROLE nexus_sales_ro NOBYPASSRLS;
ALTER ROLE nexus_bi_ro NOBYPASSRLS;
-- ETL and Admin bypass RLS
ALTER ROLE nexus_etl_rw BYPASSRLS;
ALTER ROLE nexus_admin_full BYPASSRLS;

-- ─── 3. Schema + table GRANT ───
-- All roles need schema usage
GRANT USAGE ON SCHEMA public TO nexus_pe_ro, nexus_sales_ro, nexus_bi_ro, nexus_etl_rw, nexus_admin_full;

-- PE readonly: column-level GRANT (no table-level SELECT, so denied columns actually work)
-- lot_status: deny unit_price + cost → only grant other columns
GRANT SELECT (lot_id, product_line, chip_model, grade, customer, wafer_lot, site, status, created_at)
    ON lot_status TO nexus_pe_ro;
-- sales_order: PE can see all columns
GRANT SELECT ON sales_order TO nexus_pe_ro;

-- Sales readonly: full SELECT on allowed tables (including unit_price)
GRANT SELECT ON lot_status, sales_order TO nexus_sales_ro;

-- BI readonly: all tables in public
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nexus_bi_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO nexus_bi_ro;

-- ETL readwrite: specific tables
GRANT SELECT, INSERT, UPDATE, DELETE ON lot_status, sales_order TO nexus_etl_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO nexus_etl_rw;

-- Admin: everything
GRANT ALL ON ALL TABLES IN SCHEMA public TO nexus_admin_full;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO nexus_admin_full;

-- ─── 4. Enable RLS on business tables ───
ALTER TABLE lot_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order ENABLE ROW LEVEL SECURITY;

-- Force RLS for table owners too (important for nexus_admin who is superuser)
-- Not strictly needed since our pool roles are not owners, but good practice
ALTER TABLE lot_status FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_order FORCE ROW LEVEL SECURITY;

-- ─── 5. RLS Policies on lot_status ───

-- PE: can only see rows matching their product line
-- We use current_setting to pass product_line context via SET session variable
CREATE POLICY lot_pe_product_line ON lot_status
    FOR SELECT TO nexus_pe_ro
    USING (
        product_line = current_setting('app.product_line', TRUE)
    );

-- Sales: can see all lot_status rows (no row filter on lot for sales)
CREATE POLICY lot_sales_all ON lot_status
    FOR SELECT TO nexus_sales_ro
    USING (TRUE);

-- BI: can see all lot_status rows
CREATE POLICY lot_bi_all ON lot_status
    FOR SELECT TO nexus_bi_ro
    USING (TRUE);

-- ETL: full access (BYPASSRLS, but policy needed if FORCE is on)
CREATE POLICY lot_etl_all ON lot_status
    FOR ALL TO nexus_etl_rw
    USING (TRUE) WITH CHECK (TRUE);

-- Admin: full access
CREATE POLICY lot_admin_all ON lot_status
    FOR ALL TO nexus_admin_full
    USING (TRUE) WITH CHECK (TRUE);

-- ─── 6. RLS Policies on sales_order ───

-- PE: no access to sales_order (no policy = denied)
-- (PE role has GRANT SELECT but no RLS policy → 0 rows returned)

-- Sales: can only see orders matching their region
CREATE POLICY order_sales_region ON sales_order
    FOR SELECT TO nexus_sales_ro
    USING (
        region = current_setting('app.region', TRUE)
    );

-- BI: can see all orders
CREATE POLICY order_bi_all ON sales_order
    FOR SELECT TO nexus_bi_ro
    USING (TRUE);

-- ETL: full access
CREATE POLICY order_etl_all ON sales_order
    FOR ALL TO nexus_etl_rw
    USING (TRUE) WITH CHECK (TRUE);

-- Admin: full access
CREATE POLICY order_admin_all ON sales_order
    FOR ALL TO nexus_admin_full
    USING (TRUE) WITH CHECK (TRUE);

-- ─── 7. Column-level access ───
-- PE: unit_price + cost denied via column-level GRANT (step 3 above)
-- We use column-level GRANT instead of REVOKE because PG's REVOKE
-- doesn't override a table-level GRANT. By only GRANTing specific
-- columns, denied columns are never accessible.
-- Sales: full table-level SELECT → can see all columns including unit_price
-- BI: full table-level SELECT → all columns
-- ETL/Admin: full access

-- ─── 8. Allow nexus_admin (superuser) to see RLS-filtered results ───
-- The owner (nexus_admin) bypasses RLS by default.
-- Pool roles are non-owners, so they are subject to RLS.

-- ─── 9. Create views for column-restricted access (alternative to column REVOKE) ───
-- These views allow PE to query lot_status without seeing restricted columns.
-- This is a fallback for clients that don't handle column-level REVOKE gracefully.
CREATE OR REPLACE VIEW v_lot_status_pe AS
SELECT
    lot_id, product_line, chip_model, grade,
    customer, wafer_lot, site, status, created_at
FROM lot_status;

GRANT SELECT ON v_lot_status_pe TO nexus_pe_ro;

CREATE OR REPLACE VIEW v_lot_status_sales AS
SELECT
    lot_id, product_line, chip_model, grade,
    unit_price, customer, wafer_lot, site, status, created_at
FROM lot_status;

GRANT SELECT ON v_lot_status_sales TO nexus_sales_ro;

-- ─── 10. Log the setup ───
INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
VALUES
    ('path_c_init', 'V019_native_rls', 'Created 5 PG roles, enabled RLS on lot_status + sales_order, created 9 policies', 'synced', now());
