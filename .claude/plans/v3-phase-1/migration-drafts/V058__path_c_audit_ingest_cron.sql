-- ============================================================
-- V058 (DRAFT — depends on V057 + image swap, see _p0h notes)
--
-- Path C audit ingest cron. Phase 0 of permission-default-allow
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-0.2).
--
-- Pre-req: V057 must have created authz_audit_log_path_c hypertable
-- AND pgaudit + pg_cron extensions must already be loaded
-- (timescaledb-ha:pg16 image + shared_preload_libraries — see
-- docker-compose-pgaudit-swap.md).
--
-- What this migration does:
--   1. State table tracking which csvlog files are already ingested
--   2. Parser function that COPY-loads one csvlog file → INSERTs Path C
--      audit rows into authz_audit_log_path_c
--   3. Driver function picking oldest non-current, non-completed file
--      per tick (bounded work per cron run; one file per minute)
--   4. pg_cron schedule running the driver every minute
--
-- What this migration does NOT do:
--   - Tail the *current* (still-being-written) csvlog file. We only
--     process files older than the latest, which is safe because PG
--     rotates hourly (`log_rotation_age=1h`).
--   - Backfill existing csvlog files at install time. The first cron
--     tick after V058 lands will pick them up file-by-file.
--   - Capture pgaudit `OBJECT` rows (we use `SESSION` rows from
--     `log_relation=on`, which is what the compose config sets).
-- ============================================================

