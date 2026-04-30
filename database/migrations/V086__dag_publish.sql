-- ============================================================
-- V086 — DAG-PUBLISH-V01: published-DAG fields on authz_ui_page
--
-- Plan: .claude/plans/v3-phase-1/dag-publish-v01-plan.md
--
-- ── Problem ──
--   §3.4 C primitive: admin composes a DAG in Flow Composer and wants
--   to expose it to BI_USER as a *live* page (form inputs → run DAG
--   under caller's authz → masked grid). Today only the snapshot path
--   exists (V054 + V081 sink-as-resource): pages are frozen rows, not
--   re-executable, masks are stamped at admin time.
--
-- ── Choice ──
--   Three new columns on authz_ui_page:
--     - published_dag_id  text  — FK to authz_resource (resource_type='dag')
--     - dag_snapshot      jsonb — frozen DAG-JSON at publish time
--     - form_schema       jsonb — [{name,type,required,default,help_text}]
--
--   Discriminator stays implicit: a row is "snapshot page" if
--   snapshot_data IS NOT NULL, "published-dag page" if published_dag_id
--   IS NOT NULL. Two check constraints make these mutually exclusive
--   and keep the published-dag path well-formed.
--
--   No new resource_type. The published_dag itself is registered at
--   publish time as resource_type='page' (per V081 mirror) AND a sibling
--   row resource_id='published_dag:<rid>' is written there too — that
--   row is the "blessed gate" BI_USER needs `read` on. Migration only
--   handles schema; route handles the resource registration.
--
-- ── Auth model (Fork A — default chosen) ──
--   Published DAG = bless. BI_USER needs `read` on
--   `published_dag:<dag_resource_id>`; server bypasses per-fn
--   authz_check(execute, function:rid) when running in published-run
--   context. Column-level mask still applies (read-side concern).
--   Mirrors V044 BIZ-TERM blessed semantics.
--
-- ── Out of scope ──
--   - Multi-leaf DAG publish (single-leaf required at publish time)
--   - Form schema admin-side override (auto-derived only, this revision)
--   - Published-DAG version history (re-publish overwrites; bump page_id
--     for v2 if history needed)
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 0. Widen authz_resource.resource_type to include 'published_dag'
--    The publish flow registers a sibling resource_id
--    'published_dag:<dag_rid>' that BI_USER needs `read` on. Keeping
--    it as a separate type (rather than reusing 'page') means cascade
--    rules and ModulesTab grouping treat it correctly.
-- ────────────────────────────────────────────────────────────

ALTER TABLE authz_resource
  DROP CONSTRAINT IF EXISTS authz_resource_resource_type_check;
ALTER TABLE authz_resource
  ADD CONSTRAINT authz_resource_resource_type_check
  CHECK (resource_type = ANY (ARRAY[
    'module', 'page', 'table', 'view', 'column', 'function',
    'ai_tool', 'web_page', 'web_api', 'db_schema', 'db_table',
    'db_pool', 'dag', 'ai_provider', 'published_dag'
  ]));

-- ────────────────────────────────────────────────────────────
-- 1. New columns on authz_ui_page
-- ────────────────────────────────────────────────────────────

ALTER TABLE authz_ui_page
  ADD COLUMN IF NOT EXISTS published_dag_id text REFERENCES authz_resource(resource_id),
  ADD COLUMN IF NOT EXISTS dag_snapshot     jsonb,
  ADD COLUMN IF NOT EXISTS form_schema      jsonb;

COMMENT ON COLUMN authz_ui_page.published_dag_id IS
  'FK to authz_resource (resource_type=''dag''). When set, the page is a '
  'live published-DAG page: ConfigEngine renders form_schema, /api/config-exec '
  'runs the DAG under caller authz via lib/dag-exec.executeDagAsPublished().';
COMMENT ON COLUMN authz_ui_page.dag_snapshot IS
  'Frozen DAG-JSON {nodes, edges, data_source_id, user_input_params_index} '
  'captured at publish time. Used by executor — re-publishing this page_id '
  'overwrites the snapshot.';
COMMENT ON COLUMN authz_ui_page.form_schema IS
  'Auto-derived from DAG bound_params + node-level user_input_params at '
  'publish time. Shape: [{name, type, required, default, help_text}].';

-- ────────────────────────────────────────────────────────────
-- 2. Mode-mutex + completeness invariants
-- ────────────────────────────────────────────────────────────

-- A row is at most one of: snapshot page, published-dag page.
-- (Plain pages with neither set continue to work — Tier B authored pages.)
ALTER TABLE authz_ui_page
  DROP CONSTRAINT IF EXISTS authz_ui_page_publish_mode_check;
ALTER TABLE authz_ui_page
  ADD CONSTRAINT authz_ui_page_publish_mode_check
  CHECK (NOT (snapshot_data IS NOT NULL AND published_dag_id IS NOT NULL));

-- If published_dag_id is set, dag_snapshot AND form_schema must be set.
-- Prevents half-published rows where the executor would have nothing to run.
ALTER TABLE authz_ui_page
  DROP CONSTRAINT IF EXISTS authz_ui_page_published_dag_complete_check;
ALTER TABLE authz_ui_page
  ADD CONSTRAINT authz_ui_page_published_dag_complete_check
  CHECK (
    published_dag_id IS NULL
    OR (dag_snapshot IS NOT NULL AND form_schema IS NOT NULL)
  );

-- ────────────────────────────────────────────────────────────
-- 3. Re-create fn_ui_page() so the renderer sees the new fields
--    (otherwise body identical to V054)
-- ────────────────────────────────────────────────────────────

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
            'form_schema',       p.form_schema
        )
    )
    FROM authz_ui_page p
    WHERE p.page_id = p_page_id
      AND (p.is_active OR p.handler_name IS NOT NULL);
$$;

COMMIT;

-- ── Post-migration verification (run manually) ──
-- \d authz_ui_page
--   Expect: published_dag_id, dag_snapshot, form_schema columns + 2 new constraints
-- SELECT fn_ui_page('modules_home') -> 'config' ? 'published_dag_id';   -- expect t
