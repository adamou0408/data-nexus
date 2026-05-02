-- ============================================================
-- V087: authz_anomaly_event — anomaly v1 (rule-based detection)
--
-- ── Problem ──
--   audit_log + audit_hourly_summary capture every authz decision but nothing
--   surfaces "this is unusual". Curators eyeball AuditTab and miss spikes,
--   off-hours admin actions, recon scans, and §9.7 unauthorized AI agent
--   activity until something downstream breaks.
--
-- ── Choice ──
--   Rule-based detection (5 detectors), pull-based: a worker runs every 5min
--   against existing aggregates + tables, INSERT ... ON CONFLICT (dedup_key)
--   DO NOTHING idempotently. No streaming infra, no ML pipeline.
--
--   Rule IDs (open set, expand by adding new strings — no enum so we can ship
--   detectors without a migration):
--     DENY_SPIKE             — any path 1h deny rate over threshold
--     OFF_HOURS_ADMIN        — admin-write between 22:00 and 06:00
--     UNAUTHORIZED_AI_AGENT  — Constitution §9.7: ai_agent + agent_unauthorized
--     RECON_PATTERN          — same subject hits 50+ distinct resources / 5min
--     AI_COST_SPIKE          — provider 24h cost > monthly_budget × threshold
--
-- ── dedup_key contract ──
--   Each detector builds a key that's stable for the same anomaly window. If
--   the rule fires again on the next 5min tick for the same window, the
--   INSERT no-ops. Examples:
--     DENY_SPIKE|A|2026-04-30T14:00
--     OFF_HOURS_ADMIN|adam_ou|2026-04-30T03:14:22|UPDATE_ROLE|role:foo
--     RECON_PATTERN|guest_user|2026-04-30T14:25:00
--   Worker picks the bucket boundary so dedup_key is deterministic.
--
-- ── Out of scope (later) ──
--   Per-subject baseline (z-score / MAD) — Layer 2 v2 if rule noise is high
--   Email / Slack notification — UI ack flow first; channel routing later
-- ============================================================

BEGIN;

CREATE TABLE authz_anomaly_event (
  event_id     bigserial   PRIMARY KEY,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  rule_id      text        NOT NULL,
  severity     text        NOT NULL,
  subject_id   text,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- dedup_key keeps the same anomaly window from inserting twice. Worker is
  -- responsible for building it deterministically per rule. UNIQUE prevents
  -- concurrent worker instances from racing.
  dedup_key    text        NOT NULL UNIQUE,
  acked_at     timestamptz,
  acked_by     text,
  ack_note     text,

  CONSTRAINT authz_anomaly_severity_enum CHECK (severity IN ('P1','P2','P3')),
  CONSTRAINT authz_anomaly_rule_nonblank CHECK (length(btrim(rule_id)) > 0),
  CONSTRAINT authz_anomaly_ack_consistent CHECK (
    (acked_at IS NULL AND acked_by IS NULL) OR
    (acked_at IS NOT NULL AND acked_by IS NOT NULL)
  )
);

-- Inbox query: WHERE acked_at IS NULL ORDER BY detected_at DESC
CREATE INDEX authz_anomaly_open_idx
  ON authz_anomaly_event (detected_at DESC)
  WHERE acked_at IS NULL;

-- Filter by rule for "show all DENY_SPIKE in last 7d"
CREATE INDEX authz_anomaly_rule_idx
  ON authz_anomaly_event (rule_id, detected_at DESC);

COMMENT ON TABLE authz_anomaly_event IS
  'Anomaly v1 events written by the rule-based detector worker. dedup_key keeps re-firing the same anomaly window idempotent.';
COMMENT ON COLUMN authz_anomaly_event.dedup_key IS
  'Deterministic per (rule_id, anomaly_window). UNIQUE — re-runs of the worker no-op via ON CONFLICT.';
COMMENT ON COLUMN authz_anomaly_event.severity IS
  'P1 = act now (e.g. unauthorized AI agent), P2 = needs eyes today, P3 = nice-to-know.';

COMMIT;
