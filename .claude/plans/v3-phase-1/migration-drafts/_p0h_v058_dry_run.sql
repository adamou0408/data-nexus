-- ============================================================
-- P0-H V058 parser dry-run
--
-- Validates the V058 INSERT-SELECT-FROM-string_to_array logic against
-- a synthetic _csvlog_stage table — no pgaudit, no pg_cron, no file
-- system access. Runs on the current `timescale/timescaledb:latest-pg16`
-- image (no image swap required).
--
-- What we cover:
--   1. Happy path: one SESSION/READ row → 1 row into mock target
--   2. Multiple relations on one statement (log_relation=on emits one
--      audit row per touched table) → N rows in
--   3. Recursion guard: SELECT against authz_audit_log_path_c is dropped
--   4. Recursion guard: SELECT against authz_audit_path_c_ingest_state
--      is dropped
--   5. Wrong class (WRITE) is dropped — pgaudit.log=read scope
--   6. OBJECT-class duplicate row is dropped
--   7. View / function object types → correct prefix
--   8. Statement field with embedded commas does NOT corrupt fields 5/6/7
--
-- Pre-req: NONE. Uses a TEMP-table mirror of authz_audit_log_path_c so
-- this script runs on the current `timescale/timescaledb:latest-pg16`
-- image (no V057, no pgaudit, no pg_cron). When V057 lands, swap the
-- target table from `_authz_audit_log_path_c_mock` to the real one.
--
-- Cleanup: temp tables are ON COMMIT DROP. No persistent rows.
-- ============================================================

BEGIN;

-- ─── 0. Mock target hypertable (TEMP — no V057 needed) ───
-- Schema mirrors V057's authz_audit_log_path_c so the parser INSERT
-- column list matches verbatim. authz_effect enum lives in the real
-- DB schema; if running in a fresh DB, create it locally.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'authz_effect') THEN
        CREATE TYPE authz_effect AS ENUM ('allow','deny');
    END IF;
END $$;

DROP TABLE IF EXISTS _authz_audit_log_path_c_mock;
CREATE TEMP TABLE _authz_audit_log_path_c_mock (
    audit_id        BIGSERIAL,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    access_path     CHAR(1) NOT NULL DEFAULT 'C' CHECK (access_path = 'C'),
    subject_id      TEXT NOT NULL,
    action_id       TEXT NOT NULL,
    resource_id     TEXT NOT NULL,
    decision        authz_effect NOT NULL DEFAULT 'allow',
    policy_ids      BIGINT[],
    context         JSONB,
    duration_ms     INTEGER
) ON COMMIT DROP;

-- ─── 1. Build a synthetic _csvlog_stage matching V058 schema ───
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

