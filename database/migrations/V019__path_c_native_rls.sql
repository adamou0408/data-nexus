-- ============================================================
-- V019: Path C — Native PG Roles (cluster-level only)
--
-- HISTORY (ARCH-01-FU-3, 2026-04-23):
--   This migration originally also created GRANTs / enabled RLS /
--   created POLICY / created views v_lot_status_pe / _sales on the
--   business tables `lot_status` and `sales_order`. Those tables
--   moved to the `nexus_data` database in ARCH-01 (2026-04-12).
--   On a fresh init this migration ran against `nexus_authz`,
--   where the business tables do not exist — and failed.
--
--   The business-table portions are now owned by
--   `database/migrations/data/V002__path_c_rls.sql`, which runs
--   against `nexus_data`. This file keeps ONLY the cluster-level
--   role + BYPASSRLS setup, which is harmless to apply from either
--   DB (PG roles are cluster objects). data/V002 also re-runs
--   these statements with the same `IF NOT EXISTS` guard, so the
--   double-application is idempotent.
--
-- Authority: backlog item ARCH-01-FU-3 (P1). DBA sign-off pending
-- on the split — no behavioural change vs. data/V002 because data/
-- V002 was the surviving SSOT after the ARCH-01 dev verification.
-- ============================================================

-- ─── 1. Create PG roles (cluster-level, idempotent) ───
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

-- ─── 2. RLS-applicable roles: NOBYPASSRLS / BYPASSRLS ───
ALTER ROLE nexus_pe_ro NOBYPASSRLS;
ALTER ROLE nexus_sales_ro NOBYPASSRLS;
ALTER ROLE nexus_bi_ro NOBYPASSRLS;
ALTER ROLE nexus_etl_rw BYPASSRLS;
ALTER ROLE nexus_admin_full BYPASSRLS;

-- ─── 3. (REMOVED) Schema GRANT / table GRANT / RLS / POLICY / VIEW ───
-- See database/migrations/data/V002__path_c_rls.sql — those
-- statements run against `nexus_data` where the business tables
-- live.

-- ─── 4. Log the setup ───
INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
VALUES
    ('path_c_init', 'V019_native_rls_roles_only',
     'Created/ensured 5 PG roles + BYPASSRLS settings. Business-table grants moved to data/V002 (ARCH-01-FU-3).',
     'synced', now());
