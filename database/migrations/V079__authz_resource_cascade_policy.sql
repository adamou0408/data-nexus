-- ============================================================
-- V079: authz_resource_cascade_policy — dependency cascade tracking
--
-- Context (v3 Phase 1 plan §2.6):
--   When an upstream resource is disabled (module off, data source
--   deprecated, authz_resource is_active=FALSE), downstream
--   dependents must be cascaded.
--
--   Cascade semantics:
--     - stateless_auto       : invalidate + remove immediately, no
--                              user notification (Path A 遺表, API
--                              route, AI retrieval index, scheduled
--                              job)
--     - stateful_sandbox_30d : flag dependent, notify owner, 30-day
--                              sandbox window, then archive (user
--                              dashboards, saved SQL, Tier 2/3
--                              artifacts)
--
-- Audit:
--   Cascade events emitted to existing authz_audit_log (V005 / V011)
--   with action_id='cascade_*'. No new audit table.
--
-- V-number history:
--   Originally drafted as V045 (2026-04-23) but parked while V044
--   (semantic-layer) self-review landed first. Promoted as V079 now
--   that V044…V078 are already deployed; sequential numbering rule.
-- ============================================================

-- ─── 1. Main table ───
CREATE TABLE authz_resource_cascade_policy (
    cascade_id          BIGSERIAL PRIMARY KEY,

    -- Downstream dependent: the resource that breaks when its
    -- upstream is disabled. (type, id) tuple — no FK because
    -- dependents may live outside authz_resource (saved_query,
    -- dashboard rows in Tier 2/3 stores). Cross-store integrity
    -- is enforced at cascade scan time.
    --
    -- Known resource_type prefixes today: 'fn', 'table', 'view',
    -- 'module', 'data_source', 'api_route', 'saved_query',
    -- 'dashboard'. Adding a new type does not require schema change.
    resource_type       TEXT NOT NULL,
    resource_id         TEXT NOT NULL,

    -- Upstream: what the dependent relies on.
    depends_on_type     TEXT NOT NULL,
    depends_on_id       TEXT NOT NULL,

    cascade_mode        TEXT NOT NULL,

    -- Owner — who gets notified. NULL for stateless_auto dependents.
    -- ON DELETE SET NULL so subject removal (e.g. employee
    -- offboarding) does not cascade-delete history rows; matches
    -- the policy-table convention.
    owner_subject_id    TEXT REFERENCES authz_subject(subject_id) ON DELETE SET NULL,

    -- Sandbox state machine (populated only when cascade fires).
    notified_at         TIMESTAMPTZ,
    sandbox_enter_at    TIMESTAMPTZ,
    sandbox_expire_at   TIMESTAMPTZ,
    archived_at         TIMESTAMPTZ,

    reason              TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Cascade-mode constraint ───
-- TEXT + CHECK (not ENUM) to match the V049 actor_type / authz_policy
-- status convention; new modes are an ALTER CONSTRAINT, not a
-- CREATE TYPE … ALTER TYPE dance.
ALTER TABLE authz_resource_cascade_policy
    ADD CONSTRAINT authz_resource_cascade_policy_mode_check
    CHECK (cascade_mode IN ('stateless_auto', 'stateful_sandbox_30d'));

-- ─── 3. Sandbox invariants ───
ALTER TABLE authz_resource_cascade_policy
    ADD CONSTRAINT authz_resource_cascade_policy_sandbox_check
    CHECK (
        (cascade_mode = 'stateless_auto'
         AND sandbox_enter_at IS NULL
         AND sandbox_expire_at IS NULL)
        OR
        (cascade_mode = 'stateful_sandbox_30d'
         AND (
             (sandbox_enter_at IS NULL AND sandbox_expire_at IS NULL)
             OR
             (sandbox_enter_at IS NOT NULL
              AND sandbox_expire_at IS NOT NULL
              AND sandbox_expire_at > sandbox_enter_at)
         ))
    );

-- ─── 4. Uniqueness ───
-- Same (dependent, upstream) pair only declared once. Mode change
-- is an UPDATE, not a duplicate row.
CREATE UNIQUE INDEX idx_authz_resource_cascade_policy_edge
    ON authz_resource_cascade_policy
    (resource_type, resource_id, depends_on_type, depends_on_id);

-- ─── 5. Access-pattern indexes ───
-- a) Cascade scan by upstream — "what breaks if X is disabled?"
CREATE INDEX idx_authz_resource_cascade_policy_upstream
    ON authz_resource_cascade_policy (depends_on_type, depends_on_id);

-- b) Owner-facing "my at-risk dependents" dashboard.
CREATE INDEX idx_authz_resource_cascade_policy_owner_active
    ON authz_resource_cascade_policy (owner_subject_id, sandbox_expire_at)
    WHERE archived_at IS NULL AND owner_subject_id IS NOT NULL;

-- c) Archiver job — scan for expired sandboxes hourly.
CREATE INDEX idx_authz_resource_cascade_policy_expiring
    ON authz_resource_cascade_policy (sandbox_expire_at)
    WHERE cascade_mode = 'stateful_sandbox_30d'
      AND sandbox_enter_at IS NOT NULL
      AND archived_at IS NULL;

-- ─── 6. updated_at trigger ───
CREATE OR REPLACE FUNCTION authz_resource_cascade_policy_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_authz_resource_cascade_policy_touch
    BEFORE UPDATE ON authz_resource_cascade_policy
    FOR EACH ROW EXECUTE FUNCTION authz_resource_cascade_policy_touch_updated_at();

-- ─── 7. Comments ───
COMMENT ON TABLE authz_resource_cascade_policy IS
    'Dependency edges used by cascade jobs when an upstream resource is disabled. v3 Phase 1 plan §2.6.';
COMMENT ON COLUMN authz_resource_cascade_policy.cascade_mode IS
    'stateless_auto: remove immediately. stateful_sandbox_30d: 30-day owner notification + archive.';
COMMENT ON COLUMN authz_resource_cascade_policy.sandbox_expire_at IS
    'When stateful dependent auto-archives. Owner can extend via approval workflow before this timestamp.';
COMMENT ON COLUMN authz_resource_cascade_policy.archived_at IS
    'Set by cascade_archive_job when sandbox expires. Data retained read-only.';

-- ─── 8. Rollback (for reference) ───
--   DROP TRIGGER IF EXISTS trg_authz_resource_cascade_policy_touch ON authz_resource_cascade_policy;
--   DROP FUNCTION IF EXISTS authz_resource_cascade_policy_touch_updated_at();
--   DROP TABLE IF EXISTS authz_resource_cascade_policy;
