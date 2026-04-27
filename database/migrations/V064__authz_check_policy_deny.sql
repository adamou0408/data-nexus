-- ============================================================
-- V064: authz_check() — honour authz_policy(effect='deny') in allow branch
--
-- Phase 1 of permission-default-allow
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-1.5).
--
-- Closes the gap between V062 (deny pattern seed) and V060 (default-allow
-- inversion). Plan AC-1.5 promises operators that approved deny suggestions
-- "become authz_policy(effect='deny') rows" — but V060 only consults
-- authz_role_permission for the deny override, so an approved suggestion
-- sat in authz_policy unenforced.
--
-- This migration widens V060's allow-branch deny check to also EXIST-test
-- authz_policy where:
--   - effect = 'deny'
--   - status = 'active'
--   - granularity ∈ {L0_functional, L1_data_domain}  (engine targets L0;
--     L1 included so future top-down deny policies enforce too)
--   - resource_condition->'resource_ids' ? p_resource  (direct match)
--   - subject_condition matches the user's roles (empty = matches all)
--
-- ────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT DO
-- ────────────────────────────────────────────────────────────
--   - Touch the LEGACY default-deny branch. Adding policy-driven denies to
--     legacy datasources is a behaviour change beyond Phase 1 scope; the
--     plan only scopes the inversion to default-allow datasources. Legacy
--     enforcement stays "explicit allow ∧ ¬role_permission_deny".
--   - Touch authz_check_batch(). V064 covers single-resource lookups,
--     which is the primary path. A Phase 2 follow-up may widen the batch
--     query if pilot telemetry shows the gap matters.
--   - Walk ancestors. Same direct-match semantics as V060.
--
-- ────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────
-- Re-applying V060 against the dev DB restores the prior body. No data
-- changes — pure function replacement.
-- ============================================================

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
    v_roles      TEXT[];
    v_source_id  TEXT;
    v_default    authz_effect;
    v_allowed    BOOLEAN;
    v_denied     BOOLEAN;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    SELECT ar.attributes->>'data_source_id' INTO v_source_id
    FROM authz_resource ar
    WHERE ar.resource_id = p_resource;

    IF v_source_id IS NOT NULL THEN
        SELECT ds.default_l0_policy INTO v_default
        FROM authz_data_source ds
        WHERE ds.source_id = v_source_id;
    END IF;

    -- ── Default-allow branch (V060 + V064) ──
    -- Datasource flagged 'allow' → return TRUE unless an explicit deny hits.
    -- Two deny sources are checked:
    --   1. authz_role_permission(effect='deny')  [V060 path, role-direct]
    --   2. authz_policy(effect='deny', status='active')  [V064 path, policy-driven]
    -- Either one wins (deny-wins per SEC-02).
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

    -- ── Legacy default-deny branch (unchanged from V060) ──
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

COMMENT ON FUNCTION authz_check(TEXT, TEXT[], TEXT, TEXT) IS
    'V060 + V064: default-allow inversion with two deny sources in the allow branch — authz_role_permission(effect=deny) AND authz_policy(effect=deny, status=active, granularity in L0/L1). Legacy default-deny branch unchanged. AC-1.5 enforcement contract: an approved deny suggestion (engine writes pending_review→operator approves→status=active) is now honoured by L0 lookups against default-allow datasources.';
