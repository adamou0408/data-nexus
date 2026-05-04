-- ============================================================
-- V092 — XDB-TIER-B-L4: render_mode (snapshot|live) + column_renames
--
-- Plan: .claude/plans/v3-phase-1/cross-db-tier-b-integration.md §4 L4
--
-- ── Problem ──
--   L4.1 lets the curator pick how the page renders at consumer time:
--     - snapshot: freeze the DAG outputs at publish time, return them
--                 verbatim on render. Authz is the curator's at freeze
--                 time. Fast path (no re-execute) but stale.
--     - live:     re-execute the DAG at render time under the caller's
--                 identity. authz_check resolves against current role,
--                 so role changes take effect immediately. Slower but
--                 always fresh + authz-correct.
--
--   L4.3 lets the curator rename columns at publish time when cross-DS
--   exposed nodes collide on a flat name (e.g., 'id' from ds_a.fn_a
--   and 'id' from ds_b.fn_b). Renames are persisted so re-rendering
--   (live mode) re-applies the same map and consumers see stable names.
--
-- ── Choice ──
--   Two new columns on authz_ui_page:
--     - render_mode      TEXT  NOT NULL DEFAULT 'snapshot' CHECK ('snapshot'|'live')
--     - column_renames   JSONB NOT NULL DEFAULT '{}'::jsonb
--                        Shape: { "<node_id>__<column_name>": "<new_name>" }
--
--   `render_mode` is ORTHOGONAL to `dag_snapshot.display_mode` (V086
--   added 'tabular'|'explorer' for the renderer split). The two axes
--   compose freely: tabular+snapshot, tabular+live, explorer+snapshot,
--   explorer+live are all valid. DO NOT conflate them — display_mode
--   answers "how is the page laid out", render_mode answers "is the
--   data frozen or live".
--
--   Snapshot mode also persists the frozen outputs in dag_snapshot
--   under key `cached_outputs` (route-side JSONB write, no schema
--   change needed there — dag_snapshot is free-form jsonb).
--
-- ── Backfill ──
--   Existing rows default to 'snapshot' for `render_mode`. That is
--   intentionally NOT current behaviour (today the route always
--   re-executes when params are non-empty), but the freeze step at
--   publish time is now the contract; existing rows have no
--   `cached_outputs` so the route's snapshot branch falls back to
--   live behaviour for legacy rows (see config-exec.ts).
--
-- ── Rollback ──
--   ALTER TABLE authz_ui_page DROP COLUMN render_mode, DROP COLUMN column_renames;
--   (dag_snapshot.cached_outputs is jsonb — no migration needed to drop.)
-- ============================================================

BEGIN;

ALTER TABLE authz_ui_page
  ADD COLUMN IF NOT EXISTS render_mode    text  NOT NULL DEFAULT 'snapshot',
  ADD COLUMN IF NOT EXISTS column_renames jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE authz_ui_page
  DROP CONSTRAINT IF EXISTS authz_ui_page_render_mode_check;
ALTER TABLE authz_ui_page
  ADD CONSTRAINT authz_ui_page_render_mode_check
  CHECK (render_mode IN ('snapshot', 'live'));

COMMENT ON COLUMN authz_ui_page.render_mode IS
  'XDB-TIER-B-L4.1: ''snapshot'' = return frozen rows from dag_snapshot.cached_outputs '
  '(authz baked at publish time); ''live'' = re-execute DAG at render time under '
  'caller authz. Orthogonal to dag_snapshot.display_mode (tabular|explorer).';
COMMENT ON COLUMN authz_ui_page.column_renames IS
  'XDB-TIER-B-L4.3: rename map applied at render time. Shape: '
  '{"<node_id>__<column_name>": "<new_name>"}. Empty {} = no renames. '
  'Required entries are computed at publish time when cross-DS exposed '
  'nodes produce duplicate flat column names — publish endpoint returns '
  'HTTP 409 with the conflict list until curator supplies rename values.';

-- Re-create fn_ui_page() so the renderer (config-exec) sees the new fields.
-- Body identical to V086 plus the two new keys. No semantic change for
-- existing snapshot/published-dag pages because the new columns are scalar
-- with safe defaults.
CREATE OR REPLACE FUNCTION fn_ui_page(p_page_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'config', jsonb_build_object(
            'page_id',           p.page_id,
            'title',             p.title,
            'subtitle',          p.subtitle,
            'layout',            p.layout,
            'resource_id',       p.resource_id,
            'data_table',        p.data_table,
            'order_by',          p.order_by,
            'row_limit',         p.row_limit,
            'row_drilldown',     p.row_drilldown,
            'columns_override',  p.columns_override,
            'filters_config',    p.filters_config,
            'icon',              p.icon,
            'description',       p.description,
            'handler_name',      p.handler_name,
            'snapshot_data',     p.snapshot_data,
            'published_dag_id',  p.published_dag_id,
            'dag_snapshot',      p.dag_snapshot,
            'form_schema',       p.form_schema,
            'render_mode',       p.render_mode,
            'column_renames',    p.column_renames
        )
    )
    FROM authz_ui_page p
    WHERE p.page_id = p_page_id
      AND (p.is_active OR p.handler_name IS NOT NULL);
$$;

COMMIT;

-- ── Post-migration verification (run manually) ──
-- \d authz_ui_page
--   Expect: render_mode, column_renames columns + render_mode CHECK
-- SELECT fn_ui_page('modules_home') -> 'config' ? 'render_mode';   -- expect t
