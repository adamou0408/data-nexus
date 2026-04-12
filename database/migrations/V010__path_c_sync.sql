-- ============================================================
-- V010: Path C Adapter - DB Grant Sync Engine
-- ============================================================

CREATE OR REPLACE FUNCTION authz_sync_db_grants()
RETURNS TABLE(action TEXT, detail TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
    v_profile   RECORD;
    v_schema    TEXT;
    v_table     TEXT;
    v_col_entry RECORD;
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

-- Generate pgbouncer.ini config
CREATE OR REPLACE FUNCTION authz_sync_pgbouncer_config(
    p_db_host   TEXT DEFAULT 'localhost',
    p_db_port   INTEGER DEFAULT 5432,
    p_db_name   TEXT DEFAULT 'nexus_data'
)
RETURNS TEXT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_config    TEXT := '';
    v_profile   RECORD;
BEGIN
    v_config := v_config || '[databases]' || E'\n';

    FOR v_profile IN
        SELECT dp.profile_id, dp.pg_role, dp.max_connections
        FROM authz_db_pool_profile dp
        WHERE dp.is_active = TRUE
        ORDER BY dp.profile_id
    LOOP
        v_config := v_config || format(
            '%s = host=%s port=%s dbname=%s user=%s pool_size=%s',
            replace(v_profile.profile_id, 'pool:', 'nexus_'),
            p_db_host, p_db_port, p_db_name,
            v_profile.pg_role, v_profile.max_connections
        ) || E'\n';
    END LOOP;

    v_config := v_config || E'\n[pgbouncer]\n';
    v_config := v_config || 'auth_type = md5' || E'\n';
    v_config := v_config || format(
        'auth_query = SELECT pg_role AS username, password_hash AS password FROM authz_pool_credentials WHERE pg_role = $1 AND is_active = TRUE'
    ) || E'\n';

    INSERT INTO authz_sync_log (sync_type, target_name, generated_config, sync_status, synced_at)
    VALUES ('pgbouncer_config', 'pgbouncer.ini', v_config, 'synced', now());

    RETURN v_config;
END;
$$;
