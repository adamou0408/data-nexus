// ============================================================
// /api/workflow/* — runtime for authz_composite_action.
//
// Pairs with V075 (workflow_request + workflow_approval_record)
// and V076 (npi_advance_* composite_actions). Workflow gating is
// layered ON TOP of authz_check — a request is only ACCEPTED if
// authz_check(actor, target_action, target_resource) passes, and
// only the role expected at the next chain step may record a
// decision.
//
// On final approve, lifecycle_instance is upserted to advance
// (lifecycle_id, subject_id) → preconditions.to_state. Lifecycle
// state is NOT read by authz_check; it sits beside the permission
// graph, not inside it.
// ============================================================
import { Router } from 'express';
import { pool } from '../db';
import { audit } from '../audit';
import { handleApiError, getUserId } from '../lib/request-helpers';
import { requireAuth } from '../middleware/authz';

export const workflowRouter = Router();

workflowRouter.use(requireAuth);

type ChainStep = { step: number; role: string; label?: string };

// ------------------------------------------------------------
// POST /api/workflow/request
//   Body: { policy_name, subject_id, request_reason?, request_payload? }
//   1. Resolve composite_action by policy_name.
//   2. authz_check(actor, target_action, target_resource).
//   3. INSERT authz_workflow_request with expires_at = now() + timeout_hours.
// ------------------------------------------------------------
workflowRouter.post('/request', async (req, res) => {
  const { policy_name, subject_id, request_reason, request_payload } = req.body;
  if (!policy_name || !subject_id) {
    return res.status(400).json({ error: 'policy_name and subject_id are required' });
  }
  const actor = getUserId(req);
  const groups = (req as any).authzUser?.groups ?? [];

  try {
    const ca = await pool.query(
      `SELECT id, target_action, target_resource, approval_chain, preconditions, timeout_hours
         FROM authz_composite_action
        WHERE policy_name = $1 AND status = 'active'`,
      [policy_name]
    );
    if (ca.rowCount === 0) {
      return res.status(404).json({ error: `composite_action ${policy_name} not found or inactive` });
    }
    const action = ca.rows[0];

    const allowed = (await pool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [actor, groups, action.target_action, action.target_resource]
    )).rows[0].allowed;

    audit({
      access_path: 'A',
      subject_id: actor,
      action_id: action.target_action,
      resource_id: action.target_resource,
      decision: allowed ? 'allow' : 'deny',
      context: { workflow_op: 'request', policy_name, subject_id },
    });

    if (!allowed) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: `${actor} lacks ${action.target_action} on ${action.target_resource}`,
      });
    }

    const ins = await pool.query(
      `INSERT INTO authz_workflow_request
         (composite_action_id, subject_id, requested_by, request_reason, request_payload, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now() + ($6 || ' hours')::interval)
       RETURNING request_id, requested_at, expires_at, status`,
      [action.id, subject_id, actor, request_reason ?? null,
       JSON.stringify(request_payload ?? {}), String(action.timeout_hours)]
    );

    res.status(201).json({
      ...ins.rows[0],
      composite_action: policy_name,
      approval_chain: action.approval_chain,
      preconditions: action.preconditions,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ------------------------------------------------------------
// GET /api/workflow/pending
//   Optional ?policy_name=... or ?subject_id=... filter.
//   Lists requests with status='pending', plus the next expected
//   chain step (so the inbox can show "PE needed" / "QA needed").
// ------------------------------------------------------------
workflowRouter.get('/pending', async (req, res) => {
  const { policy_name, subject_id } = req.query as Record<string, string | undefined>;
  try {
    const result = await pool.query(
      `SELECT r.request_id,
              r.subject_id,
              r.requested_by,
              r.requested_at,
              r.expires_at,
              r.request_reason,
              ca.policy_name,
              ca.approval_chain,
              ca.preconditions,
              COALESCE((SELECT COUNT(*)::int
                          FROM authz_workflow_approval_record
                         WHERE request_id = r.request_id
                           AND decision = 'approve'), 0) AS approvals_recorded
         FROM authz_workflow_request r
         JOIN authz_composite_action ca ON ca.id = r.composite_action_id
        WHERE r.status = 'pending'
          AND ($1::text IS NULL OR ca.policy_name = $1)
          AND ($2::text IS NULL OR r.subject_id = $2)
        ORDER BY r.requested_at DESC`,
      [policy_name ?? null, subject_id ?? null]
    );

    const rows = result.rows.map((row: any) => {
      const chain: ChainStep[] = row.approval_chain || [];
      const nextStep = chain[row.approvals_recorded] ?? null;
      return { ...row, next_step: nextStep };
    });
    res.json(rows);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ------------------------------------------------------------
// GET /api/workflow/:id
//   Full view of one request: chain spec + every recorded decision.
// ------------------------------------------------------------
workflowRouter.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.*, ca.policy_name, ca.approval_chain, ca.preconditions
         FROM authz_workflow_request r
         JOIN authz_composite_action ca ON ca.id = r.composite_action_id
        WHERE r.request_id = $1`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'request not found' });

    const records = await pool.query(
      `SELECT chain_step, expected_role, actor, decision, decided_at, note, dogfood_self_chained
         FROM authz_workflow_approval_record
        WHERE request_id = $1
        ORDER BY chain_step ASC`,
      [req.params.id]
    );

    res.json({ ...r.rows[0], records: records.rows });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ------------------------------------------------------------
// POST /api/workflow/:id/approve  body: { note? }
// POST /api/workflow/:id/reject   body: { note? }
//
// Both share the same load-and-gate path:
//   - request must be status='pending' and not expired
//   - next chain_step is derived from current approve-record count
//   - actor's resolved roles must include approval_chain[step].role
//   - authz_check(actor, target_action, target_resource) must pass
// On final approve: request → 'approved' AND lifecycle_instance
// upserted to preconditions.to_state.
// On reject (any step): request → 'rejected', no lifecycle change.
// ------------------------------------------------------------
async function recordDecision(
  req: any,
  res: any,
  decision: 'approve' | 'reject',
) {
  const { note } = req.body ?? {};
  const actor = getUserId(req);
  const groups = (req as any).authzUser?.groups ?? [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT r.request_id, r.composite_action_id, r.subject_id, r.requested_by,
              r.status, r.expires_at,
              ca.policy_name, ca.target_action, ca.target_resource,
              ca.approval_chain, ca.preconditions
         FROM authz_workflow_request r
         JOIN authz_composite_action ca ON ca.id = r.composite_action_id
        WHERE r.request_id = $1
        FOR UPDATE OF r`,
      [req.params.id]
    );
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'request not found' });
    }
    const wf = r.rows[0];

    if (wf.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `request is ${wf.status}, not pending` });
    }
    if (wf.expires_at && new Date(wf.expires_at) < new Date()) {
      await client.query(
        `UPDATE authz_workflow_request
            SET status = 'expired', resolved_at = now(), updated_at = now(),
                resolution_reason = 'auto-expired on decision attempt'
          WHERE request_id = $1`,
        [wf.request_id]
      );
      await client.query('COMMIT');
      return res.status(409).json({ error: 'request has expired' });
    }

    const approvedSoFar = (await client.query(
      `SELECT COUNT(*)::int AS n
         FROM authz_workflow_approval_record
        WHERE request_id = $1 AND decision = 'approve'`,
      [wf.request_id]
    )).rows[0].n;

    const chain: ChainStep[] = wf.approval_chain || [];
    const stepIdx = approvedSoFar;
    const expected = chain[stepIdx];
    if (!expected) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'chain already complete' });
    }

    const roleCheck = await client.query(
      'SELECT _authz_resolve_roles($1, $2) AS roles',
      [actor, groups]
    );
    const userRoles: string[] = roleCheck.rows[0].roles || [];
    const isSysadmin = userRoles.includes('SYSADMIN');
    if (!isSysadmin && !userRoles.includes(expected.role)) {
      await client.query('ROLLBACK');
      audit({
        access_path: 'A',
        subject_id: actor,
        action_id: wf.target_action,
        resource_id: wf.target_resource,
        decision: 'deny',
        context: {
          workflow_op: decision,
          reason: 'role_mismatch',
          expected_role: expected.role,
          actor_roles: userRoles,
          request_id: wf.request_id,
        },
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: `step ${stepIdx} expects role ${expected.role}; ${actor} has [${userRoles.join(', ')}]`,
      });
    }

    const allowed = (await client.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [actor, groups, wf.target_action, wf.target_resource]
    )).rows[0].allowed;
    if (!allowed) {
      await client.query('ROLLBACK');
      audit({
        access_path: 'A',
        subject_id: actor,
        action_id: wf.target_action,
        resource_id: wf.target_resource,
        decision: 'deny',
        context: { workflow_op: decision, reason: 'authz_check_failed', request_id: wf.request_id },
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: `${actor} lacks ${wf.target_action} on ${wf.target_resource}`,
      });
    }

    const dogfoodSelf = actor === wf.requested_by;

    const inserted = await client.query(
      `INSERT INTO authz_workflow_approval_record
         (request_id, chain_step, expected_role, actor, decision, note, dogfood_self_chained)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING record_id, decided_at`,
      [wf.request_id, stepIdx, expected.role, actor, decision, note ?? null, dogfoodSelf]
    );

    let lifecycleAdvanced: { lifecycle_id: string; from: string; to: string } | null = null;

    if (decision === 'reject') {
      await client.query(
        `UPDATE authz_workflow_request
            SET status = 'rejected', resolved_at = now(), updated_at = now(),
                resolution_reason = $2
          WHERE request_id = $1`,
        [wf.request_id, note ?? `rejected by ${actor} at step ${stepIdx}`]
      );
    } else if (stepIdx + 1 >= chain.length) {
      // final approve — close the request and advance lifecycle
      await client.query(
        `UPDATE authz_workflow_request
            SET status = 'approved', resolved_at = now(), updated_at = now(),
                resolution_reason = 'all chain steps approved'
          WHERE request_id = $1`,
        [wf.request_id]
      );

      const fromState = wf.preconditions?.from_state;
      const toState = wf.preconditions?.to_state;
      if (fromState && toState) {
        // Resolve the lifecycle that owns this transition. We pick the
        // lifecycle whose entity_kind matches the target_resource and
        // whose transitions JSONB contains a matching {from,to}.
        const lc = await client.query(
          `SELECT ld.lifecycle_id
             FROM authz_lifecycle_definition ld
             JOIN authz_resource ar ON ar.entity_kind = ld.entity_kind
            WHERE ar.resource_id = $1
              AND ld.is_active = TRUE
              AND ld.transitions @> $2::jsonb
            LIMIT 1`,
          [wf.target_resource, JSON.stringify([{ from: fromState, to: toState }])]
        );
        if (lc.rowCount && lc.rows[0].lifecycle_id) {
          const lifecycleId = lc.rows[0].lifecycle_id;
          await client.query(
            `INSERT INTO authz_lifecycle_instance
               (lifecycle_id, entity_kind, subject_id, current_state, last_actor, last_action)
             SELECT $1, ld.entity_kind, $2, $3, $4, $5
               FROM authz_lifecycle_definition ld
              WHERE ld.lifecycle_id = $1
             ON CONFLICT (lifecycle_id, subject_id) DO UPDATE
                SET current_state = EXCLUDED.current_state,
                    entered_at    = now(),
                    last_actor    = EXCLUDED.last_actor,
                    last_action   = EXCLUDED.last_action,
                    updated_at    = now()`,
            [lifecycleId, wf.subject_id, toState, actor, wf.policy_name]
          );
          lifecycleAdvanced = { lifecycle_id: lifecycleId, from: fromState, to: toState };
        }
      }
    }

    await client.query('COMMIT');

    audit({
      access_path: 'A',
      subject_id: actor,
      action_id: wf.target_action,
      resource_id: wf.target_resource,
      decision: 'allow',
      context: {
        workflow_op: decision,
        request_id: wf.request_id,
        chain_step: stepIdx,
        expected_role: expected.role,
        dogfood_self_chained: dogfoodSelf,
        lifecycle_advanced: lifecycleAdvanced,
      },
    });

    res.json({
      record_id: inserted.rows[0].record_id,
      decided_at: inserted.rows[0].decided_at,
      chain_step: stepIdx,
      expected_role: expected.role,
      dogfood_self_chained: dogfoodSelf,
      request_status:
        decision === 'reject'
          ? 'rejected'
          : stepIdx + 1 >= chain.length
          ? 'approved'
          : 'pending',
      lifecycle_advanced: lifecycleAdvanced,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleApiError(res, err);
  } finally {
    client.release();
  }
}

workflowRouter.post('/:id/approve', (req, res) => recordDecision(req, res, 'approve'));
workflowRouter.post('/:id/reject',  (req, res) => recordDecision(req, res, 'reject'));
