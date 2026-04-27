-- ============================================================
-- V061: authz_discovery_rule.effect
--
-- Phase 1 of permission-default-allow
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-1.4).
--
-- Adds an effect ENUM('allow','deny') column so a discovery rule can
-- recommend either direction (allow-with-mask vs L0 deny). V062 seeds
-- ≥30 deny rules per §3.4 against this column.
--
-- Default 'allow' matches the intent of every existing seed:
--   - column_mask rules (V055 etc) → mask data, ALLOW access
--   - row_filter rules → filter rows, ALLOW access
--   - classification rules → label only, ALLOW access
-- Existing rows get DEFAULT 'allow' on backfill — zero behaviour drift.
--
-- Why reuse authz_effect (allow|deny) rather than a new enum:
--   same precedent as V059 — semantic distinction is in the column name
--   (`effect` here means "what direction this rule recommends"), so the
--   value space (allow|deny) coincides cleanly with authz_effect.
-- ============================================================

ALTER TABLE authz_discovery_rule
    ADD COLUMN IF NOT EXISTS effect authz_effect NOT NULL DEFAULT 'allow';

COMMENT ON COLUMN authz_discovery_rule.effect IS
    'Phase 1 default-allow pilot. ''allow'' = rule recommends granting access (with mask / row-filter / label as applicable). ''deny'' = rule recommends an L0 deny policy. V062 seeds the ≥30 deny patterns from plan §3.4 against this column. Frontends use this to surface "auto-deny" vs "auto-mask" suggestions during discovery review.';

-- Partial index — most rules will stay 'allow'; the deny set is the
-- security-critical lookup ("which patterns should auto-block?").
CREATE INDEX IF NOT EXISTS idx_discovery_rule_deny_enabled
    ON authz_discovery_rule(rule_type, priority DESC)
    WHERE effect = 'deny' AND enabled = TRUE;
