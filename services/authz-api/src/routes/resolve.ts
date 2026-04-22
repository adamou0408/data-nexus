import { Router } from 'express';
import { pool } from '../db';
import { audit } from '../audit';
import { isAdminUser, handleApiError } from '../lib/request-helpers';
import * as policyCache from '../lib/policy-cache';

export const resolveRouter = Router();

// SEC-01: Strip server-side implementation details before sending to client.
// PG function authz_resolve() is SSOT — returns full config.
// Sanitization happens at API boundary (single endpoint, role-aware depth).
function sanitizeForClient(config: any): any {
  const safe = JSON.parse(JSON.stringify(config));
  // L1: strip rls_expression and subject_condition (expose SQL WHERE to client)
  if (safe.L1_data_scope) {
    for (const name of Object.keys(safe.L1_data_scope)) {
      const policy = safe.L1_data_scope[name];
      safe.L1_data_scope[name] = {
        has_rls: !!policy.rls_expression,
        resource_condition: policy.resource_condition,
      };
    }
  }
  // L2: strip function name (expose PG mask function names to client)
  if (safe.L2_column_masks) {
    for (const name of Object.keys(safe.L2_column_masks)) {
      const cols = safe.L2_column_masks[name];
      for (const col of Object.keys(cols)) {
        cols[col] = { mask_type: cols[col].mask_type };
      }
    }
  }
  return safe;
}


// Path A: Config-SM resolve
// Single endpoint — returns sanitized config for non-admin, full config for admin.
// When _detailed=true is requested, admin role is verified before returning full output.
resolveRouter.post('/', async (req, res) => {
  const { user_id, groups = [], attributes = {}, _detailed = false } = req.body;
  try {
    // FEAT-01: cache stores raw authz_resolve() output. Sanitization stays
    // at the API boundary so the same cached entry can serve admin (full)
    // and non-admin (sanitized) responses.
    const cacheKey = policyCache.makeKey(user_id, groups, attributes);
    let fullConfig = policyCache.get(cacheKey) as any;
    if (fullConfig === undefined) {
      const result = await pool.query(
        'SELECT authz_resolve($1, $2, $3) AS config',
        [user_id, groups, JSON.stringify(attributes)]
      );
      fullConfig = result.rows[0].config;
      policyCache.set(cacheKey, fullConfig);
    }

    audit({
      access_path: 'A', subject_id: `user:${user_id}`,
      action_id: 'resolve', resource_id: '*', decision: 'allow',
      context: { groups, attributes },
    });

    // Role-based output depth: admin with _detailed gets full config
    if (_detailed) {
      const admin = await isAdminUser(pool, user_id, groups);
      if (admin) {
        return res.json(fullConfig);
      }
    }

    // Non-admin or no _detailed flag: sanitize
    res.json(sanitizeForClient(fullConfig));
  } catch (err) {
    handleApiError(res, err);
  }
});

// FEAT-01: cache observability — admin-only counters, no PII
resolveRouter.get('/_cache-stats', async (req, res) => {
  const userId = (req.header('X-User-Id') || '').trim();
  const groups = (req.header('X-User-Groups') || '').split(',').map(g => g.trim()).filter(Boolean);
  if (!userId) return res.status(401).json({ error: 'X-User-Id required' });
  try {
    const admin = await isAdminUser(pool, userId, groups);
    if (!admin) return res.status(403).json({ error: 'admin only' });
    res.json(policyCache.getStats());
  } catch (err) {
    handleApiError(res, err);
  }
});

// Path B: Web ACL resolve
resolveRouter.post('/web-acl', async (req, res) => {
  const { user_id, groups = [] } = req.body;
  try {
    const result = await pool.query(
      'SELECT authz_resolve_web_acl($1, $2) AS config',
      [user_id, groups]
    );
    audit({
      access_path: 'B', subject_id: `user:${user_id}`,
      action_id: 'resolve_web_acl', resource_id: '*', decision: 'allow',
      context: { groups },
    });
    res.json(result.rows[0].config);
  } catch (err) {
    handleApiError(res, err);
  }
});
