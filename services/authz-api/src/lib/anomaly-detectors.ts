// ============================================================
// ANOMALY-V01 — rule-based detectors over the audit infrastructure.
//
// Five detectors run on a 5-min cadence (see index.ts setInterval). Each one
// returns the events to insert; the orchestrator then does
// INSERT ... ON CONFLICT (dedup_key) DO NOTHING so re-firing the same window
// is a no-op. dedup_key shape per rule is documented inline.
//
// All five are pull-based — no streaming, no extra infra. The cost is one
// scheduled SQL roundtrip per detector per tick.
// ============================================================

import { Pool } from 'pg';

export type AnomalySeverity = 'P1' | 'P2' | 'P3';

export interface AnomalyEvent {
  rule_id: string;
  severity: AnomalySeverity;
  subject_id: string | null;
  details: Record<string, unknown>;
  dedup_key: string;
}

// Tunables — kept inline so future-you doesn't have to chase a config file.
// Rule of thumb: signal-to-noise > exact recall on a small dataset like ours.
const DENY_SPIKE_MIN_EVENTS    = 50;    // need this much volume before "rate" matters
const DENY_SPIKE_RATE_PCT      = 30;    // path 1h deny rate ≥ 30%
const RECON_DISTINCT_RESOURCES = 50;    // 50+ distinct resources in 5min by one subject
const AI_COST_BUDGET_MULT      = 0.80;  // alert when 24h spend ≥ 80% of monthly_budget
const OFF_HOURS_START          = 22;    // local-server hour ≥ 22
const OFF_HOURS_END            = 6;     // local-server hour < 6

// ─── 1. DENY_SPIKE ─────────────────────────────────────────────
// "Path X had ≥ DENY_SPIKE_MIN_EVENTS decisions in some hour-bucket and
// ≥ DENY_SPIKE_RATE_PCT% of them were deny." Reads audit_hourly_summary so
// we don't scan the hypertable. Looks back 2h to catch the bucket that just
// closed plus the in-flight one.
//
// dedup_key: DENY_SPIKE|<path>|<bucket-iso>
async function detectDenySpike(pool: Pool): Promise<AnomalyEvent[]> {
  const r = await pool.query<{
    bucket: string; access_path: string;
    deny_count: string; total_count: string; deny_pct: string;
  }>(
    `WITH per_path AS (
       SELECT bucket, access_path,
              SUM(event_count) FILTER (WHERE decision='deny')::bigint  AS deny_count,
              SUM(event_count)::bigint                                  AS total_count
         FROM audit_hourly_summary
        WHERE bucket >= now() - interval '2 hours'
        GROUP BY bucket, access_path
     )
     SELECT bucket, access_path, deny_count, total_count,
            ROUND((deny_count::numeric / NULLIF(total_count,0)) * 100, 1) AS deny_pct
       FROM per_path
      WHERE total_count >= $1
        AND (deny_count::numeric / NULLIF(total_count,0)) * 100 >= $2`,
    [DENY_SPIKE_MIN_EVENTS, DENY_SPIKE_RATE_PCT],
  );
  return r.rows.map(row => ({
    rule_id: 'DENY_SPIKE',
    severity: 'P2' as const,
    subject_id: null,
    details: {
      access_path: row.access_path,
      bucket: row.bucket,
      deny_count: parseInt(row.deny_count),
      total_count: parseInt(row.total_count),
      deny_pct: parseFloat(row.deny_pct),
      threshold_pct: DENY_SPIKE_RATE_PCT,
      min_events: DENY_SPIKE_MIN_EVENTS,
    },
    dedup_key: `DENY_SPIKE|${row.access_path}|${new Date(row.bucket).toISOString()}`,
  }));
}

