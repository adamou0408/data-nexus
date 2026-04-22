import { Router, Request } from 'express';
import { pool } from '../db';
import { getUserId, handleApiError } from '../lib/request-helpers';
import { logAdminAction } from '../lib/admin-audit';
import { requireRole } from '../middleware/authz';

export const modulesRouter = Router();

/** Refresh module_tree_stats materialized view after mutations */
async function refreshModuleStats(): Promise<void> {
  try {
    await pool.query('SELECT refresh_module_tree_stats()');
  } catch (err) {
    console.warn('[modules] Failed to refresh module_tree_stats:', err);
  }
}

/** Extract resolved authz user from middleware-populated request */
function getAuthzUser(req: Request): { user_id: string; groups: string[] } {
  const authzUser = (req as any).authzUser;
  return authzUser || { user_id: getUserId(req), groups: [] };
}

/** Resolve if user has admin role (cached on request after first call) */
async function isAdminRequest(req: Request): Promise<boolean> {
  if ((req as any)._isAdmin !== undefined) return (req as any)._isAdmin;
  const { user_id, groups } = getAuthzUser(req);
  try {
    const result = await pool.query(
      'SELECT _authz_resolve_roles($1, $2) AS roles',
      [user_id, groups]
    );
    const roles: string[] = result.rows[0]?.roles || [];
    const isAdmin = roles.some(r => r === 'ADMIN' || r === 'AUTHZ_ADMIN');
    (req as any)._isAdmin = isAdmin;
    (req as any).authzRoles = roles;
    return isAdmin;
  } catch { return false; }
}

// GET /api/modules/tree — permission-filtered module tree
// Returns only modules the user can 'read', with effective actions per node
modulesRouter.get('/tree', async (req, res) => {
  const { user_id, groups } = getAuthzUser(req);
  const isAdmin = await isAdminRequest(req);

  try {
    // Fetch from materialized view (V034) — O(1) vs N×3 correlated subqueries
    const result = await pool.query(`
      SELECT resource_id, display_name, parent_id, attributes, is_active,
             child_module_count, table_count, column_count
      FROM module_tree_stats
      ORDER BY parent_id NULLS FIRST, display_name
    `);

    // Admin sees everything; non-admin: filter by authz_check per module
    if (isAdmin) {
      res.json(result.rows.map(r => ({
        ...r,
        child_module_count: Number(r.child_module_count),
        table_count: Number(r.table_count),
        column_count: Number(r.column_count),
        user_actions: ['read', 'write', 'admin'], // Admin has all
      })));
      return;
    }

    // Non-admin: batch check permissions for all modules using L3 fast path.
    // authz_check_batch() reads resource_ancestors mat view → one JOIN per action
    // instead of N recursive CTE walks. ~3-4x faster for 25 modules.
    const actionChecks = ['read', 'write'];
    const moduleIds = result.rows.map(r => r.resource_id);

    // permMap: module_id → actions[]
    const permMap = new Map<string, string[]>();
    for (const action of actionChecks) {
      const checks = await pool.query(
        `SELECT resource_id, allowed FROM authz_check_batch($1, $2, $3, $4)`,
        [user_id, groups, action, moduleIds]
      );
      for (const row of checks.rows) {
        if (row.allowed) {
          const existing = permMap.get(row.resource_id) || [];
          existing.push(action);
          permMap.set(row.resource_id, existing);
        }
      }
    }

    // Filter: only include modules the user can read
    // Also include parent modules of accessible children (for tree navigation)
    const accessibleIds = new Set(permMap.keys());
    // Walk up parent chain for each accessible module to ensure tree connectivity
    const nodeMap = new Map(result.rows.map(r => [r.resource_id, r]));
    for (const id of [...accessibleIds]) {
      let current = nodeMap.get(id);
      while (current?.parent_id && nodeMap.has(current.parent_id)) {
        accessibleIds.add(current.parent_id);
        current = nodeMap.get(current.parent_id);
      }
    }

    const filtered = result.rows
      .filter(r => accessibleIds.has(r.resource_id))
      .map(r => ({
        ...r,
        child_module_count: Number(r.child_module_count),
        table_count: Number(r.table_count),
        column_count: Number(r.column_count),
        user_actions: permMap.get(r.resource_id) || [],
      }));

    res.json(filtered);
  } catch (err) { handleApiError(res, err); }
});

