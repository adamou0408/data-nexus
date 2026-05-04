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
    // V083: "admin" view of module tree = anyone who can curate it.
    const isAdmin = roles.some(r => r === 'SYSADMIN' || r === 'AUTHZ_ADMIN' || r === 'DATA_STEWARD');
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

    // V081: Direct child pages (sink-as-authz_resource Tier B artifacts).
    // page_id stripped from resource_id ('page:<id>' → '<id>') so frontend
    // can dispatch open-auto-page directly without re-parsing.
    //
    // PUB-PAGES-ADMIN-V01 Part C: LEFT JOIN authz_ui_page so we can ORDER BY
    // display_order ASC (then fall back to display_name when 0/equal). The
    // ui_page row also gives us the canonical title (Edit dialog can update
    // it without going through authz_resource), and we expose has_dag so the
    // admin form picker only shows on rows the curator can republish.
    const childPages = await pool.query(`
      SELECT r.resource_id, r.display_name,
        r.attributes->>'page_id' AS page_id,
        r.attributes->>'dag_id'  AS dag_id,
        r.attributes->>'node_id' AS node_id,
        COALESCE(p.display_order, 0) AS display_order,
        (p.published_dag_id IS NOT NULL) AS has_dag
      FROM authz_resource r
      LEFT JOIN authz_ui_page p
             ON p.page_id = r.attributes->>'page_id'
            AND p.is_active = TRUE
      WHERE r.parent_id = $1 AND r.resource_type = 'page' AND r.is_active = TRUE
      ORDER BY COALESCE(p.display_order, 0), r.display_name
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
      const actions = ['read', 'write', 'execute', 'approve', 'export', 'connect'];
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
        pages: childPages.rows,
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

// DELETE /api/modules/:id — DATA_STEWARD-only (V083 Catalog Modules)
// Protected by requireRole middleware (mounted in index.ts for write operations)
modulesRouter.delete('/:id', requireRole('DATA_STEWARD'), async (req, res) => {
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

// PATCH /api/modules/pages/:page_id — rename / move a Tier B page (TIER-B-PAGE-RENAME-V01)
//
// What's mutable:
//   - display_name  → renames the page (mirrored to authz_ui_page.title for SSOT)
//   - parent_id     → moves the page to a different module in the catalog tree
//                     (authz_resource.parent_id only; we do NOT touch
//                     authz_ui_page.parent_page_id, which is the legacy
//                     renderer's drilldown wiring and not a curator concern)
//
// What's immutable on purpose:
//   - page_id — external refs (URLs, drilldowns, custom pages, deep links from
//     other apps) all key off page_id. Changing it would silently break those.
//     If a curator needs a "rename" that updates the URL too, the right answer
//     is delete + recreate, not in-place ID mutation.
//
// Both fields are optional; an empty body is rejected to avoid silent no-ops.
modulesRouter.patch('/pages/:page_id', requireRole('DATA_STEWARD'), async (req, res) => {
  const pageId = req.params.page_id;
  const userId = getUserId(req);
  const { display_name, parent_id, description, display_order } = (req.body || {}) as {
    display_name?: unknown;
    parent_id?: unknown;
    // PUB-PAGES-ADMIN-V01 Part B: free-form catalog metadata (Pages tab edit dialog).
    description?: unknown;
    // PUB-PAGES-ADMIN-V01 Part C: ordering inside parent module (V022:25 column).
    display_order?: unknown;
  };

  const willRename = typeof display_name === 'string' && display_name.trim().length > 0;
  const willMove = parent_id !== undefined; // null = move to root explicitly
  const willDescribe = description !== undefined; // null/'' = clear
  const willOrder = display_order !== undefined;

  if (!willRename && !willMove && !willDescribe && !willOrder) {
    return res.status(400).json({
      error: 'No change',
      detail: 'Provide display_name, parent_id, description, and/or display_order.',
    });
  }
  if (willMove && parent_id !== null && (typeof parent_id !== 'string' || !parent_id.startsWith('module:'))) {
    return res.status(400).json({ error: 'Invalid parent_id', detail: 'parent_id must be a module: resource or null.' });
  }
  if (willDescribe && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'Invalid description', detail: 'description must be a string or null.' });
  }
  if (willOrder && (typeof display_order !== 'number' || !Number.isInteger(display_order))) {
    return res.status(400).json({ error: 'Invalid display_order', detail: 'display_order must be an integer.' });
  }

  const resourceId = `page:${pageId}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify the page exists. We lock the row so the dual-write below cannot
    // race with a concurrent sink upsert that re-emits the same page.
    const existing = await client.query(
      `SELECT resource_id, display_name, parent_id
         FROM authz_resource
        WHERE resource_id = $1 AND resource_type = 'page' AND is_active = TRUE
        FOR UPDATE`,
      [resourceId]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Page not found' });
    }

    // If moving, verify the target parent is an active module.
    if (willMove && parent_id !== null) {
      const parentCheck = await client.query(
        `SELECT 1 FROM authz_resource WHERE resource_id = $1 AND resource_type = 'module' AND is_active = TRUE`,
        [parent_id]
      );
      if (parentCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Target module not found or inactive' });
      }
    }

    // Build dynamic UPDATE for authz_resource. We also stamp
    // attributes.manual_override.{display_name|parent_id}=true on the changed
    // fields so the sink upsert (sink-runtime.emitPageSnapshot) won't revert
    // them on the next DAG re-save. jsonb_set(..., create_missing=TRUE)
    // creates the manual_override sub-object on first edit.
    const sets: string[] = [];
    const params: unknown[] = [];
    if (willRename) { params.push((display_name as string).trim()); sets.push(`display_name = $${params.length}`); }
    if (willMove)   { params.push(parent_id); sets.push(`parent_id = $${params.length}`); }

    // Stamp manual_override flags. Build a chain of jsonb_set calls — only
    // for the fields the curator actually changed in this request.
    let attrsExpr = `COALESCE(attributes, '{}'::jsonb)`;
    if (willRename) attrsExpr = `jsonb_set(${attrsExpr}, '{manual_override,display_name}', 'true'::jsonb, TRUE)`;
    if (willMove)   attrsExpr = `jsonb_set(${attrsExpr}, '{manual_override,parent_id}', 'true'::jsonb, TRUE)`;
    sets.push(`attributes = ${attrsExpr}`);

    if (sets.length > 0) {
      params.push(resourceId);
      await client.query(
        `UPDATE authz_resource SET ${sets.join(', ')} WHERE resource_id = $${params.length}`,
        params
      );
    }

    // Mirror title to authz_ui_page (dual-write SSOT — V081 sink convention).
    // Best-effort: if the row doesn't exist (legacy page that never got a sink
    // snapshot), the resource update alone is the source of truth for the catalog.
    // PUB-PAGES-ADMIN-V01 Part B/C: also mutate description + display_order
    // (only present on authz_ui_page — they have no authz_resource analogue).
    const pageSets: string[] = [];
    const pageParams: unknown[] = [];
    if (willRename) { pageParams.push((display_name as string).trim()); pageSets.push(`title = $${pageParams.length}`); }
    if (willDescribe) {
      const desc = description === null ? null : (description as string);
      pageParams.push(desc);
      pageSets.push(`description = $${pageParams.length}`);
    }
    if (willOrder) {
      pageParams.push(display_order);
      pageSets.push(`display_order = $${pageParams.length}`);
    }
    if (pageSets.length > 0) {
      pageParams.push(pageId);
      await client.query(
        `UPDATE authz_ui_page SET ${pageSets.join(', ')} WHERE page_id = $${pageParams.length}`,
        pageParams
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return handleApiError(res, err);
  } finally {
    client.release();
  }

  await logAdminAction(pool, {
    userId,
    action: 'UPDATE_PAGE',
    resourceType: 'page',
    resourceId,
    details: {
      ...(willRename ? { display_name: (display_name as string).trim() } : {}),
      ...(willMove ? { parent_id } : {}),
      ...(willDescribe ? { description: description === null ? null : (description as string) } : {}),
      ...(willOrder ? { display_order } : {}),
    },
  });

  await refreshModuleStats();
  res.json({ updated: resourceId, page_id: pageId });
});

