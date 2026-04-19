-- ============================================================
-- V036: Actions UI Descriptor — L1 Metadata expansion (Phase 4B)
--
-- Validates the descriptor pattern scales beyond modules_home by
-- adding descriptors for the Actions admin CRUD page.
--
-- Design notes:
--   - authz_ui_page entry is registered with is_active=FALSE. This
--     satisfies the FK constraint on authz_ui_descriptor.page_id
--     but prevents the page from appearing in fn_ui_root() navigation.
--   - ActionsSection is mounted via BrowserTab (legacy path), not
--     Config-SM. We only need the descriptors for column metadata.
-- ============================================================

-- 1. Register actions_home as a "metadata-only" page (hidden from nav)
INSERT INTO authz_ui_page (
  page_id, title, subtitle, layout, resource_id, data_table,
  icon, description, display_order, is_active
) VALUES (
  'actions_home',
  'Actions',
  'AuthZ actions — verbs users can perform on resources',
  'table',
  NULL,
  'authz_action',
  'zap',
  'Manage authorization actions (read, write, approve, etc.)',
  0,
  FALSE           -- hidden from fn_ui_root() navigation
)
ON CONFLICT (page_id) DO UPDATE SET
  title = EXCLUDED.title,
  subtitle = EXCLUDED.subtitle;

-- 2. Seed the main grid descriptor for actions_home
INSERT INTO authz_ui_descriptor (
  descriptor_id, page_id, section_key, section_label, section_icon,
  display_order, visibility, columns, render_hints
) VALUES (
  'actions_home:grid',
  'actions_home',
  'grid',
  'Actions',
  'zap',
  1,
  'all',
  '[
    {"key": "action_id",         "label": "Action ID",     "type": "text",    "render_hint": "bold_mono",    "sortable": true},
    {"key": "display_name",      "label": "Display Name",  "type": "text",    "sortable": true},
    {"key": "description",       "label": "Description",   "type": "text",    "render_hint": "muted_text"},
    {"key": "applicable_paths",  "label": "Paths",         "type": "array",   "render_hint": "path_badges"},
    {"key": "is_active",         "label": "Active",        "type": "boolean", "render_hint": "active_badge", "sortable": true}
  ]'::jsonb,
  '{
    "grid_type": "table",
    "empty_icon": "zap-off",
    "empty_message": "No actions defined",
    "searchable_fields": ["action_id", "display_name", "description"],
    "default_sort": {"key": "action_id", "dir": "asc"}
  }'::jsonb
)
ON CONFLICT (page_id, section_key) DO UPDATE SET
  columns = EXCLUDED.columns,
  render_hints = EXCLUDED.render_hints;