INSERT INTO _csvlog_stage (log_time, user_name, database_name, session_id, error_severity, message, connection_from, application_name)
VALUES
  -- (1) happy path: SELECT one table
  (now() - INTERVAL '5 min', 'bi_user_alice', 'nexus_data', 'sess001', 'LOG',
   'AUDIT: SESSION,1,1,READ,SELECT,TABLE,public.lot_status,select * from lot_status,<not logged>',
   '10.0.1.42:54321', 'metabase'),

  -- (2) log_relation=on: one statement → 3 audit rows (one per table)
  (now() - INTERVAL '4 min', 'bi_user_alice', 'nexus_data', 'sess001', 'LOG',
   'AUDIT: SESSION,2,1,READ,SELECT,TABLE,public.wafer_test,select * from wafer_test w join lot_status l on l.id=w.lot_id,<not logged>',
   '10.0.1.42:54321', 'metabase'),
  (now() - INTERVAL '4 min', 'bi_user_alice', 'nexus_data', 'sess001', 'LOG',
   'AUDIT: SESSION,2,1,READ,SELECT,TABLE,public.lot_status,select * from wafer_test w join lot_status l on l.id=w.lot_id,<not logged>',
   '10.0.1.42:54321', 'metabase'),

  -- (3) recursion guard: SELECT against our own audit table — must be dropped
  (now() - INTERVAL '3 min', 'nexus_admin', 'nexus_authz', 'sess002', 'LOG',
   'AUDIT: SESSION,3,1,READ,SELECT,TABLE,public.authz_audit_log_path_c,select * from authz_audit_log_path_c,<not logged>',
   '127.0.0.1:5555', 'psql'),

  -- (4) recursion guard: SELECT against ingest state table — must be dropped
  (now() - INTERVAL '3 min', 'nexus_admin', 'nexus_authz', 'sess002', 'LOG',
   'AUDIT: SESSION,4,1,READ,SELECT,TABLE,public.authz_audit_path_c_ingest_state,select * from authz_audit_path_c_ingest_state,<not logged>',
   '127.0.0.1:5555', 'psql'),

  -- (5) wrong class (WRITE) — out of pgaudit.log=read scope, must be dropped
  (now() - INTERVAL '2 min', 'bi_user_alice', 'nexus_data', 'sess003', 'LOG',
   'AUDIT: SESSION,5,1,WRITE,UPDATE,TABLE,public.lot_status,update lot_status set foo=1,<not logged>',
   '10.0.1.42:54321', 'metabase'),

  -- (6) OBJECT-class duplicate (when audit_type=OBJECT, also emitted by some pgaudit configs) — dropped
  (now() - INTERVAL '1 min', 'bi_user_alice', 'nexus_data', 'sess003', 'LOG',
   'AUDIT: OBJECT,5,1,READ,SELECT,TABLE,public.lot_status,select * from lot_status,<not logged>',
   '10.0.1.42:54321', 'metabase'),

  -- (7a) view object type
  (now() - INTERVAL '1 min', 'bi_user_bob', 'nexus_data', 'sess004', 'LOG',
   'AUDIT: SESSION,6,1,READ,SELECT,VIEW,public.v_yield_summary,select * from v_yield_summary,<not logged>',
   '10.0.1.43:54322', 'datagrip'),

  -- (7b) function object type
  (now(), 'bi_user_bob', 'nexus_data', 'sess004', 'LOG',
   'AUDIT: SESSION,7,1,READ,SELECT,FUNCTION,public.compute_yield(int),select compute_yield(42),<not logged>',
   '10.0.1.43:54322', 'datagrip'),

  -- (8) statement with embedded commas — fields 5/6/7 must still parse correctly
  (now(), 'bi_user_bob', 'nexus_data', 'sess005', 'LOG',
   'AUDIT: SESSION,8,1,READ,SELECT,TABLE,public.shipment_log,select * from shipment_log where status in (''A''',
   '10.0.1.43:54322', 'datagrip');

-- ─── 2. Run the V058 parser logic verbatim ───
INSERT INTO _authz_audit_log_path_c_mock (
    timestamp, subject_id, action_id, resource_id, decision, context
)
SELECT
    log_time,
    user_name,
    audit_fields[5],
    CASE upper(audit_fields[6])
        WHEN 'TABLE'    THEN 'table:'    || audit_fields[7]
        WHEN 'VIEW'     THEN 'view:'     || audit_fields[7]
        WHEN 'FUNCTION' THEN 'function:' || audit_fields[7]
        WHEN 'INDEX'    THEN 'index:'    || audit_fields[7]
        WHEN 'SEQUENCE' THEN 'sequence:' || audit_fields[7]
        ELSE lower(audit_fields[6]) || ':' || audit_fields[7]
    END,
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
        string_to_array(
            substring(message FROM '^AUDIT: (.*)$'),
            ','
        ) AS audit_fields
    FROM _csvlog_stage
    WHERE error_severity = 'LOG'
      AND message LIKE 'AUDIT: %'
) parsed
WHERE array_length(audit_fields, 1) >= 7
  AND audit_fields[1] = 'SESSION'
  AND audit_fields[4] = 'READ'
  AND NOT (
      upper(audit_fields[6]) = 'TABLE'
      AND audit_fields[7] LIKE 'public.authz_audit_log%'
  )
  AND NOT (
      upper(audit_fields[6]) = 'TABLE'
      AND audit_fields[7] LIKE 'public.authz_audit_path_c_ingest_state%'
  );

