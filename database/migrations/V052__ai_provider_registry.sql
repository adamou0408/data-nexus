-- ============================================================
-- V052: AI Provider Registry
--
-- Foundation for AI-assisted features per Constitution Article 9.
-- Stores OpenAI-compatible LLM endpoints (OpenAI, Azure, vLLM, Ollama, etc.)
-- with encrypted API keys, purpose-based routing, and budget tracking.
--
-- Design notes (see also: docs/constitution.md §9, plan-v3-phase-1.md §2.4/§2.5):
--   * API keys stored as `enc:iv:tag:ciphertext` via services/authz-api/src/lib/crypto.ts
--     (AES-256-GCM, ENCRYPTION_KEY env var). NO pgcrypto extension required.
--   * NULL api_key_encrypted = "configured but no key yet" (template state).
--   * Purpose tags drive feature → provider routing; `is_fallback` is the
--     catch-all when no tag matches. Partial unique index ensures ≤1 fallback.
--   * Pricing stored per-model as JSONB so adapter can compute cost from
--     token counts reported by the provider (no hardcoded price table to rot).
--   * `authz_ai_usage` is the hash-only audit ledger required by §9.6 — never
--     stores raw prompt/response, only SHA-256 hash + token counts.
--
-- Idempotent-ish: table creation is IF NOT EXISTS; seed uses ON CONFLICT.
-- ============================================================

BEGIN;

