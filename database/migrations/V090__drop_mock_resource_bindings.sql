-- ============================================================
-- ARCH-02 — Drop mock business-table authz bindings + nexus_authz residue
--
-- Companion to data/V008 which drops the 14 mock tables from nexus_data.
-- This migration:
--   (a) Removes authz_role_permission / authz_policy / authz_resource
--       rows that referenced the mock business tables and their columns.
--   (b) DROPs the pre-ARCH-01 residual tables that V014 + V021 created
--       directly in nexus_authz (lot_status, sales_order, wip_inventory,
--       cp_ft_result, npi_gate_checklist, reliability_report, rma_record,
--       price_book). Those tables predate ARCH-01 and are no longer
--       reachable via Path C — strict belt-and-braces cleanup.
--
-- Idempotent. Order matters: delete dependent permissions/policies
-- before resources (FK to authz_resource).
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. Drop role_permission rows referencing mock resources
-- ──────────────────────────────────────────────────────────────
DELETE FROM authz_role_permission
WHERE resource_id LIKE 'table:lot_status%'
   OR resource_id LIKE 'table:sales_order%'
   OR resource_id LIKE 'table:cp_ft_result%'
   OR resource_id LIKE 'table:wip_inventory%'
   OR resource_id LIKE 'table:reliability_report%'
   OR resource_id LIKE 'table:rma_record%'
   OR resource_id LIKE 'table:price_book%'
   OR resource_id LIKE 'table:npi_gate_checklist%'
   OR resource_id LIKE 'table:yield_events%'
   OR resource_id LIKE 'table:lot_status_history%'
   OR resource_id LIKE 'table:lot_daily_flow%'
   OR resource_id LIKE 'table:yield_daily_trend%'
   OR resource_id LIKE 'table:v_lot_status_pe%'
   OR resource_id LIKE 'table:v_lot_status_sales%'
   OR resource_id LIKE 'column:lot_status.%'
   OR resource_id LIKE 'column:sales_order.%'
   OR resource_id LIKE 'column:cp_ft_result.%'
   OR resource_id LIKE 'column:wip_inventory.%'
   OR resource_id LIKE 'column:reliability_report.%'
   OR resource_id LIKE 'column:rma_record.%'
   OR resource_id LIKE 'column:price_book.%'
   OR resource_id LIKE 'column:npi_gate_checklist.%'
   OR resource_id LIKE 'column:yield_events.%';

-- ──────────────────────────────────────────────────────────────
-- 2. Drop ABAC policies bound to mock resources
-- ──────────────────────────────────────────────────────────────
DELETE FROM authz_policy
WHERE resource_id LIKE 'table:lot_status%'
   OR resource_id LIKE 'table:sales_order%'
   OR resource_id LIKE 'table:cp_ft_result%'
   OR resource_id LIKE 'table:wip_inventory%'
   OR resource_id LIKE 'table:reliability_report%'
   OR resource_id LIKE 'table:rma_record%'
   OR resource_id LIKE 'table:price_book%'
   OR resource_id LIKE 'table:npi_gate_checklist%'
   OR resource_id LIKE 'table:yield_events%'
   OR resource_id LIKE 'table:lot_status_history%'
   OR resource_id LIKE 'table:lot_daily_flow%'
   OR resource_id LIKE 'table:yield_daily_trend%'
   OR resource_id LIKE 'table:v_lot_status_pe%'
   OR resource_id LIKE 'table:v_lot_status_sales%'
   OR resource_id LIKE 'column:lot_status.%'
   OR resource_id LIKE 'column:sales_order.%'
   OR resource_id LIKE 'column:cp_ft_result.%'
   OR resource_id LIKE 'column:wip_inventory.%'
   OR resource_id LIKE 'column:reliability_report.%'
   OR resource_id LIKE 'column:rma_record.%'
   OR resource_id LIKE 'column:price_book.%'
   OR resource_id LIKE 'column:npi_gate_checklist.%'
   OR resource_id LIKE 'column:yield_events.%';

-- ──────────────────────────────────────────────────────────────
-- 3. Drop authz_resource rows (columns first, then tables — FK self-ref)
-- ──────────────────────────────────────────────────────────────
DELETE FROM authz_resource
WHERE resource_type = 'column'
  AND (
       resource_id LIKE 'column:lot_status.%'
    OR resource_id LIKE 'column:sales_order.%'
    OR resource_id LIKE 'column:cp_ft_result.%'
    OR resource_id LIKE 'column:wip_inventory.%'
    OR resource_id LIKE 'column:reliability_report.%'
    OR resource_id LIKE 'column:rma_record.%'
    OR resource_id LIKE 'column:price_book.%'
    OR resource_id LIKE 'column:npi_gate_checklist.%'
    OR resource_id LIKE 'column:yield_events.%'
  );

DELETE FROM authz_resource
WHERE resource_type IN ('table', 'view')
  AND resource_id IN (
    'table:lot_status',
    'table:sales_order',
    'table:cp_ft_result',
    'table:wip_inventory',
    'table:reliability_report',
    'table:rma_record',
    'table:price_book',
    'table:npi_gate_checklist',
    'table:yield_events',
    'table:lot_status_history',
    'table:lot_daily_flow',
    'table:yield_daily_trend',
    'table:v_lot_status_pe',
    'table:v_lot_status_sales',
    'view:v_lot_status_pe',
    'view:v_lot_status_sales'
  );

-- ──────────────────────────────────────────────────────────────
-- 4. Drop nexus_authz residual tables from V014 + V021 (pre-ARCH-01)
--    These should never have lived in the policy DB. Path C
--    targets nexus_data + remote pools instead.
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.lot_status         CASCADE;
DROP TABLE IF EXISTS public.sales_order        CASCADE;
DROP TABLE IF EXISTS public.wip_inventory      CASCADE;
DROP TABLE IF EXISTS public.cp_ft_result       CASCADE;
DROP TABLE IF EXISTS public.npi_gate_checklist CASCADE;
DROP TABLE IF EXISTS public.reliability_report CASCADE;
DROP TABLE IF EXISTS public.rma_record         CASCADE;
DROP TABLE IF EXISTS public.price_book         CASCADE;
