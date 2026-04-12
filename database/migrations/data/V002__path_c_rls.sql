-- ============================================================
-- Data V002: Path C — PG Roles, GRANTs, and RLS Policies
-- Migrated from V019 (originally in nexus_authz for POC)
-- PG roles are cluster-level objects, safe to create from either DB.
-- GRANTs and RLS policies must be in the DB that owns the tables.
-- ============================================================

-- ─── 1. Create PG roles with passwords ───
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_pe_ro') THEN
        CREATE ROLE nexus_pe_ro LOGIN PASSWORD 'dev_pe_pass';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_sales_ro') THEN
        CREATE ROLE nexus_sales_ro LOGIN PASSWORD 'dev_sales_pass';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_bi_ro') THEN
        CREATE ROLE nexus_bi_ro LOGIN PASSWORD 'dev_bi_pass';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_etl_rw') THEN
        CREATE ROLE nexus_etl_rw LOGIN PASSWORD 'dev_etl_pass';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_admin_full') THEN
        CREATE ROLE nexus_admin_full LOGIN PASSWORD 'dev_admin_pass';
    END IF;
END $$;

-- ─── 2. RLS-applicable roles ───
ALTER ROLE nexus_pe_ro NOBYPASSRLS;
ALTER ROLE nexus_sales_ro NOBYPASSRLS;
ALTER ROLE nexus_bi_ro NOBYPASSRLS;
ALTER ROLE nexus_etl_rw BYPASSRLS;
ALTER ROLE nexus_admin_full BYPASSRLS;

-- ─── 3. Schema + table GRANT ───
GRANT USAGE ON SCHEMA public TO nexus_pe_ro, nexus_sales_ro, nexus_bi_ro, nexus_etl_rw, nexus_admin_full;

-- PE readonly: column-level GRANT (deny unit_price + cost)
GRANT SELECT (lot_id, product_line, chip_model, grade, customer, wafer_lot, site, status, created_at)
    ON lot_status TO nexus_pe_ro;
GRANT SELECT ON sales_order TO nexus_pe_ro;

-- Sales readonly
GRANT SELECT ON lot_status, sales_order TO nexus_sales_ro;

-- BI readonly: all tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nexus_bi_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO nexus_bi_ro;

-- ETL readwrite
GRANT SELECT, INSERT, UPDATE, DELETE ON lot_status, sales_order TO nexus_etl_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO nexus_etl_rw;

-- Admin: everything
GRANT ALL ON ALL TABLES IN SCHEMA public TO nexus_admin_full;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO nexus_admin_full;

-- ─── 4. Enable RLS ───
ALTER TABLE lot_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_status FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_order FORCE ROW LEVEL SECURITY;

-- ─── 5. RLS Policies on lot_status ───
CREATE POLICY lot_pe_product_line ON lot_status
    FOR SELECT TO nexus_pe_ro
    USING (product_line = current_setting('app.product_line', TRUE));

CREATE POLICY lot_sales_all ON lot_status
    FOR SELECT TO nexus_sales_ro USING (TRUE);

CREATE POLICY lot_bi_all ON lot_status
    FOR SELECT TO nexus_bi_ro USING (TRUE);

CREATE POLICY lot_etl_all ON lot_status
    FOR ALL TO nexus_etl_rw USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY lot_admin_all ON lot_status
    FOR ALL TO nexus_admin_full USING (TRUE) WITH CHECK (TRUE);

-- ─── 6. RLS Policies on sales_order ───
CREATE POLICY order_sales_region ON sales_order
    FOR SELECT TO nexus_sales_ro
    USING (region = current_setting('app.region', TRUE));

CREATE POLICY order_bi_all ON sales_order
    FOR SELECT TO nexus_bi_ro USING (TRUE);

CREATE POLICY order_etl_all ON sales_order
    FOR ALL TO nexus_etl_rw USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY order_admin_all ON sales_order
    FOR ALL TO nexus_admin_full USING (TRUE) WITH CHECK (TRUE);

-- ─── 7. Column-restricted views ───
CREATE OR REPLACE VIEW v_lot_status_pe AS
SELECT lot_id, product_line, chip_model, grade,
       customer, wafer_lot, site, status, created_at
FROM lot_status;

GRANT SELECT ON v_lot_status_pe TO nexus_pe_ro;

CREATE OR REPLACE VIEW v_lot_status_sales AS
SELECT lot_id, product_line, chip_model, grade,
       unit_price, customer, wafer_lot, site, status, created_at
FROM lot_status;

GRANT SELECT ON v_lot_status_sales TO nexus_sales_ro;
