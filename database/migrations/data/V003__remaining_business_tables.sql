-- ============================================================
-- Data V003: Create remaining 6 business tables in nexus_data
-- Migrated from V021 (originally in nexus_authz for POC)
-- These tables are needed for the Config-Driven UI Engine
-- ============================================================

-- ─── wip_inventory ───
CREATE TABLE IF NOT EXISTS wip_inventory (
    wip_id        TEXT PRIMARY KEY,
    lot_id        TEXT NOT NULL,
    product_line  TEXT NOT NULL,
    chip_model    TEXT NOT NULL,
    stage         TEXT NOT NULL,
    quantity      INTEGER NOT NULL,
    yield_rate    NUMERIC(5,2),
    operator      TEXT,
    site          TEXT NOT NULL DEFAULT 'HQ',
    status        TEXT NOT NULL DEFAULT 'in_progress',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wip_inventory_product_line ON wip_inventory(product_line);
CREATE INDEX IF NOT EXISTS idx_wip_inventory_lot_id ON wip_inventory(lot_id);

INSERT INTO wip_inventory (wip_id, lot_id, product_line, chip_model, stage, quantity, yield_rate, operator, site, status) VALUES
    ('WIP-001', 'LOT-SSD-001', 'SSD',  'E18',   'ft_test',    4800, 96.00, 'OP-Lin',  'HQ', 'completed'),
    ('WIP-002', 'LOT-SSD-002', 'SSD',  'E18',   'packing',    4700, 94.00, 'OP-Lin',  'HQ', 'in_progress'),
    ('WIP-003', 'LOT-SSD-003', 'SSD',  'E18',   'cp_test',    4500, 90.00, 'OP-Chen', 'HQ', 'on_hold'),
    ('WIP-004', 'LOT-SSD-004', 'SSD',  'E26',   'packing',    4900, 98.00, 'OP-Lin',  'HQ', 'completed'),
    ('WIP-005', 'LOT-SSD-005', 'SSD',  'E26',   'ft_test',    4850, 97.00, 'OP-Wu',   'HQ', 'in_progress'),
    ('WIP-006', 'LOT-EMMC-001','eMMC', 'PS8211','molding',    9600, 96.00, 'OP-Hsu',  'HQ', 'in_progress'),
    ('WIP-007', 'LOT-EMMC-002','eMMC', 'PS8211','ft_test',    9400, 94.00, 'OP-Hsu',  'HQ', 'completed'),
    ('WIP-008', 'LOT-EMMC-003','eMMC', 'PS5021','wire_bond',  9800, 98.00, 'OP-Hsu',  'HQ', 'in_progress'),
    ('WIP-009', 'LOT-SD-001',  'SD',   'PS2251','packing',   19500, 97.50, 'OP-Wang', 'HQ', 'completed'),
    ('WIP-010', 'LOT-SD-002',  'SD',   'PS2251','ft_test',   19000, 95.00, 'OP-Wang', 'HQ', 'in_progress'),
    ('WIP-011', 'LOT-PCIE-001','PCIe', 'PS5025','cp_test',    2400, 96.00, 'OP-Chen', 'HQ', 'in_progress'),
    ('WIP-012', 'LOT-PCIE-002','PCIe', 'PS5025','die_attach',  2500, NULL, 'OP-Chen', 'HQ', 'in_progress');

-- ─── cp_ft_result ───
CREATE TABLE IF NOT EXISTS cp_ft_result (
    test_id       TEXT PRIMARY KEY,
    lot_id        TEXT NOT NULL,
    product_line  TEXT NOT NULL,
    chip_model    TEXT NOT NULL,
    test_type     TEXT NOT NULL,
    pass_count    INTEGER NOT NULL,
    fail_count    INTEGER NOT NULL,
    yield_rate    NUMERIC(5,2) NOT NULL,
    test_program  TEXT NOT NULL,
    tester_id     TEXT,
    site          TEXT NOT NULL DEFAULT 'HQ',
    tested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cp_ft_result_product_line ON cp_ft_result(product_line);
CREATE INDEX IF NOT EXISTS idx_cp_ft_result_lot_id ON cp_ft_result(lot_id);

INSERT INTO cp_ft_result (test_id, lot_id, product_line, chip_model, test_type, pass_count, fail_count, yield_rate, test_program, tester_id, site) VALUES
    ('CP-SSD-001', 'LOT-SSD-001', 'SSD',  'E18',   'CP', 4850, 150, 97.00, 'E18_CP_v3.2',   'T-01', 'HQ'),
    ('FT-SSD-001', 'LOT-SSD-001', 'SSD',  'E18',   'FT', 4800,  50, 98.97, 'E18_FT_v2.1',   'T-02', 'HQ'),
    ('CP-SSD-002', 'LOT-SSD-002', 'SSD',  'E18',   'CP', 4780, 220, 95.60, 'E18_CP_v3.2',   'T-01', 'HQ'),
    ('FT-SSD-002', 'LOT-SSD-002', 'SSD',  'E18',   'FT', 4700,  80, 98.33, 'E18_FT_v2.1',   'T-02', 'HQ'),
    ('CP-SSD-004', 'LOT-SSD-004', 'SSD',  'E26',   'CP', 4950,  50, 99.00, 'E26_CP_v1.5',   'T-03', 'HQ'),
    ('FT-SSD-004', 'LOT-SSD-004', 'SSD',  'E26',   'FT', 4920,  30, 99.39, 'E26_FT_v1.2',   'T-03', 'HQ'),
    ('CP-EMMC-001','LOT-EMMC-001','eMMC', 'PS8211','CP', 9700, 300, 97.00, 'PS8211_CP_v4.0','T-04', 'HQ'),
    ('FT-EMMC-001','LOT-EMMC-001','eMMC', 'PS8211','FT', 9600, 100, 98.96, 'PS8211_FT_v3.1','T-04', 'HQ'),
    ('CP-EMMC-003','LOT-EMMC-003','eMMC', 'PS5021','CP', 9850, 150, 98.50, 'PS5021_CP_v2.0','T-05', 'HQ'),
    ('CP-SD-001',  'LOT-SD-001',  'SD',   'PS2251','CP',19700, 300, 98.50, 'PS2251_CP_v5.0','T-06', 'HQ'),
    ('FT-SD-001',  'LOT-SD-001',  'SD',   'PS2251','FT',19500, 200, 99.00, 'PS2251_FT_v4.2','T-06', 'HQ'),
    ('CP-PCIE-001','LOT-PCIE-001','PCIe', 'PS5025','CP', 2450,  50, 98.00, 'PS5025_CP_v1.0','T-07', 'HQ');

-- ─── npi_gate_checklist ───
CREATE TABLE IF NOT EXISTS npi_gate_checklist (
    gate_id       SERIAL PRIMARY KEY,
    product_line  TEXT NOT NULL,
    chip_model    TEXT NOT NULL,
    gate_phase    TEXT NOT NULL,
    checklist_item TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    owner         TEXT NOT NULL,
    reviewer      TEXT,
    due_date      DATE,
    completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_npi_gate_product_line ON npi_gate_checklist(product_line);

INSERT INTO npi_gate_checklist (product_line, chip_model, gate_phase, checklist_item, status, owner, reviewer, due_date, completed_at) VALUES
    ('SSD', 'E28',  'G0_concept',       'Market analysis report',             'passed', 'user:lin_pm',   'user:chang_vp', '2026-01-15', '2026-01-14'),
    ('SSD', 'E28',  'G0_concept',       'Competitive benchmark',              'passed', 'user:lin_pm',   'user:chang_vp', '2026-01-15', '2026-01-13'),
    ('SSD', 'E28',  'G1_feasibility',   'Architecture spec review',           'passed', 'user:liu_fw',   'user:wang_pe',  '2026-02-28', '2026-02-25'),
    ('SSD', 'E28',  'G1_feasibility',   'Silicon area estimate',              'passed', 'user:tseng_rd', 'user:wang_pe',  '2026-02-28', '2026-02-27'),
    ('SSD', 'E28',  'G2_dev',           'RTL design complete',                'passed', 'user:tseng_rd', 'user:liu_fw',   '2026-04-30', '2026-04-10'),
    ('SSD', 'E28',  'G2_dev',           'Firmware alpha build',               'pending','user:liu_fw',   NULL,             '2026-05-15', NULL),
    ('SSD', 'E28',  'G2_dev',           'CP test program ready',              'pending','user:wang_pe',  NULL,             '2026-05-30', NULL),
    ('SSD', 'E28',  'G3_qualification', 'Reliability qualification (JEDEC)',  'pending','user:huang_qa', NULL,             '2026-07-31', NULL),
    ('SSD', 'E28',  'G3_qualification', 'Customer sample approval',           'pending','user:lee_sales',NULL,             '2026-08-15', NULL),
    ('eMMC','PS8220','G0_concept',      'Market sizing for automotive eMMC',  'passed', 'user:kuo_pm',   'user:chang_vp', '2026-02-01', '2026-01-28'),
    ('eMMC','PS8220','G1_feasibility',  'AEC-Q100 compliance assessment',     'pending','user:huang_qa', NULL,             '2026-04-30', NULL);

-- ─── reliability_report ───
CREATE TABLE IF NOT EXISTS reliability_report (
    report_id      TEXT PRIMARY KEY,
    product_line   TEXT NOT NULL,
    chip_model     TEXT NOT NULL,
    test_type      TEXT NOT NULL,
    test_condition TEXT NOT NULL,
    sample_size    INTEGER NOT NULL,
    pass_count     INTEGER NOT NULL,
    fail_count     INTEGER NOT NULL,
    duration_hours INTEGER,
    failure_mode   TEXT,
    engineer       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'in_progress',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reliability_product_line ON reliability_report(product_line);

INSERT INTO reliability_report (report_id, product_line, chip_model, test_type, test_condition, sample_size, pass_count, fail_count, duration_hours, failure_mode, engineer, status) VALUES
    ('REL-001', 'SSD',  'E18',   'HTOL',    '125C / 1000hrs',    77, 77,  0, 1000, NULL,                     'user:huang_qa', 'passed'),
    ('REL-002', 'SSD',  'E18',   'TC',      '-40~125C / 500cyc', 77, 77,  0,  NULL, NULL,                    'user:huang_qa', 'passed'),
    ('REL-003', 'SSD',  'E18',   'UHAST',   '130C/85%RH/96hrs',  77, 76,  1,   96, 'Corrosion on pad',       'user:huang_qa', 'failed'),
    ('REL-004', 'SSD',  'E26',   'HTOL',    '125C / 1000hrs',    77, 77,  0, 1000, NULL,                     'user:huang_qa', 'passed'),
    ('REL-005', 'SSD',  'E26',   'ESD',     'HBM 2kV / CDM 500V', 30, 30,  0,  NULL, NULL,                   'user:huang_qa', 'passed'),
    ('REL-006', 'eMMC', 'PS8211','HTOL',    '125C / 1000hrs',    77, 77,  0, 1000, NULL,                     'user:huang_qa', 'passed'),
    ('REL-007', 'eMMC', 'PS8211','TC',      '-40~125C / 500cyc', 77, 77,  0,  NULL, NULL,                    'user:huang_qa', 'passed'),
    ('REL-008', 'eMMC', 'PS5021','HTOL',    '125C / 500hrs',     77, 77,  0,  500, NULL,                     'user:huang_qa', 'in_progress'),
    ('REL-009', 'SD',   'PS2251','Latch-up','JEDEC standard',      10, 10,  0,  NULL, NULL,                    'user:huang_qa', 'passed'),
    ('REL-010', 'PCIe', 'PS5025','ESD',     'HBM 4kV / CDM 750V', 30, 29,  1,  NULL, 'ESD fail at pad 37',   'user:huang_qa', 'failed');

-- ─── rma_record ───
CREATE TABLE IF NOT EXISTS rma_record (
    rma_id             TEXT PRIMARY KEY,
    customer           TEXT NOT NULL,
    product_line       TEXT NOT NULL,
    chip_model         TEXT NOT NULL,
    quantity           INTEGER NOT NULL,
    failure_description TEXT NOT NULL,
    root_cause         TEXT,
    status             TEXT NOT NULL DEFAULT 'open',
    region             TEXT NOT NULL,
    created_by         TEXT NOT NULL,
    assigned_to        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rma_product_line ON rma_record(product_line);
CREATE INDEX IF NOT EXISTS idx_rma_region ON rma_record(region);

INSERT INTO rma_record (rma_id, customer, product_line, chip_model, quantity, failure_description, root_cause, status, region, created_by, assigned_to) VALUES
    ('RMA-001', 'Kingston',   'SSD',  'E18',   500,  'Random read timeout after 6 months',      'FW bug in wear-leveling',        'resolved', 'US', 'user:smith_sales', 'user:liu_fw'),
    ('RMA-002', 'Samsung',    'SSD',  'E18',   200,  'SMART health warning at 80% TBW',         NULL,                              'analyzing','US', 'user:smith_sales', 'user:wang_pe'),
    ('RMA-003', 'Longsys',    'eMMC', 'PS8211', 1000, 'Boot failure after power cycle test',     'Capacitor decoupling issue',     'closed',   'CN', 'user:zhang_sales', 'user:chen_pe'),
    ('RMA-004', 'ADATA',      'SSD',  'E26',    150,  'Performance degradation under sustained write', NULL,                       'open',     'TW', 'user:lee_sales',   NULL),
    ('RMA-005', 'Transcend',  'SD',   'PS2251',  800, 'CRC error in cold temperature (-20C)',   'Clock timing margin too tight',  'resolved', 'TW', 'user:lee_sales',   'user:wang_pe'),
    ('RMA-006', 'SK Hynix',   'eMMC', 'PS5021',  300, 'UFS HS-G4 link training failure',        NULL,                              'analyzing','US', 'user:smith_sales', 'user:chen_pe'),
    ('RMA-007', 'Xiaomi',     'eMMC', 'PS8211', 2000, 'Endurance test fail at 3000 P/E cycles',  NULL,                             'open',     'CN', 'user:zhang_sales', NULL);

-- ─── price_book ───
CREATE TABLE IF NOT EXISTS price_book (
    price_id       SERIAL PRIMARY KEY,
    product_line   TEXT NOT NULL,
    chip_model     TEXT NOT NULL,
    customer_tier  TEXT NOT NULL,
    unit_price     NUMERIC(10,2) NOT NULL,
    cost           NUMERIC(10,2) NOT NULL,
    margin         NUMERIC(5,2) NOT NULL,
    volume_discount NUMERIC(5,2) DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'USD',
    effective_date DATE NOT NULL,
    valid_until    DATE,
    region         TEXT NOT NULL DEFAULT 'GLOBAL'
);
CREATE INDEX IF NOT EXISTS idx_price_book_product_line ON price_book(product_line);
CREATE INDEX IF NOT EXISTS idx_price_book_customer_tier ON price_book(customer_tier);

INSERT INTO price_book (product_line, chip_model, customer_tier, unit_price, cost, margin, volume_discount, effective_date, valid_until, region) VALUES
    ('SSD',  'E18',   'tier1',       11.00, 6.50, 40.91, 5.0,  '2026-01-01', '2026-06-30', 'GLOBAL'),
    ('SSD',  'E18',   'tier2',       12.50, 6.50, 48.00, 3.0,  '2026-01-01', '2026-06-30', 'GLOBAL'),
    ('SSD',  'E18',   'tier3',       13.50, 6.50, 51.85, 0.0,  '2026-01-01', '2026-06-30', 'GLOBAL'),
    ('SSD',  'E18',   'distributor', 10.00, 6.50, 35.00, 8.0,  '2026-01-01', '2026-06-30', 'GLOBAL'),
    ('SSD',  'E26',   'tier1',       16.50, 9.00, 45.45, 5.0,  '2026-01-01', '2026-06-30', 'GLOBAL'),
    ('SSD',  'E26',   'tier2',       18.00, 9.00, 50.00, 3.0,  '2026-01-01', '2026-06-30', 'GLOBAL'),
    ('SSD',  'E26',   'tier3',       19.50, 9.00, 53.85, 0.0,  '2026-01-01', '2026-06-30', 'GLOBAL'),
    ('eMMC', 'PS8211','tier1',        2.85, 1.70, 40.35, 5.0,  '2026-01-01', '2026-12-31', 'GLOBAL'),
    ('eMMC', 'PS8211','tier2',        3.20, 1.70, 46.88, 3.0,  '2026-01-01', '2026-12-31', 'GLOBAL'),
    ('eMMC', 'PS5021','tier1',        4.00, 2.50, 37.50, 5.0,  '2026-01-01', '2026-12-31', 'GLOBAL'),
    ('eMMC', 'PS5021','tier2',        4.50, 2.50, 44.44, 3.0,  '2026-01-01', '2026-12-31', 'GLOBAL'),
    ('SD',   'PS2251','tier1',        1.30, 0.80, 38.46, 5.0,  '2026-01-01', NULL,          'GLOBAL'),
    ('SD',   'PS2251','tier2',        1.50, 0.80, 46.67, 3.0,  '2026-01-01', NULL,          'GLOBAL'),
    ('SD',   'PS3111','tier1',        1.80, 1.15, 36.11, 5.0,  '2026-01-01', NULL,          'GLOBAL'),
    ('SD',   'PS3111','tier2',        2.10, 1.15, 45.24, 3.0,  '2026-01-01', NULL,          'GLOBAL'),
    ('PCIe', 'PS5025','tier1',        7.80, 4.60, 41.03, 5.0,  '2026-01-01', '2026-06-30', 'GLOBAL'),
    ('PCIe', 'PS5025','tier2',        8.50, 4.60, 45.88, 3.0,  '2026-01-01', '2026-06-30', 'GLOBAL');
