// ============================================================
// Tier A primitive #3: per-user feedback on Tier B pages
//
// End-user (any authenticated): POST self-write / GET self-list (mine)
// Curator (ADMIN/AUTHZ_ADMIN, SYSADMIN bypass): GET inbox / PATCH status
//
// Append-only for users — no PATCH/DELETE on own feedback (v1).
//
// Plan: .claude/plans/v3-phase-1/tier-a-feedback-plan.md
// Migration: V082__authz_feedback.sql
// ============================================================

import { Router } from 'express';
import { pool } from '../db';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';
import { logAdminAction } from '../lib/admin-audit';
import { requireRole } from '../middleware/authz';

export const feedbackRouter = Router();

const KIND_VALUES = ['data_wrong', 'feature_request', 'confusing', 'other'] as const;
const TRIAGE_STATUS_VALUES = ['triaged', 'resolved', 'dismissed'] as const;
const TARGET_PATH_RE = /^(page|column:.+|filter:.+)$/;

// POST /api/feedback — end-user self-write
feedbackRouter.post('/', async (req, res) => {
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const { page_id, target_path, kind, body } = req.body || {};

  if (!page_id || typeof page_id !== 'string') {
    res.status(400).json({ error: 'page_id required' });
    return;
  }
  if (!target_path || typeof target_path !== 'string' || !TARGET_PATH_RE.test(target_path)) {
    res.status(400).json({ error: "target_path must be 'page' | 'column:<col>' | 'filter:<field>'" });
    return;
  }
  if (!kind || !(KIND_VALUES as readonly string[]).includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${KIND_VALUES.join('/')}` });
    return;
  }
  if (!body || typeof body !== 'string' || body.trim().length === 0 || body.length > 4000) {
    res.status(400).json({ error: 'body required (1-4000 chars)' });
    return;
  }

  try {
    const r = await pool.query(
      `INSERT INTO authz_feedback (user_id, page_id, target_path, kind, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING feedback_id, user_id, page_id, target_path, kind, body, status,
                 curator_id, resolved_at, created_at, updated_at`,
      [userId, page_id, target_path, kind, body]
    );

    void logAdminAction(pool, {
      userId,
      action: 'tier_a_feedback_create',
      resourceType: 'authz_feedback',
      resourceId: r.rows[0].feedback_id,
      details: { page_id, target_path, kind },
      ip,
    });

    res.status(201).json({ feedback: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});

// GET /api/feedback/mine?page_id=X — end-user self-list
feedbackRouter.get('/mine', async (req, res) => {
  const userId = getUserId(req);
  const pageId = req.query.page_id as string | undefined;
  try {
    const params: unknown[] = [userId];
    let where = 'user_id = $1';
    if (pageId) {
      params.push(pageId);
      where += ` AND page_id = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT feedback_id, user_id, page_id, target_path, kind, body, status,
              curator_id, resolved_at, created_at, updated_at
         FROM authz_feedback
        WHERE ${where}
        ORDER BY created_at DESC`,
      params
    );
    res.json({ feedback: r.rows });
  } catch (err) { handleApiError(res, err); }
});

// GET /api/feedback/inbox?status=&page_id= — Curator inbox
feedbackRouter.get('/inbox', requireRole('ADMIN', 'AUTHZ_ADMIN'), async (req, res) => {
  const status = req.query.status as string | undefined;
  const pageId = req.query.page_id as string | undefined;
  try {
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (status) {
      params.push(status);
      wheres.push(`status = $${params.length}`);
    }
    if (pageId) {
      params.push(pageId);
      wheres.push(`page_id = $${params.length}`);
    }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT feedback_id, user_id, page_id, target_path, kind, body, status,
              curator_id, resolved_at, created_at, updated_at
         FROM authz_feedback
         ${whereClause}
        ORDER BY created_at DESC
        LIMIT 500`,
      params
    );
    res.json({ feedback: r.rows });
  } catch (err) { handleApiError(res, err); }
});

// PATCH /api/feedback/:id/status — Curator triage
feedbackRouter.patch('/:id/status', requireRole('ADMIN', 'AUTHZ_ADMIN'), async (req, res) => {
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const { id } = req.params;
  const { status } = req.body || {};

  if (!status || !(TRIAGE_STATUS_VALUES as readonly string[]).includes(status)) {
    res.status(400).json({ error: `status must be one of ${TRIAGE_STATUS_VALUES.join('/')}` });
    return;
  }

  try {
    // resolved_at: set on first move out of 'open'; preserve on subsequent transitions
    const r = await pool.query(
      `UPDATE authz_feedback
          SET status      = $3,
              curator_id  = $2,
              resolved_at = COALESCE(resolved_at, now()),
              updated_at  = now()
        WHERE feedback_id = $1
        RETURNING feedback_id, user_id, page_id, target_path, kind, body, status,
                  curator_id, resolved_at, created_at, updated_at`,
      [id, userId, status]
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    void logAdminAction(pool, {
      userId,
      action: `tier_a_feedback_${status}`,
      resourceType: 'authz_feedback',
      resourceId: id,
      details: { from_user: r.rows[0].user_id, page_id: r.rows[0].page_id },
      ip,
    });

    res.json({ feedback: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});