// ─── 2. OFF_HOURS_ADMIN ────────────────────────────────────────
// Any admin write between 22:00 and 06:00 server-time. Cheap because
// authz_admin_audit_log is small (one row per admin action). Looks back 30min
// — anything older is already alerted.
//
// dedup_key: OFF_HOURS_ADMIN|<id>  (per-row idempotent — one row, one alert)
async function detectOffHoursAdmin(pool: Pool): Promise<AnomalyEvent[]> {
  const r = await pool.query<{
    id: string; user_id: string; timestamp: string;
    action: string; resource_type: string; resource_id: string | null;
    actor_type: string; consent_given: string;
  }>(
    `SELECT id::text, user_id, timestamp, action, resource_type, resource_id,
            actor_type, consent_given
       FROM authz_admin_audit_log
      WHERE timestamp >= now() - interval '30 minutes'
        AND (
          EXTRACT(HOUR FROM timestamp AT TIME ZONE 'localtime') >= $1
          OR EXTRACT(HOUR FROM timestamp AT TIME ZONE 'localtime') < $2
        )
        -- Skip read-only / inert audit entries; flag mutations only.
        AND action NOT LIKE 'READ_%'
        AND action NOT LIKE 'LIST_%'
        AND action NOT LIKE '%_VIEW'`,
    [OFF_HOURS_START, OFF_HOURS_END],
  );
  return r.rows.map(row => ({
    rule_id: 'OFF_HOURS_ADMIN',
    severity: 'P2' as const,
    subject_id: row.user_id,
    details: {
      audit_id: row.id,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      timestamp: row.timestamp,
      actor_type: row.actor_type,
      consent_given: row.consent_given,
      window: `${OFF_HOURS_START}:00-0${OFF_HOURS_END}:00`,
    },
    dedup_key: `OFF_HOURS_ADMIN|${row.id}`,
  }));
}

// ─── 3. UNAUTHORIZED_AI_AGENT ──────────────────────────────────
// Constitution §9.7: any actor_type='ai_agent' with consent_given='agent_unauthorized'
// is a P1. One alert per row. Looks back 30min.
//
// dedup_key: UNAUTHORIZED_AI_AGENT|<id>
async function detectUnauthorizedAiAgent(pool: Pool): Promise<AnomalyEvent[]> {
  const r = await pool.query<{
    id: string; user_id: string; timestamp: string;
    action: string; resource_type: string; resource_id: string | null;
    agent_id: string | null; model_id: string | null;
  }>(
    `SELECT id::text, user_id, timestamp, action, resource_type, resource_id,
            agent_id, model_id
       FROM authz_admin_audit_log
      WHERE actor_type = 'ai_agent'
        AND consent_given = 'agent_unauthorized'
        AND timestamp >= now() - interval '30 minutes'`,
  );
  return r.rows.map(row => ({
    rule_id: 'UNAUTHORIZED_AI_AGENT',
    severity: 'P1' as const,
    subject_id: row.user_id,
    details: {
      audit_id: row.id,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      agent_id: row.agent_id,
      model_id: row.model_id,
      timestamp: row.timestamp,
      constitution_section: '9.7',
    },
    dedup_key: `UNAUTHORIZED_AI_AGENT|${row.id}`,
  }));
}

// ─── 4. RECON_PATTERN ──────────────────────────────────────────
// Same subject hits ≥ RECON_DISTINCT_RESOURCES distinct resource_id in any
// 5-min bucket. Bucket-aligned via date_trunc so dedup_key stays stable when
// the same window re-fires on the next tick (mid-bucket the worker may see
// growing counts; ON CONFLICT swallows the duplicate insert).
//
// dedup_key: RECON_PATTERN|<subject>|<bucket-iso>
async function detectReconPattern(pool: Pool): Promise<AnomalyEvent[]> {
  const r = await pool.query<{
    subject_id: string; bucket: string;
    distinct_resources: string; total_events: string;
  }>(
    `SELECT subject_id,
            date_trunc('minute', timestamp)
              - (EXTRACT(MINUTE FROM timestamp)::int % 5) * interval '1 minute' AS bucket,
            COUNT(DISTINCT resource_id)::bigint AS distinct_resources,
            COUNT(*)::bigint                    AS total_events
       FROM authz_audit_log
      WHERE timestamp >= now() - interval '15 minutes'
      GROUP BY subject_id, bucket
      HAVING COUNT(DISTINCT resource_id) >= $1`,
    [RECON_DISTINCT_RESOURCES],
  );
  return r.rows.map(row => ({
    rule_id: 'RECON_PATTERN',
    severity: 'P2' as const,
    subject_id: row.subject_id,
    details: {
      bucket_start: row.bucket,
      window_minutes: 5,
      distinct_resources: parseInt(row.distinct_resources),
      total_events: parseInt(row.total_events),
      threshold: RECON_DISTINCT_RESOURCES,
    },
    dedup_key: `RECON_PATTERN|${row.subject_id}|${new Date(row.bucket).toISOString()}`,
  }));
}

