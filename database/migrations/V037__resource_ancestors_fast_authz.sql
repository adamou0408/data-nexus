-- ============================================================
-- V037: Resource Ancestors Mat View + Fast Batch Authz Check
--
-- L3 CQRS expansion: pre-compute the expensive recursive CTE
-- that authz_check() runs on every call.
--
-- Problem: authz_check() walks parent_id chain for EACH call.
-- For 25 modules × 2 actions = 50 recursive walks per request.
--
-- Solution: materialize the "ancestor" relationship once,
-- refresh via pg_notify on authz_resource changes, then
-- provide authz_check_batch() that does a single SQL JOIN.
-- ============================================================

-- 1. Materialized view: for each resource, list its ancestors (including self)
--    Size ≈ N × avg_depth. For 200 modules with depth 3: ~600 rows.
CREATE MATERIALIZED VIEW IF NOT EXISTS resource_ancestors AS
WITH RECURSIVE ancestors AS (
  -- Seed: each resource is its own ancestor (depth 0)
  SELECT
    resource_id,
    resource_id AS ancestor_id,
    0 AS depth
  FROM authz_resource
  WHERE is_active = TRUE

  UNION ALL

  -- Recursive: walk up via parent_id
  SELECT
    a.resource_id,
    r.parent_id AS ancestor_id,
    a.depth + 1 AS depth
  FROM ancestors a
  JOIN authz_resource r
    ON r.resource_id = a.ancestor_id
   AND r.parent_id IS NOT NULL
   AND r.is_active = TRUE
)
SELECT DISTINCT resource_id, ancestor_id, depth
FROM ancestors;

-- Unique index for CONCURRENT refresh + fast JOIN lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_ancestors_pk
  ON resource_ancestors (resource_id, ancestor_id);

CREATE INDEX IF NOT EXISTS idx_resource_ancestors_ancestor
  ON resource_ancestors (ancestor_id);

-- 2. Refresh helper — called by event listener
CREATE OR REPLACE FUNCTION refresh_resource_ancestors()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY resource_ancestors;
END;
$$;

-- 3. Batch authz check — one query for N resources × 1 action
--    Returns table of (resource_id, allowed) — caller sees all results at once.
--    Semantics identical to authz_check() applied per resource.
CREATE OR REPLACE FUNCTION authz_check_batch(
  p_user_id    TEXT,
  p_groups     TEXT[],
  p_action     TEXT,
  p_resources  TEXT[]
) RETURNS TABLE (resource_id TEXT, allowed BOOLEAN)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_roles TEXT[];
BEGIN
  -- Same role resolution as authz_check
  v_roles := _authz_resolve_roles(p_user_id, p_groups);

  RETURN QUERY
  WITH allowed_set AS (
    -- Allow: any ancestor (or '*') has role_permission with effect=allow
    SELECT DISTINCT ra.resource_id
    FROM resource_ancestors ra
    JOIN authz_role_permission rp
      ON (rp.resource_id = ra.ancestor_id OR rp.resource_id = '*')
    WHERE ra.resource_id = ANY(p_resources)
      AND rp.role_id = ANY(v_roles)
      AND rp.is_active = TRUE
      AND rp.effect = 'allow'
      AND (rp.action_id = p_action OR rp.action_id = '*')
  ),
  denied_set AS (
    -- Deny: explicit deny at the leaf resource only (not walked)
    -- Matches authz_check() behavior — deny is leaf-scoped
    SELECT DISTINCT rp.resource_id
    FROM authz_role_permission rp
    WHERE rp.resource_id = ANY(p_resources)
      AND rp.role_id = ANY(v_roles)
      AND rp.is_active = TRUE
      AND rp.effect = 'deny'
      AND (rp.action_id = p_action OR rp.action_id = '*')
  )
  SELECT
    r::TEXT AS resource_id,
    (r IN (SELECT s.resource_id FROM allowed_set s)
     AND r NOT IN (SELECT d.resource_id FROM denied_set d)) AS allowed
  FROM unnest(p_resources) AS r;
END;
$$;

COMMENT ON MATERIALIZED VIEW resource_ancestors IS
  'L3 read model: pre-computed resource parent-chain ancestors. Refreshed via pg_notify on authz_resource changes.';

COMMENT ON FUNCTION authz_check_batch(TEXT, TEXT[], TEXT, TEXT[]) IS
  'Batch permission check for N resources × 1 action. Reads resource_ancestors mat view instead of running recursive CTE per resource. ~O(1) vs ~O(N×depth) for authz_check().';
