// ACTIVITY-V01 — read-only stats over the existing audit infrastructure.
//
// V030 already created two TimescaleDB continuous aggregates that nobody was
// querying:
//   audit_hourly_summary(bucket, access_path, decision, event_count, avg_duration_ms)
//   audit_daily_by_subject(bucket, subject_id, access_path, decision, event_count)
//
// This router exposes them to the dashboard so the Observe → Activity tab can
// render a path × decision heatmap and per-subject leaderboards without
// scanning raw authz_audit_log on every page load.
//
// Top-N denied resources is NOT covered by either continuous aggregate
// (no resource_id rollup), so it falls back to the hypertable directly with
// a tight time window. That's still cheap because the hypertable is chunked
// + indexed on (resource_id, timestamp DESC).

import { Router } from 'express';
import { pool } from '../db';
import { handleApiError } from '../lib/request-helpers';
import { requireRole } from '../middleware/authz';

export const activityRouter = Router();

// Same gate as /audit-logs — admin or steward can observe; SYSADMIN bypassed
// inside requireRole.
const requireActivityReader = requireRole('AUTHZ_ADMIN', 'DATA_STEWARD');

// ─── GET /activity/hourly-summary?hours=24 ───
// Returns one row per (bucket, access_path, decision) for the requested
// trailing window. Caller pivots into a heatmap client-side — the matrix is
// small (24 hours × 3 paths × 2 decisions = 144 cells) so JSON is fine.
activityRouter.get('/hourly-summary', requireActivityReader, async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);
  try {
    const r = await pool.query(
      `SELECT bucket, access_path, decision, event_count, avg_duration_ms
         FROM audit_hourly_summary
        WHERE bucket >= now() - ($1 || ' hours')::interval
        ORDER BY bucket DESC, access_path, decision`,
      [hours.toString()],
    );
    res.json({ hours, rows: r.rows });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── GET /activity/top-subjects?days=7&limit=10 ───
// Daily per-subject counts, summed over the window. Decision split kept so
// the UI can show "X allowed / Y denied" inline.
activityRouter.get('/top-subjects', requireActivityReader, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 30);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
  try {
    const r = await pool.query(
      `SELECT subject_id,
              SUM(event_count) FILTER (WHERE decision = 'allow') AS allow_count,
              SUM(event_count) FILTER (WHERE decision = 'deny')  AS deny_count,
              SUM(event_count) AS total_count
         FROM audit_daily_by_subject
        WHERE bucket >= (now() - ($1 || ' days')::interval)::date
        GROUP BY subject_id
        ORDER BY total_count DESC
        LIMIT $2`,
      [days.toString(), limit],
    );
    res.json({ days, rows: r.rows });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── GET /activity/top-denied-resources?hours=24&limit=10 ───
// Hits the hypertable because no aggregate rolls up resource_id. We bound by
// hours (not days) because resource cardinality blows up the row count fast,
// and the deny-resource view is a recent-ops signal anyway.
activityRouter.get('/top-denied-resources', requireActivityReader, async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
  try {
    const r = await pool.query(
      `SELECT resource_id, access_path, COUNT(*)::bigint AS deny_count,
              COUNT(DISTINCT subject_id)::bigint AS distinct_subjects
         FROM authz_audit_log
        WHERE decision = 'deny'
          AND timestamp >= now() - ($1 || ' hours')::interval
        GROUP BY resource_id, access_path
        ORDER BY deny_count DESC
        LIMIT $2`,
      [hours.toString(), limit],
    );
    res.json({ hours, rows: r.rows });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── GET /activity/totals?hours=24 ───
// Single-row roundup for the tab header (allow / deny / total). Lets the UI
// show a "1.2k decisions, 4.3% denied" banner without summing the heatmap.
activityRouter.get('/totals', requireActivityReader, async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);
  try {
    const r = await pool.query(
      `SELECT
          COALESCE(SUM(event_count) FILTER (WHERE decision='allow'), 0)::bigint AS allow_count,
          COALESCE(SUM(event_count) FILTER (WHERE decision='deny'),  0)::bigint AS deny_count,
          COALESCE(SUM(event_count), 0)::bigint AS total_count
         FROM audit_hourly_summary
        WHERE bucket >= now() - ($1 || ' hours')::interval`,
      [hours.toString()],
    );
    res.json({ hours, ...r.rows[0] });
  } catch (err) {
    handleApiError(res, err);
  }
});