// ─── PUB-PAGES-ADMIN-V01 Part B: Pages admin inventory ───
//
// Purpose: surface every published_dag-backed page with the metadata curators
// need to manage them — backing DAG, last publisher, embedders count, catalog
// parent. Steward-only (admin gets through via SYSADMIN bypass in requireRole).
//
// Why not in routes/dag.ts: this is catalog management, not DAG runtime.
// Co-locating with the existing PATCH `/pages/:page_id` keeps all page-mutation
// routes under one router.
//
// Filters:
//   - parent_module_id: scope to a single module
//   - q: case-insensitive substring on title or page_id
//
// N+1 safety: embedders_count uses a correlated subquery against the same
// authz_ui_page table; published_dag set is dozens at demo scale, so the cost
// is bounded. Revisit if catalog grows past ~200.
modulesRouter.get('/pages', requireRole('DATA_STEWARD'), async (req, res) => {
  const parentModuleId = typeof req.query.parent_module_id === 'string' ? req.query.parent_module_id : null;
  const q = typeof req.query.q === 'string' && req.query.q.trim().length > 0 ? req.query.q.trim() : null;

  // page mirror = authz_resource row with resource_id 'page:<page_id>',
  // resource_type 'page'. authz_ui_page.resource_id points at the bless gate
  // (published_dag:...), NOT the page mirror — V086 keeps them as siblings.
  // We JOIN on the page mirror because that's the row whose parent_id is the
  // catalog parent the curator chose in the publish dialog.
  const params: unknown[] = [];
  const where: string[] = [
    `p.is_active = TRUE`,
    `p.published_dag_id IS NOT NULL`,
    `pm.is_active = TRUE`,
    `pm.resource_type = 'page'`,
  ];
  if (parentModuleId) {
    params.push(parentModuleId);
    where.push(`pm.parent_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(p.title) LIKE $${params.length} OR LOWER(p.page_id) LIKE $${params.length})`);
  }

  const sql = `
    SELECT p.page_id,
           p.title,
           p.description,
           p.display_order,
           p.published_dag_id                          AS dag_id,
           p.dag_snapshot->>'data_source_id'           AS data_source_id,
           p.resource_id                               AS published_dag_rid,
           pm.resource_id                              AS page_rid,
           pm.parent_id                                AS parent_module_id,
           parent.display_name                         AS parent_module_name,
           (
             SELECT COUNT(*) FROM authz_ui_page parent_p
              WHERE parent_p.is_active = TRUE
                AND parent_p.dag_snapshot->'embedded_subdags'
                    @> jsonb_build_array(jsonb_build_object('child_rid', p.resource_id))
           )                                            AS embedders_count,
           (
             SELECT created_at FROM authz_admin_audit_log
              WHERE resource_id = p.resource_id
                AND action IN ('DAG_PUBLISH', 'DAG_PUBLISH_OVERWRITE')
              ORDER BY created_at DESC LIMIT 1
           )                                            AS last_published_at,
           (
             SELECT user_id FROM authz_admin_audit_log
              WHERE resource_id = p.resource_id
                AND action IN ('DAG_PUBLISH', 'DAG_PUBLISH_OVERWRITE')
              ORDER BY created_at DESC LIMIT 1
           )                                            AS last_published_by
      FROM authz_ui_page p
      JOIN authz_resource pm     ON pm.resource_id = 'page:' || p.page_id
      LEFT JOIN authz_resource parent ON parent.resource_id = pm.parent_id
     WHERE ${where.join(' AND ')}
     ORDER BY pm.parent_id NULLS LAST, p.display_order, p.title`;

  try {
    const { rows } = await pool.query(sql, params);
    res.json({
      pages: rows.map(r => ({
        page_id: r.page_id,
        title: r.title,
        description: r.description,
        display_order: r.display_order ?? 0,
        dag_id: r.dag_id,
        data_source_id: r.data_source_id,
        published_dag_rid: r.published_dag_rid,
        page_rid: r.page_rid,
        parent_module_id: r.parent_module_id,
        parent_module_name: r.parent_module_name,
        embedders_count: Number(r.embedders_count ?? 0),
        last_published_at: r.last_published_at,
        last_published_by: r.last_published_by,
      })),
    });
  } catch (err) { handleApiError(res, err); }
});

