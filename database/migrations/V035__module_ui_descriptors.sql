-- ============================================================
-- V035: Module UI Descriptors — L1 Metadata-Driven
--
-- Store sub-tab definitions and column schemas for tree_detail
-- pages in DB metadata. Frontend reads these descriptors instead
-- of hardcoding tabs/columns in JSX.
-- ============================================================

-- 1. UI Descriptor table — defines sub-tabs, columns, render hints
-- Each row is one "section" (sub-tab or panel) within a page
CREATE TABLE IF NOT EXISTS authz_ui_descriptor (
  descriptor_id   TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES authz_ui_page(page_id),
  section_key     TEXT NOT NULL,           -- e.g. 'tables', 'access', 'profiles'
  section_label   TEXT NOT NULL,           -- display label
  section_icon    TEXT,                    -- lucide icon name
  display_order   INT NOT NULL DEFAULT 0,
  visibility      TEXT NOT NULL DEFAULT 'all'
    CHECK (visibility IN ('all', 'admin', 'write', 'read')),
  -- Column definitions for this section's data grid
  columns         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Render hints (e.g. grid type, empty state message, actions)
  render_hints    JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, section_key)
);

COMMENT ON TABLE authz_ui_descriptor IS 'L1 metadata: per-page section descriptors (sub-tabs, columns, render hints)';
COMMENT ON COLUMN authz_ui_descriptor.visibility IS 'Min permission level to see this section: all|admin|write|read';
COMMENT ON COLUMN authz_ui_descriptor.columns IS 'Array of {key, label, type, width?, render_hint?, sortable?}';
COMMENT ON COLUMN authz_ui_descriptor.render_hints IS 'Section-specific rendering: {grid_type, empty_icon, empty_message, actions[]}';

-- 2. Seed descriptors for modules_home page
INSERT INTO authz_ui_descriptor (descriptor_id, page_id, section_key, section_label, section_icon, display_order, visibility, columns, render_hints)
VALUES
  -- Tables sub-tab: visible to all users with read access
  ('modules_home:tables', 'modules_home', 'tables', 'Tables', 'table-2', 1, 'read',
   '[
     {"key": "display_name",   "label": "Table",   "type": "text",   "render_hint": "mono_icon", "width": "flex"},
     {"key": "resource_type",  "label": "Type",    "type": "badge",  "render_hint": "type_badge"},
     {"key": "column_count",   "label": "Columns", "type": "number"},
     {"key": "data_source_id", "label": "Source",  "type": "text",   "render_hint": "mono_truncate", "width": "120px"}
   ]'::jsonb,
   '{"grid_type": "table", "empty_icon": "table-2", "empty_message": "No tables mapped to this module",
     "actions": [{"key": "reassign", "label": "Reassign", "type": "dropdown", "visibility": "write"}]
   }'::jsonb),

  -- Access sub-tab: visible to admins only
  ('modules_home:access', 'modules_home', 'access', 'Access', 'shield', 2, 'admin',
   '[
     {"key": "role_name",  "label": "Role",    "type": "text",   "width": "200px"},
     {"key": "actions",    "label": "Actions",  "type": "action_grid", "render_hint": "allow_deny_grid"}
   ]'::jsonb,
   '{"grid_type": "action_grid", "empty_icon": "shield-off", "empty_message": "No role permissions on this module"}'::jsonb),

  -- Profiles sub-tab: visible to admins only
  ('modules_home:profiles', 'modules_home', 'profiles', 'Profiles', 'database', 3, 'admin',
   '[
     {"key": "profile_id",      "label": "Profile",    "type": "text",   "render_hint": "mono"},
     {"key": "pg_role",          "label": "PG Role",    "type": "text",   "render_hint": "mono"},
     {"key": "connection_mode",  "label": "Mode",       "type": "badge"},
     {"key": "data_source_id",   "label": "Source",     "type": "text",   "render_hint": "mono"}
   ]'::jsonb,
   '{"grid_type": "table", "empty_icon": "database", "empty_message": "No pool profiles reference this module"}'::jsonb)

ON CONFLICT (page_id, section_key) DO UPDATE SET
  section_label = EXCLUDED.section_label,
  section_icon = EXCLUDED.section_icon,
  display_order = EXCLUDED.display_order,
  visibility = EXCLUDED.visibility,
  columns = EXCLUDED.columns,
  render_hints = EXCLUDED.render_hints;

-- 3. Function to fetch descriptors for a page
CREATE OR REPLACE FUNCTION fn_ui_descriptors(p_page_id TEXT)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'section_key',   d.section_key,
        'section_label', d.section_label,
        'section_icon',  d.section_icon,
        'display_order', d.display_order,
        'visibility',    d.visibility,
        'columns',       d.columns,
        'render_hints',  d.render_hints
      ) ORDER BY d.display_order
    ),
    '[]'::jsonb
  )
  FROM authz_ui_descriptor d
  WHERE d.page_id = p_page_id AND d.is_active = TRUE;
$$;
