-- ============================================================
-- Data V001: Business tables for nexus_data
-- Migrated from V014 (originally in nexus_authz for POC)
-- ============================================================

-- ─── lot_status: 生產批次追蹤 ───
CREATE TABLE lot_status (
    lot_id       TEXT PRIMARY KEY,
    product_line TEXT NOT NULL,      -- SSD, eMMC, SD, PCIe
    chip_model   TEXT NOT NULL,      -- E18, E26, PS5021, etc.
    grade        TEXT,               -- A+, A, B, C, Reject
    unit_price   NUMERIC(10,2),     -- customer-facing price (restricted)
    cost         NUMERIC(10,2),     -- internal cost (highly restricted)
    customer     TEXT,
    wafer_lot    TEXT,
    site         TEXT NOT NULL DEFAULT 'HQ',  -- HQ (Hsinchu), HK, JP
    status       TEXT NOT NULL DEFAULT 'active', -- active, hold, shipped, scrapped
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lot_status_product_line ON lot_status(product_line);
CREATE INDEX idx_lot_status_site ON lot_status(site);

-- ─── sales_order: 訂單管理 (for SALES/FAE RLS by region) ───
CREATE TABLE sales_order (
    order_id     TEXT PRIMARY KEY,
    customer     TEXT NOT NULL,
    product_line TEXT NOT NULL,
    chip_model   TEXT NOT NULL,
    quantity     INTEGER NOT NULL,
    unit_price   NUMERIC(10,2) NOT NULL,
    total_amount NUMERIC(12,2) NOT NULL,
    region       TEXT NOT NULL,       -- TW, CN, US, JP, EU
    status       TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, shipped, closed
    order_date   DATE NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sales_order_region ON sales_order(region);
CREATE INDEX idx_sales_order_product_line ON sales_order(product_line);
