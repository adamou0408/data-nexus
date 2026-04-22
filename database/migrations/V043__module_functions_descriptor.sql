-- V043: Add 'functions' sub-tab to modules_home page descriptors.
-- Enables the Modules → Module Detail UI to surface child functions
-- (resource_type='function') alongside tables/views. Without this row
-- the descriptor-driven tab list omits Functions, so functions
-- promoted via Discover became invisible in the Modules tab.

INSERT INTO authz_ui_descriptor (descriptor_id, page_id, section_key, section_label, section_icon, display_order, visibility, columns, render_hints)
VALUES
  ('modules_home:functions', 'modules_home', 'functions', 'Functions', 'code-2', 2, 'read',
   '[
     {"key": "display_name",    "label": "Function",    "type": "text",   "render_hint": "mono_icon", "width": "flex"},
     {"key": "schema",           "label": "Schema",     "type": "text",   "render_hint": "mono",        "width": "120px"},
     {"key": "data_source_id",   "label": "Source",     "type": "text",   "render_hint": "mono_truncate", "width": "120px"}
   ]'::jsonb,
   '{"grid_type": "table", "empty_icon": "code-2", "empty_message": "No functions mapped to this module"}'::jsonb)

ON CONFLICT (page_id, section_key) DO UPDATE SET
  section_label = EXCLUDED.section_label,
  section_icon = EXCLUDED.section_icon,
  display_order = EXCLUDED.display_order,
  visibility = EXCLUDED.visibility,
  columns = EXCLUDED.columns,
  render_hints = EXCLUDED.render_hints;

-- Bump display_order so Functions slots between Tables (1) and Access (now 3)
UPDATE authz_ui_descriptor SET display_order = 3 WHERE descriptor_id = 'modules_home:access';
UPDATE authz_ui_descriptor SET display_order = 4 WHERE descriptor_id = 'modules_home:profiles';
