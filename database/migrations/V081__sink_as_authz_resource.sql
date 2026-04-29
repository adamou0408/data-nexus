-- ============================================================
-- V081: Sink-as-authz_resource — Tier B page lifecycle primitive
--
-- Plan: .claude/plans/v3-phase-1/sink-as-authz-resource-plan.md
--
-- ── Problem ──
--   authz_ui_page (Tier B sink artifact) and authz_resource (module
--   tree SSOT) are two independent FK trees. Pages saved via DAG
--   sink (V054 snapshot path) have no surface in ModulesTab and do
--   not participate in V070 cascade / V079 cascade_policy. Effect:
--   reload-loss + RBAC isolation.
--
-- ── Choice ──
--   Mirror dag-origin authz_ui_page rows into authz_resource using
--   the EXISTING 'page' resource_type (already in CHECK constraint
--   since pre-V042; already recognised by authz_resolve V060/V066/
--   V067 cascade). No constraint widening; cascade is free.
--
--   resource_id format: 'page:' || page_id
--   parent_id rule:     dag's parent_id (so page inherits from the
--                       module the dag lives under). Fallback when
--                       dag.parent_id IS NULL: module:pg_tiptop_v1
--                       (per plan §3.3 — current dev DB only has
--                       tiptop content; PROD backfill should re-eval).
--
-- ── Scope of this migration ──
--   1. Backfill ONLY pages with snapshot_data->'origin'->>'kind' = 'dag'
--      (sink artifacts). System pages like modules_home / npi_gate_console
--      are explicitly skipped — they have no module lifecycle gap.
--   2. Add 'pages' sub-tab descriptor to authz_ui_descriptor for
--      modules_home so ModuleDetail renders the new leaf.
--
-- ── Out of scope ──
--   - Live re-execution sink (refresh-sink primitive)
--   - Page rename / move-to-module UI
--   - sink_kind != 'page' authz_resource rows
--
-- ── Cascade policy default ──
--   resource_type='page' inherits the default behaviour of V079
--   authz_resource_cascade_policy. No row added here = falls through
--   to whatever the framework's default is for unknown types. Plan §3
--   open question (rename/soft-delete cascade) deferred to executor
--   of refresh-sink primitive.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Backfill dag-origin authz_ui_page → authz_resource('page')
-- ────────────────────────────────────────────────────────────

INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
SELECT
  'page:' || p.page_id                                                          AS resource_id,
  'page'                                                                        AS resource_type,
  COALESCE(d.parent_id, 'module:pg_tiptop_v1')                                  AS parent_id,
  p.title                                                                       AS display_name,
  jsonb_build_object(
    'page_id',     p.page_id,
    'origin_kind', p.snapshot_data->'origin'->>'kind',
    'dag_id',      p.snapshot_data->'origin'->>'dag_id',
    'node_id',     p.snapshot_data->'origin'->>'node_id'
  )                                                                             AS attributes,
  p.is_active
FROM authz_ui_page p
LEFT JOIN authz_resource d
       ON d.resource_id = p.snapshot_data->'origin'->>'dag_id'
      AND d.resource_type = 'dag'
WHERE p.snapshot_data IS NOT NULL
  AND p.snapshot_data->'origin'->>'kind' = 'dag'
ON CONFLICT (resource_id) DO UPDATE
  SET parent_id    = EXCLUDED.parent_id,
      display_name = EXCLUDED.display_name,
      attributes   = EXCLUDED.attributes,
      is_active    = EXCLUDED.is_active;

-- ────────────────────────────────────────────────────────────
-- 2. Refresh module_tree_stats so the new 'page' children
--    propagate into the cached counts (used by ModuleDetail).
-- ────────────────────────────────────────────────────────────

SELECT refresh_module_tree_stats();

-- ────────────────────────────────────────────────────────────
-- 3. ModuleDetail 'pages' sub-tab descriptor
-- ────────────────────────────────────────────────────────────

INSERT INTO authz_ui_descriptor
  (descriptor_id, page_id, section_key, section_label, section_icon, display_order, visibility, columns, render_hints)
VALUES (
  'modules_home:pages',
  'modules_home',
  'pages',
  'Pages',
  'file-text',
  5,
  'read',
  '[
    {"key": "display_name", "label": "Page",   "type": "text", "render_hint": "mono_icon", "width": "flex"},
    {"key": "page_id",      "label": "Page ID","type": "text", "render_hint": "mono_truncate", "width": "180px"},
    {"key": "dag_id",       "label": "Source DAG","type": "text", "render_hint": "mono_truncate", "width": "200px"}
  ]'::jsonb,
  '{"grid_type": "table", "empty_icon": "file-text", "empty_message": "No saved pages under this module yet — save a DAG snapshot via Composer to populate."}'::jsonb
)
ON CONFLICT (page_id, section_key) DO UPDATE SET
  section_label = EXCLUDED.section_label,
  section_icon  = EXCLUDED.section_icon,
  display_order = EXCLUDED.display_order,
  visibility    = EXCLUDED.visibility,
  columns       = EXCLUDED.columns,
  render_hints  = EXCLUDED.render_hints;

COMMIT;

-- ── Post-migration verification (run manually) ──
-- SELECT resource_id, parent_id, display_name
-- FROM authz_resource WHERE resource_type = 'page' ORDER BY 1;
--
-- Expected after dev backfill:
--   page:dag_test__n1_snapshot | module:pg_tiptop_v1 | get_work_orders_by_part — snapshot
--   page:dag_test__n4_snapshot | module:pg_tiptop_v1 | fn_cxmzr115_shipment_history_by_material_no — snapshot
