-- ============================================================
-- V009: Path B Adapter - Traditional Web ACL Resolve
-- ============================================================

CREATE OR REPLACE FUNCTION authz_resolve_web_acl(
    p_user_id       TEXT,
    p_user_groups   TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles     TEXT[];
    v_pages     JSONB;
    v_apis      JSONB;
    v_public    JSONB;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    -- Accessible web pages
    SELECT jsonb_agg(sub) INTO v_pages
    FROM (
        SELECT jsonb_build_object(
            'resource_id', rp.resource_id,
            'display_name', ar.display_name,
            'actions', jsonb_agg(DISTINCT rp.action_id),
            'attributes', ar.attributes
        ) AS sub
        FROM authz_role_permission rp
        JOIN authz_resource ar ON ar.resource_id = rp.resource_id
        WHERE rp.role_id = ANY(v_roles) AND rp.is_active AND rp.effect = 'allow'
          AND ar.resource_type = 'web_page' AND ar.is_active
        GROUP BY rp.resource_id, ar.display_name, ar.attributes
    ) t;

    -- Accessible web APIs
    SELECT jsonb_agg(sub) INTO v_apis
    FROM (
        SELECT jsonb_build_object(
            'resource_id', rp.resource_id,
            'display_name', ar.display_name,
            'actions', jsonb_agg(DISTINCT rp.action_id),
            'parent_page', ar.parent_id
        ) AS sub
        FROM authz_role_permission rp
        JOIN authz_resource ar ON ar.resource_id = rp.resource_id
        WHERE rp.role_id = ANY(v_roles) AND rp.is_active AND rp.effect = 'allow'
          AND ar.resource_type = 'web_api' AND ar.is_active
        GROUP BY rp.resource_id, ar.display_name, ar.parent_id
    ) t;

    -- Public pages (no auth required)
    SELECT jsonb_agg(jsonb_build_object(
        'resource_id', resource_id,
        'display_name', display_name
    )) INTO v_public
    FROM authz_resource
    WHERE resource_type = 'web_page'
      AND is_active AND (attributes->>'auth_required')::boolean = FALSE;

    RETURN jsonb_build_object(
        'user_id',       p_user_id,
        'resolved_roles', to_jsonb(v_roles),
        'access_path',   'B',
        'resolved_at',   now(),
        'web_pages',     COALESCE(v_pages, '[]'::jsonb),
        'web_apis',      COALESCE(v_apis, '[]'::jsonb),
        'public_pages',  COALESCE(v_public, '[]'::jsonb)
    );
END;
$$;