// ─── PUB-PAGES-ADMIN-V01 Part E: Page detail / lineage panel ───
//
// Returns the inventory row + dag_snapshot summary + recent admin audit so the
// PagesTab row-expand can show one consolidated view ("what's this page, what's
// in it, who touched it"). Form schema and embedded_subdags are passed through
// for the troubleshooting panel.
//
// Audit cap: last 30 entries on this page's resource_id (PUBLISH + UPDATE +
// DELETE actions). Older detail still queryable from the Audit tab.
modulesRouter.get('/pages/:page_id', requireRole('DATA_STEWARD'), async (req, res) => {
  const pageId = req.params.page_id;
  const resourceId = `page:${pageId}`;

  try {
    const pageRes = await pool.query(
      `SELECT p.page_id, p.title, p.description, p.display_order,
              p.published_dag_id                AS dag_id,
              p.resource_id                     AS published_dag_rid,
              p.dag_snapshot, p.form_schema,
              p.dag_snapshot->>'data_source_id' AS data_source_id,
              p.dag_snapshot->>'output_node_id' AS output_node_id,
              p.dag_snapshot->'exposed_node_ids' AS exposed_node_ids,
              p.dag_snapshot->'embedded_subdags' AS embedded_subdags,
              p.dag_snapshot->>'display_mode'   AS display_mode,
              p.dag_snapshot->>'cached_at'      AS snapshot_cached_at,
              p.render_mode                      AS render_mode,
              p.column_renames                   AS column_renames,
              pm.resource_id                    AS page_rid,
              pm.parent_id                      AS parent_module_id,
              parent.display_name               AS parent_module_name
         FROM authz_ui_page p
         JOIN authz_resource pm     ON pm.resource_id = 'page:' || p.page_id AND pm.resource_type = 'page' AND pm.is_active = TRUE
         LEFT JOIN authz_resource parent ON parent.resource_id = pm.parent_id
        WHERE p.page_id = $1 AND p.is_active = TRUE AND p.published_dag_id IS NOT NULL`,
      [pageId]
    );
    if (pageRes.rows.length === 0) {
      return res.status(404).json({ error: 'Page not found or not a published_dag' });
    }
    const row = pageRes.rows[0];
    const snapshotNodes = (row.dag_snapshot?.nodes ?? []) as Array<{ id: string; data?: { data_source_id?: string } }>;
    // XDB-TIER-B-L4: derive cross-DS shape so the catalog inspector can
    // render a "Cross-DS · N sources" badge.  Each node may carry its own
    // data_source_id (V086-FU L2); fall back to the dag-level default.
    const dsSet = new Set<string>();
    for (const n of snapshotNodes) {
      const ds = n?.data?.data_source_id || row.data_source_id;
      if (ds) dsSet.add(ds);
    }
    const dataSourceIds = Array.from(dsSet);

    const auditRes = await pool.query(
      `SELECT user_id, action, details, created_at, ip_address, actor_type, agent_id
         FROM authz_admin_audit_log
        WHERE resource_id = $1
        ORDER BY created_at DESC
        LIMIT 30`,
      [row.published_dag_rid]
    );

    res.json({
      page: {
        page_id: row.page_id,
        title: row.title,
        description: row.description,
        display_order: row.display_order ?? 0,
        dag_id: row.dag_id,
        data_source_id: row.data_source_id,
        published_dag_rid: row.published_dag_rid,
        page_rid: row.page_rid,
        parent_module_id: row.parent_module_id,
        parent_module_name: row.parent_module_name,
        // XDB-TIER-B-L4: surface the new V092 axes so the catalog inspector
        // can render "Snapshot · cached at X" / "Live · re-run on render"
        // chips, plus a "Cross-DS · N sources" badge when applicable.
        render_mode: row.render_mode || 'snapshot',
        display_mode: row.display_mode || 'tabular',
        column_renames: row.column_renames || {},
        data_source_ids: dataSourceIds,
        snapshot_cached_at: row.snapshot_cached_at,
      },
      snapshot_meta: {
        node_count: snapshotNodes.length,
        output_node_id: row.output_node_id,
        exposed_node_ids: row.exposed_node_ids ?? [],
        form_schema: row.form_schema ?? [],
        embedded_subdags: row.embedded_subdags ?? [],
      },
      recent_audit: auditRes.rows,
    });
  } catch (err) { handleApiError(res, err); }
});

