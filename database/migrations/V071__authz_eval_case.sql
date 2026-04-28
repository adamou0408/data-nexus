-- ============================================================
-- V071: authz_eval_case — eval cases captured via explicit user 👍/👎 consent
-- ============================================================
-- Source:  Constitution v2.2 §9.6 carve-out + new §9.9 Eval Case Capture.
--          AI-DOGFOOD-01 (AuthorPanel AI 助理) shipped 2026-04-28; this table
--          is the dogfood-driven eval-set capture loop replacing the original
--          eval-set-collection-plan §64-72 cross-team kickoff path (which
--          required hiring/interviews — out of Phase 1 scope per memory
--          project_pure_software_dev).
--
-- §9.6 carve-out:
--   authz_ai_usage stays hash-only (default). authz_eval_case stores the FULL
--   prompt + response, but ONLY when the user clicks 👍/👎 in the UI — that
--   click constitutes Article 3 explicit consent. Backend / agents MUST NOT
--   write into this table without that user-initiated path.
--
-- Use cases:
--   1. Build text-to-SQL eval set (target 200 cases, plan §2.8)
--   2. Model swap baseline (§9.8 — re-run eval set on new model)
--   3. Prompt regression (catch when prompt template changes break working
--      cases)
--   4. Continuous improvement: which prompts repeatedly fail → improve
--      schema context / system prompt / classify training set
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS authz_eval_case (
    case_id            BIGSERIAL PRIMARY KEY,

    -- Provenance: link back to the original ai_usage row so we can correlate
    -- with token counts / latency / cost. ON DELETE SET NULL because eval
    -- cases outlive usage rows (we may prune authz_ai_usage but keep cases).
    ai_usage_id        BIGINT REFERENCES authz_ai_usage(usage_id) ON DELETE SET NULL,

    -- Denormalised so the case stays meaningful even if FK is nulled. Mirrors
    -- the keys we already record in authz_ai_usage.
    feature_tag        TEXT NOT NULL,
    provider_id        TEXT NOT NULL,
    model_id           TEXT NOT NULL,
    data_source_id     TEXT,                          -- NULL for explain (no DS)

    -- The actual eval payload — full plaintext under §9.9 explicit-consent
    -- carve-out from §9.6. Both columns NOT NULL because an eval case without
    -- one or the other is useless.
    prompt_text        TEXT NOT NULL,
    response_text      TEXT NOT NULL,

    -- The user's verdict. NULL not allowed — if they didn't click, no case.
    verdict            TEXT NOT NULL CHECK (verdict IN ('good','bad')),
    notes              TEXT,                          -- optional free-form

    -- Provenance trio
    marked_by          TEXT NOT NULL,                 -- subject_id (e.g. 'user:adam_ou')
    marked_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE authz_eval_case IS
  'AI eval cases captured via explicit user 👍/👎 consent. See Constitution v2.2 §9.6 (carve-out) and §9.9 (eval case capture). Plaintext stored ONLY because user clicked verdict button — server / agents MUST NOT write here autonomously.';

COMMENT ON COLUMN authz_eval_case.ai_usage_id IS
  'FK to authz_ai_usage(usage_id) of the AI call that produced this case. ON DELETE SET NULL so case survives usage pruning.';

COMMENT ON COLUMN authz_eval_case.prompt_text IS
  'Full plaintext prompt — stored under §9.9 explicit-consent carve-out from §9.6 hash-only default. Captured ONLY when user clicks 👍/👎.';

COMMENT ON COLUMN authz_eval_case.response_text IS
  'Full plaintext model response. Same §9.9 carve-out as prompt_text.';

COMMENT ON COLUMN authz_eval_case.verdict IS
  'good / bad — the user vouches for whether this is a useful eval case (good = expected output; bad = regression / known-bad we want to catch).';

CREATE INDEX IF NOT EXISTS idx_eval_case_feature_tag ON authz_eval_case(feature_tag);
CREATE INDEX IF NOT EXISTS idx_eval_case_marked_by ON authz_eval_case(marked_by);
CREATE INDEX IF NOT EXISTS idx_eval_case_marked_at ON authz_eval_case(marked_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_case_verdict ON authz_eval_case(verdict);

COMMIT;
