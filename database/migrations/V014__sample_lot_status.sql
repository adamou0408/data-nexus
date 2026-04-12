-- ============================================================
-- V014: Sample business tables for RLS simulation
-- Aligned with Phison Electronics product lines & operations
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

INSERT INTO lot_status (lot_id, product_line, chip_model, grade, unit_price, cost, customer, wafer_lot, site, status) VALUES
    -- SSD Controller lots (E18/E26 series)
    ('LOT-SSD-001', 'SSD', 'E18',   'A+', 12.50, 6.80, 'Samsung',    'WF-2024-A01', 'HQ', 'active'),
    ('LOT-SSD-002', 'SSD', 'E18',   'A',  11.20, 6.50, 'WD',         'WF-2024-A01', 'HQ', 'active'),
    ('LOT-SSD-003', 'SSD', 'E18',   'B',   9.80, 6.50, 'Kingston',   'WF-2024-A02', 'HQ', 'hold'),
    ('LOT-SSD-004', 'SSD', 'E26',   'A+', 18.00, 9.20, 'Micron',     'WF-2024-B01', 'HQ', 'shipped'),
    ('LOT-SSD-005', 'SSD', 'E26',   'A',  16.50, 9.00, 'SK Hynix',   'WF-2024-B01', 'HQ', 'active'),
    ('LOT-SSD-006', 'SSD', 'E26',   'A+', 17.80, 9.10, 'Corsair',    'WF-2024-B02', 'HQ', 'active'),
    ('LOT-SSD-007', 'SSD', 'E18',   'A',  11.00, 6.40, 'ADATA',      'WF-2024-A03', 'HQ', 'shipped'),
    ('LOT-SSD-008', 'SSD', 'E18',   'C',   7.50, 6.30, 'PNY',        'WF-2024-A03', 'HQ', 'scrapped'),

    -- eMMC/UFS Controller lots (PS8211/PS5021)
    ('LOT-EMMC-001','eMMC', 'PS8211','A+', 3.20,  1.80, 'Samsung',    'WF-2024-C01', 'HQ', 'active'),
    ('LOT-EMMC-002','eMMC', 'PS8211','A',  2.90,  1.70, 'Kioxia',     'WF-2024-C01', 'HQ', 'active'),
    ('LOT-EMMC-003','eMMC', 'PS5021','A+', 4.50,  2.60, 'SK Hynix',   'WF-2024-C02', 'HQ', 'active'),
    ('LOT-EMMC-004','eMMC', 'PS5021','B',  3.80,  2.50, 'Micron',     'WF-2024-C02', 'HQ', 'hold'),
    ('LOT-EMMC-005','eMMC', 'PS8211','A',  2.85,  1.65, 'Longsys',    'WF-2024-C03', 'HK', 'shipped'),

    -- SD Controller lots (PS2251/PS3111)
    ('LOT-SD-001',  'SD',  'PS2251','A+', 1.50,  0.85, 'Transcend',  'WF-2024-D01', 'HQ', 'active'),
    ('LOT-SD-002',  'SD',  'PS2251','A',  1.35,  0.80, 'ADATA',      'WF-2024-D01', 'HQ', 'active'),
    ('LOT-SD-003',  'SD',  'PS3111','A+', 2.10,  1.20, 'Kingston',   'WF-2024-D02', 'HQ', 'active'),
    ('LOT-SD-004',  'SD',  'PS3111','B',  1.80,  1.15, 'PNY',        'WF-2024-D02', 'HQ', 'hold'),
    ('LOT-SD-005',  'SD',  'PS2251','A',  1.30,  0.78, 'Silicon Power','WF-2024-D03','JP', 'shipped'),

    -- PCIe Bridge lots (PS5025)
    ('LOT-PCIE-001','PCIe','PS5025','A+', 8.50,  4.80, 'ASMedia',    'WF-2024-E01', 'HQ', 'active'),
    ('LOT-PCIE-002','PCIe','PS5025','A',  7.80,  4.60, 'Realtek',    'WF-2024-E01', 'HQ', 'active'),
    ('LOT-PCIE-003','PCIe','PS5025','B',  6.20,  4.50, 'Innodisk',   'WF-2024-E02', 'JP', 'hold');

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

INSERT INTO sales_order (order_id, customer, product_line, chip_model, quantity, unit_price, total_amount, region, status, order_date) VALUES
    -- Taiwan region orders
    ('ORD-TW-001', 'Transcend',       'SD',   'PS2251', 50000,  1.50,  75000.00, 'TW', 'confirmed', '2026-03-15'),
    ('ORD-TW-002', 'ADATA',           'SSD',  'E18',    20000, 11.20, 224000.00, 'TW', 'shipped',   '2026-03-20'),
    ('ORD-TW-003', 'Silicon Power',   'SD',   'PS3111',100000,  2.10, 210000.00, 'TW', 'pending',   '2026-04-01'),
    ('ORD-TW-004', 'Innodisk',        'PCIe', 'PS5025',  5000,  8.50,  42500.00, 'TW', 'confirmed', '2026-04-05'),

    -- China region orders
    ('ORD-CN-001', 'Longsys',         'eMMC', 'PS8211',200000,  2.90, 580000.00, 'CN', 'confirmed', '2026-03-10'),
    ('ORD-CN-002', 'YMTC',            'SSD',  'E26',    30000, 16.50, 495000.00, 'CN', 'pending',   '2026-03-25'),
    ('ORD-CN-003', 'Lenovo',          'eMMC', 'PS5021', 80000,  4.50, 360000.00, 'CN', 'shipped',   '2026-04-02'),
    ('ORD-CN-004', 'Xiaomi',          'eMMC', 'PS8211',150000,  2.85, 427500.00, 'CN', 'confirmed', '2026-04-08'),

    -- US/EU region orders
    ('ORD-US-001', 'Samsung',          'SSD',  'E18',   100000, 12.50,1250000.00, 'US', 'confirmed', '2026-03-01'),
    ('ORD-US-002', 'WD',               'SSD',  'E26',    50000, 18.00, 900000.00, 'US', 'shipped',   '2026-03-12'),
    ('ORD-US-003', 'Micron',           'SSD',  'E26',    40000, 17.80, 712000.00, 'US', 'pending',   '2026-04-01'),
    ('ORD-US-004', 'SK Hynix',         'eMMC', 'PS5021', 60000,  4.50, 270000.00, 'US', 'confirmed', '2026-04-10'),
    ('ORD-US-005', 'Kingston',          'SSD',  'E18',    80000, 11.00, 880000.00, 'US', 'confirmed', '2026-04-11'),
    ('ORD-US-006', 'Corsair',           'SSD',  'E26',    25000, 17.80, 445000.00, 'US', 'pending',   '2026-04-12');
