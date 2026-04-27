-- ============================================================
-- V067: authz_resolve cross-join populates L0_functional for SYSADMIN
-- ============================================================
-- Source: Adam 2026-04-27 — "L0_functional UX 缺口" AskUserQuestion
--         answer A. SYSADMIN 登入 dashboard 看到空菜單。
-- Fix:    當 is_sysadmin=true 時,authz_resolve() 把
--         all (resource × action) FOR resource_type IN
--         ('module','page','table','column','function','ai_tool')
--         塞進 L0_functional,frontend AuthzContext .some() 自動全綠。
-- Tradeoff: payload +~235 entries / +~10KB / +~5ms per call.
--           Acceptable since SYSADMIN holders are few.
-- Note:   V064 deny-override 仍在 authz_check() — UI 顯示「可見」
--         的 resource,實際 API 仍會被 explicit deny 擋。SYSADMIN
--         看到的選單是「god-mode 視角」,不是「保證能執行」。
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION authz_resolve(
    p_user_id     TEXT,
    p_user_groups TEXT[],
    p_user_attrs  JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles                 TEXT[];
    v_functional            JSONB;
    v_data_scope            JSONB;
    v_column_masks          JSONB;
    v_actions               JSONB;
    v_default_allow_sources TEXT[];
    v_is_sysadmin           BOOLEAN;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);
    v_is_sysadmin := 'SYSADMIN' = ANY(v_roles);

    -- L0_functional: SYSADMIN gets the cross-join (god-mode UI);
    -- everyone else gets enumerated grants from authz_role_permission.
    IF v_is_sysadmin THEN
        SELECT jsonb_agg(jsonb_build_object(
            'resource', ar.resource_id,
            'action', aa.action_id,
            'effect', 'allow'
        ))
        INTO v_functional
        FROM authz_resource ar
        CROSS JOIN authz_action aa
        WHERE ar.resource_type IN ('module', 'page', 'table', 'column', 'function', 'ai_tool')
          AND COALESCE(ar.is_active, TRUE) = TRUE;
    ELSE
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
    END IF;

    SELECT array_agg(source_id) INTO v_default_allow_sources
    FROM authz_data_source
    WHERE default_l0_policy = 'allow';

    SELECT jsonb_object_agg(ap.policy_name, jsonb_build_object(
        'rls_expression', ap.rls_expression,
        'subject_condition', ap.subject_condition,
        'resource_condition', ap.resource_condition
    )) INTO v_data_scope
    FROM authz_policy ap
    WHERE ap.granularity = 'L1_data_domain' AND ap.status = 'active'
      AND ap.effect = 'allow'
      AND (ap.applicable_paths @> ARRAY['A'] OR ap.applicable_paths @> ARRAY['A','B','C'])
      AND _authz_match_subject_condition(ap.subject_condition, v_roles, p_user_attrs);

    SELECT jsonb_object_agg(ap.policy_name, ap.column_mask_rules) INTO v_column_masks
    FROM authz_policy ap
    WHERE ap.granularity = 'L2_row_column' AND ap.status = 'active'
      AND ap.column_mask_rules IS NOT NULL
      AND _authz_match_subject_condition(ap.subject_condition, v_roles, p_user_attrs);

    SELECT jsonb_agg(jsonb_build_object(
        'action', ca.target_action,
        'resource', ca.target_resource,
        'preconditions', ca.preconditions,
        'approval_chain', ca.approval_chain
    )) INTO v_actions
    FROM authz_composite_action ca
    WHERE ca.status = 'active'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(ca.approval_chain) step
          WHERE step->>'required_role' = ANY(v_roles)
      );

    RETURN jsonb_build_object(
        'user_id',                    p_user_id,
        'resolved_roles',             v_roles,
        'access_path',                'A',
        'resolved_at',                now(),
        'is_sysadmin',                v_is_sysadmin,
        'L0_functional',              COALESCE(v_functional, '[]'::jsonb),
        'L0_default_allow_sources',   COALESCE(to_jsonb(v_default_allow_sources), '[]'::jsonb),
        'L1_data_scope',              COALESCE(v_data_scope, '{}'::jsonb),
        'L2_column_masks',            COALESCE(v_column_masks, '{}'::jsonb),
        'L3_actions',                 COALESCE(v_actions, '[]'::jsonb)
    );
END;
$$;

COMMENT ON FUNCTION authz_resolve(TEXT, TEXT[], JSONB) IS
    'V067: SYSADMIN gets cross-join L0_functional for god-mode UI; others get role_permission enumeration as before. is_sysadmin sidecar from V066 retained.';

COMMIT;
