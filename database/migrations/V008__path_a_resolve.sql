-- ============================================================
-- V008: Path A Adapter - Config-as-State-Machine Resolve
-- v2.4 FIX: L1/L2 queries now filter by subject_condition
--   matching user's roles and attributes, same as authz_filter().
-- ============================================================

CREATE OR REPLACE FUNCTION authz_resolve(
    p_user_id       TEXT,
    p_user_groups   TEXT[],
    p_user_attrs    JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles         TEXT[];
    v_functional    JSONB;
    v_data_scope    JSONB;
    v_column_masks  JSONB;
    v_actions       JSONB;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    -- L0: functional permissions (role-based, no subject_condition needed)
    SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'resource', rp.resource_id,
        'action', rp.action_id
    )) INTO v_functional
    FROM authz_role_permission rp
    JOIN authz_resource ar ON ar.resource_id = rp.resource_id
    WHERE rp.role_id = ANY(v_roles)
      AND rp.is_active AND rp.effect = 'allow'
      AND ar.resource_type IN ('module', 'page', 'table', 'column', 'function', 'ai_tool');

    -- L1: data domain scope (v2.4: filter by subject_condition)
    SELECT jsonb_object_agg(ap.policy_name, jsonb_build_object(
        'rls_expression', ap.rls_expression,
        'subject_condition', ap.subject_condition,
        'resource_condition', ap.resource_condition
    )) INTO v_data_scope
    FROM authz_policy ap
    WHERE ap.status = 'active' AND ap.granularity = 'L1_data_domain'
      AND 'A' = ANY(ap.applicable_paths)
      AND (ap.effective_until IS NULL OR ap.effective_until > now())
      AND _authz_match_subject_condition(ap.subject_condition, v_roles, p_user_attrs);

    -- L2: column mask rules (v2.4: filter by subject_condition)
    SELECT jsonb_object_agg(ap.policy_name, ap.column_mask_rules) INTO v_column_masks
    FROM authz_policy ap
    WHERE ap.status = 'active' AND ap.granularity = 'L2_row_column'
      AND ap.column_mask_rules IS NOT NULL
      AND 'A' = ANY(ap.applicable_paths)
      AND (ap.effective_until IS NULL OR ap.effective_until > now())
      AND _authz_match_subject_condition(ap.subject_condition, v_roles, p_user_attrs);

    -- L3: composite actions (already filtered by role via approval_chain check)
    SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'action', ca.target_action,
        'resource', ca.target_resource,
        'approval_chain', ca.approval_chain,
        'preconditions', ca.preconditions
    )) INTO v_actions
    FROM authz_composite_action ca
    WHERE ca.status = 'active'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(ca.approval_chain) AS step
          WHERE step->>'required_role' = ANY(v_roles)
      );

    RETURN jsonb_build_object(
        'user_id',          p_user_id,
        'resolved_roles',   to_jsonb(v_roles),
        'access_path',      'A',
        'resolved_at',      now(),
        'L0_functional',    COALESCE(v_functional, '[]'::jsonb),
        'L1_data_scope',    COALESCE(v_data_scope, '{}'::jsonb),
        'L2_column_masks',  COALESCE(v_column_masks, '{}'::jsonb),
        'L3_actions',       COALESCE(v_actions, '[]'::jsonb)
    );
END;
$$;
