// CATALOG-TELEMETRY-V01 — frame open/close events for the unified Catalog
// Workspace.
//
// Two endpoints:
//   POST /catalog/usage-event    — ingest (any signed-in user)
//   GET  /catalog/usage-stats    — admin/steward read of the daily cagg
//
// Storage layer: V091 catalog_usage_event hypertable + catalog_usage_daily
// continuous aggregate. The cagg is hourly-refreshed; for short windows
// (<= 1 day) we fall back to the raw hypertable so today's badges aren't
// blank.

import { Router } from 'express';
import { pool } from '../db';
import { getUserId, handleApiError } from '../lib/request-helpers';
import { requireRole } from '../middleware/authz';

export const catalogUsageRouter = Router();

// Same gate as activity/anomaly — read access for admins / data stewards.
const requireUsageReader = requireRole('AUTHZ_ADMIN', 'DATA_STEWARD');

const VALID_ACTIONS = new Set(['open', 'close']);
const MAX_BATCH = 50;
const VALID_GROUP_BY = new Set(['target_id', 'frame_kind']);

type IngestEvent = {
  session_id?: unknown;
  preset?: unknown;
  frame_kind?: unknown;
  target_id?: unknown;
  action?: unknown;
  dwell_ms?: unknown;
  trigger?: unknown;
  context?: unknown;
};

function parseWindowDays(raw: string | undefined): number | null {
  // Accepts '7d', '30d', '90d', '365d'. Returns days as integer or null on error.
  if (!raw) return 7;
  const m = /^(\d+)d$/.exec(raw.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 365) return null;
  return n;
}

