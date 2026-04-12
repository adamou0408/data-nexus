-- ============================================================
-- V017: Fix authz_filter() resource_condition matching
-- Problem: resource_condition only checked resource_type,
--   ignoring data_domain. This caused SALES region filters
--   to be applied to lot_status (which has no region column).
-- Fix: When data_domain is specified in resource_condition,
--   check if the target resource belongs to that domain
--   by walking the resource hierarchy.
-- ============================================================

-- Helper: check if a resource belongs to a data_domain
-- Walks parent hierarchy and checks if any ancestor's resource_id
-- contains one of the domain keywords.
-- e.g. table:lot_status → parent module:mrp.lot_tracking → matches "lot"
--      table:sales_order → parent module:sales.order_mgmt → matches "order"
CREATE OR REPLACE FUNCTION _authz_resource_matches_domain(
    p_resource_id   TEXT,
    p_domains       JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_domain    TEXT;
    v_ancestor  TEXT;
BEGIN
    -- If no domain filter, always match
    IF p_domains IS NULL OR jsonb_array_length(p_domains) = 0 THEN
        RETURN TRUE;
    END IF;

    -- Walk the resource hierarchy and check domain keywords
    FOR v_ancestor IN
        WITH RECURSIVE res_tree AS (
            SELECT resource_id, parent_id FROM authz_resource WHERE resource_id = p_resource_id
            UNION ALL
            SELECT r.resource_id, r.parent_id
            FROM authz_resource r JOIN res_tree rt ON r.resource_id = rt.parent_id
        )
        SELECT resource_id FROM res_tree
    LOOP
        FOR v_domain IN
            SELECT jsonb_array_elements_text(p_domains)
        LOOP
            IF v_ancestor ILIKE '%' || v_domain || '%' THEN
                RETURN TRUE;
            END IF;
        END LOOP;
    END LOOP;

    RETURN FALSE;
END;
$$;

-- Updated authz_filter: now checks data_domain in resource_condition
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
        SELECT ap.rls_expression, ap.subject_condition, ap.resource_condition
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
        -- Skip if subject_condition doesn't match this user
        IF NOT _authz_match_subject_condition(v_policy.subject_condition, v_roles, p_user_attrs) THEN
            CONTINUE;
        END IF;

        -- Skip if data_domain is specified but resource doesn't match
        IF v_policy.resource_condition ? 'data_domain'
           AND NOT _authz_resource_matches_domain(
               p_resource_type,
               v_policy.resource_condition->'data_domain'
           ) THEN
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
