-- ============================================================
-- V007: Core Functions - Role Resolution, Permission Check, Row Filter
-- ============================================================

-- Internal helper: resolve roles for a subject
CREATE OR REPLACE FUNCTION _authz_resolve_roles(
    p_user_id       TEXT,
    p_user_groups   TEXT[]
)
RETURNS TEXT[]
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles TEXT[];
BEGIN
    SELECT array_agg(DISTINCT sr.role_id) INTO v_roles
    FROM authz_subject_role sr
    WHERE sr.is_active = TRUE
      AND (sr.valid_until IS NULL OR sr.valid_until > now())
      AND (
          sr.subject_id = 'user:' || p_user_id
          OR sr.subject_id = ANY(SELECT 'group:' || unnest(p_user_groups))
      );
    RETURN COALESCE(v_roles, '{}'::TEXT[]);
END;
$$;

-- authz_check: boolean permission check with resource hierarchy
CREATE OR REPLACE FUNCTION authz_check(
    p_user_id       TEXT,
    p_user_groups   TEXT[],
    p_action        TEXT,
    p_resource      TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles     TEXT[];
    v_allowed   BOOLEAN;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    -- Check allow (with resource hierarchy walk)
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

    -- Explicit deny overrides allow
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

-- ============================================================
-- Shared helper: evaluate subject_condition against user's roles and attributes
-- v2.4: Extracted from authz_filter() to reuse in authz_resolve()
-- Returns TRUE if the user matches the condition (or if condition is empty)
-- ============================================================
CREATE OR REPLACE FUNCTION _authz_match_subject_condition(
    p_condition     JSONB,
    p_roles         TEXT[],
    p_user_attrs    JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    v_cond_key  TEXT;
    v_cond_val  JSONB;
BEGIN
    IF p_condition IS NULL OR p_condition = '{}'::jsonb THEN
        RETURN TRUE;
    END IF;

    FOR v_cond_key, v_cond_val IN
        SELECT key, value FROM jsonb_each(p_condition)
    LOOP
        IF v_cond_key = 'role' THEN
            IF NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(v_cond_val) AS req_role
                WHERE req_role = ANY(p_roles)
            ) THEN
                RETURN FALSE;
            END IF;
        ELSE
            IF NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(v_cond_val) AS req_val
                WHERE req_val = p_user_attrs->>v_cond_key
            ) THEN
                RETURN FALSE;
            END IF;
        END IF;
    END LOOP;

    RETURN TRUE;
END;
$$;

-- authz_filter: generate SQL WHERE clause for row-level filtering
-- v2.4: Uses _authz_match_subject_condition() shared helper
CREATE OR REPLACE FUNCTION authz_filter(
    p_user_id       TEXT,
    p_user_groups   TEXT[],
    p_user_attrs    JSONB,
    p_resource_type TEXT,
    p_path          CHAR(1) DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles     TEXT[];
    v_clauses   TEXT[] := '{}';
    v_policy    RECORD;
    v_expr      TEXT;
    v_attr_key  TEXT;
    v_attr_val  TEXT;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    FOR v_policy IN
        SELECT ap.rls_expression, ap.subject_condition
        FROM authz_policy ap
        WHERE ap.status = 'active'
          AND ap.granularity IN ('L1_data_domain', 'L2_row_column')
          AND ap.rls_expression IS NOT NULL
          AND (ap.effective_until IS NULL OR ap.effective_until > now())
          AND (p_path IS NULL OR p_path = ANY(ap.applicable_paths))
          AND (
              ap.resource_condition->>'resource_id' = p_resource_type
              OR ap.resource_condition->>'resource_type' = split_part(p_resource_type, ':', 1)
          )
    LOOP
        -- v2.4: skip policy if subject_condition doesn't match this user
        IF NOT _authz_match_subject_condition(v_policy.subject_condition, v_roles, p_user_attrs) THEN
            CONTINUE;
        END IF;

        v_expr := v_policy.rls_expression;

        FOR v_attr_key, v_attr_val IN
            SELECT key, value #>> '{}' FROM jsonb_each(p_user_attrs)
        LOOP
            v_expr := replace(v_expr, '${subject.' || v_attr_key || '}', quote_literal(v_attr_val));
        END LOOP;

        v_clauses := array_append(v_clauses, '(' || v_expr || ')');
    END LOOP;

    IF array_length(v_clauses, 1) IS NULL OR array_length(v_clauses, 1) = 0 THEN
        RETURN 'TRUE';
    END IF;

    RETURN array_to_string(v_clauses, ' AND ');
END;
$$;

-- authz_check_from_cache: evaluate resolved config JSON without DB query
CREATE OR REPLACE FUNCTION authz_check_from_cache(
    p_resolved_config JSONB,
    p_action          TEXT,
    p_resource        TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_resolved_config->'L0_functional') AS perm
        WHERE (perm->>'action' = p_action OR perm->>'action' = '*')
          AND (perm->>'resource' = p_resource OR perm->>'resource' = '*')
    );
END;
$$;
