-- ============================================================
-- V024: Fix authz_check_from_cache() + include deny in L0_functional
-- SEC-02: Deny-wins semantics for cached permission checks
-- SSOT: L0_functional now contains BOTH allow and deny entries
-- ============================================================

-- Step 1: Update authz_resolve() to include deny entries in L0_functional
-- Previously only included effect='allow'. Now includes both with effect field.
CREATE OR REPLACE FUNCTION authz_resolve(
    p_user_id       TEXT,
    p_user_groups   TEXT[],
    p_attributes    JSONB DEFAULT '{}'
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

    -- L0: functional permissions — now includes BOTH allow AND deny (SSOT for cache)
    SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'resource', rp.resource_id,
        'action', rp.action_id,
        'effect', rp.effect::text
    )) INTO v_functional
    FROM authz_role_permission rp
    JOIN authz_resource ar ON ar.resource_id = rp.resource_id
    WHERE rp.role_id = ANY(v_roles)
      AND rp.is_active
      AND ar.resource_type IN ('module', 'page', 'table', 'column', 'function', 'ai_tool');

    -- L1: data domain scope (unchanged from V008)
    SELECT jsonb_object_agg(ap.policy_name, jsonb_build_object(
        'rls_expression', ap.rls_expression,
        'subject_condition', ap.subject_condition,
        'resource_condition', ap.resource_condition
    )) INTO v_data_scope
    FROM authz_policy ap
    WHERE ap.granularity = 'L1' AND ap.status = 'active'
      AND ap.effect = 'allow'
      AND (ap.applicable_paths @> ARRAY['A'] OR ap.applicable_paths @> ARRAY['A','B','C'])
      AND _authz_match_subject_condition(ap.subject_condition, v_roles, p_attributes);

    -- L2: column masks (unchanged from V008)
    SELECT jsonb_object_agg(ap.policy_name, ap.column_mask_rules) INTO v_column_masks
    FROM authz_policy ap
    WHERE ap.granularity = 'L2' AND ap.status = 'active'
      AND ap.column_mask_rules IS NOT NULL
      AND _authz_match_subject_condition(ap.subject_condition, v_roles, p_attributes);

    -- L3: composite actions (unchanged from V008)
    SELECT jsonb_agg(jsonb_build_object(
        'action', ca.action_id,
        'resource', ca.resource_id,
        'preconditions', ca.preconditions,
        'approval_chain', ca.approval_chain
    )) INTO v_actions
    FROM authz_composite_action ca
    WHERE ca.is_active AND ca.required_role = ANY(v_roles);

    RETURN jsonb_build_object(
        'user_id',          p_user_id,
        'resolved_roles',   v_roles,
        'access_path',      'A',
        'resolved_at',      now(),
        'L0_functional',    COALESCE(v_functional, '[]'::jsonb),
        'L1_data_scope',    COALESCE(v_data_scope, '{}'::jsonb),
        'L2_column_masks',  COALESCE(v_column_masks, '{}'::jsonb),
        'L3_actions',       COALESCE(v_actions, '[]'::jsonb)
    );
END;
$$;

-- Step 2: Fix authz_check_from_cache() with deny-wins semantics
CREATE OR REPLACE FUNCTION authz_check_from_cache(
    p_resolved_config JSONB,
    p_action          TEXT,
    p_resource        TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    -- Deny-wins: if any deny matches, return FALSE immediately
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_resolved_config->'L0_functional') AS perm
        WHERE perm->>'effect' = 'deny'
          AND (perm->>'action' = p_action OR perm->>'action' = '*')
          AND (perm->>'resource' = p_resource OR perm->>'resource' = '*')
    ) THEN
        RETURN FALSE;
    END IF;

    -- Then check allow (effect='allow' or legacy entries without effect field)
    RETURN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_resolved_config->'L0_functional') AS perm
        WHERE (perm->>'effect' IS NULL OR perm->>'effect' = 'allow')
          AND (perm->>'action' = p_action OR perm->>'action' = '*')
          AND (perm->>'resource' = p_resource OR perm->>'resource' = '*')
    );
END;
$$;
