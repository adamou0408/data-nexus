-- ============================================================
-- V034: Module Tree Stats — Materialized View + Event Emission
--
-- Phase 2 / L3 CQRS: Replace correlated subqueries in
-- GET /api/modules/tree with a pre-computed materialized view.
-- Add pg_notify on authz_resource mutations for cache invalidation.
-- ============================================================

-- 1. Materialized View: pre-computed stats per module
CREATE MATERIALIZED VIEW IF NOT EXISTS module_tree_stats AS
SELECT
  r.resource_id,
  r.display_name,
  r.parent_id,
  r.attributes,
  r.is_active,
  COALESCE(cm.child_module_count, 0) AS child_module_count,
  COALESCE(ct.table_count, 0)       AS table_count,
  COALESCE(cc.column_count, 0)      AS column_count
FROM authz_resource r
LEFT JOIN LATERAL (
  SELECT count(*) AS child_module_count
  FROM authz_resource c
  WHERE c.parent_id = r.resource_id
    AND c.resource_type = 'module'
    AND c.is_active = TRUE
) cm ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS table_count
  FROM authz_resource c
  WHERE c.parent_id = r.resource_id
    AND c.resource_type IN ('table', 'view')
    AND c.is_active = TRUE
) ct ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS column_count
  FROM authz_resource col
  WHERE col.resource_type = 'column'
    AND col.is_active = TRUE
    AND col.parent_id IN (
      SELECT t.resource_id
      FROM authz_resource t
      WHERE t.parent_id = r.resource_id
        AND t.resource_type IN ('table', 'view')
        AND t.is_active = TRUE
    )
) cc ON TRUE
WHERE r.resource_type = 'module'
  AND r.is_active = TRUE
ORDER BY r.parent_id NULLS FIRST, r.display_name;

-- Unique index for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_module_tree_stats_pk
  ON module_tree_stats (resource_id);

-- 2. Helper function: refresh the materialized view
-- Called from application layer after mutations, or via trigger
CREATE OR REPLACE FUNCTION refresh_module_tree_stats()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY module_tree_stats;
END;
$$;

-- 3. Event emission: notify on authz_resource changes
-- Extends V012 pattern — separate channel for resource changes
CREATE OR REPLACE FUNCTION authz_notify_resource_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  payload jsonb;
  rid text;
  rtype text;
BEGIN
  -- Use NEW for INSERT/UPDATE, OLD for DELETE
  IF TG_OP = 'DELETE' THEN
    rid   := OLD.resource_id;
    rtype := OLD.resource_type;
  ELSE
    rid   := NEW.resource_id;
    rtype := NEW.resource_type;
  END IF;

  payload := jsonb_build_object(
    'table',         TG_TABLE_NAME,
    'action',        TG_OP,
    'resource_id',   rid,
    'resource_type', rtype,
    'timestamp',     now()
  );

  PERFORM pg_notify('authz_resource_changed', payload::text);

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Trigger on authz_resource for module-relevant changes
-- Fires on any resource change (modules, tables, views, columns)
-- since all affect module tree stats
DROP TRIGGER IF EXISTS trg_resource_change ON authz_resource;
CREATE TRIGGER trg_resource_change
  AFTER INSERT OR UPDATE OR DELETE ON authz_resource
  FOR EACH ROW EXECUTE FUNCTION authz_notify_resource_change();
