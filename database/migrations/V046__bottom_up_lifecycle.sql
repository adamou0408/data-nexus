-- ============================================================
-- V046: Bottom-up Lifecycle (Discover → Suggest → Approve)
--
-- DRAFT — not yet promoted to database/migrations/
-- Depends on: V001 (policy_status enum), V002 (authz_resource),
--             V003 (authz_policy, authz_mask_function), V016 (mask fns)
--
-- Goal: support a discovery-first workflow where Discover scans data
-- sources, detects PII / multi-tenant / sensitive patterns via the
-- authz_discovery_rule registry, and writes draft policies for an
-- admin to review. Approved drafts become 'active' policies.
--
-- Lifecycle states:
--   resource: discovered → suggested → active → deprecated → retired
--   policy:   pending_review (existing) → active | rejected
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) Resource lifecycle columns
-- ------------------------------------------------------------
ALTER TABLE authz_resource
    ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active'
        CHECK (lifecycle_state IN
               ('discovered', 'suggested', 'active', 'deprecated', 'retired')),
    ADD COLUMN IF NOT EXISTS discovered_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS discovered_by_scan_id UUID,
    ADD COLUMN IF NOT EXISTS approved_by           TEXT,
    ADD COLUMN IF NOT EXISTS approved_at           TIMESTAMPTZ;

-- Partial index for "needs admin attention" queries (Overview Inbox).
CREATE INDEX IF NOT EXISTS idx_authz_resource_lifecycle_pending
    ON authz_resource (lifecycle_state, discovered_at DESC)
 WHERE lifecycle_state IN ('discovered', 'suggested');

COMMENT ON COLUMN authz_resource.lifecycle_state IS
    'Bottom-up lifecycle: discovered (raw scan) → suggested (rule matched) → active (admin approved) → deprecated/retired.';

-- ------------------------------------------------------------
-- 2) Extend policy_status enum with 'rejected'
--    (existing values: active, inactive, pending_review)
--    'pending_review' is reused as the "Discover-suggested, awaiting approval" state.
-- ------------------------------------------------------------
ALTER TYPE policy_status ADD VALUE IF NOT EXISTS 'rejected';

-- ------------------------------------------------------------
-- 3) Discovery rule registry
--    Drives the "what should Discover suggest?" engine.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authz_discovery_rule (
    rule_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_type                 TEXT NOT NULL CHECK (rule_type IN
                                  ('column_mask', 'row_filter', 'classification')),
    match_target              TEXT NOT NULL DEFAULT 'column_name'
                                  CHECK (match_target IN ('column_name', 'table_name', 'schema_name')),
    match_pattern             TEXT NOT NULL,                        -- POSIX regex
    suggested_mask_fn         TEXT REFERENCES authz_mask_function(function_name),
    suggested_filter_template TEXT,                                  -- e.g. '{column} = current_setting(''app.tenant_id'')'
    suggested_label           TEXT,                                  -- e.g. 'PII:email', 'tenant_scope'
    description               TEXT,
    priority                  INTEGER NOT NULL DEFAULT 100,          -- higher wins on ties
    enabled                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_rule_payload CHECK (
        (rule_type = 'column_mask'    AND suggested_mask_fn IS NOT NULL) OR
        (rule_type = 'row_filter'     AND suggested_filter_template IS NOT NULL) OR
        (rule_type = 'classification' AND suggested_label IS NOT NULL)
    )
);

COMMENT ON TABLE authz_discovery_rule IS
    'Heuristic registry powering Discover''s auto-suggestion engine. Pattern-matches column/table/schema names and proposes column masks, row filters, or classification labels.';

CREATE INDEX IF NOT EXISTS idx_discovery_rule_enabled
    ON authz_discovery_rule (enabled, rule_type, priority DESC);

-- ------------------------------------------------------------
-- 4) Policy lineage — which Discover scan/rule produced this policy?
-- ------------------------------------------------------------
ALTER TABLE authz_policy
    ADD COLUMN IF NOT EXISTS suggested_by_rule UUID REFERENCES authz_discovery_rule(rule_id),
    ADD COLUMN IF NOT EXISTS suggested_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS suggested_reason  TEXT;

COMMENT ON COLUMN authz_policy.suggested_by_rule IS
    'If non-NULL: this policy was auto-drafted by the Discover engine using the named rule. Status starts at pending_review until admin approves.';