// ─── 5. AI_COST_SPIKE ──────────────────────────────────────────
// Provider's 24h spend ≥ monthly_budget × AI_COST_BUDGET_MULT. Alerts once
// per day-bucket per provider so curators don't get flooded across ticks.
//
// dedup_key: AI_COST_SPIKE|<provider>|<utc-day>
async function detectAiCostSpike(pool: Pool): Promise<AnomalyEvent[]> {
  const r = await pool.query<{
    provider_id: string; cost_24h: string;
    monthly_budget_usd: string | null; pct_of_budget: string;
  }>(
    `WITH spend AS (
       SELECT provider_id, COALESCE(SUM(cost_usd), 0)::numeric AS cost_24h
         FROM authz_ai_usage
        WHERE called_at >= now() - interval '24 hours'
          AND status = 'ok'
        GROUP BY provider_id
     )
     SELECT s.provider_id,
            s.cost_24h::text,
            p.monthly_budget_usd::text,
            ROUND((s.cost_24h / NULLIF(p.monthly_budget_usd, 0)) * 100, 1)::text AS pct_of_budget
       FROM spend s
       JOIN authz_ai_provider p ON p.provider_id = s.provider_id
      WHERE p.monthly_budget_usd IS NOT NULL
        AND p.is_active = TRUE
        AND s.cost_24h >= p.monthly_budget_usd * $1`,
    [AI_COST_BUDGET_MULT],
  );
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  return r.rows.map(row => ({
    rule_id: 'AI_COST_SPIKE',
    severity: 'P2' as const,
    subject_id: null,
    details: {
      provider_id: row.provider_id,
      cost_24h_usd: parseFloat(row.cost_24h),
      monthly_budget_usd: row.monthly_budget_usd ? parseFloat(row.monthly_budget_usd) : null,
      pct_of_budget: parseFloat(row.pct_of_budget),
      threshold_mult: AI_COST_BUDGET_MULT,
    },
    dedup_key: `AI_COST_SPIKE|${row.provider_id}|${today}`,
  }));
}

// ─── Orchestrator ──────────────────────────────────────────────
// Runs all five detectors and inserts. ON CONFLICT (dedup_key) DO NOTHING
// makes re-runs a no-op so two workers (or a re-fire after restart) can't
// double-write. Returns counts for logging.
export interface DetectorRunResult {
  rule_id: string;
  candidates: number;
  inserted: number;
  error?: string;
}

const detectors: Array<[string, (p: Pool) => Promise<AnomalyEvent[]>]> = [
  ['DENY_SPIKE',            detectDenySpike],
  ['OFF_HOURS_ADMIN',       detectOffHoursAdmin],
  ['UNAUTHORIZED_AI_AGENT', detectUnauthorizedAiAgent],
  ['RECON_PATTERN',         detectReconPattern],
  ['AI_COST_SPIKE',         detectAiCostSpike],
];

export async function runAllDetectors(pool: Pool): Promise<DetectorRunResult[]> {
  const results: DetectorRunResult[] = [];
  for (const [rule_id, fn] of detectors) {
    try {
      const events = await fn(pool);
      let inserted = 0;
      for (const ev of events) {
        const r = await pool.query(
          `INSERT INTO authz_anomaly_event (rule_id, severity, subject_id, details, dedup_key)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (dedup_key) DO NOTHING
           RETURNING event_id`,
          [ev.rule_id, ev.severity, ev.subject_id, JSON.stringify(ev.details), ev.dedup_key],
        );
        if (r.rowCount && r.rowCount > 0) inserted++;
      }
      results.push({ rule_id, candidates: events.length, inserted });
    } catch (err) {
      results.push({ rule_id, candidates: 0, inserted: 0, error: String(err) });
    }
  }
  return results;
}
