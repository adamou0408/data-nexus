-- ============================================================
-- V070: Permission inheritance cascade — schema-as-parent + deny-walk
-- ============================================================
-- Source: Adam 2026-04-28 vision —
--   "想要的 database & schema 層級適用預設通用,並且對應的 function 也是
--    繼承 schema 的設定. 而用反向的方式,deny 那些 database & schema 不該
--    被看到 ... 降低設定的成本"
--
-- Plan: .claude/plans/v3-phase-1/permission-inheritance-cascade.md
--
-- ── What this migration does ──
-- 1. Seeds db_schema rows for known datasource schemas (pg_k8.tiptop is the
--    only one with active resource children today; rest deferred until
--    Discovery promote auto-ensures them — Phase B of this plan).
-- 2. Reparents existing function:tiptop.* rows so they inherit from the
--    schema row instead of dangling parent_id=NULL.
-- 3. Refreshes resource_ancestors mat view (V037) so the new edges are
--    visible to authz_check_batch and the deny-walk added below.
-- 4. Replaces authz_check() to walk parent_id chain on the deny side as
--    well — schema-level deny now blocks all descendants. Allow-walk and
--    SYSADMIN god-mode + V064 deny-wins invariant are preserved.
-- 5. Extends V067 authz_resolve cross-join to include 'db_schema' so
--    SYSADMIN's god-mode menu sees schema rows too.
--
-- ── What this migration does NOT do (scope discipline per plan §2) ──
--   - Does NOT change resource_id naming for any existing leaf row
--   - Does NOT add a new resource_type enum value (db_schema already exists
--     since V052; we're just starting to use it)
--   - Does NOT modify authz_check_batch — V064 deferred batch update applies
--     here too; single-resource path is the primary read
--   - Does NOT auto-ensure schema rows in Discovery promote — separate PR
--   - Does NOT extend cache invalidation walk — separate PR (cache.ts)
--   - Does NOT touch row_filter / column_mask mechanics — out of scope
--
-- ── Defaults Adam pre-approved 2026-04-28 (default-driven workflow) ──
--   Q1 (schema naming): db_schema:<datasource_id_after_colon>.<schema_name>
--                       e.g. db_schema:pg_k8.tiptop
--   Q2 (Path C sync):   skip — V063 ALL TABLES IN SCHEMA already covers
--   Q3 (wildcard deny): skip — no schema:* wildcards in V070
--
-- ── Rollback ──
-- Re-applying V066 (authz_check) + V067 (authz_resolve) restores prior
-- behaviour. Schema rows + reparent edges remain but become inert (no
-- ancestor walk via deny path). See migration-drafts/V070_rollback.sql
-- if rollback needed.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Seed db_schema rows for active datasources
-- ────────────────────────────────────────────────────────────
-- Naming convention: db_schema:<datasource_short>.<schema_name>
--   where <datasource_short> = source_id with leading 'ds:' stripped.
--
-- Today only ds:pg_k8 / tiptop has resource children. Other schemas will
-- be created on-demand by the Discovery promote auto-ensure flow.

INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
    'db_schema:pg_k8.tiptop',
    'db_schema',
    NULL,  -- chain top: NULL parent. authz_check derives default from
           -- attributes.data_source_id → authz_data_source.default_l0_policy
    'pg_k8 / tiptop',
    jsonb_build_object(
        'data_source_id', 'ds:pg_k8',
        'schema_name', 'tiptop',
        'default_policy_inherits', 'data_source',
        'created_by', 'V070',
        'comment', 'Schema-level container; descendants inherit policy unless explicit grant/deny on the schema row.'
    ),
    TRUE
)
ON CONFLICT (resource_id) DO UPDATE
SET attributes  = EXCLUDED.attributes,
    is_active   = TRUE,
    updated_at  = now();

-- ────────────────────────────────────────────────────────────
-- 2. Reparent existing tiptop-schema functions
-- ────────────────────────────────────────────────────────────
-- Pre-V070: parent_id = NULL on all 3 function rows.
-- Post-V070: parent_id = db_schema:pg_k8.tiptop so deny-walk catches them.
UPDATE authz_resource
   SET parent_id = 'db_schema:pg_k8.tiptop',
       updated_at = now()
 WHERE resource_id LIKE 'function:tiptop.%'
   AND resource_type = 'function'
   AND parent_id IS NULL;

