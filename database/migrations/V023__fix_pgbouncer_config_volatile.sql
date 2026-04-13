-- ============================================================
-- V023: Fix authz_sync_pgbouncer_config() volatility
-- The function does INSERT INTO authz_sync_log, so it must be VOLATILE not STABLE
-- ============================================================

CREATE OR REPLACE FUNCTION authz_sync_pgbouncer_config(
    p_db_host   TEXT DEFAULT 'localhost',
    p_db_port   INTEGER DEFAULT 5432,
    p_db_name   TEXT DEFAULT 'nexus_data'
)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE
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