// ─── PUB-PAGES-ADMIN-V01 Part D: soft-delete with embedder block ───
//
// Two safety layers:
//   1. Embedder check — if any other published_dag has this page in its
//      embedded_subdags array, refuse with 409 + the blocking parents. The
//      front-end pre-flights /api/dag/published/:rid/embedders, but we re-check
//      here to defend against TOCTOU (race with a concurrent embed).
//   2. Soft delete only — flips is_active=FALSE on both the page mirror
//      (authz_resource) and the bless gate (also authz_resource, type
//      'published_dag') plus authz_ui_page row. We deliberately leave
//      role_permission rows intact: an inactive resource fails authz_check, so
//      the effective grant is revoked, and the audit trail of who-had-read
//      survives.
//
// What stays for V090+: hard delete + cron purge + role_permission cleanup.
// Demo scope says soft-only; ops can revive a deletion by flipping is_active
// back to TRUE in two tables.
modulesRouter.delete('/pages/:page_id', requireRole('DATA_STEWARD'), async (req, res) => {
  const pageId = req.params.page_id;
  const userId = getUserId(req);
  const resourceId = `page:${pageId}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pageRow = await client.query(
      `SELECT p.resource_id AS published_dag_rid, p.published_dag_id AS dag_id, p.title
         FROM authz_ui_page p
        WHERE p.page_id = $1 AND p.is_active = TRUE
        FOR UPDATE`,
      [pageId]
    );
    if (pageRow.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Page not found or already deleted' });
    }
    const publishedDagRid: string = pageRow.rows[0].published_dag_rid;

    // 1. Embedder defense-in-depth — block if any active parent embeds this
    //    page's bless gate.
    const filter = JSON.stringify([{ child_rid: publishedDagRid }]);
    const embedders = await client.query(
      `SELECT page.page_id            AS parent_page_id,
              page.resource_id        AS parent_published_dag_rid,
              page.published_dag_id   AS parent_dag_id,
              page.title              AS parent_title
         FROM authz_ui_page page
        WHERE page.is_active = TRUE
          AND page.page_id <> $2
          AND page.dag_snapshot->'embedded_subdags' @> $1::jsonb`,
      [filter, pageId]
    );
    if (embedders.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Cannot delete: page is embedded in ${embedders.rows.length} other published_dag(s)`,
        blocking_parents: embedders.rows,
      });
    }

    // 2. Soft delete — page mirror + ui_page row are 1:1 with page_id, so
    //    always flip them. The bless gate (published_dag:<dag_id>) is 1:DAG —
    //    multiple page_ids from the same DAG can share it (V086 keyed on
    //    dag_id, not page_id). Only deactivate the bless gate when this is
    //    the LAST page referencing it; otherwise sibling pages would silently
    //    lose BI_USER read access.
    await client.query(
      `UPDATE authz_resource SET is_active = FALSE WHERE resource_id = $1`,
      [resourceId]
    );
    await client.query(
      `UPDATE authz_ui_page SET is_active = FALSE WHERE page_id = $1`,
      [pageId]
    );
    const remaining = await client.query(
      `SELECT 1 FROM authz_ui_page
        WHERE resource_id = $1 AND is_active = TRUE
        LIMIT 1`,
      [publishedDagRid]
    );
    if (remaining.rowCount === 0) {
      await client.query(
        `UPDATE authz_resource SET is_active = FALSE WHERE resource_id = $1`,
        [publishedDagRid]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return handleApiError(res, err);
  } finally {
    client.release();
  }

  await logAdminAction(pool, {
    userId,
    action: 'DELETE_PAGE',
    resourceType: 'page',
    resourceId,
    details: { soft_delete: true },
  });

  await refreshModuleStats();
  res.json({ deleted: resourceId, page_id: pageId, soft_delete: true });
});
