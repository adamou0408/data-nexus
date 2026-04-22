import { Router } from 'express';
import { pool as authzPool } from '../db';
import { getUserId, handleApiError } from '../lib/request-helpers';
import { logAdminAction } from '../lib/admin-audit';

export const discoverRouter = Router();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

// ─── Cross-source resource discovery ───
// Lists tables/views/functions across all data sources from the local catalog
// (authz_resource). Already-discovered resources only — does NOT re-introspect
// remote DBs. Use POST /api/datasources/:id/discover to refresh a specific DS.
discoverRouter.get('/', async (req, res) => {
  try {
    const type = String(req.query.type || 'all'); // 'table' | 'view' | 'function' | 'all'
    const unmappedOnly = String(req.query.unmapped_only || 'false') === 'true';
    const q = String(req.query.q || '').trim();
    const dataSourceId = String(req.query.data_source_id || '').trim();

    const validTypes = ['table', 'view', 'function'];
    const typeFilter = validTypes.includes(type) ? type : null;

    const params: unknown[] = [typeFilter, unmappedOnly, q || null, dataSourceId || null];

    const sql = `
      SELECT
        ar.resource_id,
        ar.resource_type,
        ar.display_name,
        ar.attributes->>'data_source_id'   AS data_source_id,
        ds.display_name                    AS ds_display_name,
        ds.db_type                         AS ds_db_type,
        ar.attributes->>'table_schema'     AS schema,
        ar.parent_id,
        parent.display_name                AS parent_display_name,
        parent.resource_type               AS parent_resource_type,
        ar.created_at
      FROM authz_resource ar
      LEFT JOIN authz_data_source ds
             ON ds.source_id = ar.attributes->>'data_source_id'
      LEFT JOIN authz_resource parent
             ON parent.resource_id = ar.parent_id
      WHERE ar.is_active = TRUE
        AND ar.resource_type IN ('table', 'view', 'function')
        AND ($1::text IS NULL OR ar.resource_type = $1)
        AND ($2::boolean IS FALSE
             OR parent.resource_type IS DISTINCT FROM 'module')
        AND ($3::text IS NULL
             OR ar.display_name ILIKE '%' || $3 || '%'
             OR ar.resource_id ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL
             OR ar.attributes->>'data_source_id' = $4)
      ORDER BY ds_display_name NULLS LAST, ar.resource_type, ar.display_name
      LIMIT 5000
    `;

    const result = await authzPool.query(sql, params);

    const rows = result.rows.map(r => ({
      resource_id: r.resource_id,
      resource_type: r.resource_type as 'table' | 'view' | 'function',
      display_name: r.display_name,
      data_source_id: r.data_source_id,
      ds_display_name: r.ds_display_name,
      ds_db_type: r.ds_db_type,
      schema: r.schema,
      mapped_to_module: r.parent_resource_type === 'module' ? {
        resource_id: r.parent_id,
        display_name: r.parent_display_name,
      } : null,
      created_at: r.created_at,
    }));

    res.json({
      total: rows.length,
      truncated: rows.length === 5000,
      rows,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Stats summary (cheap aggregate for the StatStrip) ───
discoverRouter.get('/stats', async (_req, res) => {
  try {
    const sql = `
      SELECT
        ar.resource_type,
        COUNT(*)                                                    AS total,
        COUNT(*) FILTER (WHERE parent.resource_type = 'module')     AS mapped,
        COUNT(*) FILTER (WHERE parent.resource_type IS DISTINCT FROM 'module') AS unmapped,
        COUNT(DISTINCT ar.attributes->>'data_source_id')            AS ds_count
      FROM authz_resource ar
      LEFT JOIN authz_resource parent
             ON parent.resource_id = ar.parent_id
      WHERE ar.is_active = TRUE
        AND ar.resource_type IN ('table', 'view', 'function')
      GROUP BY ar.resource_type
    `;
    const result = await authzPool.query(sql);

    const summary = {
      table: { total: 0, mapped: 0, unmapped: 0 },
      view: { total: 0, mapped: 0, unmapped: 0 },
      function: { total: 0, mapped: 0, unmapped: 0 },
      ds_count: 0,
    };
    for (const row of result.rows) {
      const t = row.resource_type as 'table' | 'view' | 'function';
      summary[t] = {
        total: Number(row.total),
        mapped: Number(row.mapped),
        unmapped: Number(row.unmapped),
      };
      summary.ds_count = Math.max(summary.ds_count, Number(row.ds_count));
    }
    res.json(summary);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Promote: map an unmapped resource to a Module ───
// Two modes (mutually exclusive):
//   1. CREATE — body: { resource_id, module_display_name, parent_module_id? }
//      Creates a new Module (slugified id, collision-suffixed) and
//      reparents the resource under it. parent_module_id nests the new
//      module under an existing one.
//   2. ATTACH — body: { resource_id, target_module_id }
//      Reparents the resource directly under an existing Module — no new
//      module created.
//
// Effects (both modes): refreshes module_tree_stats, writes admin audit.
discoverRouter.post('/promote', async (req, res) => {
  const userId = getUserId(req);
  const resourceId = String(req.body?.resource_id || '').trim();
  const targetModuleId = req.body?.target_module_id ? String(req.body.target_module_id).trim() : null;
  const displayName = String(req.body?.module_display_name || '').trim();
  const parentModuleId = req.body?.parent_module_id ? String(req.body.parent_module_id).trim() : null;

  if (!resourceId) return res.status(400).json({ error: 'resource_id required' });
  // Mode discriminator
  const isAttach = !!targetModuleId;
  if (!isAttach) {
    if (!displayName) return res.status(400).json({ error: 'module_display_name required (or pass target_module_id to attach to existing)' });
    if (displayName.length > 200) return res.status(400).json({ error: 'module_display_name too long (max 200)' });
    const slug = slugify(displayName);
    if (!slug) return res.status(400).json({ error: 'module_display_name produced empty slug' });
  }

  const client = await authzPool.connect();
  try {
    await client.query('BEGIN');

    // Validate target resource
    const target = await client.query(
      `SELECT resource_id, resource_type, parent_id, is_active
         FROM authz_resource
        WHERE resource_id = $1`,
      [resourceId],
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'resource_id not found' });
    }
    const t = target.rows[0];
    if (!t.is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'resource is inactive' });
    }
    if (!['table', 'view', 'function'].includes(t.resource_type)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `cannot promote resource_type=${t.resource_type}` });
    }
    // If already under a module, refuse — caller should detach first
    if (t.parent_id) {
      const existingParent = await client.query(
        `SELECT resource_type FROM authz_resource WHERE resource_id = $1`,
        [t.parent_id],
      );
      if (existingParent.rows[0]?.resource_type === 'module') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'resource already mapped to a module',
          current_parent: t.parent_id,
        });
      }
    }

    let moduleId: string;
    let resolvedDisplayName: string;

    if (isAttach) {
      // ── Attach mode: validate target module, no new module created ──
      const m = await client.query(
        `SELECT resource_id, display_name, resource_type, is_active
           FROM authz_resource WHERE resource_id = $1`,
        [targetModuleId],
      );
      if (m.rows.length === 0 || !m.rows[0].is_active || m.rows[0].resource_type !== 'module') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'target_module_id must be an active module' });
      }
      moduleId = m.rows[0].resource_id;
      resolvedDisplayName = m.rows[0].display_name;
    } else {
      // ── Create mode ──
      // Validate parent_module_id if provided
      if (parentModuleId) {
        const parent = await client.query(
          `SELECT resource_type, is_active FROM authz_resource WHERE resource_id = $1`,
          [parentModuleId],
        );
        if (parent.rows.length === 0 || !parent.rows[0].is_active || parent.rows[0].resource_type !== 'module') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'parent_module_id must be an active module' });
        }
      }

      // Build a unique module_id with slug + collision suffix
      const slug = slugify(displayName);
      const baseId = parentModuleId
        ? `${parentModuleId}.${slug}`
        : `module:${slug}`;
      moduleId = baseId;
      for (let i = 0; i < 50; i++) {
        const exists = await client.query(
          `SELECT 1 FROM authz_resource WHERE resource_id = $1`,
          [moduleId],
        );
        if (exists.rows.length === 0) break;
        moduleId = `${baseId}_${i + 2}`;
      }

      // Insert new module
      await client.query(
        `INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
         VALUES ($1, 'module', $2, $3, $4::jsonb)`,
        [
          moduleId,
          parentModuleId,
          displayName,
          JSON.stringify({ promoted_from: resourceId, promoted_by: userId }),
        ],
      );
      resolvedDisplayName = displayName;
    }

    // Reparent the resource
    await client.query(
      `UPDATE authz_resource SET parent_id = $1, updated_at = now() WHERE resource_id = $2`,
      [moduleId, resourceId],
    );

    await client.query('COMMIT');

    // Fire-and-forget side effects
    try {
      await authzPool.query('SELECT refresh_module_tree_stats()');
    } catch (e) {
      console.warn('[discover/promote] refresh_module_tree_stats failed:', e);
    }
    await logAdminAction(authzPool, {
      userId,
      action: isAttach ? 'ATTACH_TO_MODULE' : 'PROMOTE_TO_MODULE',
      resourceType: 'module',
      resourceId: moduleId,
      details: { promoted_resource: resourceId, mode: isAttach ? 'attach' : 'create', parent_module_id: parentModuleId },
    });

    res.json({
      mode: isAttach ? 'attach' : 'create',
      module_id: moduleId,
      display_name: resolvedDisplayName,
      parent_module_id: parentModuleId,
      promoted_resource_id: resourceId,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleApiError(res, err);
  } finally {
    client.release();
  }
});