-- ────────────────────────────────────────────────────────────
-- 3. Refresh ancestors mat view (V037) so new edges are visible
-- ────────────────────────────────────────────────────────────
REFRESH MATERIALIZED VIEW resource_ancestors;

-- ────────────────────────────────────────────────────────────
-- 4. Replace authz_check — extend deny check to walk ancestors
-- ────────────────────────────────────────────────────────────
-- Diff vs V066:
--   - SYSADMIN branch: deny check now walks ancestors (was direct match)
--   - Default-allow branch: deny check now walks ancestors (was direct match)
--   - Default-deny branch: deny check now walks ancestors (was direct match)
--   - Allow walk in default-deny branch: replaced inline recursive CTE with
--     resource_ancestors mat view (semantic identical, faster)
--
-- Invariant preservation:
--   - V064: deny still wins on default-allow datasources ✓
--   - V066: SYSADMIN god-mode short-circuits allow-side ✓
--   - SEC-02: deny-wins ✓ (now extended to ancestor-deny)
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
    -- Deny check (walks ancestors per V070): any ancestor-deny on this
    -- subject blocks even SYSADMIN. authz_policy deny still direct-match
    -- (policy granularity is per-resource, not cascading).
    IF 'SYSADMIN' = ANY(v_roles) THEN
        SELECT
            EXISTS(
                SELECT 1
                FROM authz_role_permission rp
                JOIN resource_ancestors ra ON ra.ancestor_id = rp.resource_id
                WHERE ra.resource_id = p_resource
                  AND rp.role_id = ANY(v_roles)
                  AND rp.is_active = TRUE
                  AND rp.effect = 'deny'
                  AND (rp.action_id = p_action OR rp.action_id = '*')
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

    -- Datasource lookup for default-allow flag
    SELECT ar.attributes->>'data_source_id' INTO v_source_id
    FROM authz_resource ar
    WHERE ar.resource_id = p_resource;

    IF v_source_id IS NOT NULL THEN
        SELECT ds.default_l0_policy INTO v_default
        FROM authz_data_source ds
        WHERE ds.source_id = v_source_id;
    END IF;

    -- ── Default-allow branch (V060 + V064 + V070 ancestor-deny) ──
    IF v_default = 'allow' THEN
        SELECT
            EXISTS(
                SELECT 1
                FROM authz_role_permission rp
                JOIN resource_ancestors ra ON ra.ancestor_id = rp.resource_id
                WHERE ra.resource_id = p_resource
                  AND rp.role_id = ANY(v_roles)
                  AND rp.is_active = TRUE
                  AND rp.effect = 'deny'
                  AND (rp.action_id = p_action OR rp.action_id = '*')
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

    -- ── Legacy default-deny branch (V070: switched to mat view + ancestor-deny) ──
    -- Allow: any ancestor (or '*') has role_permission with effect=allow.
    SELECT EXISTS(
        SELECT 1
        FROM authz_role_permission rp
        WHERE rp.role_id = ANY(v_roles)
          AND rp.is_active = TRUE
          AND rp.effect = 'allow'
          AND (rp.action_id = p_action OR rp.action_id = '*')
          AND (
              rp.resource_id = '*'
              OR rp.resource_id IN (
                  SELECT ra.ancestor_id FROM resource_ancestors ra
                   WHERE ra.resource_id = p_resource
              )
          )
    ) INTO v_allowed;

    -- Deny: any ancestor has role_permission with effect=deny → block.
    IF v_allowed THEN
        SELECT NOT EXISTS(
            SELECT 1
            FROM authz_role_permission rp
            JOIN resource_ancestors ra ON ra.ancestor_id = rp.resource_id
            WHERE ra.resource_id = p_resource
              AND rp.role_id = ANY(v_roles)
              AND rp.is_active = TRUE
              AND rp.effect = 'deny'
              AND (rp.action_id = p_action OR rp.action_id = '*')
        ) INTO v_allowed;
    END IF;

    RETURN COALESCE(v_allowed, FALSE);
END;
$$;

-- ────────────────────────────────────────────────────────────
-- 5. Extend V067 authz_resolve cross-join to include db_schema
-- ────────────────────────────────────────────────────────────
-- SYSADMIN's god-mode menu now sees schema rows too. Non-SYSADMIN path
-- unchanged (only sees resource_types they have explicit grants on).
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

    IF v_is_sysadmin THEN
        SELECT jsonb_agg(jsonb_build_object(
            'resource', ar.resource_id,
            'action', aa.action_id,
            'effect', 'allow'
        ))
        INTO v_functional
        FROM authz_resource ar
        CROSS JOIN authz_action aa
        WHERE ar.resource_type IN (
            'module', 'page', 'table', 'column', 'function', 'ai_tool',
            'db_schema'  -- V070: schema rows visible in god-mode menu
        )
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
          AND ar.resource_type IN (
              'module', 'page', 'table', 'column', 'function', 'ai_tool',
              'db_schema'  -- V070: explicit schema grants surface to non-SYSADMIN too
          );
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

COMMENT ON FUNCTION authz_check(TEXT, TEXT[], TEXT, TEXT) IS
    'V070: deny check now walks resource_ancestors (mat view) — schema-level deny blocks descendants. SYSADMIN god-mode + V064 deny-wins + default-allow / default-deny branches preserved. Allow walk in default-deny branch switched from inline recursive CTE to mat view (V037).';

COMMENT ON FUNCTION authz_resolve(TEXT, TEXT[], JSONB) IS
    'V070: db_schema added to L0_functional resource_type filter (both SYSADMIN cross-join and non-SYSADMIN enumeration). V066 is_sysadmin sidecar + V067 cross-join retained.';

-- ────────────────────────────────────────────────────────────
-- 6. Audit row (constitution §9.7 AI identity columns + V065)
-- ────────────────────────────────────────────────────────────
INSERT INTO authz_audit_log (
    access_path, subject_id, action_id, resource_id, decision,
    context, actor_type, agent_id, model_id, consent_given, timestamp
) VALUES (
    'A', 'user:adam_ou', 'migration_apply', 'authz_check', 'allow',
    jsonb_build_object(
        'migration', 'V070',
        'plan', '.claude/plans/v3-phase-1/permission-inheritance-cascade.md',
        'changes', ARRAY[
            'seed db_schema:pg_k8.tiptop',
            'reparent function:tiptop.* parent_id',
            'refresh resource_ancestors',
            'authz_check deny-walk via resource_ancestors',
            'authz_resolve include db_schema in L0_functional cross-join'
        ],
        'invariants_preserved', ARRAY['V064 deny-wins', 'V066 SYSADMIN god-mode', 'SEC-02 deny-wins'],
        'consent_basis', 'AskUserQuestion 2026-04-28 default-driven workflow approval'
    ),
    'ai_agent', 'claude-planner-executor-v1', 'claude-opus-4-7', TRUE, now()
);

COMMIT;

-- ────────────────────────────────────────────────────────────
-- 7. Post-apply verification (run manually)
-- ────────────────────────────────────────────────────────────
-- Expected after V070:
--   SELECT COUNT(*) FROM authz_resource WHERE resource_type='db_schema';
--     → 1  (db_schema:pg_k8.tiptop)
--
--   SELECT COUNT(*) FROM authz_resource
--    WHERE resource_id LIKE 'function:tiptop.%' AND parent_id='db_schema:pg_k8.tiptop';
--     → 3
--
--   SELECT * FROM resource_ancestors
--    WHERE resource_id LIKE 'function:tiptop.%';
--     → at least 6 rows (3 functions × {self, db_schema parent})
--
--   -- End-to-end cascade test:
--   --   1. ds:pg_k8.default_l0_policy = 'allow'
--   --   2. authz_check('user:tsai_bi', ARRAY['BI_USER'], 'execute',
--   --                  'function:tiptop.get_work_orders_by_part') → TRUE
--   --   3. INSERT INTO authz_role_permission(role_id, action_id, resource_id, effect)
--   --        VALUES ('BI_USER', 'execute', 'db_schema:pg_k8.tiptop', 'deny');
--   --   4. authz_check(...) → FALSE  -- ancestor deny propagates
