-- ============================================================
-- V044: Extend authz_resource with Semantic Layer columns
--       (business_term / definition / formula / owner /
--        status lifecycle / blessing metadata)
--
-- Self-reviewed and promoted 2026-04-26 (Adam, pure-software-dev
-- mode — no separate DBA counter-sign role exists in Phase 1).
--
-- V-number rationale:
--   Latest applied migration at promote time = V052. V044/V045 are
--   gap slots (V046-V052 already taken). Filling V044 is safe
--   because (a) Makefile db-migrate iterates V*.sql alphabetically
--   so on fresh db-reset V044 runs before V046+ which is fine
--   (purely additive on V002's authz_resource), (b) on the live
--   dev DB this V044 is applied manually now since V046-V052 are
--   already in place. Pre-existing V030 collision tracked as
--   MIG-01 / ARCH-01-FU-3, not a V044 blocker.
--
-- Context:
--   v3 Phase 1 plan (docs/plan-v3-phase-1.md §2.7) — Semantic
--   layer lives on authz_resource. No separate bi_semantic_model
--   table is created. Tier 2 / Tier 3 wizards display rows where
--   status='blessed'; personal sandbox may view 'draft' /
--   'under_review'.
--
-- Self-review decisions (2026-04-26):
--   1. owner_subject_id = TEXT (renamed from owner_user_id for
--      consistency with V020 owner_subject; FK target unchanged)
--   2. blessed_fields_check loosened: deprecated rows preserve
--      blessed_at + blessed_by for audit history (drafter's own
--      reservation about strictness honored)
--   3. Audit trigger deferred to app layer (authz_audit_log
--      pipeline with action='semantic_term_*')
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
    -- Subject FKs are TEXT throughout (see V002, V004, V018, V020).
    -- Naming aligned with V020 owner_subject (was owner_user_id in
    -- earlier draft; renamed 2026-04-26 for consistency).
    ADD COLUMN owner_subject_id   TEXT REFERENCES authz_subject(subject_id),
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
-- Loosened 2026-04-26: deprecated rows MAY retain blessed_at and
-- blessed_by so the row itself preserves audit history of who/when
-- last blessed it. Only draft / under_review / NULL must have
-- bless fields cleared. status='blessed' still requires both set.
ALTER TABLE authz_resource
    ADD CONSTRAINT authz_resource_blessed_fields_check
    CHECK (
        (status = 'blessed' AND blessed_at IS NOT NULL AND blessed_by IS NOT NULL)
        OR
        (status = 'deprecated')
        OR
        (status IS DISTINCT FROM 'blessed' AND status IS DISTINCT FROM 'deprecated'
            AND blessed_at IS NULL AND blessed_by IS NULL)
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
CREATE INDEX idx_authz_resource_owner_subject
    ON authz_resource (owner_subject_id)
    WHERE owner_subject_id IS NOT NULL;

-- ─── 5. Comments ───
COMMENT ON COLUMN authz_resource.business_term IS
    'Human-readable business term (e.g. 活躍客戶, 月營收). Unique when status=blessed.';
COMMENT ON COLUMN authz_resource.definition IS
    'Plain-language definition of the business term. Shown in wizard tooltip.';
COMMENT ON COLUMN authz_resource.formula IS
    'SQL or textual formula for computed terms. Resolved server-side; not trusted input.';
COMMENT ON COLUMN authz_resource.owner_subject_id IS
    'Subject (FK to authz_subject) responsible for this term. Ownership grant is separate from AuthZ grants.';
COMMENT ON COLUMN authz_resource.status IS
    'Semantic layer lifecycle: draft -> under_review -> blessed -> deprecated. NULL = resource is not a semantic-layer term.';
COMMENT ON COLUMN authz_resource.blessed_at IS
    'Timestamp of last bless event. NULL for draft/under_review/non-semantic rows. Preserved for status=deprecated as audit history.';
COMMENT ON COLUMN authz_resource.blessed_by IS
    'Subject who blessed this term. NULL for draft/under_review/non-semantic rows. Preserved for status=deprecated as audit history.';

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
--   (b) rely on the existing authz_audit_log pipeline
--       (V005 / V011) from the application layer — routes that
--       mutate these columns should emit an audit_event with
--       action='semantic_term_*'.
-- Deferring that decision until this column set lands.
