// ANOMALY-V01 — list + ack endpoints over authz_anomaly_event.
//
// The detector worker (lib/anomaly-detectors.ts) writes events; this router
// is the read/triage surface. Same gate as activity (AUTHZ_ADMIN/STEWARD)
// because seeing "subject X did Y at 03:00" is equivalent to seeing the
// audit row itself.

import { Router } from 'express';
import { pool } from '../db';
import { handleApiError } from '../lib/request-helpers';
import { requireRole } from '../middleware/authz';
import { logAdminAction } from '../lib/admin-audit';

export const anomalyRouter = Router();

const requireAnomalyReader = requireRole('AUTHZ_ADMIN', 'DATA_STEWARD');

// ─── GET /anomaly/events?status=open|all&limit=50 ───
// Default returns open events only — the inbox view. status=all also returns
// acked events for audit/history. Capped at 200 rows so a runaway never
// floods the UI.
anomalyRouter.get('/events', requireAnomalyReader, async (req, res) => {
  const status = (req.query.status as string) === 'all' ? 'all' : 'open';
  const rule = (req.query.rule as string) || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status === 'open') conditions.push('acked_at IS NULL');
    if (rule) {
      params.push(rule);
      conditions.push(`rule_id = $${params.length}`);
    }
    params.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT event_id, detected_at, rule_id, severity, subject_id, details,
              acked_at, acked_by, ack_note
         FROM authz_anomaly_event
         ${where}
        ORDER BY detected_at DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ status, rule, rows: r.rows });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── GET /anomaly/summary ───
// Counts open events by rule + severity for the tab badge / header strip.
anomalyRouter.get('/summary', requireAnomalyReader, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT rule_id, severity, COUNT(*)::bigint AS open_count
         FROM authz_anomaly_event
        WHERE acked_at IS NULL
        GROUP BY rule_id, severity
        ORDER BY severity, rule_id`,
    );
    const total = r.rows.reduce((acc, row) => acc + parseInt(row.open_count), 0);
    res.json({ total_open: total, by_rule: r.rows });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── PATCH /anomaly/events/:id/ack ───
// Close one event. Body: { note?: string }. Idempotent — re-acking is a 200
// with the existing acked_by, not an error, so concurrent triage doesn't 409.
anomalyRouter.patch('/events/:id/ack', requireAnomalyReader, async (req, res) => {
  const eventId = parseInt(req.params.id);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: 'invalid event_id' });
  }
  const userId = req.headers['x-user-id'] as string | undefined;
  if (!userId) return res.status(401).json({ error: 'missing x-user-id' });
  const note: string | null = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;

  try {
    const r = await pool.query(
      `UPDATE authz_anomaly_event
          SET acked_at = COALESCE(acked_at, now()),
              acked_by = COALESCE(acked_by, $2),
              ack_note = COALESCE(ack_note, $3)
        WHERE event_id = $1
        RETURNING event_id, rule_id, severity, subject_id,
                  acked_at, acked_by, ack_note`,
      [eventId, userId, note],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'event not found' });

    // Tie the ack to the admin audit trail — quick triage history shows up
    // alongside other curator actions (CREATE_POLICY etc.) in AuditTab.
    await logAdminAction(pool, {
      userId,
      action: 'ACK_ANOMALY_EVENT',
      resourceType: 'anomaly_event',
      resourceId: String(eventId),
      details: { rule_id: r.rows[0].rule_id, severity: r.rows[0].severity, note },
    });

    res.json({ event: r.rows[0] });
  } catch (err) {
    handleApiError(res, err);
  }
});
