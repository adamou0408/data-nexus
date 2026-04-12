-- ============================================================
-- V015: SSOT — Pool denied columns derived from role_permission
-- Ensures Path C column restrictions come from the same SSOT
-- as Path A/B (authz_role_permission deny rules).
-- ============================================================

-- Helper: compute denied columns for a pool profile from SSOT
-- Returns JSON like {"lot_status": ["unit_price", "cost"]}
-- by reading column-level deny from authz_role_permission
-- for all roles associated with the pool's assigned subjects.
CREATE OR REPLACE FUNCTION _authz_pool_ssot_denied_columns(
    p_profile_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles     TEXT[];
    v_result    JSONB := '{}'::jsonb;
    v_rec       RECORD;
    v_table     TEXT;
    v_column    TEXT;
BEGIN
    -- Resolve all roles assigned to subjects who use this pool
    SELECT array_agg(DISTINCT sr.role_id) INTO v_roles
    FROM authz_db_pool_assignment da
    JOIN authz_subject_role sr ON sr.subject_id = da.subject_id AND sr.is_active
    WHERE da.profile_id = p_profile_id AND da.is_active;

    IF v_roles IS NULL THEN
        RETURN '{}'::jsonb;
    END IF;

    -- Find column-level deny rules for these roles
    FOR v_rec IN
        SELECT rp.resource_id
        FROM authz_role_permission rp
        JOIN authz_resource ar ON ar.resource_id = rp.resource_id
        WHERE rp.role_id = ANY(v_roles)
          AND rp.effect = 'deny'
          AND rp.is_active
          AND ar.resource_type = 'column'
    LOOP
        -- Parse "column:table_name.column_name" format
        v_table  := split_part(split_part(v_rec.resource_id, ':', 2), '.', 1);
        v_column := split_part(split_part(v_rec.resource_id, ':', 2), '.', 2);

        IF v_result ? v_table THEN
            -- Append column if not already present
            IF NOT v_result->v_table @> to_jsonb(v_column) THEN
                v_result := jsonb_set(v_result, ARRAY[v_table],
                    (v_result->v_table) || to_jsonb(v_column));
            END IF;
        ELSE
            v_result := v_result || jsonb_build_object(v_table, jsonb_build_array(v_column));
        END IF;
    END LOOP;

    RETURN v_result;
END;
$$;

-- View: compare pool's static denied_columns vs SSOT-derived
-- Useful for dashboard/admin to detect drift
CREATE OR REPLACE VIEW v_pool_ssot_check AS
SELECT
    dp.profile_id,
    dp.pg_role,
    dp.denied_columns AS static_denied,
    _authz_pool_ssot_denied_columns(dp.profile_id) AS ssot_denied,
    COALESCE(dp.denied_columns, '{}'::jsonb) IS DISTINCT FROM
    _authz_pool_ssot_denied_columns(dp.profile_id) AS has_drift
FROM authz_db_pool_profile dp
WHERE dp.is_active;

-- Updated sync: merge static denied_columns with SSOT-derived
-- SSOT takes precedence; static is treated as additional overrides
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
        SELECT * FROM authz_db_pool_profile WHERE is_active = TRUE
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