-- ─── 1. Ingest state ───
CREATE TABLE authz_audit_path_c_ingest_state (
    file_name           TEXT PRIMARY KEY,
    completed           BOOLEAN NOT NULL DEFAULT FALSE,
    rows_ingested       BIGINT NOT NULL DEFAULT 0,
    last_processed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE authz_audit_path_c_ingest_state IS
    'V058 ingest state — one row per processed csvlog file. Driver function skips files marked completed.';

-- ─── 2. Per-file parser ───
-- SECURITY DEFINER so the function can COPY FROM server-side files
-- regardless of the calling role. Owner must be a superuser
-- (nexus_admin in dev). On prod, swap to a dedicated audit_ingest role
-- with pg_read_server_files membership.
CREATE OR REPLACE FUNCTION _ingest_one_pgaudit_csvlog(p_path TEXT)
RETURNS BIGINT AS $$
DECLARE
    v_inserted BIGINT;
BEGIN
    -- PG 16 csvlog has 26 columns. Schema must match exactly or COPY fails.
    CREATE TEMP TABLE _csvlog_stage (
        log_time              TIMESTAMPTZ,
        user_name             TEXT,
        database_name         TEXT,
        process_id            INTEGER,
        connection_from       TEXT,
        session_id            TEXT,
        session_line_num      BIGINT,
        command_tag           TEXT,
        session_start_time    TIMESTAMPTZ,
        virtual_transaction_id TEXT,
        transaction_id        BIGINT,
        error_severity        TEXT,
        sql_state_code        TEXT,
        message               TEXT,
        detail                TEXT,
        hint                  TEXT,
        internal_query        TEXT,
        internal_query_pos    INTEGER,
        context               TEXT,
        query                 TEXT,
        query_pos             INTEGER,
        location              TEXT,
        application_name      TEXT,
        backend_type          TEXT,
        leader_pid            INTEGER,
        query_id              BIGINT
    ) ON COMMIT DROP;

    EXECUTE format('COPY _csvlog_stage FROM %L WITH (FORMAT csv)', p_path);

    -- Parser extracts pgaudit fields from the LOG-level "AUDIT: ..." message.
    -- Format (log_relation=on, SESSION rows):
    --   AUDIT: SESSION,<stmt_id>,<sub_id>,<class>,<command>,<obj_type>,<obj_name>,<statement>,<param>
    --
    -- We split on ',' and take fields 5..7. The statement field (8)
    -- may contain commas; we never read it, so safe.
    --
    -- Recursion guard: rows whose object is one of our own audit
    -- tables would re-enter this function via the next tick. Skip them.
    INSERT INTO authz_audit_log_path_c (
        timestamp, subject_id, action_id, resource_id, decision, context
    )
    SELECT
        log_time,
        user_name,
        audit_fields[5]                                            AS action_id,
        CASE upper(audit_fields[6])
            WHEN 'TABLE'    THEN 'table:'    || audit_fields[7]
            WHEN 'VIEW'     THEN 'view:'     || audit_fields[7]
            WHEN 'FUNCTION' THEN 'function:' || audit_fields[7]
            WHEN 'INDEX'    THEN 'index:'    || audit_fields[7]
            WHEN 'SEQUENCE' THEN 'sequence:' || audit_fields[7]
            ELSE lower(audit_fields[6]) || ':' || audit_fields[7]
        END                                                        AS resource_id,
        'allow'::authz_effect,
        jsonb_build_object(
            'database',        database_name,
            'session_id',      session_id,
            'audit_type',      audit_fields[1],
            'statement_id',    audit_fields[2],
            'substatement_id', audit_fields[3],
            'class',           audit_fields[4],
            'object_type',     audit_fields[6],
            'object_name',     audit_fields[7],
            'connection_from', connection_from,
            'application',    application_name
        )
    FROM (
        SELECT
            log_time, user_name, database_name, session_id,
            connection_from, application_name,
            -- Quote-naive split: a quoted identifier like public."weird,name"
            -- would land a comma inside field 7. Not present in this codebase,
            -- but worth knowing if pgaudit ever logs against such an object.
            string_to_array(
                substring(message FROM '^AUDIT: (.*)$'),
                ','
            ) AS audit_fields
        FROM _csvlog_stage
        WHERE error_severity = 'LOG'
          AND message LIKE 'AUDIT: %'
    ) parsed
    WHERE array_length(audit_fields, 1) >= 7
      AND audit_fields[1] = 'SESSION'   -- skip OBJECT-class duplicates
      AND audit_fields[4] = 'READ'       -- pgaudit.log=read scope
      AND NOT (
          upper(audit_fields[6]) = 'TABLE'
          AND audit_fields[7] LIKE 'public.authz_audit_log%'
      )
      AND NOT (
          upper(audit_fields[6]) = 'TABLE'
          AND audit_fields[7] LIKE 'public.authz_audit_path_c_ingest_state%'
      );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 3. Driver — one file per tick ───
CREATE OR REPLACE FUNCTION ingest_pgaudit_csvlog()
RETURNS TABLE(file_processed TEXT, rows_inserted BIGINT) AS $$
DECLARE
    v_log_dir TEXT := '/var/lib/postgresql/data/pg_log';
    v_latest  TEXT;
    v_target  TEXT;
    v_inserted BIGINT;
BEGIN
    -- Single-run guard: if the previous tick is still ingesting (busy
    -- days, large file), bail out instead of doubling up on COPY.
    -- Idempotency-via-state-table would catch the double-insert, but
    -- this avoids the wasted I/O. Lock auto-releases at txn end.
    IF NOT pg_try_advisory_xact_lock(hashtext('pgaudit_csvlog_ingest')) THEN
        RETURN;
    END IF;

    -- Latest file is still being written — skip it until next rotation.
    SELECT name INTO v_latest
    FROM pg_ls_dir(v_log_dir) AS t(name)
    WHERE name LIKE 'postgresql-%.csv'
    ORDER BY name DESC
    LIMIT 1;

    -- Pick oldest unprocessed (excluding current).
    SELECT name INTO v_target
    FROM pg_ls_dir(v_log_dir) AS t(name)
    WHERE name LIKE 'postgresql-%.csv'
      AND name <> COALESCE(v_latest, '')
      AND NOT EXISTS (
          SELECT 1 FROM authz_audit_path_c_ingest_state s
          WHERE s.file_name = name AND s.completed
      )
    ORDER BY name
    LIMIT 1;

    IF v_target IS NULL THEN
        RETURN;  -- nothing to do this tick
    END IF;

    v_inserted := _ingest_one_pgaudit_csvlog(v_log_dir || '/' || v_target);

    INSERT INTO authz_audit_path_c_ingest_state (file_name, completed, rows_ingested, last_processed_at)
    VALUES (v_target, TRUE, v_inserted, now())
    ON CONFLICT (file_name) DO UPDATE
        SET completed = TRUE,
            rows_ingested = EXCLUDED.rows_ingested,
            last_processed_at = now();

    file_processed := v_target;
    rows_inserted  := v_inserted;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION ingest_pgaudit_csvlog() IS
    'V058 driver — picks one oldest unprocessed pgaudit csvlog file and ingests it into authz_audit_log_path_c. Idempotent via authz_audit_path_c_ingest_state. Scheduled by pg_cron every minute.';

-- ─── 4. Schedule ───
-- Every minute. With log_rotation_age=1h, that means on the first tick
-- after a rotation we pick up the newly-finished file (~60s lag in the
-- worst case for normal traffic).
SELECT cron.schedule(
    'pgaudit_csvlog_ingest',
    '* * * * *',
    $cmd$ SELECT ingest_pgaudit_csvlog(); $cmd$
);
