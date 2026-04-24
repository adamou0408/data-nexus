-- ============================================================
-- V049: AI Audit columns for Constitution Article 9.7
--
-- Constitution v2.0 (ratified 2026-04-24) §9.7 mandates extra columns
-- on the admin audit table so AI-originated operations are first-class
-- query targets, not buried in details JSONB:
--
--   actor_type     ai_agent | human | system
--   agent_id       LLM adapter identifier (nullable; required when actor_type='ai_agent')
--   model_id       model identifier at time of action (nullable)
--   consent_given  human_explicit | human_via_suggestion_card |
--                  agent_auto_read | agent_unauthorized
--
-- Scope: authz_admin_audit_log only. The runtime hypertable
-- authz_audit_log (V030) doesn't need these — AI reads flow through
-- authz_resolve(user) and log under the user's subject_id, not as a
-- separate AI actor.
--
-- §9.7 "AI rows 永不刪除" is satisfied by this table having no
-- compression policy and no retention policy. If that changes later,
-- a row-level retention exclusion for actor_type='ai_agent' must be
-- added at the same time (and any such change requires Article 8
-- re-amendment per §9.3).
-- ============================================================

-- ─── 1. Add the four columns ───
ALTER TABLE authz_admin_audit_log
    ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'human'
        CHECK (actor_type IN ('ai_agent', 'human', 'system')),
    ADD COLUMN agent_id TEXT,
    ADD COLUMN model_id TEXT,
    ADD COLUMN consent_given TEXT NOT NULL DEFAULT 'human_explicit'
        CHECK (consent_given IN (
            'human_explicit',
            'human_via_suggestion_card',
            'agent_auto_read',
            'agent_unauthorized'
        ));

-- ─── 2. Integrity: AI actor must declare its agent_id ───
ALTER TABLE authz_admin_audit_log
    ADD CONSTRAINT admin_audit_ai_requires_agent_id
    CHECK (actor_type <> 'ai_agent' OR agent_id IS NOT NULL);

-- ─── 3. Backfill consent_given from existing details JSONB ───
-- Pre-v2.0 rows that already carried consent_given inside details
-- (e.g. constitution v1.0 datasource consent flow) get promoted to
-- the column. Everything else stays at the default 'human_explicit'.
UPDATE authz_admin_audit_log
SET consent_given = details->>'consent_given'
WHERE details ? 'consent_given'
  AND details->>'consent_given' IN (
      'human_explicit',
      'human_via_suggestion_card',
      'agent_auto_read',
      'agent_unauthorized'
  );

-- ─── 4. Indexes for AI / consent queries ───
-- Partial index on AI rows: most queries will filter by actor_type='ai_agent'
-- (e.g. quarterly §9.6 PII spot-check, model swap audit, SLO violation review).
CREATE INDEX idx_admin_audit_ai_actor
    ON authz_admin_audit_log (timestamp DESC, agent_id)
    WHERE actor_type = 'ai_agent';

-- Index on agent_unauthorized rows for incident response (Article 6 + §9.7).
CREATE INDEX idx_admin_audit_unauthorized
    ON authz_admin_audit_log (timestamp DESC)
    WHERE consent_given = 'agent_unauthorized';

-- ─── 5. Comments ───
COMMENT ON COLUMN authz_admin_audit_log.actor_type IS
    'Constitution §9.7: ai_agent | human | system. Defaults to human for backward compat.';
COMMENT ON COLUMN authz_admin_audit_log.agent_id IS
    'Constitution §9.7: LLM adapter agent identifier. NOT NULL when actor_type=ai_agent (CHECK admin_audit_ai_requires_agent_id).';
COMMENT ON COLUMN authz_admin_audit_log.model_id IS
    'Constitution §9.7: Model identifier at time of action. Used for §9.8 model_swap audit and SLO regression analysis.';
COMMENT ON COLUMN authz_admin_audit_log.consent_given IS
    'Constitution §9.7: How was this action authorised. agent_unauthorized = Article 6 violation, requires immediate user notification per §9.6.';
