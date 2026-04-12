-- ============================================================
-- V012: Cache Invalidation via PG LISTEN/NOTIFY
-- ============================================================

CREATE OR REPLACE FUNCTION authz_notify_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('authz_policy_changed', json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'timestamp', now()
    )::text);
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_policy_change AFTER INSERT OR UPDATE OR DELETE ON authz_policy
    FOR EACH ROW EXECUTE FUNCTION authz_notify_change();
CREATE TRIGGER trg_role_perm_change AFTER INSERT OR UPDATE OR DELETE ON authz_role_permission
    FOR EACH ROW EXECUTE FUNCTION authz_notify_change();
CREATE TRIGGER trg_subject_role_change AFTER INSERT OR UPDATE OR DELETE ON authz_subject_role
    FOR EACH ROW EXECUTE FUNCTION authz_notify_change();
