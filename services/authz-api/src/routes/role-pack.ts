// ============================================================
// PERM-SLIM-V01-PATH2 — Role Pack admin routes
//
// Surface for V089 authz_role_pack* tables. Read endpoints are
// open to AUTHZ_ADMIN/DATA_STEWARD (same gate as activity); write
// endpoints (CRUD on packs / members / assignments) are AUTHZ_ADMIN
// only — assigning a pack to a role can grant 10+ permissions in
// one click, so we treat it like editing role_permission directly.
//
// All write paths route through services/authz-api/src/lib/role-pack.ts
// so the sync engine (advisory lock + transactional expand/unexpand)
// is the single code path that mutates pack-tagged authz_role_permission
// rows. Direct table writes from this router are limited to the pack
// definition itself + members; expansion into role_permission goes
// through the lib functions only.
// ============================================================

import { Router } from 'express';
import { pool } from '../db';
import { getUserId, handleApiError } from '../lib/request-helpers';
import { requireRole } from '../middleware/authz';
import { logAdminAction } from '../lib/admin-audit';
import {
  expandPackToRole,
  unexpandPackFromRole,
  resyncPackMembers,
  previewExpansion,
  PackNotFoundError,
  RoleNotFoundError,
} from '../lib/role-pack';

export const rolePackRouter = Router();

// Read = AUTHZ_ADMIN or DATA_STEWARD; write = AUTHZ_ADMIN only.
const requirePackReader = requireRole('AUTHZ_ADMIN', 'DATA_STEWARD');
const requirePackWriter = requireRole('AUTHZ_ADMIN');

// ─── helpers ────────────────────────────────────────────────
function isPackId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(s);
}

function mapLibError(err: unknown, res: import('express').Response): boolean {
  if (err instanceof PackNotFoundError) {
    res.status(404).json({ error: 'pack_not_found', pack_id: err.packId });
    return true;
  }
  if (err instanceof RoleNotFoundError) {
    res.status(404).json({ error: 'role_not_found', role_id: err.roleId });
    return true;
  }
  return false;
}

