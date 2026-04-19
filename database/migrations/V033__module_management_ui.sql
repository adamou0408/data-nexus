-- ============================================================
-- V033: Module Management — Config-SM registration + layout type
-- Adds 'tree_detail' layout to authz_ui_page CHECK constraint
-- Registers modules_home page so fn_ui_root() can show it
-- ============================================================

-- 1. Add tree_detail layout type
ALTER TABLE authz_ui_page DROP CONSTRAINT IF EXISTS authz_ui_page_layout_check;
ALTER TABLE authz_ui_page ADD CONSTRAINT authz_ui_page_layout_check
  CHECK (layout IN ('card_grid', 'table', 'agg_table', 'split', 'timeline', 'context_panel', 'tree_detail'));

-- 2. Register Module Management as a Config-SM page
-- resource_id = NULL means visible to ALL authenticated users (fn_ui_root checks authz_check)
-- We use 'module:*' pattern — but since authz_check needs exact resource_id,
-- we set resource_id = NULL so all users see the entry card.
-- Per-module filtering happens inside /api/modules/tree endpoint.
INSERT INTO authz_ui_page (
  page_id, title, subtitle, layout, resource_id, data_table,
  icon, description, display_order, is_active
) VALUES (
  'modules_home',
  'Modules',
  'Business domain modules — tables, permissions, pool profiles',
  'tree_detail',
  NULL,           -- visible to all (per-module filtering in API)
  NULL,           -- no direct data table (custom endpoints)
  'boxes',
  'Organize data tables into business domains for department-level access control',
  5,              -- between root cards
  TRUE
) ON CONFLICT (page_id) DO UPDATE SET
  title = EXCLUDED.title,
  subtitle = EXCLUDED.subtitle,
  layout = EXCLUDED.layout,
  icon = EXCLUDED.icon,
  description = EXCLUDED.description,
  display_order = EXCLUDED.display_order;
