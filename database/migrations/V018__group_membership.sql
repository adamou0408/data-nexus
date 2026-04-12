-- ============================================================
-- V018: Group membership table
-- Stores user-to-group relationships synced from LDAP
-- Enables DB-level group lookup (no X-User-Groups header needed)
-- ============================================================

CREATE TABLE authz_group_member (
    group_id    TEXT NOT NULL REFERENCES authz_subject(subject_id),
    user_id     TEXT NOT NULL REFERENCES authz_subject(subject_id),
    synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source      TEXT NOT NULL DEFAULT 'manual',  -- 'ldap_sync' | 'manual'
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_member_user ON authz_group_member(user_id);
CREATE INDEX idx_group_member_group ON authz_group_member(group_id);

COMMENT ON TABLE authz_group_member IS 'LDAP group membership — synced from LDAP or manually managed. Used by API to resolve user groups without X-User-Groups header.';

-- ============================================================
-- Helper function: resolve groups for a given user_id
-- Returns TEXT[] of group subject_ids
-- ============================================================

CREATE OR REPLACE FUNCTION authz_resolve_user_groups(p_user_id TEXT)
RETURNS TEXT[] AS $$
    SELECT COALESCE(array_agg(group_id), ARRAY[]::TEXT[])
    FROM authz_group_member
    WHERE user_id = p_user_id;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION authz_resolve_user_groups(TEXT) IS 'Resolve all groups a user belongs to from authz_group_member table';
