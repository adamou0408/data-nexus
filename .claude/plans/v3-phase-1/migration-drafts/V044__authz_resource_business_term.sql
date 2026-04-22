-- ============================================================
-- V044: Extend authz_resource with Semantic Layer columns
--       (business_term / definition / formula / owner /
--        status lifecycle / blessing metadata)
--
-- *** DRAFT — NOT YET APPLIED ***
-- *** Requires human review before being placed into
--     database/migrations/ and executed. Do NOT run this from
--     the drafts folder. ***
--
-- Context:
--   v3 Phase 1 plan (docs/plan-v3-phase-1.md §2.7) — Semantic
--   layer lives on authz_resource. No separate bi_semantic_model
--   table is created. Tier 2 / Tier 3 wizards display rows where
--   status='blessed'; personal sandbox may view 'draft' /
--   'under_review'.
--
-- V-number:
--   Latest committed migration = V043. A collision already exists
--   at V030 (V030__timescaledb_audit_hypertable.sql +
--   V030__view_function_discovery.sql). This draft uses V044 —
--   one ahead of V043 — because the v3 Phase 1 design decision is
--   freshly locked and no intervening migration is expected, but
--   the next operator MUST verify latest V-number before moving
--   this file into database/migrations/ and bump if needed.
-- ============================================================

-- ─── 1. Add semantic-layer columns ───
-- All columns are NULLable so the migration is backfill-safe on
-- the existing ~N rows. A later data migration (see companion
-- notes) will set status='draft' on any row an owner wants to
-- promote into the semantic layer.
ALTER TABLE authz_resource
    ADD COLUMN business_term   TEXT,
    ADD COLUMN definition      TEXT,
    ADD COLUMN formula         TEXT,
    -- Project convention: subject_id is TEXT, not BIGINT.
    -- The drafting request asked for BIGINT; using TEXT here to
    -- match authz_subject(subject_id) everywhere else in the
    -- codebase (see V002, V020 owner_subject). Flag for reviewer.
    ADD COLUMN owner_user_id   TEXT REFERENCES authz_subject(subject_id),
    ADD COLUMN status          TEXT,
    ADD COLUMN blessed_at      TIMESTAMPTZ,
    ADD COLUMN blessed_by      TEXT REFERENCES authz_subject(subject_id);

-- ─── 2. Status lifecycle constraint ───
-- Using CHECK rather than CREATE TYPE ... AS ENUM, because:
--   a) authz_resource is a widely-shared table and adding new
--      statuses later is easier with CHECK than with ALTER TYPE.
--   b) Other lifecycle fields in this codebase that are
--      hot-iterated (e.g. authz_resource.resource_type in V042)
--      also use TEXT + CHECK, not enum. V001 enums are reserved
--      for values that have never changed (effect, granularity).
-- NULL is allowed so rows not participating in the semantic
-- layer are unconstrained.
ALTER TABLE authz_resource
    ADD CONSTRAINT authz_resource_semantic_status_check
    CHECK (status IS NULL OR status IN (
        'draft',
        'under_review',
        'blessed',
        'deprecated'
    ));

-- ─── 3. Blessing invariants ───
-- If status='blessed' we require blessed_at AND blessed_by to be
-- set. If status is anything else they must be NULL. Keeping this
-- as a separate CHECK makes it easy to relax if the review flow
-- changes.
ALTER TABLE authz_resource
    ADD CONSTRAINT authz_resource_blessed_fields_check
    CHECK (
        (status = 'blessed' AND blessed_at IS NOT NULL AND blessed_by IS NOT NULL)
        OR
        (status IS DISTINCT FROM 'blessed' AND blessed_at IS NULL AND blessed_by IS NULL)
    );

-- ─── 4. Indexes ───
-- a) Blessed-term lookup by business_term must be unique — two
--    blessed terms with the same name would poison the wizard.
--    Partial unique index so drafts / deprecated rows can share
--    names (expected during rename / re-bless cycles).
CREATE UNIQUE INDEX idx_authz_resource_blessed_term_unique
    ON authz_resource (business_term)
    WHERE status = 'blessed' AND business_term IS NOT NULL;

-- b) Non-unique lookup for autocomplete in wizard / sandbox view.
CREATE INDEX idx_authz_resource_business_term
    ON authz_resource (business_term)
    WHERE business_term IS NOT NULL;

-- c) Status filtering (wizard lists blessed only; admin UI filters
--    by status).
CREATE INDEX idx_authz_resource_status
    ON authz_resource (status)
    WHERE status IS NOT NULL;

-- d) Owner-based queries (my terms, ownership transfers).
CREATE INDEX idx_authz_resource_owner_user
    ON authz_resource (owner_user_id)
    WHERE owner_user_id IS NOT NULL;

-- ─── 5. Comments ───
COMMENT ON COLUMN authz_resource.business_term IS
    'Human-readable business term (e.g. 活躍客戶, 月營收). Unique when status=blessed.';
COMMENT ON COLUMN authz_resource.definition IS
    'Plain-language definition of the business term. Shown in wizard tooltip.';
COMMENT ON COLUMN authz_resource.formula IS
    'SQL or textual formula for computed terms. Resolved server-side; not trusted input.';
COMMENT ON COLUMN authz_resource.owner_user_id IS
    'Subject (FK to authz_subject) responsible for this term. Ownership grant is separate from AuthZ grants.';
COMMENT ON COLUMN authz_resource.status IS
    'Semantic layer lifecycle: draft -> under_review -> blessed -> deprecated. NULL = resource is not a semantic-layer term.';
COMMENT ON COLUMN authz_resource.blessed_at IS
    'Timestamp of last bless event. NULL until status=blessed.';
COMMENT ON COLUMN authz_resource.blessed_by IS
    'Subject who blessed this term. NULL until status=blessed.';

-- ─── 6. Audit trigger ───
-- NOTE: the project does not currently have a generic audit
-- trigger pattern for authz_resource. V006 implements an
-- auto-versioning trigger for authz_policy (authz_policy_version
-- table + authz_policy_version_trigger()), and V034 has a
-- pg_notify trigger on authz_resource changes (trg_resource_change
-- / authz_notify_resource_change) but that only fans out cache
-- invalidation, not an audit record.
--
-- Recommendation for reviewer: do NOT invent a new pattern in
-- this migration. Instead, either:
--   (a) introduce a generic authz_resource_version table in a
--       separate migration mirroring V006, OR
--   (b) rely on the existing authz_audit_event pipeline
--       (V005 / V011) from the application layer — routes that
--       mutate these columns should emit an audit_event with
--       action='semantic_term_*'.
-- Deferring that decision until this column set lands.