// ─── GET /role-pack — list packs with member/assignment counts ───
rolePackRouter.get('/', requirePackReader, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.pack_id, p.display_name, p.description, p.is_system,
              p.created_by, p.created_at, p.updated_at,
              COALESCE(m.member_count, 0)::int       AS member_count,
              COALESCE(a.assignment_count, 0)::int   AS assignment_count
         FROM authz_role_pack p
    LEFT JOIN (SELECT pack_id, COUNT(*) AS member_count
                 FROM authz_role_pack_member GROUP BY pack_id) m
           ON m.pack_id = p.pack_id
    LEFT JOIN (SELECT pack_id, COUNT(*) AS assignment_count
                 FROM authz_role_pack_assignment GROUP BY pack_id) a
           ON a.pack_id = p.pack_id
        ORDER BY p.is_system DESC, p.pack_id`,
    );
    res.json({ packs: r.rows });
  } catch (err) { handleApiError(res, err); }
});

// ─── GET /role-pack/:pack_id — detail incl. members + assignments ──
rolePackRouter.get('/:pack_id', requirePackReader, async (req, res) => {
  const { pack_id } = req.params;
  try {
    const pack = await pool.query(
      `SELECT pack_id, display_name, description, is_system,
              created_by, created_at, updated_at
         FROM authz_role_pack WHERE pack_id = $1`,
      [pack_id],
    );
    if (pack.rowCount === 0) {
      res.status(404).json({ error: 'pack_not_found', pack_id });
      return;
    }
    const members = await pool.query(
      `SELECT resource_id, action_id, effect::text, added_by, added_at
         FROM authz_role_pack_member
        WHERE pack_id = $1
        ORDER BY resource_id, action_id`,
      [pack_id],
    );
    const assignments = await pool.query(
      `SELECT role_id, applied_by, applied_at
         FROM authz_role_pack_assignment
        WHERE pack_id = $1
        ORDER BY role_id`,
      [pack_id],
    );
    res.json({
      pack: pack.rows[0],
      members: members.rows,
      assignments: assignments.rows,
    });
  } catch (err) { handleApiError(res, err); }
});

// ─── POST /role-pack — create a new pack (no members yet) ──
rolePackRouter.post('/', requirePackWriter, async (req, res) => {
  const userId = getUserId(req);
  const { pack_id, display_name, description } = req.body || {};
  if (!isPackId(pack_id)) {
    res.status(400).json({ error: 'pack_id must match ^[a-z][a-z0-9_]{2,63}$' });
    return;
  }
  if (typeof display_name !== 'string' || display_name.trim().length === 0) {
    res.status(400).json({ error: 'display_name required' });
    return;
  }
  try {
    const r = await pool.query(
      `INSERT INTO authz_role_pack (pack_id, display_name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING pack_id, display_name, description, is_system,
                 created_by, created_at, updated_at`,
      [pack_id, display_name.trim(), description ?? null, userId],
    );
    void logAdminAction(pool, {
      userId,
      action: 'CREATE_ROLE_PACK',
      resourceType: 'role_pack',
      resourceId: pack_id,
      details: { pack_id, display_name, description },
    });
    res.status(201).json({ pack: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});

// ─── PATCH /role-pack/:pack_id — rename / re-describe (system packs OK) ─
rolePackRouter.patch('/:pack_id', requirePackWriter, async (req, res) => {
  const userId = getUserId(req);
  const { pack_id } = req.params;
  const { display_name, description } = req.body || {};
  if (display_name === undefined && description === undefined) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  if (display_name !== undefined &&
      (typeof display_name !== 'string' || display_name.trim().length === 0)) {
    res.status(400).json({ error: 'display_name must be non-empty string' });
    return;
  }
  try {
    const r = await pool.query(
      `UPDATE authz_role_pack
          SET display_name = COALESCE($2, display_name),
              description  = COALESCE($3, description)
        WHERE pack_id = $1
        RETURNING pack_id, display_name, description, is_system,
                  created_by, created_at, updated_at`,
      [pack_id, display_name?.trim() ?? null, description ?? null],
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'pack_not_found', pack_id });
      return;
    }
    void logAdminAction(pool, {
      userId,
      action: 'UPDATE_ROLE_PACK',
      resourceType: 'role_pack',
      resourceId: pack_id,
      details: { display_name, description_changed: description !== undefined },
    });
    res.json({ pack: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});

// ─── DELETE /role-pack/:pack_id — block when is_system or in use ──
rolePackRouter.delete('/:pack_id', requirePackWriter, async (req, res) => {
  const userId = getUserId(req);
  const { pack_id } = req.params;
  try {
    const pack = await pool.query(
      `SELECT is_system FROM authz_role_pack WHERE pack_id = $1`, [pack_id],
    );
    if (pack.rowCount === 0) {
      res.status(404).json({ error: 'pack_not_found', pack_id });
      return;
    }
    if (pack.rows[0].is_system === true) {
      res.status(409).json({ error: 'system_pack_undeletable', pack_id });
      return;
    }
    // Refuse if any role still has it assigned. Caller must unexpand first
    // (so role_permission stays in a sane state — CASCADE would silently
    // delete pack_source rows but skip the audit trail).
    const used = await pool.query(
      `SELECT COUNT(*)::int AS n FROM authz_role_pack_assignment WHERE pack_id = $1`,
      [pack_id],
    );
    if (used.rows[0].n > 0) {
      res.status(409).json({
        error: 'pack_in_use',
        pack_id,
        assignment_count: used.rows[0].n,
        hint: 'unexpand from all roles before deleting',
      });
      return;
    }
    await pool.query(`DELETE FROM authz_role_pack WHERE pack_id = $1`, [pack_id]);
    void logAdminAction(pool, {
      userId,
      action: 'DELETE_ROLE_PACK',
      resourceType: 'role_pack',
      resourceId: pack_id,
      details: { pack_id },
    });
    res.json({ status: 'deleted', pack_id });
  } catch (err) { handleApiError(res, err); }
});

// ─── POST /role-pack/:pack_id/members — add a (resource, action, effect) ──
rolePackRouter.post('/:pack_id/members', requirePackWriter, async (req, res) => {
  const userId = getUserId(req);
  const { pack_id } = req.params;
  const { resource_id, action_id, effect } = req.body || {};
  if (typeof resource_id !== 'string' || typeof action_id !== 'string') {
    res.status(400).json({ error: 'resource_id and action_id required' });
    return;
  }
  const eff = effect === 'deny' ? 'deny' : 'allow';
  try {
    const exists = await pool.query(
      `SELECT 1 FROM authz_role_pack WHERE pack_id = $1`, [pack_id],
    );
    if (exists.rowCount === 0) {
      res.status(404).json({ error: 'pack_not_found', pack_id });
      return;
    }
    await pool.query(
      `INSERT INTO authz_role_pack_member
         (pack_id, resource_id, action_id, effect, added_by)
       VALUES ($1, $2, $3, $4::authz_effect, $5)
       ON CONFLICT (pack_id, resource_id, action_id) DO UPDATE
         SET effect = EXCLUDED.effect`,
      [pack_id, resource_id, action_id, eff, userId],
    );

    // Re-sync every role currently assigned to this pack so the new
    // member is mirrored into authz_role_permission immediately.
    const synced = await resyncPackMembers(pool, pack_id, userId);

    void logAdminAction(pool, {
      userId,
      action: 'ADD_ROLE_PACK_MEMBER',
      resourceType: 'role_pack',
      resourceId: pack_id,
      details: { pack_id, resource_id, action_id, effect: eff, resync_count: synced.length },
    });
    res.status(201).json({
      member: { pack_id, resource_id, action_id, effect: eff },
      resync: synced,
    });
  } catch (err) {
    if (mapLibError(err, res)) return;
    handleApiError(res, err);
  }
});

// ─── DELETE /role-pack/:pack_id/members/:resource_id/:action_id ─
// Uses params instead of body so the URL is bookmarkable / curlable.
rolePackRouter.delete('/:pack_id/members/:resource_id/:action_id',
  requirePackWriter, async (req, res) => {
    const userId = getUserId(req);
    const { pack_id, resource_id, action_id } = req.params;
    try {
      const r = await pool.query(
        `DELETE FROM authz_role_pack_member
          WHERE pack_id = $1 AND resource_id = $2 AND action_id = $3
          RETURNING effect::text`,
        [pack_id, resource_id, action_id],
      );
      if (r.rowCount === 0) {
        res.status(404).json({ error: 'member_not_found' });
        return;
      }
      // Re-sync so pack-tagged rows for this tuple are dropped on every
      // role that currently has the pack assigned.
      const synced = await resyncPackMembers(pool, pack_id, userId);

      void logAdminAction(pool, {
        userId,
        action: 'REMOVE_ROLE_PACK_MEMBER',
        resourceType: 'role_pack',
        resourceId: pack_id,
        details: { pack_id, resource_id, action_id, resync_count: synced.length },
      });
      res.json({ status: 'removed', pack_id, resource_id, action_id, resync: synced });
    } catch (err) {
      if (mapLibError(err, res)) return;
      handleApiError(res, err);
    }
  });

// ─── GET /role-pack/:pack_id/preview/:role_id — dry-run diff ──
rolePackRouter.get('/:pack_id/preview/:role_id', requirePackReader, async (req, res) => {
  const { pack_id, role_id } = req.params;
  try {
    const r = await previewExpansion(pool, pack_id, role_id);
    res.json({ pack_id, role_id, ...r });
  } catch (err) {
    if (mapLibError(err, res)) return;
    handleApiError(res, err);
  }
});

// ─── POST /role-pack/:pack_id/assignments/:role_id — apply pack ──
rolePackRouter.post('/:pack_id/assignments/:role_id', requirePackWriter, async (req, res) => {
  const userId = getUserId(req);
  const { pack_id, role_id } = req.params;
  try {
    const result = await expandPackToRole(pool, pack_id, role_id, userId);
    res.status(201).json(result);
  } catch (err) {
    if (mapLibError(err, res)) return;
    handleApiError(res, err);
  }
});

// ─── DELETE /role-pack/:pack_id/assignments/:role_id — unapply pack ──
rolePackRouter.delete('/:pack_id/assignments/:role_id', requirePackWriter, async (req, res) => {
  const userId = getUserId(req);
  const { pack_id, role_id } = req.params;
  try {
    const result = await unexpandPackFromRole(pool, pack_id, role_id, userId);
    res.json({ pack_id, role_id, ...result });
  } catch (err) {
    if (mapLibError(err, res)) return;
    handleApiError(res, err);
  }
});

// ─── POST /role-pack/:pack_id/resync — re-run sync for every assigned role ─
// Useful after manual DB intervention or as an admin "force convergence" knob.
rolePackRouter.post('/:pack_id/resync', requirePackWriter, async (req, res) => {
  const userId = getUserId(req);
  const { pack_id } = req.params;
  try {
    const results = await resyncPackMembers(pool, pack_id, userId);
    res.json({ pack_id, results });
  } catch (err) {
    if (mapLibError(err, res)) return;
    handleApiError(res, err);
  }
});