// ─── POST /catalog/usage-event ───
// Body: { events: [{ session_id, preset, frame_kind, target_id?, action,
//                    dwell_ms?, trigger?, context? }, ...] }
// Up to 50 events per call.
catalogUsageRouter.post('/usage-event', async (req, res) => {
  const subjectId = getUserId(req);
  if (!subjectId || subjectId === 'unknown') {
    return res.status(401).json({ error: 'Missing X-User-Id header' });
  }
  const events = (req.body?.events ?? []) as IngestEvent[];
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events must be a non-empty array' });
  }
  if (events.length > MAX_BATCH) {
    return res.status(400).json({ error: `events array exceeds max batch size of ${MAX_BATCH}` });
  }

  const rows: Array<[string, string, string, string, string | null, string, number | null, string | null, string | null, string | null]> = [];
  for (const e of events) {
    const preset = typeof e.preset === 'string' ? e.preset.trim() : '';
    const frameKind = typeof e.frame_kind === 'string' ? e.frame_kind.trim() : '';
    const action = typeof e.action === 'string' ? e.action.trim() : '';
    if (!preset || !frameKind || !VALID_ACTIONS.has(action)) {
      return res.status(400).json({ error: 'each event needs preset, frame_kind, and action ∈ {open, close}' });
    }
    const targetId = typeof e.target_id === 'string' && e.target_id.length > 0 ? e.target_id : null;
    const sessionId = typeof e.session_id === 'string' && e.session_id.length > 0 ? e.session_id : null;
    const trigger = typeof e.trigger === 'string' && e.trigger.length > 0 ? e.trigger : null;
    const dwellMs = typeof e.dwell_ms === 'number' && Number.isFinite(e.dwell_ms) && e.dwell_ms >= 0
      ? Math.min(Math.round(e.dwell_ms), 24 * 60 * 60 * 1000) // clamp at 24h to reject pathological values
      : null;
    const contextJson = e.context && typeof e.context === 'object'
      ? JSON.stringify(e.context)
      : null;
    rows.push([subjectId, preset, frameKind, action, targetId, sessionId ?? '', dwellMs, trigger, contextJson, null]);
  }

  try {
    // Build a single multi-VALUES INSERT; 10 placeholders per row.
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const row of rows) {
      // (subject_id, preset, frame_kind, action, target_id, session_id, dwell_ms, trigger, context)
      valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb)`);
      params.push(row[0], row[1], row[2], row[3], row[4], row[5] || null, row[6], row[7], row[8]);
    }
    await pool.query(
      `INSERT INTO catalog_usage_event
         (subject_id, preset, frame_kind, action, target_id, session_id, dwell_ms, trigger, context)
       VALUES ${valuesSql.join(', ')}`,
      params
    );
    res.json({ ingested: rows.length });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── GET /catalog/usage-stats ───
// Query: preset (required), window (default '7d', max '365d'),
//        group_by ('target_id'|'frame_kind', default 'target_id'),
//        limit (default 50, max 500).
// Returns rows ordered by open_count DESC.
//
// bounce_rate uses bounce_count / NULLIF(open_count, 0) — the simpler form
// (per spec). Close events may be missing on tab-close even with pagehide,
// so close_event_count would understate denominators.
catalogUsageRouter.get('/usage-stats', requireUsageReader, async (req, res) => {
  const preset = (req.query.preset as string | undefined)?.trim();
  if (!preset) {
    return res.status(400).json({ error: 'preset query param is required' });
  }
  const days = parseWindowDays(req.query.window as string | undefined);
  if (days === null) {
    return res.status(400).json({ error: 'window must be a string like "7d", max "365d"' });
  }
  const groupByRaw = (req.query.group_by as string | undefined) || 'target_id';
  if (!VALID_GROUP_BY.has(groupByRaw)) {
    return res.status(400).json({ error: 'group_by must be target_id or frame_kind' });
  }
  const groupBy = groupByRaw as 'target_id' | 'frame_kind';
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 500);

  try {
    if (days <= 1) {
      // Raw hypertable for short windows — cagg lags by ~1h.
      const r = await pool.query(
        `SELECT ${groupBy} AS group_key,
                COUNT(*) FILTER (WHERE action='open')::bigint                       AS open_count,
                COUNT(DISTINCT subject_id) FILTER (WHERE action='open')::bigint     AS distinct_users,
                COUNT(DISTINCT session_id) FILTER (WHERE action='open')::bigint     AS distinct_sessions,
                AVG(dwell_ms) FILTER (WHERE action='close' AND dwell_ms IS NOT NULL) AS avg_dwell_ms,
                COUNT(*) FILTER (WHERE action='close' AND dwell_ms < 3000)::bigint  AS bounce_count
           FROM catalog_usage_event
          WHERE preset = $1
            AND ts >= now() - ($2 || ' days')::interval
          GROUP BY ${groupBy}
          ORDER BY open_count DESC
          LIMIT $3`,
        [preset, days.toString(), limit]
      );
      return res.json({
        window: `${days}d`,
        group_by: groupBy,
        rows: r.rows.map(shapeRow),
      });
    }

    // Daily continuous aggregate — windows >= 2d.
    const r = await pool.query(
      `SELECT ${groupBy} AS group_key,
              SUM(open_count)::bigint        AS open_count,
              SUM(distinct_users)::bigint    AS distinct_users,
              SUM(distinct_sessions)::bigint AS distinct_sessions,
              AVG(avg_dwell_ms)              AS avg_dwell_ms,
              SUM(bounce_count)::bigint      AS bounce_count
         FROM catalog_usage_daily
        WHERE preset = $1
          AND bucket >= (now() - ($2 || ' days')::interval)::date
        GROUP BY ${groupBy}
        ORDER BY open_count DESC NULLS LAST
        LIMIT $3`,
      [preset, days.toString(), limit]
    );
    res.json({
      window: `${days}d`,
      group_by: groupBy,
      rows: r.rows.map(shapeRow),
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

function shapeRow(row: Record<string, unknown>) {
  const openCount = Number(row.open_count ?? 0);
  const bounceCount = Number(row.bounce_count ?? 0);
  return {
    group_key: row.group_key,
    open_count: openCount,
    distinct_users: Number(row.distinct_users ?? 0),
    distinct_sessions: Number(row.distinct_sessions ?? 0),
    avg_dwell_ms: row.avg_dwell_ms === null || row.avg_dwell_ms === undefined
      ? null
      : Math.round(Number(row.avg_dwell_ms)),
    bounce_count: bounceCount,
    bounce_rate: openCount > 0 ? bounceCount / openCount : 0,
  };
}
