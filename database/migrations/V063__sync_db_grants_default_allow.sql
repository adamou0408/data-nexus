-- ============================================================
-- V063: authz_sync_db_grants() — default-allow branch
--
-- Phase 1 of permission-default-allow
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-1.6).
--
-- ────────────────────────────────────────────────────────────
-- WHY THIS MIGRATION EXISTS
-- ────────────────────────────────────────────────────────────
-- V041 sync_db_grants assumes legacy "explicit-allow-list" semantics:
--   REVOKE ALL → GRANT only allowed_tables → REVOKE column denies.
-- For Path C against a default-allow datasource (V059
-- default_l0_policy='allow'), we instead want:
--   wide GRANT on the whole schema + GRANT EXECUTE on functions +
--   ALTER DEFAULT PRIVILEGES so freshly-created tables inherit access,
--   then REVOKE only the explicitly-denied resources.
--
-- This file replaces authz_sync_db_grants() with a function that
-- branches on each profile's data_source_id → default_l0_policy.
--
-- ────────────────────────────────────────────────────────────
-- ROLLBACK SYMMETRY (AC-1.7)
-- ────────────────────────────────────────────────────────────
-- ALTER DEFAULT PRIVILEGES writes durable rows into pg_default_acl;
-- they survive function replacement and silently re-grant access on
-- newly-created tables until explicitly revoked. The legacy branch
-- below therefore runs the SAME ALTER DEFAULT PRIVILEGES ... REVOKE
-- triplet so flipping default_l0_policy back to 'deny' is a true
-- rollback (not just "stop adding new grants").
--
-- ⚠️  Per-grantor caveat: ALTER DEFAULT PRIVILEGES applies only to
-- objects created by the role that ran the statement (here:
-- nexus_admin, the migration runner). If a different role later
-- creates objects in the schema, they will not inherit. Phase 1 pilot
-- assumes nexus_admin owns all schema DDL — Phase 2 must extend to
-- other grantors via FOR ROLE iteration.
--
-- ────────────────────────────────────────────────────────────
-- DENY-LIST LAYERING (allow branch)
-- ────────────────────────────────────────────────────────────
-- Two deny sources are walked after the wide GRANT:
--   1. authz_role_permission(effect='deny', is_active=TRUE) joined to
--      authz_resource where attributes->>'data_source_id' matches the
--      profile's data_source_id. Granularity: table-level (REVOKE ALL
--      ON table) or column-level (REVOKE SELECT(col)).
--      NOTE: profiles don't carry role_id directly, so this branch
--      revokes denies for the *role assigned to this profile* via
--      authz_subject_role × authz_db_pool_assignment lookup. When the
--      mapping is ambiguous (multiple roles share a pool), we union
--      all role denies — safe because deny-wins.
--   2. The existing _authz_pool_ssot_denied_columns(profile_id)
--      column-level loop, unchanged from V041.
--
-- Today (2026-04) authz_policy has 0 effect='deny' rows so the
-- table-level loop is a no-op against current data; the wiring is
-- exercised the moment ops materializes a deny policy from the V062
-- discovery suggestions.
-- ============================================================

