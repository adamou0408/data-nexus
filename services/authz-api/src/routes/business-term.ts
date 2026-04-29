// ============================================================
// Tier A — gate-prep tooling for §3.4 C primitive
//
// Admin-only CRUD over the V044 semantic-layer columns on
// authz_resource (business_term / definition / formula /
// owner_subject_id / status / blessed_at / blessed_by).
//
// Mounted under requireRole('DATA_STEWARD') in index.ts (V083 curator
// surface under Govern) — every route here assumes the caller is already
// a steward (or SYSADMIN via god-mode bypass).
//
// Transition endpoint is the only path that touches
// status/blessed_at/blessed_by, to keep V044 invariants
// (constraint authz_resource_blessed_fields_check) centralized.
//
// Plan: .claude/plans/v3-phase-1/tier-a-business-term-admin-plan.md
// Schema: V044__authz_resource_business_term.sql
// ============================================================

import { Router } from 'express';
import { pool } from '../db';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';
import { logAdminAction } from '../lib/admin-audit';

export const businessTermRouter = Router();

const STATUS_VALUES = ['draft', 'under_review', 'blessed', 'deprecated'] as const;
type Status = typeof STATUS_VALUES[number];

const SELECT_COLS = `
  resource_id, business_term, definition, formula, owner_subject_id,
  status, blessed_at, blessed_by, created_at, updated_at
`;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

// GET /api/business-term?status=
businessTermRouter.get('/', async (req, res) => {
  const status = req.query.status as string | undefined;
  try {
    const params: unknown[] = [];
    let where = 'business_term IS NOT NULL OR status IS NOT NULL';
    if (status) {
      if (!(STATUS_VALUES as readonly string[]).includes(status)) {
        res.status(400).json({ error: `status must be one of ${STATUS_VALUES.join('/')}` });
        return;
      }
      params.push(status);
      where = `status = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT ${SELECT_COLS}
         FROM authz_resource
        WHERE ${where}
        ORDER BY status NULLS LAST, business_term NULLS LAST, resource_id
        LIMIT 500`,
      params
    );
    res.json({ rows: r.rows });
  } catch (err) { handleApiError(res, err); }
});

