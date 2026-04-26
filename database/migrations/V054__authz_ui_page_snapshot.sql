-- V054 — Snapshot pages (DAG-SAVE-PAGE-01, Path A from Two-Tier model)
--
-- Goal: let a Curator save the result of one DAG node as a Tier B page
-- without writing React. This is the cheapest end-to-end loop:
--   run DAG → click "Save as page" → page appears under Modules with the
--   cached rows. Live re-execution (DAG-as-data_source) is Path B and
--   needs config-exec dispatch work; deferred.
--
-- Schema choice: one new JSONB column `snapshot_data` carries everything
-- the renderer needs (columns, rows, origin). Keeping it in a single
-- column avoids touching the layout CHECK constraint and keeps fn_ui_page
-- simple — the front-end already gets full PageConfig shape from one
-- jsonb_build_object call.
--
-- Shape:
--   {
--     "columns": [{"key","label","data_type","render"?,"semantic_type"?}],
--     "rows":    [{...}, ...],
--     "origin":  {"kind":"dag","dag_id":"dag:...","node_id":"n3",
--                 "bound_params":{...},"captured_at":"2026-04-26T..."}
--   }

ALTER TABLE authz_ui_page
    ADD COLUMN IF NOT EXISTS snapshot_data JSONB;

COMMENT ON COLUMN authz_ui_page.snapshot_data IS
    'Cached rows + columns from a DAG node run. Set by POST /api/dag/save-as-page. '
    'When non-null, config-exec short-circuits and returns these rows directly '
    '(no information_schema scan, no buildMaskedSelect). data_table can be NULL.';

-- Re-create fn_ui_page so snapshot_data flows back to the renderer.
-- The body is otherwise identical to the V038 version.
CREATE OR REPLACE FUNCTION fn_ui_page(p_page_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'config', jsonb_build_object(
            'page_id',          p.page_id,
            'title',            p.title,
            'subtitle',         p.subtitle,
            'layout',           p.layout,
            'resource_id',      p.resource_id,
            'data_table',       p.data_table,
            'order_by',         p.order_by,
            'row_limit',        p.row_limit,
            'row_drilldown',    p.row_drilldown,
            'columns_override', p.columns_override,
            'filters_config',   p.filters_config,
            'icon',             p.icon,
            'description',      p.description,
            'handler_name',     p.handler_name,
            'snapshot_data',    p.snapshot_data
        )
    )
    FROM authz_ui_page p
    WHERE p.page_id = p_page_id
      AND (p.is_active OR p.handler_name IS NOT NULL);
$$;
