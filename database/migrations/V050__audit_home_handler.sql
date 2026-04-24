-- ============================================================
-- V050: Convert Audit tab to registry-driven (handler_name pattern)
--
-- Phase 1 proof that handler_name (V038) generalizes beyond
-- tree_detail — any inherently-custom read-only page can register
-- in authz_ui_page and be dispatched through ConfigEngine instead
-- of hard-wired in App.tsx.
--
-- Changes:
--   1. Set audit_home.handler_name = 'audit_home_handler'
--   2. NULL audit_home.data_table — the handler fetches its own data
--      (authz_audit_log is a control-plane hypertable, not a
--      nexus_data business table; buildMaskedSelect can't reach it).
--   3. Relax fn_ui_page's is_active filter. is_active controls nav
--      visibility (fn_ui_root's card grid). Direct page lookup for
--      handler-driven pages (registered with is_active=FALSE to stay
--      out of the default nav) must still succeed.
-- ============================================================

-- 1. Wire audit_home to the AuditTab handler + clear data_table
UPDATE authz_ui_page
   SET handler_name = 'audit_home_handler',
       data_table   = NULL
 WHERE page_id = 'audit_home';

-- 2. Relax fn_ui_page gate, but only for handler-driven pages.
--    Rationale: V039 registered several `is_active=FALSE` pages (roles_home,
--    subjects_home) that are not meant to be directly executable — they're
--    descriptor placeholders for BrowserTab. Only pages with handler_name
--    should be directly reachable while hidden from the nav card grid.
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
  WHERE p.page_id = p_page_id
    AND (p.is_active OR p.handler_name IS NOT NULL);
$$;
