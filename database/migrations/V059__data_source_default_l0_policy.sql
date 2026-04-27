-- ============================================================
-- V059: authz_data_source.default_l0_policy
--
-- Phase 1 of permission-default-allow
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-1.1).
--
-- Adds a per-datasource flag toggling L0 default-deny vs default-allow.
-- Phase 1 ships only the column + default 'deny' (zero behaviour change);
-- V060 / V063 hook the flag into authz_resolve / authz_check / sync_db_grants.
--
-- Why reuse authz_effect (allow|deny) rather than a new enum:
--   semantic distinction is in the column name — `default_l0_policy` is
--   the default-when-no-rule-hits, while `authz_effect` on a permission
--   row is "what this rule says". Same value space, no need for a second
--   enum type.
-- ============================================================

ALTER TABLE authz_data_source
    ADD COLUMN IF NOT EXISTS default_l0_policy authz_effect NOT NULL DEFAULT 'deny';

COMMENT ON COLUMN authz_data_source.default_l0_policy IS
    'Phase 1 default-allow pilot flag. ''deny'' (default) = legacy explicit-allow-list semantics. ''allow'' = L0 returns allow for this datasource''s resources unless an authz_policy(effect=deny) hits. Inversion logic lives in authz_resolve()/authz_check() (V060) and authz_sync_db_grants() (V063). Pilot scope: single BI sandbox datasource (AC-2.1).';

-- Partial index — most rows stay 'deny'; only the few flipped pilots
-- need fast lookup ("which datasources are running default-allow today?").
CREATE INDEX IF NOT EXISTS idx_data_source_default_allow
    ON authz_data_source(source_id)
    WHERE default_l0_policy = 'allow';
