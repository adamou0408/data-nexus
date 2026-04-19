-- ============================================================
-- V039: Extend UI Descriptors to Roles / Subjects / Audit (Phase 4D)
--
-- Proves the descriptor pattern scales beyond actions_home by
-- registering metadata for 3 additional tabs. UI refactoring can
-- follow incrementally — these descriptors are consumable NOW by
-- any component via GET /api/ui/descriptors/:page_id.
-- ============================================================

-- ─── 1. roles_home ─────────────────────────────────────────
INSERT INTO authz_ui_page (
  page_id, title, subtitle, layout, resource_id, data_table,
  icon, description, display_order, is_active
) VALUES (
  'roles_home',
  'Roles',
  'AuthZ roles — group permissions into reusable bundles',
  'table',
  NULL,
  'authz_role',
  'key-round',
  'Manage roles, their permissions, and role assignments',
  0,
  FALSE           -- hidden from fn_ui_root navigation (legacy BrowserTab path)
)
ON CONFLICT (page_id) DO UPDATE SET
  title = EXCLUDED.title,
  subtitle = EXCLUDED.subtitle;

INSERT INTO authz_ui_descriptor (
  descriptor_id, page_id, section_key, section_label, section_icon,
  display_order, visibility, columns, render_hints
) VALUES (
  'roles_home:grid',
  'roles_home',
  'grid',
  'Roles',
  'key-round',
  1,
  'all',
  '[
    {"key": "role_id",          "label": "Role ID",      "type": "text",    "render_hint": "bold_mono",    "sortable": true},
    {"key": "display_name",     "label": "Display Name", "type": "text",    "sortable": true},
    {"key": "description",      "label": "Description",  "type": "text",    "render_hint": "muted_text"},
    {"key": "is_system",        "label": "System",       "type": "boolean", "render_hint": "system_badge", "sortable": true},
    {"key": "assignment_count", "label": "Assignments",  "type": "number",  "sortable": true},
    {"key": "permission_count", "label": "Permissions",  "type": "number",  "sortable": true}
  ]'::jsonb,
  '{
    "grid_type": "table",
    "empty_icon": "key-round",
    "empty_message": "No roles defined",
    "searchable_fields": ["role_id", "display_name", "description"],
    "default_sort": {"key": "role_id", "dir": "asc"},
    "supports_expand": true,
    "expand_detail": "permissions"
  }'::jsonb
)
ON CONFLICT (page_id, section_key) DO UPDATE SET
  columns = EXCLUDED.columns,
  render_hints = EXCLUDED.render_hints;

-- ─── 2. subjects_home ──────────────────────────────────────
INSERT INTO authz_ui_page (
  page_id, title, subtitle, layout, resource_id, data_table,
  icon, description, display_order, is_active
) VALUES (
  'subjects_home',
  'Subjects',
  'Users, groups, and service accounts — the "who" of authorization',
  'table',
  NULL,
  'authz_subject',
  'users',
  'Manage subjects: LDAP users, groups, service accounts',
  0,
  FALSE
)
ON CONFLICT (page_id) DO UPDATE SET
  title = EXCLUDED.title,
  subtitle = EXCLUDED.subtitle;

INSERT INTO authz_ui_descriptor (
  descriptor_id, page_id, section_key, section_label, section_icon,
  display_order, visibility, columns, render_hints
) VALUES (
  'subjects_home:grid',
  'subjects_home',
  'grid',
  'Subjects',
  'users',
  1,
  'all',
  '[
    {"key": "subject_id",    "label": "Subject ID",   "type": "text",    "render_hint": "bold_mono",       "sortable": true},
    {"key": "display_name",  "label": "Display Name", "type": "text",    "sortable": true},
    {"key": "subject_type",  "label": "Type",         "type": "badge",   "render_hint": "subject_type_badge", "sortable": true},
    {"key": "ldap_dn",       "label": "LDAP DN",      "type": "text",    "render_hint": "mono_truncate"},
    {"key": "is_active",     "label": "Active",       "type": "boolean", "render_hint": "active_badge",    "sortable": true}
  ]'::jsonb,
  '{
    "grid_type": "table",
    "empty_icon": "users",
    "empty_message": "No subjects defined",
    "searchable_fields": ["subject_id", "display_name", "subject_type"],
    "default_sort": {"key": "display_name", "dir": "asc"},
    "supports_expand": true,
    "expand_detail": "roles_and_groups"
  }'::jsonb
)
ON CONFLICT (page_id, section_key) DO UPDATE SET
  columns = EXCLUDED.columns,
  render_hints = EXCLUDED.render_hints;

-- ─── 3. audit_home ─────────────────────────────────────────
INSERT INTO authz_ui_page (
  page_id, title, subtitle, layout, resource_id, data_table,
  icon, description, display_order, is_active
) VALUES (
  'audit_home',
  'Audit Log',
  'Immutable trail of admin operations — hypertable in TimescaleDB',
  'table',
  NULL,
  'authz_audit_log',
  'file-text',
  'Browse audit events with filters for user, action, resource',
  0,
  FALSE
)
ON CONFLICT (page_id) DO UPDATE SET
  title = EXCLUDED.title,
  subtitle = EXCLUDED.subtitle;

INSERT INTO authz_ui_descriptor (
  descriptor_id, page_id, section_key, section_label, section_icon,
  display_order, visibility, columns, render_hints
) VALUES (
  'audit_home:grid',
  'audit_home',
  'grid',
  'Audit Entries',
  'file-text',
  1,
  'admin',
  '[
    {"key": "ts",            "label": "Time",         "type": "timestamp", "render_hint": "relative_time", "sortable": true},
    {"key": "subject_id",    "label": "Subject",      "type": "text",      "render_hint": "mono",          "sortable": true},
    {"key": "action",        "label": "Action",       "type": "badge",     "render_hint": "audit_action"},
    {"key": "resource_type", "label": "Resource Type","type": "text"},
    {"key": "resource_id",   "label": "Resource",     "type": "text",      "render_hint": "mono_truncate"},
    {"key": "ip_address",    "label": "IP",           "type": "text",      "render_hint": "mono"}
  ]'::jsonb,
  '{
    "grid_type": "table",
    "empty_icon": "file-text",
    "empty_message": "No audit entries in time range",
    "searchable_fields": ["subject_id", "action", "resource_id"],
    "default_sort": {"key": "ts", "dir": "desc"},
    "filters": [
      {"key": "action", "label": "Action", "type": "select"},
      {"key": "subject_id", "label": "Subject", "type": "select"}
    ]
  }'::jsonb
)
ON CONFLICT (page_id, section_key) DO UPDATE SET
  columns = EXCLUDED.columns,
  render_hints = EXCLUDED.render_hints;
