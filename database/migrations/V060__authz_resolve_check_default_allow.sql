-- ============================================================
-- V060: authz_resolve() / authz_check() default-allow inversion
--
-- Phase 1 of permission-default-allow
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-1.2 / 1.3).
--
-- Pre-req: V059 added authz_data_source.default_l0_policy column.
--
-- What this migration does:
--   1. Rewrite authz_check() so resources whose owning datasource has
--      default_l0_policy='allow' default to allow, and only an explicit
--      authz_role_permission(effect='deny') row blocks access.
--   2. Rewrite authz_resolve() to emit a sibling JSONB key
--      `L0_default_allow_sources` listing source_ids running default-allow,
--      so Path A frontends can render "this datasource is open by default,
--      explicit denies hidden" without a second round-trip.
--
-- What this migration does NOT do:
--   - Touch authz_check_from_cache(). The cache check is per-resource and
--     does not know the resource's data_source_id. Plan §3.2 explicitly
--     pushes default-allow interpretation to the frontend ("前端依旗標
--     決定預設可見"). Keeping cache-side semantics legacy avoids ballooning
--     the resolved JSONB with a full resource→source map (~10K-100K rows).
--   - Walk ancestors for the deny check in the invert branch. Deny patterns
--     in §3.4 (`*_password`, `salary`, ...) target columns directly. If
--     parent-deny inheritance is later needed, that's a follow-up migration.
--   - Change L1/L2/L3 SEMANTICS. Per plan §1, sensitive data protection
--     stays exactly where it is — RLS row filter + column mask still apply
--     on top of L0. (Note: this migration *does* fix pre-existing bugs in
--     the L1/L2/L3 query bodies — see "INCIDENTAL FIXES" below — but the
--     intended behaviour is unchanged.)
--
-- ────────────────────────────────────────────────────────────
-- INCIDENTAL FIXES (Phase 1 added scope, V008-era origin)
-- ────────────────────────────────────────────────────────────
-- Rewriting authz_resolve() in this file uncovered two pre-existing bugs
-- that have made the function hard-error on every call since the V008-era
-- enum/schema renames. They are repaired here because CREATE OR REPLACE
-- has to ship a fully-working body. No caller could have depended on the
-- broken behaviour, so this is a strict bug fix, not a behaviour change.
--
--   1. L1 / L2 enum literals: V024 wrote `granularity = 'L1'` / `'L2'`,
--      but a later migration renamed the authz_granularity enum members
--      to L1_data_domain / L2_row_column. Every call raised
--      "invalid input value for enum authz_granularity".
--      Fix: literals updated to L1_data_domain / L2_row_column.
--
--   2. L3 composite_action column references: V024 referenced
--      ca.action_id / ca.resource_id / ca.is_active / ca.required_role —
--      none of which exist on authz_composite_action. The V003 schema
--      defines target_action / target_resource / status, with
--      required_role nested per-step inside the approval_chain JSONB.
--      Every call raised "column does not exist".
--      Fix: column references updated; required_role lookup rewritten as
--      a JSONB EXISTS over jsonb_array_elements(approval_chain).
--
-- Regression coverage for these fixes lives in
-- scripts/verify-phase1-default-allow.sh under the L1/L2/L3 section.
--
-- Resource→source lookup convention:
--   authz_resource.attributes->>'data_source_id' is set by the discovery
--   sync at services/authz-api/src/routes/datasource.ts:685 (tables/views),
--   :713 (columns), :728 (PG functions), :791 (Oracle functions).
--   Resources without an attribute (module:, page:, web_*, ai_tool:, ...)
--   have NULL data_source_id and fall through to legacy semantics.
-- ============================================================

-- ─── 1. authz_check() with default-allow inversion ───
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

    -- Resolve resource → datasource → default policy.
    -- Resources without a data_source_id attribute (module:, page:, web_*,
    -- ai_tool:, ...) yield NULL, which triggers legacy default-deny below.
    SELECT ar.attributes->>'data_source_id' INTO v_source_id
    FROM authz_resource ar
    WHERE ar.resource_id = p_resource;

    IF v_source_id IS NOT NULL THEN
        SELECT ds.default_l0_policy INTO v_default
        FROM authz_data_source ds
        WHERE ds.source_id = v_source_id;
    END IF;

    -- ── Default-allow branch ──
    -- Datasource flagged 'allow' → return TRUE unless an explicit deny hits.
    -- Direct match only (no ancestor walk) — see migration header for why.
    IF v_default = 'allow' THEN
        SELECT EXISTS(
            SELECT 1
            FROM authz_role_permission rp
            WHERE rp.role_id = ANY(v_roles)
              AND rp.is_active = TRUE
              AND rp.effect = 'deny'
              AND (rp.action_id = p_action OR rp.action_id = '*')
              AND rp.resource_id = p_resource
        ) INTO v_denied;

        RETURN NOT COALESCE(v_denied, FALSE);
    END IF;

    -- ── Legacy default-deny branch (unchanged from V007) ──
    -- Check allow with resource hierarchy walk.
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

    -- Explicit deny overrides allow.
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

-- ─── 2. authz_resolve() — emit L0_default_allow_sources sidecar ───
-- Adds the list of source_ids running default-allow alongside the existing
-- L0/L1/L2/L3 keys. Frontends consult the list to render "open by default
-- minus explicit denies" semantics on Path A. Cache-side authz_check_from_cache()
-- intentionally stays legacy (per migration header).
--
-- We list ALL sources with flag='allow', not just those the user touches —
-- pilot scope is one source, so the cost is trivial; widening the pilot
-- doesn't require a resolver rewrite.
CREATE OR REPLACE FUNCTION authz_resolve(
    p_user_id       TEXT,
    p_user_groups   TEXT[],
    p_user_attrs    JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles                 TEXT[];
    v_functional            JSONB;
    v_data_scope            JSONB;
    v_column_masks          JSONB;
    v_actions               JSONB;
    v_default_allow_sources TEXT[];
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    -- L0: functional permissions — unchanged from V024 (allow + deny entries
    -- both included for SEC-02 deny-wins cache semantics).
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

    -- L0 sidecar: datasources running default-allow. Pilot ≈ 1 source,
    -- so we materialize the full list — no per-user filtering needed.
    SELECT array_agg(source_id) INTO v_default_allow_sources
    FROM authz_data_source
    WHERE default_l0_policy = 'allow';

    -- L1: data domain scope.
    -- Fixes pre-existing V024 bug: literals were 'L1'/'L2' but the
    -- authz_granularity enum was renamed to L1_data_domain/L2_row_column
    -- in a later migration, so V024's authz_resolve raised
    -- "invalid input value for enum authz_granularity" on every call.
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

    -- L2: column masks.
    SELECT jsonb_object_agg(ap.policy_name, ap.column_mask_rules) INTO v_column_masks
    FROM authz_policy ap
    WHERE ap.granularity = 'L2_row_column' AND ap.status = 'active'
      AND ap.column_mask_rules IS NOT NULL
      AND _authz_match_subject_condition(ap.subject_condition, v_roles, p_user_attrs);

    -- L3: composite actions.
    -- Fixes another pre-existing V024 bug: V024 referenced
    -- ca.action_id / ca.resource_id / ca.is_active / ca.required_role —
    -- none of which exist on this table. The V003 schema actually defines
    -- target_action / target_resource / status / approval_chain (with
    -- required_role nested per-step inside approval_chain JSONB). V024's
    -- L3 block has therefore raised "column does not exist" since at
    -- least V008.
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
        'L0_functional',              COALESCE(v_functional, '[]'::jsonb),
        'L0_default_allow_sources',   COALESCE(to_jsonb(v_default_allow_sources), '[]'::jsonb),
        'L1_data_scope',              COALESCE(v_data_scope, '{}'::jsonb),
        'L2_column_masks',            COALESCE(v_column_masks, '{}'::jsonb),
        'L3_actions',                 COALESCE(v_actions, '[]'::jsonb)
    );
END;
$$;

-- ─── 3. authz_check_batch() with default-allow inversion ───
-- Path A's batch UI rendering relies on this for N-resources × 1-action checks.
-- Same semantics as the rewritten authz_check(): per-resource lookup of
-- attributes->>'data_source_id' → default_l0_policy. If the per-row default
-- is 'allow', allowed = NOT EXISTS(explicit deny on that resource); otherwise
-- legacy logic (allow_set ∧ ¬denied_set) applies.
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
    -- Per input resource: resolve default policy via authz_resource → authz_data_source.
    -- LEFT JOIN so resources without a data_source_id attribute keep NULL → legacy.
    resource_default AS (
      SELECT
        i.resource_id,
        ds.default_l0_policy AS default_policy
      FROM input_res i
      LEFT JOIN authz_resource ar ON ar.resource_id = i.resource_id
      LEFT JOIN authz_data_source ds
        ON ds.source_id = ar.attributes->>'data_source_id'
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
    rd.resource_id,
    CASE
      WHEN rd.default_policy = 'allow'
        THEN d.resource_id IS NULL                          -- invert: only explicit deny blocks
      ELSE
        a.resource_id IS NOT NULL AND d.resource_id IS NULL -- legacy: allow ∧ ¬deny
    END AS allowed
  FROM resource_default rd
  LEFT JOIN allowed_set a ON a.resource_id = rd.resource_id
  LEFT JOIN denied_set  d ON d.resource_id = rd.resource_id;
END;
$$;

COMMENT ON FUNCTION authz_check(TEXT, TEXT[], TEXT, TEXT) IS
    'V060: default-allow inversion. Resources whose authz_data_source.default_l0_policy=''allow'' return TRUE unless an explicit role_permission(effect=''deny'') matches the (action, resource_id) pair directly. Resources without a data_source_id attribute (modules/pages/web_*/ai_tool) keep legacy default-deny semantics.';

COMMENT ON FUNCTION authz_resolve(TEXT, TEXT[], JSONB) IS
    'V060: emits L0_default_allow_sources alongside L0_functional. Frontends interpret the sidecar to render default-allow datasources as "open minus explicit denies". cache-side authz_check_from_cache() intentionally stays legacy — inversion happens server-side via authz_check() or in the Path A frontend.';

COMMENT ON FUNCTION authz_check_batch(TEXT, TEXT[], TEXT, TEXT[]) IS
    'V060: per-resource default-allow inversion. For each input resource, lookup attributes->>data_source_id → default_l0_policy. ''allow'' rows return TRUE unless an explicit deny exists; ''deny''/NULL rows use V040 legacy semantics (allow ∧ ¬deny).';
