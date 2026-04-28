-- ============================================================
-- V074: lifecycle primitive (definition + instance)
--
-- Generalises the bottom-up lifecycle pattern (V046 added a
-- discovered/suggested/active/deprecated/retired lifecycle to
-- authz_resource itself) into a Tier B-definable state machine
-- that any entity_kind (V073) can opt into.
--
-- Two tables:
--   authz_lifecycle_definition — Tier B: the state-machine spec
--     (what states exist, what transitions are allowed, which
--     entity_kind it applies to).
--   authz_lifecycle_instance   — runtime: one row per
--     (entity_kind, subject_id) tracking the current state.
--
-- First consumer: NPI gate sign-off (V075). Defines an
-- 'npi_gate_lifecycle' against entity_kind='npi_material' with
-- 5 states (NPI_G0..NPI_G4) and 4 transitions, then creates a
-- lifecycle_instance for each NPI material under dogfood.
--
-- Hot-path note: lifecycle_instance is NOT read inside authz_check
-- / authz_resolve. Lifecycle gating happens in the workflow /
-- request layer (V075), not the permission layer. Permissions
-- still flow through authz_role_permission + authz_policy.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) Lifecycle definition (Tier B-editable state machine)
-- ------------------------------------------------------------
CREATE TABLE authz_lifecycle_definition (
    lifecycle_id   TEXT PRIMARY KEY,
    entity_kind    TEXT NOT NULL REFERENCES authz_entity_kind(entity_kind),
    display_name   TEXT NOT NULL,
    description    TEXT,
    states         TEXT[] NOT NULL,
    initial_state  TEXT NOT NULL,
    -- transitions: array of {from, to, action} JSON objects.
    -- Validated at write-time by frontends; engine reads as JSONB.
    transitions    JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_initial_state_in_states
        CHECK (initial_state = ANY(states))
);

COMMENT ON TABLE  authz_lifecycle_definition IS
    'Tier B-editable lifecycle (state machine) spec. One definition per entity_kind (typically). transitions JSONB shape: [{"from":"S1","to":"S2","action":"approve_g1"}, ...] — engine resolves via JSONB ops.';

CREATE INDEX idx_lifecycle_def_entity_kind
    ON authz_lifecycle_definition (entity_kind)
 WHERE is_active = TRUE;

-- ------------------------------------------------------------
-- 2) Lifecycle instance (runtime state per subject)
-- ------------------------------------------------------------
CREATE TABLE authz_lifecycle_instance (
    instance_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lifecycle_id    TEXT NOT NULL REFERENCES authz_lifecycle_definition(lifecycle_id),
    entity_kind     TEXT NOT NULL REFERENCES authz_entity_kind(entity_kind),
    -- subject_id is the business key of the entity instance,
    -- e.g. tiptop.cimzr067.tc_ima001 (material number) for NPI dogfood.
    -- TEXT because business keys are heterogeneous across systems.
    subject_id      TEXT NOT NULL,
    current_state   TEXT NOT NULL,
    entered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_actor      TEXT,
    last_action     TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (lifecycle_id, subject_id)
);

COMMENT ON TABLE  authz_lifecycle_instance IS
    'Runtime state per (lifecycle, subject). subject_id is the business key (e.g. material number). NOT read by authz_check — lifecycle gating happens in the workflow layer.';

-- Partial index for "show me everything that's currently in state X"
-- (workflow inbox / dashboard query). Hot path is "by current_state",
-- not "by subject_id".
CREATE INDEX idx_lifecycle_instance_current_state
    ON authz_lifecycle_instance (lifecycle_id, current_state)
 WHERE current_state IS NOT NULL;

CREATE INDEX idx_lifecycle_instance_entity_kind
    ON authz_lifecycle_instance (entity_kind, subject_id);

COMMIT;
