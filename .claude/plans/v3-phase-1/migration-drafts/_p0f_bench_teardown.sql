-- Teardown for P0-F bench. Constitution-compliant — drops the entire
-- bench hypertable so no synthetic _bench rows leak past the session.
DROP TABLE IF EXISTS authz_audit_log_bench CASCADE;