-- ------------------------------------------------------------
-- 5) Add fn_mask_last4 (common for IDs, credit cards, phone)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_mask_last4(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_value IS NULL OR length(p_value) <= 4 THEN '****'
        ELSE repeat('*', length(p_value) - 4) || right(p_value, 4)
    END;
$$;

INSERT INTO authz_mask_function VALUES
    ('fn_mask_last4', 'partial', 'fn_mask_last4',
     'Show only last 4 chars (common for IDs / cards / phone)',
     '0912345678', '******5678', 'fn_mask_last4({col})')
ON CONFLICT (function_name) DO NOTHING;

-- ------------------------------------------------------------
-- 6) Seed starter rules — these can all be edited by admin later
-- ------------------------------------------------------------
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_mask_fn, suggested_label, description, priority)
VALUES
    -- PII column-name patterns
    ('column_mask', 'column_name', '(?i)^(email|e_mail|user_email|mail)$',
     'fn_mask_partial', 'PII:email',
     'Email-like column names — partial mask shows first/last char.', 200),

    ('column_mask', 'column_name', '(?i)(phone|mobile|tel|cellphone)',
     'fn_mask_last4', 'PII:phone',
     'Phone-like columns — keep last 4 digits.', 200),

    ('column_mask', 'column_name', '(?i)(id_card|ssn|tax_id|passport|national_id)',
     'fn_mask_hash', 'PII:national_id',
     'National ID-like columns — irreversible hash.', 250),

    ('column_mask', 'column_name', '(?i)(credit_card|card_no|card_number|cc_num)',
     'fn_mask_last4', 'PII:credit_card',
     'Credit-card-like columns — last 4 only.', 250),

    ('column_mask', 'column_name', '(?i)^(salary|annual_income|income|bonus)$',
     'fn_mask_range', 'sensitive:compensation',
     'Compensation columns — bucketed range.', 150),

    ('column_mask', 'column_name', '(?i)^(cost|unit_cost|cogs|margin)$',
     'fn_mask_range', 'sensitive:cost',
     'Internal cost / margin columns — bucketed range.', 150),

    ('column_mask', 'column_name', '(?i)(address|home_addr|residence)',
     'fn_mask_partial', 'PII:address',
     'Address columns — partial mask.', 180);

-- Row filter starter rules (template substitutes {column} for actual column name)
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_filter_template, suggested_label, description, priority)
VALUES
    ('row_filter', 'column_name', '(?i)^tenant_id$',
     '{column} = current_setting(''app.tenant_id'', true)::TEXT',
     'tenant_scope',
     'Multi-tenant scoping — restrict rows to caller''s tenant.', 250),

    ('row_filter', 'column_name', '(?i)^(org_id|organization_id)$',
     '{column} = ANY(string_to_array(current_setting(''app.org_ids'', true), '',''))',
     'org_scope',
     'Organization scoping — restrict rows to caller''s orgs.', 220),

    ('row_filter', 'column_name', '(?i)^(owner_id|created_by|user_id)$',
     '{column} = current_setting(''app.user_id'', true)::TEXT',
     'owner_scope',
     'Ownership-based scoping — only see rows you own. Admin should override per role.', 100);

-- Classification-only rules (no mask, no filter — just tag for downstream policy authoring)
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_label, description, priority)
VALUES
    ('classification', 'table_name', '(?i)(audit|log|history)',
     'volume:high',
     'Tables likely to be high-volume — flag for index review before granting broad read.', 50),

    ('classification', 'column_name', '(?i)(password|secret|api_key|token)',
     'security:credential',
     'Credential-bearing columns — should never be readable except via dedicated service role.', 300);

COMMIT;

-- ------------------------------------------------------------
-- Rollback notes (for future reference, not part of this migration):
--   ALTER TABLE authz_resource DROP COLUMN lifecycle_state, ...;
--   ALTER TABLE authz_policy   DROP COLUMN suggested_by_rule, ...;
--   DROP TABLE authz_discovery_rule;
--   DROP FUNCTION fn_mask_last4(TEXT);
--   DELETE FROM authz_mask_function WHERE function_name='fn_mask_last4';
--   -- 'rejected' enum value cannot be dropped; leave it.
-- ------------------------------------------------------------