// GET /api/business-term/:resource_id
businessTermRouter.get('/:resource_id', async (req, res) => {
  const { resource_id } = req.params;
  try {
    const r = await pool.query(
      `SELECT ${SELECT_COLS} FROM authz_resource WHERE resource_id = $1`,
      [resource_id]
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ row: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});

// PATCH /api/business-term/:resource_id
//   body: { business_term?, definition?, formula?, owner_subject_id? }
//   Does NOT change status — use /transition for that.
businessTermRouter.patch('/:resource_id', async (req, res) => {
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const { resource_id } = req.params;
  const { business_term, definition, formula, owner_subject_id } = req.body || {};

  if (business_term !== undefined && business_term !== null) {
    if (!isStr(business_term) || business_term.trim().length === 0 || business_term.length > 200) {
      res.status(400).json({ error: 'business_term must be 1-200 chars' });
      return;
    }
  }
  if (definition !== undefined && definition !== null) {
    if (!isStr(definition) || definition.length > 4000) {
      res.status(400).json({ error: 'definition must be ≤ 4000 chars' });
      return;
    }
  }
  if (formula !== undefined && formula !== null) {
    if (!isStr(formula) || formula.length > 4000) {
      res.status(400).json({ error: 'formula must be ≤ 4000 chars' });
      return;
    }
  }
  if (owner_subject_id !== undefined && owner_subject_id !== null) {
    if (!isStr(owner_subject_id) || owner_subject_id.trim().length === 0) {
      res.status(400).json({ error: 'owner_subject_id must be non-empty string or null' });
      return;
    }
  }

  // Build dynamic SET clause — only include fields the caller sent.
  const sets: string[] = [];
  const params: unknown[] = [resource_id];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (business_term !== undefined)    push('business_term', business_term);
  if (definition !== undefined)       push('definition', definition);
  if (formula !== undefined)          push('formula', formula);
  if (owner_subject_id !== undefined) push('owner_subject_id', owner_subject_id);

  if (sets.length === 0) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }

  try {
    const r = await pool.query(
      `UPDATE authz_resource
          SET ${sets.join(', ')}, updated_at = now()
        WHERE resource_id = $1
        RETURNING ${SELECT_COLS}`,
      params
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    void logAdminAction(pool, {
      userId,
      action: 'tier_a_business_term_update',
      resourceType: 'authz_resource',
      resourceId: resource_id,
      details: {
        fields: sets.map(s => s.split(' = ')[0]),
      },
      ip,
    });

    res.json({ row: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});

// POST /api/business-term/:resource_id/transition
//   body: { status: 'draft' | 'under_review' | 'blessed' | 'deprecated' }
//
// V044 invariants (constraint authz_resource_blessed_fields_check):
//   - blessed                  → blessed_at + blessed_by NOT NULL
//   - draft / under_review     → blessed_at + blessed_by MUST be NULL
//   - deprecated               → bless fields free (preserved as audit)
//
// Bless requires business_term to be set on the row.
businessTermRouter.post('/:resource_id/transition', async (req, res) => {
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const { resource_id } = req.params;
  const { status } = req.body || {};

  if (!status || !(STATUS_VALUES as readonly string[]).includes(status)) {
    res.status(400).json({ error: `status must be one of ${STATUS_VALUES.join('/')}` });
    return;
  }
  const target = status as Status;

  try {
    // Pre-flight: row must exist; bless requires business_term set.
    const cur = await pool.query(
      `SELECT ${SELECT_COLS} FROM authz_resource WHERE resource_id = $1`,
      [resource_id]
    );
    if (cur.rowCount === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const row = cur.rows[0];

    if (target === 'blessed' && !row.business_term) {
      res.status(422).json({ error: 'business_term required for bless' });
      return;
    }

    // Apply bless-field rule per target. Centralized here so the constraint
    // never fires from the dashboard — server is the only writer of these
    // three columns post-V044.
    //
    // blessed_by FK references authz_subject(subject_id), which uses
    // 'user:'-prefixed canonical form (per _authz_resolve_roles). X-User-Id
    // arrives bare (e.g. 'sys_admin'), so canonicalize before INSERT.
    const blessedBy = userId.includes(':') ? userId : `user:${userId}`;
    let sql: string;
    let params: unknown[];
    if (target === 'blessed') {
      sql = `UPDATE authz_resource
                SET status = $2,
                    blessed_at = now(),
                    blessed_by = $3,
                    updated_at = now()
              WHERE resource_id = $1
              RETURNING ${SELECT_COLS}`;
      params = [resource_id, target, blessedBy];
    } else if (target === 'deprecated') {
      // Preserve blessed_at/blessed_by as audit history.
      sql = `UPDATE authz_resource
                SET status = $2, updated_at = now()
              WHERE resource_id = $1
              RETURNING ${SELECT_COLS}`;
      params = [resource_id, target];
    } else {
      // draft | under_review → bless fields MUST be NULL
      sql = `UPDATE authz_resource
                SET status = $2,
                    blessed_at = NULL,
                    blessed_by = NULL,
                    updated_at = now()
              WHERE resource_id = $1
              RETURNING ${SELECT_COLS}`;
      params = [resource_id, target];
    }

    const r = await pool.query(sql, params);

    void logAdminAction(pool, {
      userId,
      action: `tier_a_business_term_transition_${target}`,
      resourceType: 'authz_resource',
      resourceId: resource_id,
      details: {
        from_status: row.status,
        to_status: target,
        business_term: row.business_term,
      },
      ip,
    });

    res.json({ row: r.rows[0] });
  } catch (err) { handleApiError(res, err); }
});
