-- Teardown for P0-I SLA bench. Constitution-compliant — drops the
-- entire bench hypertable (synthetic _bench rows must not leak past
-- the session).
DROP TABLE IF EXISTS authz_audit_log_bench CASCADE;
