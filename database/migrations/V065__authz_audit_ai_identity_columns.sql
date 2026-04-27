-- ============================================================
-- V065: Add AI agent identity columns to authz_audit_log
-- ============================================================
-- Source: Constitution v2.0 §9.7 promised actor_type/agent_id/model_id/
--         consent_given on authz_audit_log; companion migration was
--         marked "pending" since 2026-04-24 ratification.
-- Trigger: Adam 2026-04-27 三大基線原則 #2 (所有 AI 決策要可解釋) —
--          hard precondition for default-allow pilot.
--
-- Design:
--   actor_type     TEXT NOT NULL DEFAULT 'user'  — values constrained
--   agent_id       TEXT NULL                     — required when actor_type='ai_agent'
--   model_id       TEXT NULL                     — required when actor_type='ai_agent'
--   consent_given  BOOLEAN NULL                  — TRUE/FALSE for AI rows; NULL for non-AI
--
-- Backwards compat: existing authz-api INSERT calls unchanged (default 'user').
--   Future AI write path must explicitly set actor_type/agent_id/model_id.
--
-- TimescaleDB note: dev DB has no compressed chunks yet (compression
--   policy runs on chunks older than 30 days). For prod migration with
--   compressed data, decompress affected chunks first.
-- ============================================================

BEGIN;

-- 1. Four new columns
ALTER TABLE authz_audit_log
    ADD COLUMN actor_type    TEXT NOT NULL DEFAULT 'user',
    ADD COLUMN agent_id      TEXT,
    ADD COLUMN model_id      TEXT,
    ADD COLUMN consent_given BOOLEAN;

-- 2. actor_type vocabulary
ALTER TABLE authz_audit_log
    ADD CONSTRAINT authz_audit_log_actor_type_check
    CHECK (actor_type IN ('user', 'service', 'ai_agent', 'system'));

-- 3. AI rows must carry full identity (constitution §9.7)
ALTER TABLE authz_audit_log
    ADD CONSTRAINT authz_audit_log_ai_identity_check
    CHECK (
        actor_type <> 'ai_agent'
        OR (agent_id IS NOT NULL AND model_id IS NOT NULL)
    );

-- 4. Index for AI-only queries (partial — skips the dominant 'user' rows)
CREATE INDEX IF NOT EXISTS idx_audit_actor_type
    ON authz_audit_log(actor_type, timestamp DESC)
    WHERE actor_type <> 'user';

-- 5. Documentation
COMMENT ON COLUMN authz_audit_log.actor_type IS
    'Constitution §9.7. one of user|service|ai_agent|system. Default user.';
COMMENT ON COLUMN authz_audit_log.agent_id IS
    'Constitution §9.7. Required when actor_type=ai_agent. e.g. claude-investigator-v1.';
COMMENT ON COLUMN authz_audit_log.model_id IS
    'Constitution §9.7. Required when actor_type=ai_agent. e.g. claude-opus-4-7.';
COMMENT ON COLUMN authz_audit_log.consent_given IS
    'Constitution §9.7. TRUE if sensitive write blessed by human; FALSE for unblessed; NULL for non-AI rows.';

COMMIT;
