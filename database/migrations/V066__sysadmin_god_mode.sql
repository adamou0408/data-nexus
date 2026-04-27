-- ============================================================
-- V066: SYSADMIN role — allow-side god-mode (deny still wins)
-- ============================================================
-- Source: Adam 2026-04-27 — "sysadmin則是有所有的權限,不應該要再次設定才有.
--         這樣子可以減少很多初始debug的白工"
-- Decision (AskUserQuestion B): bypass enumeration on the allow side ONLY;
--   explicit deny (V064 authz_policy or role_permission deny) still wins.
--   Reason: keep V062 PII/SOX 紅線 + 三大基線原則 #1 audit traceability.
--
-- Why a function short-circuit (not a wildcard role_permission row):
--   authz_role_permission has FK to authz_resource(resource_id) and
--   authz_action(action_id). No '*' sentinel rows exist; adding one
--   would force every JOIN that resolves resource hierarchy to handle
--   the synthetic row. Function short-circuit is cleaner + cheaper.
--
-- Constitution scope:
--   - Article 2 protects rows in authz_data_source (not touched here).
--   - Function CREATE OR REPLACE on authz_check / authz_resolve is DDL,
--     not in Article 2 scope. Adam approved the design via
--     AskUserQuestion 2026-04-27 (Option B + priority "V065 first").
-- ============================================================

BEGIN;

-- 1. Define SYSADMIN role
INSERT INTO authz_role (role_id, display_name, description, is_system, is_active, security_clearance, job_level)
VALUES (
    'SYSADMIN',
    '系統管理員 (Superuser)',
    'Allow-side god-mode: skips role_permission enumeration for new modules/datasources. Explicit deny (authz_policy effect=deny + role_permission effect=deny) still wins per V064 / SEC-02 deny-wins. Granted via group:SYSADMINS or direct user:* mapping.',
    TRUE,
    TRUE,
    'RESTRICTED'::security_clearance,
    99
)
ON CONFLICT (role_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    is_active = TRUE;

-- 2a. Seed SYSADMINS group subject (FK target for subject_role)
INSERT INTO authz_subject (subject_id, subject_type, display_name, is_active)
VALUES ('group:SYSADMINS', 'ldap_group', '系統管理員群組 (SYSADMIN god-mode holders)', TRUE)
ON CONFLICT (subject_id) DO NOTHING;

-- 2b. Map group → SYSADMIN role (Adam adds members via LDAP or direct subject_role insert)
INSERT INTO authz_subject_role (subject_id, role_id, is_active, granted_by, valid_from)
VALUES ('group:SYSADMINS', 'SYSADMIN', TRUE, 'V066-seed', now())
ON CONFLICT DO NOTHING;

-- 3. authz_check: prepend SYSADMIN short-circuit
CREATE OR REPLACE FUNCTION authz_check(
    p_user_id    TEXT,
    p_user_groups TEXT[],
    p_action     TEXT,
    p_resource   TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles      TEXT[];
    v_source_id  TEXT;
    v_default    authz_effect;
    v_allowed    BOOLEAN;
    v_denied     BOOLEAN;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    -- ── V066: SYSADMIN short-circuit (allow-side god-mode) ──
    -- Behaves identically to default-allow branch — TRUE unless explicit
    -- deny hits. Adam Option B 2026-04-27.
    IF 'SYSADMIN' = ANY(v_roles) THEN
        SELECT
            EXISTS(
                SELECT 1
                FROM authz_role_permission rp
                WHERE rp.role_id = ANY(v_roles)
                  AND rp.is_active = TRUE
                  AND rp.effect = 'deny'
                  AND (rp.action_id = p_action OR rp.action_id = '*')
                  AND rp.resource_id = p_resource
            )
            OR EXISTS(
                SELECT 1
                FROM authz_policy ap
                WHERE ap.status = 'active'
                  AND ap.effect = 'deny'
                  AND ap.granularity IN ('L0_functional', 'L1_data_domain')
                  AND ap.resource_condition->'resource_ids' ? p_resource
                  AND _authz_match_subject_condition(ap.subject_condition, v_roles, '{}'::jsonb)
            )
            INTO v_denied;

        RETURN NOT COALESCE(v_denied, FALSE);
    END IF;

    SELECT ar.attributes->>'data_source_id' INTO v_source_id
    FROM authz_resource ar
    WHERE ar.resource_id = p_resource;

    IF v_source_id IS NOT NULL THEN
        SELECT ds.default_l0_policy INTO v_default
        FROM authz_data_source ds
        WHERE ds.source_id = v_source_id;
    END IF;

    -- ── Default-allow branch (V060 + V064) ──
    IF v_default = 'allow' THEN
        SELECT
            EXISTS(
                SELECT 1
                FROM authz_role_permission rp
                WHERE rp.role_id = ANY(v_roles)
                  AND rp.is_active = TRUE
                  AND rp.effect = 'deny'
                  AND (rp.action_id = p_action OR rp.action_id = '*')
                  AND rp.resource_id = p_resource
            )
            OR EXISTS(
                SELECT 1
                FROM authz_policy ap
                WHERE ap.status = 'active'
                  AND ap.effect = 'deny'
                  AND ap.granularity IN ('L0_functional', 'L1_data_domain')
                  AND ap.resource_condition->'resource_ids' ? p_resource
                  AND _authz_match_subject_condition(ap.subject_condition, v_roles, '{}'::jsonb)
            )
            INTO v_denied;

        RETURN NOT COALESCE(v_denied, FALSE);
    END IF;

    -- ── Legacy default-deny branch ──
    SELECT EXISTS(
        SELECT 1
        FROM authz_role_permission rp
        WHERE rp.role_id = ANY(v_roles)
          AND rp.is_active = TRUE
          AND rp.effect = 'allow'
          AND (rp.action_id = p_action OR rp.action_id = '*')
          AND (
              rp.resource_id = p_resource
              OR rp.resource_id = '*'
              OR rp.resource_id IN (
                  WITH RECURSIVE res_tree AS (
                      SELECT resource_id, parent_id FROM authz_resource WHERE resource_id = p_resource
                      UNION ALL
                      SELECT r.resource_id, r.parent_id
                      FROM authz_resource r JOIN res_tree rt ON r.resource_id = rt.parent_id
                  )
                  SELECT resource_id FROM res_tree
              )
          )
    ) INTO v_allowed;

    IF v_allowed THEN
        SELECT NOT EXISTS(
            SELECT 1
            FROM authz_role_permission rp
            WHERE rp.role_id = ANY(v_roles)
              AND rp.is_active = TRUE
              AND rp.effect = 'deny'
              AND (rp.action_id = p_action OR rp.action_id = '*')
              AND rp.resource_id = p_resource
        ) INTO v_allowed;
    END IF;

    RETURN COALESCE(v_allowed, FALSE);
END;
$$;

-- 4. authz_resolve: add is_sysadmin sidecar so frontend can mark god-mode UI
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

COMMENT ON FUNCTION authz_check(TEXT, TEXT[], TEXT, TEXT) IS
    'V066: SYSADMIN short-circuit added (allow-side god-mode, deny still wins). Order: SYSADMIN → default-allow ds → default-deny.';
COMMENT ON FUNCTION authz_resolve(TEXT, TEXT[], JSONB) IS
    'V066: is_sysadmin sidecar added so frontend can render god-mode UI without enumerating all resources.';

COMMIT;
