// ============================================================
// Tier A primitive #2: saved view CRUD
//
// Self-scope only in v1: every query filters on user_id = current
// user. Cross-user 404 (no enumeration leak).
//
// Plan: .claude/plans/v3-phase-1/tier-a-saved-view-plan.md
// Migration: V080__authz_user_view.sql
// ============================================================

import { Router } from 'express';
import { pool } from '../db';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';
import { logAdminAction } from '../lib/admin-audit';

export const savedViewRouter = Router();

interface SavedViewConfig {
  filters?: Array<{ field: string; op: string; value: string }>;
  sort?: { col: string; dir: 'asc' | 'desc' };
  hidden_cols?: string[];
}

function isPlainConfig(x: unknown): x is SavedViewConfig {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.filters !== undefined && !Array.isArray(o.filters)) return false;
  if (o.sort !== undefined && (typeof o.sort !== 'object' || o.sort === null)) return false;
  if (o.hidden_cols !== undefined && !Array.isArray(o.hidden_cols)) return false;
  return true;
}

// GET /api/saved-view?page_id=xxx — list current user's views for a page
savedViewRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const pageId = (req.query.page_id as string | undefined) || '';
  if (!pageId) {
    res.status(400).json({ error: 'page_id required' });
    return;
  }
  try {
    const r = await pool.query(
      `SELECT view_id, user_id, page_id, name, config_json, is_default, created_at, updated_at
         FROM authz_user_view
        WHERE user_id = $1 AND page_id = $2
        ORDER BY is_default DESC, updated_at DESC`,
      [userId, pageId]
    );
    res.json({ views: r.rows });
  } catch (err) { handleApiError(res, err); }
});

// GET /api/saved-view/:view_id — fetch one (404 for cross-user / wrong page_id)
savedViewRouter.get('/:view_id', async (req, res) => {
  const userId = getUserId(req);
  const { view_id } = req.params;
  const pageId = req.query.page_id as string | undefined;
  try {
    const r = await pool.query(
      `SELECT view_id, user_id, page_id, name, config_json, is_default, created_at, updated_at
         FROM authz_user_view
        WHERE view_id = $1 AND user_id = $2`,
      [view_id, userId]
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (pageId && r.rows[0].page_id !== pageId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ view: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});

// POST /api/saved-view — create
savedViewRouter.post('/', async (req, res) => {
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const { page_id, name, config_json, is_default } = req.body || {};
  if (!page_id || !name || !config_json) {
    res.status(400).json({ error: 'page_id, name, config_json required' });
    return;
  }
  if (!isPlainConfig(config_json)) {
    res.status(400).json({ error: 'config_json shape invalid (filters/sort/hidden_cols)' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (is_default === true) {
      await client.query(
        `UPDATE authz_user_view
            SET is_default = false, updated_at = now()
          WHERE user_id = $1 AND page_id = $2 AND is_default = true`,
        [userId, page_id]
      );
    }
    const r = await client.query(
      `INSERT INTO authz_user_view (user_id, page_id, name, config_json, is_default)
       VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, false))
       RETURNING view_id, user_id, page_id, name, config_json, is_default, created_at, updated_at`,
      [userId, page_id, name, JSON.stringify(config_json), is_default === true]
    );
    await client.query('COMMIT');

    void logAdminAction(pool, {
      userId,
      action: 'tier_a_saved_view_create',
      resourceType: 'authz_user_view',
      resourceId: r.rows[0].view_id,
      details: { page_id, name, is_default: r.rows[0].is_default },
      ip,
    });

    res.status(201).json({ view: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleApiError(res, err);
  } finally {
    client.release();
  }
});

// PATCH /api/saved-view/:view_id — rename / update config_json
savedViewRouter.patch('/:view_id', async (req, res) => {
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const { view_id } = req.params;
  const { name, config_json } = req.body || {};
  if (name === undefined && config_json === undefined) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  if (config_json !== undefined && !isPlainConfig(config_json)) {
    res.status(400).json({ error: 'config_json shape invalid' });
    return;
  }
  try {
    const r = await pool.query(
      `UPDATE authz_user_view
          SET name        = COALESCE($3, name),
              config_json = COALESCE($4::jsonb, config_json),
              updated_at  = now()
        WHERE view_id = $1 AND user_id = $2
        RETURNING view_id, user_id, page_id, name, config_json, is_default, created_at, updated_at`,
      [view_id, userId, name ?? null, config_json !== undefined ? JSON.stringify(config_json) : null]
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    void logAdminAction(pool, {
      userId,
      action: 'tier_a_saved_view_update',
      resourceType: 'authz_user_view',
      resourceId: view_id,
      details: { name, config_changed: config_json !== undefined },
      ip,
    });
    res.json({ view: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});

// POST /api/saved-view/:view_id/set-default — demote-then-promote in transaction
savedViewRouter.post('/:view_id/set-default', async (req, res) => {
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const { view_id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      `SELECT page_id FROM authz_user_view WHERE view_id = $1 AND user_id = $2`,
      [view_id, userId]
    );
    if (owned.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const pageId = owned.rows[0].page_id;
    await client.query(
      `UPDATE authz_user_view
          SET is_default = false, updated_at = now()
        WHERE user_id = $1 AND page_id = $2 AND is_default = true`,
      [userId, pageId]
    );
    const r = await client.query(
      `UPDATE authz_user_view
          SET is_default = true, updated_at = now()
        WHERE view_id = $1 AND user_id = $2
        RETURNING view_id, user_id, page_id, name, config_json, is_default, created_at, updated_at`,
      [view_id, userId]
    );
    await client.query('COMMIT');

    void logAdminAction(pool, {
      userId,
      action: 'tier_a_saved_view_set_default',
      resourceType: 'authz_user_view',
      resourceId: view_id,
      details: { page_id: pageId },
      ip,
    });
    res.json({ view: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleApiError(res, err);
  } finally {
    client.release();
  }
});

// DELETE /api/saved-view/:view_id
savedViewRouter.delete('/:view_id', async (req, res) => {
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const { view_id } = req.params;
  try {
    const r = await pool.query(
      `DELETE FROM authz_user_view
        WHERE view_id = $1 AND user_id = $2
        RETURNING page_id, name`,
      [view_id, userId]
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    void logAdminAction(pool, {
      userId,
      action: 'tier_a_saved_view_delete',
      resourceType: 'authz_user_view',
      resourceId: view_id,
      details: { page_id: r.rows[0].page_id, name: r.rows[0].name },
      ip,
    });
    res.json({ status: 'deleted', view_id });
  } catch (err) { handleApiError(res, err); }
});
