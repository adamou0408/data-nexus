-- ============================================================
-- V062: Deny pattern library — Phase 1 default-allow pilot seed
--
-- Phase 1 of permission-default-allow
-- (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md AC-1.5).
--
-- ⚠️  PRODUCTION DEPLOYMENT REQUIRES DUAL SIGN-OFF
-- ⚠️  Per AC-1.5: Adam + 法遵 / 內稽 (Compliance / Internal Audit) must
-- ⚠️  approve this seed before applying to staging or prod. Dev apply
-- ⚠️  is fine for testing the discovery pipeline.
--
-- ────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES
-- ────────────────────────────────────────────────────────────
-- Seeds 30 deny-side discovery rules across the categories called out
-- in plan §3.4. Each rule is rule_type='classification' (per the
-- chk_rule_payload constraint, which only allows 'classification' for
-- non-mask, non-filter rules) with effect='deny' (V061 column).
--
-- The discovery engine picks these up when scanning a default-allow
-- datasource (default_l0_policy='allow') and surfaces them as
-- "auto-deny suggestions" in the review UI. Operators confirm /
-- override before they become authz_policy(effect='deny') rows.
--
-- ────────────────────────────────────────────────────────────
-- COVERAGE (30 patterns, ≥ AC-1.5 minimum)
-- ────────────────────────────────────────────────────────────
--   薪資 (salary):        6 patterns
--   合約 (contracts):     5 patterns
--   IP / 機密:            6 patterns
--   系統 / 認證:          8 patterns
--   金融 / SOX:           3 patterns
--   法務 / 合規:          2 patterns
--
-- PII (email/phone/id_*) and 客戶 (customer_*) already exist as
-- column_mask rules (effect='allow') — plan §3.4 categorizes them as
-- "mask + L0 可訪問", not deny — so this migration does NOT touch them.
--
-- ────────────────────────────────────────────────────────────
-- PRIORITY CONVENTION
-- ────────────────────────────────────────────────────────────
-- Default priority = 100 (per V003). Deny patterns get priority 200
-- so they fire BEFORE allow-with-mask suggestions when both match
-- (e.g. a column literally named "salary" hits both V055's mask rule
-- and our new deny rule — deny wins per SEC-02 semantics).
-- ============================================================

-- ─── 薪資 (Salary / Compensation) — 6 patterns ───
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_label, description, priority, effect)
VALUES
    ('classification', 'column_name', '(?i)^(salary|monthly_salary|annual_salary|base_salary)$',
     'sox-deny-salary',
     'Salary fields — SOX-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(bonus|annual_bonus|year_end_bonus|performance_bonus)$',
     'sox-deny-bonus',
     'Bonus / variable pay — SOX-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(compensation|total_comp|comp_amount|comp_package)$',
     'sox-deny-compensation',
     'Total compensation — SOX-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(payroll|pay_check|pay_slip|paycheck_amount)$',
     'sox-deny-payroll',
     'Payroll records — SOX-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(commission|sales_commission|incentive_pay|spiff)$',
     'sox-deny-commission',
     'Sales commission — SOX-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(stock_option|rsu|equity_grant|esop_units)$',
     'sox-deny-equity',
     'Equity / stock options — SOX-sensitive, default L0 deny',
     200, 'deny');

-- ─── 合約 (Contracts / Agreements) — 5 patterns ───
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_label, description, priority, effect)
VALUES
    ('classification', 'table_name', '(?i)^contract(_|s$).*',
     'legal-deny-contract-table',
     'Contract tables — legal-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'table_name', '(?i)^agreement(_|s$).*',
     'legal-deny-agreement-table',
     'Agreement tables — legal-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'table_name', '(?i)^(nda|mou|loi|sla)(_|s$).*',
     'legal-deny-binding-doc',
     'Binding-doc tables (NDA / MOU / LOI / SLA) — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(license_terms|terms_of_service|tos_content|eula_text)$',
     'legal-deny-licensing',
     'Licensing terms text — legal-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(contract_value|contract_amount|deal_size|tcv)$',
     'legal-deny-contract-value',
     'Contract monetary value — legal-sensitive, default L0 deny',
     200, 'deny');