// GET /api/modules/descriptors — UI metadata for module detail sub-tabs
// Returns section definitions (tabs, columns, render hints) from DB
modulesRouter.get('/descriptors', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT fn_ui_descriptors('modules_home') AS descriptors`
    );
    res.json(result.rows[0]?.descriptors || []);
  } catch (err) { handleApiError(res, err); }
});

// GET /api/modules/:id/details — single module with children, access, profiles
// Includes user's permission context for conditional UI rendering
modulesRouter.get('/:id/details', async (req, res) => {
  const moduleId = req.params.id;
  const { user_id, groups } = getAuthzUser(req);
  const isAdmin = await isAdminRequest(req);

  try {
    // Permission gate: user must have 'read' on this module (or be admin)
    if (!isAdmin) {
      const checkResult = await pool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [user_id, groups, 'read', moduleId]
      );
      if (!checkResult.rows[0]?.allowed) {
        return res.status(403).json({ error: 'No read access to this module' });
      }
    }

    // Module itself
    const modResult = await pool.query(
      `SELECT resource_id, display_name, parent_id, attributes
       FROM authz_resource WHERE resource_id = $1 AND resource_type = 'module'`,
      [moduleId]
    );
    if (modResult.rows.length === 0) {
      return res.status(404).json({ error: 'Module not found' });
    }

    // Child modules with table counts
    const childModules = await pool.query(`
      SELECT r.resource_id, r.display_name,
        (SELECT count(*) FROM authz_resource c
         WHERE c.parent_id = r.resource_id AND c.resource_type IN ('table','view') AND c.is_active) AS table_count
      FROM authz_resource r
      WHERE r.parent_id = $1 AND r.resource_type = 'module' AND r.is_active = TRUE
      ORDER BY r.display_name
    `, [moduleId]);

    // Direct child tables/views with column count and data_source_id
    const childTables = await pool.query(`
      SELECT r.resource_id, r.display_name, r.resource_type,
        r.attributes->>'data_source_id' AS data_source_id,
        (SELECT count(*) FROM authz_resource c
         WHERE c.parent_id = r.resource_id AND c.resource_type = 'column' AND c.is_active) AS column_count
      FROM authz_resource r
      WHERE r.parent_id = $1 AND r.resource_type IN ('table','view') AND r.is_active = TRUE
      ORDER BY r.resource_type, r.display_name
    `, [moduleId]);

    // Direct child functions with schema (parsed from resource_id) + data_source_id
    const childFunctions = await pool.query(`
      SELECT r.resource_id, r.display_name,
        r.attributes->>'data_source_id' AS data_source_id,
        split_part(substring(r.resource_id from 10), '.', 1) AS schema
      FROM authz_resource r
      WHERE r.parent_id = $1 AND r.resource_type = 'function' AND r.is_active = TRUE
      ORDER BY r.display_name
    `, [moduleId]);

    // Access summary: which roles have permissions on this module
    const access = await pool.query(`
      SELECT rp.role_id, ro.display_name AS role_name, rp.action_id, rp.effect
      FROM authz_role_permission rp
      JOIN authz_role ro ON ro.role_id = rp.role_id AND ro.is_active = TRUE
      WHERE rp.resource_id = $1 AND rp.is_active = TRUE
      ORDER BY rp.role_id, rp.action_id
    `, [moduleId]);

    // Pool profiles referencing this module
    const profiles = await pool.query(`
      SELECT profile_id, pg_role, connection_mode, data_source_id
      FROM authz_db_pool_profile
      WHERE is_active = TRUE AND allowed_modules @> ARRAY[$1]
    `, [moduleId]);

    // Group access by role
    const accessByRole: Record<string, { role_id: string; role_name: string; actions: { action_id: string; effect: string }[] }> = {};
    for (const row of access.rows) {
      if (!accessByRole[row.role_id]) {
        accessByRole[row.role_id] = { role_id: row.role_id, role_name: row.role_name, actions: [] };
      }
      accessByRole[row.role_id].actions.push({ action_id: row.action_id, effect: row.effect });
    }

    // User's effective permissions on this module (L3 fast path)
    // One query per action against authz_check_batch (uses resource_ancestors mat view)
    const userActions: string[] = [];
    if (isAdmin) {
      userActions.push('read', 'write', 'admin');
    } else {
      const actions = ['read', 'write', 'approve', 'export', 'connect'];
      const checks = await Promise.all(actions.map(action =>
        pool.query(
          `SELECT allowed FROM authz_check_batch($1, $2, $3, $4) LIMIT 1`,
          [user_id, groups, action, [moduleId]]
        )
      ));
      checks.forEach((r, i) => {
        if (r.rows[0]?.allowed) userActions.push(actions[i]);
      });
    }

    res.json({
      module: modResult.rows[0],
      children: {
        modules: childModules.rows.map(r => ({ ...r, table_count: Number(r.table_count) })),
        tables: childTables.rows.map(r => ({ ...r, column_count: Number(r.column_count) })),
        functions: childFunctions.rows,
      },
      access: Object.values(accessByRole),
      profiles: profiles.rows,
      user_permissions: {
        actions: userActions,
        is_admin: isAdmin,
      },
    });
  } catch (err) { handleApiError(res, err); }
});

// DELETE /api/modules/:id — admin-only enhanced delete with cascade
// Protected by requireRole middleware (mounted in index.ts for write operations)
modulesRouter.delete('/:id', requireRole('ADMIN', 'AUTHZ_ADMIN'), async (req, res) => {
  const moduleId = req.params.id;
  const cascade = req.body?.cascade === true;
  const userId = getUserId(req);

  try {
    // Check module exists
    const modResult = await pool.query(
      `SELECT resource_id, parent_id FROM authz_resource WHERE resource_id = $1 AND resource_type = 'module' AND is_active = TRUE`,
      [moduleId]
    );
    if (modResult.rows.length === 0) {
      return res.status(404).json({ error: 'Module not found' });
    }
    const parentId = modResult.rows[0].parent_id;

    // Check for children (modules + tables)
    const children = await pool.query(
      `SELECT resource_id, resource_type FROM authz_resource WHERE parent_id = $1 AND is_active = TRUE`,
      [moduleId]
    );

    if (children.rows.length > 0 && !cascade) {
      return res.status(400).json({
        error: 'Module has children',
        detail: `${children.rows.length} child resources exist. Use cascade=true to reassign them to parent.`,
        children: children.rows,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (children.rows.length > 0 && cascade) {
        await client.query(
          `UPDATE authz_resource SET parent_id = $1 WHERE parent_id = $2 AND is_active = TRUE`,
          [parentId, moduleId]
        );
      }

      await client.query(
        `UPDATE authz_resource SET is_active = FALSE WHERE resource_id = $1`,
        [moduleId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await logAdminAction(pool, {
      userId,
      action: 'DELETE_MODULE',
      resourceType: 'module',
      resourceId: moduleId,
      details: { cascade, children_reassigned: cascade ? children.rows.length : 0 },
    });

    // Refresh materialized view after mutation
    await refreshModuleStats();

    res.json({
      deleted: moduleId,
      cascade,
      children_reassigned: cascade ? children.rows.length : 0,
      new_parent: cascade ? parentId : null,
    });
  } catch (err) { handleApiError(res, err); }
});
