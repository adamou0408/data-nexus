-- ============================================================
-- V040: Optimize authz_check_batch (LEFT JOIN instead of IN subquery)
-- ============================================================

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
  v_roles := _authz_resolve_roles(p_user_id, p_groups);

  RETURN QUERY
  WITH
    input_res AS (
      SELECT r AS resource_id FROM unnest(p_resources) AS r
    ),
    allowed_set AS (
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
      SELECT DISTINCT rp.resource_id
      FROM authz_role_permission rp
      WHERE rp.resource_id = ANY(p_resources)
        AND rp.role_id = ANY(v_roles)
        AND rp.is_active = TRUE
        AND rp.effect = 'deny'
        AND (rp.action_id = p_action OR rp.action_id = '*')
    )
  SELECT
    i.resource_id,
    (a.resource_id IS NOT NULL AND d.resource_id IS NULL) AS allowed
  FROM input_res i
  LEFT JOIN allowed_set a ON a.resource_id = i.resource_id
  LEFT JOIN denied_set  d ON d.resource_id = i.resource_id;
END;
$$;
