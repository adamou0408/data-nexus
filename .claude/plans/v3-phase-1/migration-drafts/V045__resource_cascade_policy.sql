-- ============================================================
-- V045: resource_cascade_policy — dependency cascade tracking
--
-- *** DRAFT — NOT YET APPLIED ***
-- *** Requires DBA review. Do NOT run this from the drafts folder.
-- *** Must land AFTER V044 (both are Phase 1 基座 schema).
--
-- Context:
--   v3 Phase 1 plan (docs/plan-v3-phase-1.md §1.1, §2.6, §3 Q3)
--   — when an upstream resource is disabled (module off, data
--   source deprecated, authz_resource is_active=FALSE), downstream
--   dependents must be cascaded.
--
--   Cascade semantics (§2.6):
--     - stateless_auto        : invalidate + remove immediately,
--                               no user notification needed
--                               (e.g. Path A 遺表, API route,
--                               AI retrieval index, scheduled job)
--     - stateful_sandbox_30d  : flag dependent, notify owner,
--                               30-day sandbox window, then archive
--                               (e.g. user dashboards, saved SQL,
--                               Tier 2/3 artifacts)
--
-- V-number:
--   V044 is the previous drafted migration. Verify latest
--   committed V-number before moving this file into
--   database/migrations/ and bump if needed.
--
-- Audit:
--   Cascade events are emitted to the existing authz_audit_log
--   pipeline (V005 / V011) with action_id='cascade_*'. No new
--   audit table is introduced — same policy as V044.
-- ============================================================

-- ─── 1. Main table ───
CREATE TABLE resource_cascade_policy (
    cascade_id          BIGSERIAL PRIMARY KEY,

    -- Downstream dependent: the resource that breaks when its
    -- upstream is disabled. Stored as (type, id) tuple because
    -- dependents may be rows in authz_resource OR external
    -- artifacts (saved_query, dashboard definitions living in a
    -- separate BI store). No FK — cross-store integrity is
    -- enforced at cascade scan time.
    resource_type       TEXT NOT NULL,
    resource_id         TEXT NOT NULL,

    -- Upstream: what the dependent relies on.
    depends_on_type     TEXT NOT NULL,
    depends_on_id       TEXT NOT NULL,

    -- Cascade semantics. See header for definitions.
    cascade_mode        TEXT NOT NULL,

    -- Owner — who gets notified (TEXT FK to authz_subject per
    -- project convention; see V044 discussion). NULL for
    -- stateless_auto dependents where no notification is sent.
    owner_user_id       TEXT REFERENCES authz_subject(subject_id),

    -- Sandbox state machine (populated only when cascade fires).
    notified_at         TIMESTAMPTZ,
    sandbox_enter_at    TIMESTAMPTZ,
    sandbox_expire_at   TIMESTAMPTZ,
    archived_at         TIMESTAMPTZ,

    -- Free-form reason (disable cause, notes from cascade scan).
    reason              TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Cascade-mode constraint ───
ALTER TABLE resource_cascade_policy
    ADD CONSTRAINT resource_cascade_policy_mode_check
    CHECK (cascade_mode IN ('stateless_auto', 'stateful_sandbox_30d'));

-- ─── 3. Sandbox invariants ───
-- For stateful_sandbox_30d rows that have entered sandbox,
-- sandbox_expire_at must be set. Owner must exist to be notified.
-- stateless_auto rows should never populate sandbox fields.
ALTER TABLE resource_cascade_policy
    ADD CONSTRAINT resource_cascade_policy_sandbox_check
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
-- Same (dependent, upstream) pair should only be declared once.
-- If the relationship changes cascade_mode later, UPDATE the row
-- rather than creating a new entry.
CREATE UNIQUE INDEX idx_resource_cascade_policy_edge
    ON resource_cascade_policy
    (resource_type, resource_id, depends_on_type, depends_on_id);

-- ─── 5. Access-pattern indexes ───
-- a) Cascade scan by upstream — "what breaks if X is disabled?"
CREATE INDEX idx_resource_cascade_policy_upstream
    ON resource_cascade_policy (depends_on_type, depends_on_id);

-- b) Owner-facing "my at-risk dependents" dashboard.
CREATE INDEX idx_resource_cascade_policy_owner_active
    ON resource_cascade_policy (owner_user_id, sandbox_expire_at)
    WHERE archived_at IS NULL AND owner_user_id IS NOT NULL;

-- c) Archiver job — scan for expired sandboxes hourly.
CREATE INDEX idx_resource_cascade_policy_expiring
    ON resource_cascade_policy (sandbox_expire_at)
    WHERE cascade_mode = 'stateful_sandbox_30d'
      AND sandbox_enter_at IS NOT NULL
      AND archived_at IS NULL;

-- ─── 6. updated_at trigger ───
-- Reuse the codebase convention (see V001 / V002 for trigger
-- style). If an _update_timestamp() helper exists, prefer it.
CREATE OR REPLACE FUNCTION resource_cascade_policy_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_resource_cascade_policy_touch
    BEFORE UPDATE ON resource_cascade_policy
    FOR EACH ROW EXECUTE FUNCTION resource_cascade_policy_touch_updated_at();

-- ─── 7. Comments ───
COMMENT ON TABLE resource_cascade_policy IS
    'Dependency graph edges used by cascade jobs when an upstream resource is disabled. See v3 Phase 1 plan §2.6.';
COMMENT ON COLUMN resource_cascade_policy.cascade_mode IS
    'stateless_auto: remove immediately. stateful_sandbox_30d: 30-day owner notification + archive.';
COMMENT ON COLUMN resource_cascade_policy.sandbox_expire_at IS
    'When stateful dependent auto-archives. owner can extend via approval workflow before this timestamp.';
COMMENT ON COLUMN resource_cascade_policy.archived_at IS
    'Set by cascade_archive_job when sandbox expires. Data retained read-only.';

-- ─── 8. Rollback ───
-- Clean rollback (table is new, additive):
--   DROP TRIGGER IF EXISTS trg_resource_cascade_policy_touch ON resource_cascade_policy;
--   DROP FUNCTION IF EXISTS resource_cascade_policy_touch_updated_at();
--   DROP TABLE IF EXISTS resource_cascade_policy;
