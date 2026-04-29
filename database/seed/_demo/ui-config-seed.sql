-- ============================================================
-- Config-Driven UI Seed Data (LEGACY DEMO)
-- ============================================================
-- Moved to _demo/ on 2026-04-27 — all 8 page rows below bind to mock
-- modules (module:mrp.*, module:sales.*, module:quality.*) that were
-- removed from dev-seed.sql when mock data was purged. Reapplying this
-- file would fail the FK to authz_resource(resource_id) unless those
-- mock modules are recreated first.
--
-- Files under database/seed/_demo/ are NOT auto-loaded by
-- deploy/docker-compose/init-db.sh (its glob is `seed/*.sql`,
-- non-recursive). Apply manually only for legacy Path A demos.
--
-- Depends on: dev-seed.sql (authz_resource entries must exist)
-- Populates: authz_ui_page (UI page definitions — SSOT)
-- ============================================================

INSERT INTO authz_ui_page (page_id, title, subtitle, layout, resource_id, data_table, order_by, row_limit, icon, description, display_order, row_drilldown, columns_override, filters_config) VALUES
(
    'lot_explorer',
    'Lot Status Explorer',
    'Production lot tracking across all product lines',
    'table',
    'module:mrp.lot_tracking',
    'lot_status',
    'lot_id',
    1000,
    'package',
    'Track production lots, grades, and shipping status',
    10,
    '{"page_id": "lot_detail", "param_mapping": {"lot_id": "$row.lot_id", "product_line": "$row.product_line"}}'::jsonb,
    '{
        "grade":      {"render": "status_badge", "sortable": true, "help_text": "A/B/C 等級由 final-test yield 與外觀檢驗決定;A=>98% pass、B=95-98%、C<95%"},
        "status":     {"render": "status_badge", "sortable": true, "help_text": "WIP=製程中、QC=待品檢、SHIPPED=已出貨;批號狀態由 ERP 即時同步"},
        "unit_price": {"align": "right", "sortable": true},
        "cost":       {"align": "right", "sortable": true},
        "lot_id":     {"sortable": true, "help_text": "格式 LOTYYYYMMDD-NNN;同一 lot_id 對應同 wafer 起始批"},
        "product_line": {"sortable": true},
        "chip_model": {"sortable": true},
        "customer":   {"sortable": true}
    }'::jsonb,
    '[
        {"field": "product_line", "type": "select"},
        {"field": "status",       "type": "select", "help_text": "篩選批號狀態;選 All 顯示全部"},
        {"field": "site",         "type": "select"}
    ]'::jsonb
),
(
    'lot_detail',
    'Lot Detail — WIP Inventory',
    NULL,
    'table',
    'module:mrp.lot_tracking',
    'wip_inventory',
    'wip_id',
    500,
    'layers',
    'Work-in-progress inventory for a specific lot',
    0,
    NULL,
    '{
        "stage":      {"render": "phase_tag", "sortable": true},
        "status":     {"render": "status_badge", "sortable": true},
        "yield_rate": {"render": "yield_bar", "align": "right"},
        "quantity":   {"align": "right"}
    }'::jsonb,
    '[
        {"field": "stage",  "type": "select"},
        {"field": "status", "type": "select"}
    ]'::jsonb
),
(
    'test_results',
    'CP/FT Test Results',
    'Chip Probing & Final Test yield analysis',
    'table',
    'module:mrp.yield_analysis',
    'cp_ft_result',
    'tested_at DESC',
    1000,
    'flask-conical',
    'View CP and FT test results and yield rates',
    15,
    NULL,
    '{
        "test_type":  {"render": "phase_tag", "sortable": true, "help_text": "CP=Chip Probing(裸 die 測試)、FT=Final Test(封裝後測試)"},
        "yield_rate": {"render": "yield_bar", "align": "right", "help_text": "良率 = pass_count / (pass_count + fail_count);<90% 進 RMA review"},
        "pass_count": {"align": "right"},
        "fail_count": {"align": "right"},
        "lot_id":     {"sortable": true}
    }'::jsonb,
    '[
        {"field": "product_line", "type": "select"},
        {"field": "test_type",    "type": "select"},
        {"field": "site",         "type": "select"}
    ]'::jsonb
),
(
    'sales_orders',
    'Sales Orders',
    'Customer order management across all regions',
    'table',
    'module:sales.order_mgmt',
    'sales_order',
    'order_date DESC',
    1000,
    'shopping-cart',
    'Browse and filter sales orders by region, product, and status',
    20,
    NULL,
    '{
        "status":       {"render": "status_badge", "sortable": true},
        "unit_price":   {"align": "right"},
        "total_amount": {"align": "right"},
        "quantity":     {"align": "right"},
        "order_date":   {"sortable": true},
        "customer":     {"sortable": true},
        "region":       {"sortable": true}
    }'::jsonb,
    '[
        {"field": "region",       "type": "select"},
        {"field": "product_line", "type": "select"},
        {"field": "status",       "type": "select"}
    ]'::jsonb
),
(
    'npi_checklist',
    'NPI Gate Checklist',
    'New Product Introduction gate review tracking',
    'table',
    'module:mrp.npi',
    'npi_gate_checklist',
    'gate_phase, gate_id',
    500,
    'clipboard-check',
    'Track NPI gate phases and checklist item status',
    25,
    NULL,
    '{
        "gate_phase": {"render": "gate_badge", "sortable": true},
        "status":     {"render": "status_badge", "sortable": true},
        "due_date":   {"sortable": true}
    }'::jsonb,
    '[
        {"field": "product_line", "type": "select"},
        {"field": "gate_phase",   "type": "select"},
        {"field": "status",       "type": "select"}
    ]'::jsonb
),
(
    'quality_reports',
    'Reliability Reports',
    'Product reliability test results and compliance',
    'table',
    'module:quality.reliability',
    'reliability_report',
    'created_at DESC',
    1000,
    'shield-check',
    'Reliability testing: HTOL, TC, UHAST, ESD, Latch-up',
    30,
    NULL,
    '{
        "test_type":  {"render": "phase_tag", "sortable": true},
        "status":     {"render": "status_badge", "sortable": true},
        "pass_count": {"align": "right"},
        "fail_count": {"align": "right"},
        "sample_size": {"align": "right"},
        "duration_hours": {"align": "right"}
    }'::jsonb,
    '[
        {"field": "product_line", "type": "select"},
        {"field": "test_type",    "type": "select"},
        {"field": "status",       "type": "select"}
    ]'::jsonb
),
(
    'rma_records',
    'RMA Records',
    'Return merchandise authorization tracking',
    'table',
    'module:quality.rma',
    'rma_record',
    'created_at DESC',
    1000,
    'undo-2',
    'Track customer returns, root cause analysis, and resolution',
    35,
    NULL,
    '{
        "status":   {"render": "status_badge", "sortable": true},
        "quantity": {"align": "right"},
        "customer": {"sortable": true},
        "region":   {"sortable": true}
    }'::jsonb,
    '[
        {"field": "product_line", "type": "select"},
        {"field": "status",       "type": "select"},
        {"field": "region",       "type": "select"}
    ]'::jsonb
),
(
    'price_book',
    'Price Book',
    'Product pricing by customer tier and region',
    'table',
    'module:sales.pricing',
    'price_book',
    'product_line, customer_tier',
    500,
    'dollar-sign',
    'Manage unit pricing, costs, margins, and volume discounts',
    40,
    NULL,
    '{
        "unit_price":      {"align": "right", "sortable": true},
        "cost":            {"align": "right"},
        "margin":          {"align": "right"},
        "volume_discount": {"align": "right"},
        "customer_tier":   {"render": "status_badge", "sortable": true},
        "effective_date":  {"sortable": true}
    }'::jsonb,
    '[
        {"field": "product_line",  "type": "select"},
        {"field": "customer_tier", "type": "select"},
        {"field": "region",        "type": "select"}
    ]'::jsonb
);

-- Set lot_detail as child of lot_explorer (not shown as top-level card)
UPDATE authz_ui_page SET parent_page_id = 'lot_explorer' WHERE page_id = 'lot_detail';