CREATE OR REPLACE FUNCTION authz_sync_db_grants()
RETURNS TABLE(action TEXT, detail TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
    v_profile          RECORD;
    v_schema           TEXT;
    v_table            TEXT;
    v_ssot_denied      JSONB;
    v_merged_denied    JSONB;
    v_denied_table     TEXT;
    v_denied_col       TEXT;
    v_col_arr          JSONB;
    v_default_policy   authz_effect;
    v_deny_resource    RECORD;
    v_table_only       TEXT;
    v_col_only         TEXT;
BEGIN
    FOR v_profile IN
        SELECT p.*,
               COALESCE(ds.default_l0_policy, 'deny'::authz_effect) AS default_l0_policy
        FROM authz_db_pool_profile p
        LEFT JOIN authz_data_source ds ON ds.source_id = p.data_source_id
        WHERE p.is_active = TRUE
          AND (p.data_source_id IS NULL OR p.data_source_id = 'ds:local')
    LOOP
        v_default_policy := v_profile.default_l0_policy;

        -- Ensure PG role exists
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_profile.pg_role) THEN
            EXECUTE format('CREATE ROLE %I LOGIN', v_profile.pg_role);
            action := 'CREATE_ROLE'; detail := v_profile.pg_role;
            RETURN NEXT;

            INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
            VALUES ('db_grant', v_profile.pg_role, 'CREATE ROLE ' || v_profile.pg_role || ' LOGIN', 'synced', now());
        END IF;

        -- Set NOBYPASSRLS if RLS should apply
        IF v_profile.rls_applies THEN
            EXECUTE format('ALTER ROLE %I NOBYPASSRLS', v_profile.pg_role);
        END IF;

        -- Compute SSOT denied columns and merge with static overrides
        v_ssot_denied := _authz_pool_ssot_denied_columns(v_profile.profile_id);
        v_merged_denied := COALESCE(v_ssot_denied, '{}'::jsonb) || COALESCE(v_profile.denied_columns, '{}'::jsonb);

        -- ─── Per-schema GRANT loop ───
        FOREACH v_schema IN ARRAY v_profile.allowed_schemas
        LOOP
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', v_schema, v_profile.pg_role);
            EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', v_schema, v_profile.pg_role);

            IF v_default_policy = 'allow' THEN
                -- ─── DEFAULT-ALLOW BRANCH (Phase 1 AC-1.6) ───
                -- Wide grant: every table in schema, future tables too.
                EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
                EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
                EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);

                -- Future objects (only those created by current_user — see header caveat)
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO %I',
                               v_schema, v_profile.pg_role);
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I',
                               v_schema, v_profile.pg_role);
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE ON SEQUENCES TO %I',
                               v_schema, v_profile.pg_role);

                action := 'GRANT_DEFAULT_ALLOW';
                detail := v_schema || ' -> ' || v_profile.pg_role || ' (wide + default privs)';
                RETURN NEXT;

                INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
                VALUES ('db_grant', v_schema || '->' || v_profile.pg_role,
                        'GRANT default-allow (SELECT/EXECUTE/USAGE + ALTER DEFAULT PRIVILEGES) ON SCHEMA '
                        || v_schema || ' TO ' || v_profile.pg_role,
                        'synced', now());
            ELSE
                -- ─── LEGACY EXPLICIT-ALLOW-LIST BRANCH (V041 body) ───
                CASE v_profile.connection_mode
                    WHEN 'readonly' THEN
                        IF v_profile.allowed_tables IS NULL THEN
                            EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
                        ELSE
                            FOREACH v_table IN ARRAY v_profile.allowed_tables
                            LOOP
                                EXECUTE format('GRANT SELECT ON %I.%I TO %I', v_schema, v_table, v_profile.pg_role);
                            END LOOP;
                        END IF;

                    WHEN 'readwrite' THEN
                        IF v_profile.allowed_tables IS NULL THEN
                            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I',
                                           v_schema, v_profile.pg_role);
                        ELSE
                            FOREACH v_table IN ARRAY v_profile.allowed_tables
                            LOOP
                                EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO %I',
                                               v_schema, v_table, v_profile.pg_role);
                            END LOOP;
                        END IF;

                    WHEN 'admin' THEN
                        EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
                END CASE;

                -- Symmetric REVOKE of any leftover default privileges from a
                -- prior allow-mode flip, so rollback is a true reset (AC-1.7).
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE SELECT ON TABLES FROM %I',
                               v_schema, v_profile.pg_role);
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE EXECUTE ON FUNCTIONS FROM %I',
                               v_schema, v_profile.pg_role);
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE USAGE ON SEQUENCES FROM %I',
                               v_schema, v_profile.pg_role);

                action := 'GRANT_' || v_profile.connection_mode::TEXT;
                detail := v_schema || ' -> ' || v_profile.pg_role;
                RETURN NEXT;

                INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
                VALUES ('db_grant', v_schema || '->' || v_profile.pg_role,
                        'GRANT ' || v_profile.connection_mode || ' ON SCHEMA ' || v_schema || ' TO ' || v_profile.pg_role
                        || ' (+ symmetric ALTER DEFAULT PRIVILEGES REVOKE)',
                        'synced', now());
            END IF;
        END LOOP;

        -- ─── Default-allow branch: REVOKE explicitly-denied resources ───
        -- Walks authz_role_permission(effect='deny') for every role currently
        -- pooled to this pg_role, scoped to resources in this datasource.
        IF v_default_policy = 'allow' THEN
            FOR v_deny_resource IN
                SELECT DISTINCT ar.resource_id, ar.resource_type
                FROM authz_db_pool_assignment a
                JOIN authz_subject_role sr ON sr.subject_id = a.subject_id
                JOIN authz_role_permission rp
                  ON rp.role_id = sr.role_id
                 AND rp.effect = 'deny'
                 AND rp.is_active = TRUE
                JOIN authz_resource ar
                  ON ar.resource_id = rp.resource_id
                 AND ar.attributes->>'data_source_id' = v_profile.data_source_id
                WHERE a.profile_id = v_profile.profile_id
            LOOP
                BEGIN
                    IF v_deny_resource.resource_type = 'table' THEN
                        v_table_only := substring(v_deny_resource.resource_id from '^table:(.+)$');
                        IF v_table_only IS NOT NULL THEN
                            EXECUTE format('REVOKE ALL ON %I FROM %I', v_table_only, v_profile.pg_role);
                            action := 'REVOKE_TABLE_DENY';
                            detail := v_table_only || ' FROM ' || v_profile.pg_role;
                            RETURN NEXT;
                        END IF;
                    ELSIF v_deny_resource.resource_type = 'column' THEN
                        v_table_only := substring(v_deny_resource.resource_id from '^column:([^.]+)\.');
                        v_col_only   := substring(v_deny_resource.resource_id from '^column:[^.]+\.(.+)$');
                        IF v_table_only IS NOT NULL AND v_col_only IS NOT NULL THEN
                            EXECUTE format('REVOKE SELECT (%I) ON %I FROM %I',
                                           v_col_only, v_table_only, v_profile.pg_role);
                            action := 'REVOKE_COLUMN_DENY';
                            detail := v_table_only || '.' || v_col_only || ' FROM ' || v_profile.pg_role;
                            RETURN NEXT;
                        END IF;
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    action := 'REVOKE_DENY_SKIP';
                    detail := v_deny_resource.resource_id || ' (' || SQLERRM || ')';
                    RETURN NEXT;
                END;
            END LOOP;
        END IF;

        -- ─── Column-level deny REVOKE (legacy + allow modes both apply) ───
        IF v_merged_denied IS NOT NULL AND v_merged_denied != '{}'::jsonb THEN
            FOR v_denied_table, v_col_arr IN
                SELECT key, value FROM jsonb_each(v_merged_denied)
            LOOP
                FOR v_denied_col IN
                    SELECT jsonb_array_elements_text(v_col_arr)
                LOOP
                    BEGIN
                        EXECUTE format('REVOKE SELECT (%I) ON %I FROM %I',
                                       v_denied_col, v_denied_table, v_profile.pg_role);
                        action := 'REVOKE_COLUMN';
                        detail := v_denied_table || '.' || v_denied_col || ' FROM ' || v_profile.pg_role;
                        RETURN NEXT;

                        INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
                        VALUES ('db_grant', v_profile.pg_role,
                                'REVOKE SELECT(' || v_denied_col || ') ON ' || v_denied_table || ' FROM ' || v_profile.pg_role,
                                'synced', now());
                    EXCEPTION WHEN OTHERS THEN
                        action := 'REVOKE_COLUMN_SKIP';
                        detail := v_denied_table || '.' || v_denied_col || ' (table may not exist)';
                        RETURN NEXT;
                    END;
                END LOOP;
            END LOOP;
        END IF;

        -- ─── Sequence USAGE for readwrite/admin (legacy parity) ───
        IF v_default_policy = 'deny' AND v_profile.connection_mode IN ('readwrite', 'admin') THEN
            FOREACH v_schema IN ARRAY v_profile.allowed_schemas
            LOOP
                EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
            END LOOP;
        END IF;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION authz_sync_db_grants() IS
    'Phase 1 default-allow pilot. Branches per pool profile on data_source.default_l0_policy: allow branch grants wide schema access + ALTER DEFAULT PRIVILEGES × 3 then REVOKEs explicit denies; deny branch keeps V041 explicit-allow-list semantics + symmetric ALTER DEFAULT PRIVILEGES REVOKE so rollback drains pg_default_acl. Per-grantor limitation documented in V063 header.';