-- ─── Provider registry ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS authz_ai_provider (
    provider_id         TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL,
    description         TEXT,

    -- All OpenAI-compatible; kind drives only UI labelling + sane defaults.
    provider_kind       TEXT NOT NULL
        CHECK (provider_kind IN (
            'openai', 'azure_openai', 'vllm', 'ollama', 'openrouter', 'custom_oai'
        )),
    base_url            TEXT NOT NULL,

    -- Credential: AES-256-GCM ciphertext from lib/crypto.ts (enc:iv:tag:data format).
    -- NULL allowed so admin can save a template provider row and add the key later.
    api_key_encrypted   TEXT,
    api_key_last4       TEXT,
    api_key_rotated_at  TIMESTAMPTZ,

    -- Model defaults (per-call override still allowed in the adapter layer).
    default_model       TEXT,
    available_models    TEXT[] NOT NULL DEFAULT '{}',
    default_temperature NUMERIC(3,2) DEFAULT 0.2,
    default_max_tokens  INTEGER DEFAULT 4096,
    timeout_ms          INTEGER NOT NULL DEFAULT 30000,

    -- Pricing: { "<model_id>": { "input": <usd_per_1M>, "output": <usd_per_1M> } }
    -- Adapter computes cost = (prompt_tokens * input + completion_tokens * output) / 1_000_000.
    pricing             JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Purpose routing. Feature code asks "which provider serves purpose X?"
    -- Adapter picks first active provider with the tag; if none, falls back
    -- to is_fallback=TRUE; if none, throws "no provider for purpose X".
    purpose_tags        TEXT[] NOT NULL DEFAULT '{}',
    is_fallback         BOOLEAN NOT NULL DEFAULT FALSE,

    -- Budget enforcement (adapter returns 429 when exceeded).
    monthly_budget_usd  NUMERIC(10,2),   -- NULL = unlimited
    rate_limit_rpm      INTEGER,         -- NULL = unlimited

    -- Health probe state (updated by /_test endpoint).
    last_tested_at      TIMESTAMPTZ,
    last_test_status    TEXT,
    last_test_detail    TEXT,

    -- Lifecycle (mirror authz_data_source pattern).
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    owner_subject       TEXT REFERENCES authz_subject(subject_id),
    registered_by       TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE authz_ai_provider IS
    'Registry of OpenAI-compatible LLM providers. Constitution §9.1 scope.';
COMMENT ON COLUMN authz_ai_provider.api_key_encrypted IS
    'AES-256-GCM ciphertext (enc:iv:tag:data) via services/authz-api/src/lib/crypto.ts. NULL = template.';
COMMENT ON COLUMN authz_ai_provider.purpose_tags IS
    'Capability declaration: {chat,text_to_sql,suggestion,embedding}. Adapter routes by tag.';
COMMENT ON COLUMN authz_ai_provider.is_fallback IS
    'Catch-all when no purpose_tag matches. Max one active fallback enforced by partial unique index.';
COMMENT ON COLUMN authz_ai_provider.pricing IS
    'Per-model USD/1M-tokens: {"gpt-4o-mini":{"input":0.15,"output":0.60}}. Adapter computes cost.';

-- Max one active fallback provider.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_one_fallback
    ON authz_ai_provider ((TRUE))
    WHERE is_fallback = TRUE AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_ai_provider_active
    ON authz_ai_provider (is_active) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_ai_provider_purpose_tags
    ON authz_ai_provider USING GIN (purpose_tags);

-- updated_at trigger (reuse pattern from authz_data_source).
CREATE OR REPLACE FUNCTION fn_ai_provider_touch()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_provider_touch ON authz_ai_provider;
CREATE TRIGGER trg_ai_provider_touch
    BEFORE UPDATE ON authz_ai_provider
    FOR EACH ROW EXECUTE FUNCTION fn_ai_provider_touch();

-- ─── Usage ledger (§9.6 hash-only audit) ───────────────────
CREATE TABLE IF NOT EXISTS authz_ai_usage (
    usage_id            BIGSERIAL PRIMARY KEY,
    provider_id         TEXT NOT NULL REFERENCES authz_ai_provider(provider_id),
    called_by           TEXT NOT NULL,              -- subject_id (§9.2 inheritance check)
    called_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    feature_tag         TEXT,                       -- 'query_tool.explain_sql', etc. (§9.7 traceability)
    model_id            TEXT NOT NULL,

    -- §9.6 MUST: no raw prompt/response, hash only.
    prompt_hash         TEXT,                       -- SHA-256 hex of canonical prompt
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    cost_usd            NUMERIC(10,6),              -- NULL when pricing unconfigured
    latency_ms          INTEGER,

    status              TEXT NOT NULL
        CHECK (status IN ('ok','rate_limited','budget_exceeded','error','timeout')),
    error_detail        TEXT                        -- never contains prompt content
);

COMMENT ON TABLE authz_ai_usage IS
    'Per-call LLM usage ledger. Constitution §9.6 mandates hash-only; raw prompt/response forbidden.';
COMMENT ON COLUMN authz_ai_usage.prompt_hash IS
    'SHA-256 of canonical prompt. Enables dedup/replay-detection without storing content.';

CREATE INDEX IF NOT EXISTS idx_ai_usage_provider_time
    ON authz_ai_usage (provider_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_called_by
    ON authz_ai_usage (called_by, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_feature
    ON authz_ai_usage (feature_tag, called_at DESC) WHERE feature_tag IS NOT NULL;

-- ─── Authz resource type for per-provider permissions ───────
-- The resource_type check constraint doesn't currently allow 'ai_provider'.
-- Extend it so admins can grant 'configure' / 'use' per provider_id.
ALTER TABLE authz_resource DROP CONSTRAINT IF EXISTS authz_resource_resource_type_check;
ALTER TABLE authz_resource ADD CONSTRAINT authz_resource_resource_type_check
    CHECK (resource_type = ANY (ARRAY[
        'module','page','table','view','column','function','ai_tool',
        'web_page','web_api','db_schema','db_table','db_pool','dag',
        'ai_provider'
    ]));

-- Register the wildcard resource so role grants can use 'ai_provider:*'.
INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes)
VALUES ('ai_provider:*', 'ai_provider', 'All AI providers', '{"wildcard": true}'::jsonb)
ON CONFLICT (resource_id) DO NOTHING;

-- ─── Register new actions: configure / use ─────────────────
-- `configure` = CRUD the provider config (admin surface).
-- `use`       = invoke the adapter at runtime (every login user, §9.2).
INSERT INTO authz_action (action_id, display_name, description, applicable_paths)
VALUES
    ('configure', 'Configure',
     'Change platform configuration (provider endpoints, secrets, routing). Admin surface.',
     ARRAY['A','B']),
    ('use', 'Use',
     'Invoke a callable capability at runtime (AI provider call, tool invocation).',
     ARRAY['A','B'])
ON CONFLICT (action_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description  = EXCLUDED.description;

-- ─── Default permissions ────────────────────────────────────
-- Per Adam: "permissions = user's" — AUTHZ_ADMIN configures; everyone uses.
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect)
VALUES
    ('AUTHZ_ADMIN', 'configure', 'ai_provider:*', 'allow'),
    ('AUTHZ_ADMIN', 'use',       'ai_provider:*', 'allow')
ON CONFLICT (role_id, action_id, resource_id) DO UPDATE SET effect = 'allow', is_active = TRUE;

-- ─── Seed template provider ─────────────────────────────────
-- Starts disabled with no key; admin fills key via UI → toggles active.
-- available_models populated with OpenAI's public list as of 2026-04; refresh
-- button in UI will re-query /v1/models and overwrite.
INSERT INTO authz_ai_provider (
    provider_id, display_name, description,
    provider_kind, base_url,
    default_model, available_models,
    pricing, purpose_tags,
    is_active, registered_by
) VALUES (
    'ai:openai_main_template',
    'OpenAI (template)',
    'Add your API key to activate. Default OpenAI endpoint with gpt-4o family preset.',
    'openai',
    'https://api.openai.com/v1',
    'gpt-4o-mini',
    ARRAY['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    '{
        "gpt-4o":       {"input": 2.50, "output": 10.00},
        "gpt-4o-mini":  {"input": 0.15, "output": 0.60},
        "gpt-4-turbo":  {"input": 10.00,"output": 30.00},
        "gpt-3.5-turbo":{"input": 0.50, "output": 1.50}
    }'::jsonb,
    ARRAY['chat', 'text_to_sql', 'suggestion'],
    FALSE,
    'system'
) ON CONFLICT (provider_id) DO NOTHING;

COMMIT;
