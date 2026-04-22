-- ============================================================
-- V041: Fix authz_sync_db_grants() to skip external data sources
--
-- Bug: When a pool profile targets an external data source (e.g.
-- data_source_id = 'ds:pg_k8' pointing at a remote Greenplum), the
-- function still tried to CREATE ROLE / GRANT against the LOCAL
-- nexus_authz DB — failing with "schema ... does not exist" because
-- the profile's allowed_schemas only exist on the remote cluster.
--
-- Fix: Only process profiles that are local-facing:
--   - data_source_id IS NULL, OR
--   - data_source_id = 'ds:local'
-- External profiles are handled by the remote sync path (pool.ts
-- /sync/external-grants → lib/remote-sync.ts), not this function.
--
-- Regression introduced when external data source support was added.
-- Same body as V015, only WHERE clause changed.
-- ============================================================

CREATE OR REPLACE FUNCTION authz_sync_db_grants()
RETURNS TABLE(action TEXT, detail TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
    v_profile       RECORD;
    v_schema        TEXT;
    v_table         TEXT;
    v_ssot_denied   JSONB;
    v_merged_denied JSONB;
    v_denied_table  TEXT;
    v_denied_col    TEXT;
    v_col_arr       JSONB;
BEGIN
    FOR v_profile IN
        SELECT * FROM authz_db_pool_profile
        WHERE is_active = TRUE
          AND (data_source_id IS NULL OR data_source_id = 'ds:local')
    LOOP
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

        -- Process each allowed schema
        FOREACH v_schema IN ARRAY v_profile.allowed_schemas
        LOOP
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', v_schema, v_profile.pg_role);
            EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', v_schema, v_profile.pg_role);

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

            action := 'GRANT_' || v_profile.connection_mode::TEXT;
            detail := v_schema || ' -> ' || v_profile.pg_role;
            RETURN NEXT;

            INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
            VALUES ('db_grant', v_schema || '->' || v_profile.pg_role,
                    'GRANT ' || v_profile.connection_mode || ' ON SCHEMA ' || v_schema || ' TO ' || v_profile.pg_role,
                    'synced', now());
        END LOOP;

        -- Revoke column-level access based on merged denied columns (SSOT + overrides)
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

        -- Grant sequence usage for readwrite/admin
        IF v_profile.connection_mode IN ('readwrite', 'admin') THEN
            FOREACH v_schema IN ARRAY v_profile.allowed_schemas
            LOOP
                EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
            END LOOP;
        END IF;
    END LOOP;
END;
$$;
