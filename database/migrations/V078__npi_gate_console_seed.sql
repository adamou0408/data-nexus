-- ============================================================
-- V078: npi_gate_console Path A page + read permissions
--
-- Registers the dogfood console page that exercises the
-- workflow runtime (V075 + V076). The page is handler-driven
-- — the React component owns the layout — but it still goes
-- through fn_ui_page / fn_ui_root so authz_check gates
-- visibility from the navigation card grid.
--
-- Permission story:
--   - V076 seeded PE/QA/VP × approve × module:mrp.npi.gate_signoff
--     so the workflow router can record decisions.
--   - This migration seeds the matching read permission so
--     fn_ui_root('user:adam_npi_pe', ...) actually returns the
--     console card. Without it the page would 200 on direct
--     navigation but never show up in the home grid — silent
--     UX regression on permission-aware nav.
-- ============================================================

BEGIN;

-- 1. Page registration
INSERT INTO authz_ui_page (
    page_id, title, subtitle, layout,
    resource_id, data_table, handler_name,
    icon, description, display_order, is_active
)
VALUES (
    'npi_gate_console',
    'NPI Gate Sign-off',
    'Advance NPI materials through G0 → G4 with PE → QA → VP chain approval',
    'table',                                   -- nominal layout; handler owns the body
    'module:mrp.npi.gate_signoff',             -- gates visibility via authz_check(read, ...)
    NULL,                                      -- handler fetches its own data
    'npi_gate_console_handler',
    'shield-check',
    'Submit and approve NPI gate transitions. The handler reads from authz_workflow_request and authz_lifecycle_instance.',
    20,
    TRUE
)
ON CONFLICT (page_id) DO UPDATE
   SET title         = EXCLUDED.title,
       subtitle      = EXCLUDED.subtitle,
       layout        = EXCLUDED.layout,
       resource_id   = EXCLUDED.resource_id,
       data_table    = EXCLUDED.data_table,
       handler_name  = EXCLUDED.handler_name,
       icon          = EXCLUDED.icon,
       description   = EXCLUDED.description,
       display_order = EXCLUDED.display_order,
       is_active     = TRUE;

-- 2. read permission for the chain roles so the card shows in fn_ui_root
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect, is_active)
VALUES
    ('PE', 'read', 'module:mrp.npi.gate_signoff', 'allow', TRUE),
    ('QA', 'read', 'module:mrp.npi.gate_signoff', 'allow', TRUE),
    ('VP', 'read', 'module:mrp.npi.gate_signoff', 'allow', TRUE)
ON CONFLICT (role_id, action_id, resource_id) DO UPDATE
   SET effect    = EXCLUDED.effect,
       is_active = EXCLUDED.is_active;

COMMIT;
