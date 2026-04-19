-- ============================================================
-- V038: Config-SM DB-Driven Handler Registry (Phase 4D / L4)
--
-- Problem: tree_detail layout dispatch uses a hardcoded TS registry
-- in ConfigEngine (TREE_DETAIL_HANDLERS[page_id] = ModulesTab).
-- Adding a new tree_detail page requires code change.
--
-- Solution: add handler_name column to authz_ui_page. Frontend still
-- bundles handler components, but maps handler_name → component.
-- Admin can assign any registered handler to any page via SQL.
-- ============================================================

-- 1. Add handler_name column (nullable — only needed for layouts that dispatch)
ALTER TABLE authz_ui_page
  ADD COLUMN IF NOT EXISTS handler_name TEXT;

COMMENT ON COLUMN authz_ui_page.handler_name IS
  'Optional handler component identifier. Used by ConfigEngine to dispatch complex layouts (e.g., tree_detail) to the appropriate React component. NULL for built-in layouts (card_grid, table).';

-- 2. Backfill existing tree_detail pages
UPDATE authz_ui_page
   SET handler_name = 'modules_home_handler'
 WHERE page_id = 'modules_home'
   AND layout = 'tree_detail'
   AND handler_name IS NULL;

-- 3. Update fn_ui_page() to include handler_name in the returned config
CREATE OR REPLACE FUNCTION fn_ui_page(p_page_id TEXT)
RETURNS JSONB
LANGUAGE sql STABLE
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
      'handler_name',     p.handler_name
    )
  )
  FROM authz_ui_page p
  WHERE p.page_id = p_page_id AND p.is_active;
$$;