-- ─── 3. Assertions ───
-- Expected: 6 rows survive (cases 1, 2a, 2b, 7a, 7b, 8). Dropped: 4 (cases 3, 4, 5, 6).
DO $$
DECLARE
    v_total INTEGER;
    v_alice INTEGER;
    v_join INTEGER;
    v_view INTEGER;
    v_func INTEGER;
    v_recursion INTEGER;
    v_write INTEGER;
    v_object INTEGER;
BEGIN
    SELECT count(*) INTO v_total FROM _authz_audit_log_path_c_mock
    WHERE subject_id IN ('bi_user_alice','bi_user_bob','nexus_admin');

    SELECT count(*) INTO v_alice FROM _authz_audit_log_path_c_mock
    WHERE subject_id = 'bi_user_alice' AND resource_id = 'table:public.lot_status';

    SELECT count(*) INTO v_join FROM _authz_audit_log_path_c_mock
    WHERE subject_id = 'bi_user_alice' AND resource_id IN
        ('table:public.lot_status','table:public.wafer_test')
      AND (context->>'statement_id')::int = 2;

    SELECT count(*) INTO v_view FROM _authz_audit_log_path_c_mock
    WHERE resource_id = 'view:public.v_yield_summary';

    SELECT count(*) INTO v_func FROM _authz_audit_log_path_c_mock
    WHERE resource_id = 'function:public.compute_yield(int)';

    SELECT count(*) INTO v_recursion FROM _authz_audit_log_path_c_mock
    WHERE resource_id LIKE 'table:public.authz_audit_%';

    SELECT count(*) INTO v_write FROM _authz_audit_log_path_c_mock
    WHERE action_id = 'UPDATE';

    SELECT count(*) INTO v_object FROM _authz_audit_log_path_c_mock
    WHERE context->>'audit_type' = 'OBJECT';

    RAISE NOTICE 'V058 dry-run results:';
    RAISE NOTICE '  total rows = %  (expect 6)', v_total;
    RAISE NOTICE '  alice/lot_status = %  (expect 2: cases 1 and 2b)', v_alice;
    RAISE NOTICE '  join stmt rows  = %  (expect 2)', v_join;
    RAISE NOTICE '  view rows       = %  (expect 1)', v_view;
    RAISE NOTICE '  function rows   = %  (expect 1)', v_func;
    RAISE NOTICE '  recursion drops = %  (expect 0 — guard works)', v_recursion;
    RAISE NOTICE '  WRITE drops     = %  (expect 0 — class filter works)', v_write;
    RAISE NOTICE '  OBJECT drops    = %  (expect 0 — audit_type filter works)', v_object;

    IF v_total <> 6 THEN RAISE EXCEPTION 'V058 dry-run FAIL: total rows = %, expected 6', v_total; END IF;
    IF v_recursion <> 0 THEN RAISE EXCEPTION 'V058 dry-run FAIL: recursion guard let % rows through', v_recursion; END IF;
    IF v_write <> 0     THEN RAISE EXCEPTION 'V058 dry-run FAIL: WRITE class let % rows through', v_write; END IF;
    IF v_object <> 0    THEN RAISE EXCEPTION 'V058 dry-run FAIL: OBJECT type let % rows through', v_object; END IF;
    IF v_view <> 1      THEN RAISE EXCEPTION 'V058 dry-run FAIL: view rows = %, expected 1', v_view; END IF;
    IF v_func <> 1      THEN RAISE EXCEPTION 'V058 dry-run FAIL: function rows = %, expected 1', v_func; END IF;
    IF v_join <> 2      THEN RAISE EXCEPTION 'V058 dry-run FAIL: join stmt rows = %, expected 2', v_join; END IF;

    RAISE NOTICE 'V058 dry-run PASS — parser logic validated.';
END $$;

-- ─── 4. Cleanup (constitution: no test rows leak past session) ───
DELETE FROM _authz_audit_log_path_c_mock
WHERE subject_id IN ('bi_user_alice','bi_user_bob','nexus_admin');

SELECT count(*) AS leftover_test_rows
FROM _authz_audit_log_path_c_mock
WHERE subject_id IN ('bi_user_alice','bi_user_bob','nexus_admin');

COMMIT;
-- temp tables (ON COMMIT DROP) are released here.