-- ─── IP / 機密 (Intellectual Property) — 6 patterns ───
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_label, description, priority, effect)
VALUES
    ('classification', 'column_name', '(?i)^(formula|recipe|composition|chem_composition)$',
     'ip-deny-formula',
     'Trade-secret formulas / recipes — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(blueprint|schematic|design_spec|cad_data)$',
     'ip-deny-design',
     'Engineering blueprints / schematics — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(secret|trade_secret|proprietary_data|confidential_note)$',
     'ip-deny-trade-secret',
     'Explicitly trade-secret fields — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(source_code|build_script|deploy_key|signing_cert)$',
     'ip-deny-source-deploy',
     'Source code / build / deploy artifacts — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(patent_draft|invention_disclosure|prior_art|patent_claim)$',
     'ip-deny-patent',
     'Patent drafts / inventions — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^algorithm_(weights|params|model|hyperparameters)$',
     'ip-deny-ml-model',
     'ML model weights / hyperparameters — default L0 deny',
     200, 'deny');

-- ─── 系統 / 認證 (System Credentials) — 8 patterns ───
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_label, description, priority, effect)
VALUES
    ('classification', 'column_name', '(?i).*_password$',
     'sec-deny-password',
     'Password fields (any *_password column) — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i).*_token$',
     'sec-deny-token',
     'Token fields (any *_token column) — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(api_key|access_token|refresh_token|bearer_token)$',
     'sec-deny-api-credential',
     'API credentials — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(private_key|signing_key|encryption_key|tls_key)$',
     'sec-deny-cryptokey',
     'Cryptographic keys — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(client_secret|webhook_secret|app_secret|oauth_secret)$',
     'sec-deny-shared-secret',
     'Shared secrets (OAuth / webhook / app) — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(session_id|csrf_token|auth_cookie|jwt_token)$',
     'sec-deny-session',
     'Session / CSRF / cookie tokens — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(db_password|root_password|master_pass|admin_pwd)$',
     'sec-deny-db-credential',
     'Database / root credentials — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^.*_(secret_key|secret_token)$',
     'sec-deny-suffix-secret',
     'Suffix-style secret keys (*_secret_key, *_secret_token) — default L0 deny',
     200, 'deny');

-- ─── 金融 / SOX — 3 patterns ───
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_label, description, priority, effect)
VALUES
    ('classification', 'column_name', '(?i)^(bank_account|iban|swift_code|routing_no|account_number)$',
     'sox-deny-bank-detail',
     'Bank account detail — SOX-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(tax_id|ein|vat_number|business_license_no)$',
     'sox-deny-tax-id',
     'Corporate tax ID / VAT — SOX-sensitive, default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(audit_finding|sox_remediation|control_weakness|material_weakness)$',
     'sox-deny-audit-finding',
     'Audit findings — SOX-sensitive, default L0 deny',
     200, 'deny');

-- ─── 法務 / 合規 — 2 patterns ───
INSERT INTO authz_discovery_rule
    (rule_type, match_target, match_pattern, suggested_label, description, priority, effect)
VALUES
    ('classification', 'column_name', '(?i)^(legal_hold|litigation_status|deposition_note|case_strategy)$',
     'legal-deny-litigation',
     'Litigation / legal-hold notes — default L0 deny',
     200, 'deny'),
    ('classification', 'column_name', '(?i)^(investigation_note|whistleblower_id|hr_complaint|misconduct_report)$',
     'hr-deny-investigation',
     'HR / whistleblower investigations — default L0 deny',
     200, 'deny');

-- ─── Sanity check: ≥30 deny rules now exist ───
DO $$
DECLARE
    deny_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO deny_count
    FROM authz_discovery_rule
    WHERE effect = 'deny' AND enabled = TRUE;

    IF deny_count < 30 THEN
        RAISE EXCEPTION 'V062 sanity check failed: expected ≥30 enabled deny rules, found %', deny_count;
    END IF;

    RAISE NOTICE 'V062 seeded: % enabled deny rules total', deny_count;
END $$;
