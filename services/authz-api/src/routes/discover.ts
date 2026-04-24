import { Router } from 'express';
import { pool as authzPool } from '../db';
import { getUserId, handleApiError } from '../lib/request-helpers';
import { logAdminAction } from '../lib/admin-audit';
import { runDiscoveryRules } from '../lib/discovery-rule-engine';

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

// ─── Reparent: detach (target_module_id=null) or move (string) a mapped resource ───
// Inverse of /promote — only operates on resources currently parented under a module.
//   - { resource_id, target_module_id: null }   → detach: parent_id = NULL (returns to unmapped pool)
//   - { resource_id, target_module_id: "..." }  → move: reparent under a different active module
// Refuses unmapped resources (callers should use /promote attach mode instead).
discoverRouter.post('/reparent', async (req, res) => {
  const userId = getUserId(req);
  const resourceId = String(req.body?.resource_id || '').trim();
  const rawTarget = req.body?.target_module_id;
  const targetModuleId = rawTarget === null || rawTarget === undefined || rawTarget === ''
    ? null
    : String(rawTarget).trim();

  if (!resourceId) return res.status(400).json({ error: 'resource_id required' });

  const client = await authzPool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT resource_id, resource_type, parent_id, is_active
         FROM authz_resource WHERE resource_id = $1`,
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
      return res.status(400).json({ error: `cannot reparent resource_type=${t.resource_type}` });
    }
    if (!t.parent_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'resource is not currently mapped to a module — use /promote instead' });
    }
    const currentParent = await client.query(
      `SELECT resource_type, display_name FROM authz_resource WHERE resource_id = $1`,
      [t.parent_id],
    );
    if (currentParent.rows[0]?.resource_type !== 'module') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'resource is not currently under a module — use /promote instead' });
    }
    const previousModuleId: string = t.parent_id;
    const previousDisplayName: string = currentParent.rows[0].display_name;

    let newDisplayName: string | null = null;
    if (targetModuleId) {
      if (targetModuleId === previousModuleId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'target_module_id matches current parent — no-op' });
      }
      const m = await client.query(
        `SELECT resource_id, display_name, resource_type, is_active
           FROM authz_resource WHERE resource_id = $1`,
        [targetModuleId],
      );
      if (m.rows.length === 0 || !m.rows[0].is_active || m.rows[0].resource_type !== 'module') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'target_module_id must be an active module' });
      }
      newDisplayName = m.rows[0].display_name;
    }

    await client.query(
      `UPDATE authz_resource SET parent_id = $1, updated_at = now() WHERE resource_id = $2`,
      [targetModuleId, resourceId],
    );

    await client.query('COMMIT');

    try {
      await authzPool.query('SELECT refresh_module_tree_stats()');
    } catch (e) {
      console.warn('[discover/reparent] refresh_module_tree_stats failed:', e);
    }
    await logAdminAction(authzPool, {
      userId,
      action: targetModuleId ? 'MOVE_TO_MODULE' : 'DETACH_FROM_MODULE',
      resourceType: 'module',
      resourceId: targetModuleId || previousModuleId,
      details: {
        resource_id: resourceId,
        previous_module_id: previousModuleId,
        new_module_id: targetModuleId,
      },
    });

    res.json({
      mode: targetModuleId ? 'move' : 'detach',
      resource_id: resourceId,
      previous_module_id: previousModuleId,
      previous_display_name: previousDisplayName,
      new_module_id: targetModuleId,
      new_display_name: newDisplayName,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleApiError(res, err);
  } finally {
    client.release();
  }
});

// ─── Bulk: attach / detach / create_attach across many resources ───
// Three modes (Phase E):
//   1. create_attach — body: { mode, resource_ids, module_display_name, parent_module_id? }
//       Creates one new Module and attaches all currently-unmapped rows to it.
//   2. attach        — body: { mode, resource_ids, target_module_id }
//       Attaches all currently-unmapped rows to an existing active module.
//   3. detach        — body: { mode, resource_ids }
//       Clears parent_id on all currently-mapped rows (returns to unmapped pool).
//
// Behavior: rows that don't match the mode's precondition (wrong type, not
// active, already mapped for attach modes, already unmapped for detach) are
// SKIPPED with a per-row reason — the rest still apply. The whole set runs in
// one transaction so an unexpected DB error rolls back all changes atomically.
// One admin audit row is written per operation summarizing affected ids.
discoverRouter.post('/bulk', async (req, res) => {
  const userId = getUserId(req);
  const mode = String(req.body?.mode || '');
  const rawIds: unknown = req.body?.resource_ids;
  if (!['create_attach', 'attach', 'detach'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be create_attach | attach | detach' });
  }
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return res.status(400).json({ error: 'resource_ids must be a non-empty array' });
  }
  const resourceIds = Array.from(new Set(rawIds.map(id => String(id).trim()).filter(Boolean)));
  if (resourceIds.length === 0) return res.status(400).json({ error: 'resource_ids is empty after trimming' });
  if (resourceIds.length > 500) return res.status(400).json({ error: 'resource_ids capped at 500 per request' });

  const targetModuleId = req.body?.target_module_id ? String(req.body.target_module_id).trim() : null;
  const parentModuleId = req.body?.parent_module_id ? String(req.body.parent_module_id).trim() : null;
  const displayName = String(req.body?.module_display_name || '').trim();

  if (mode === 'attach' && !targetModuleId) {
    return res.status(400).json({ error: 'target_module_id required for attach mode' });
  }
  if (mode === 'create_attach') {
    if (!displayName) return res.status(400).json({ error: 'module_display_name required for create_attach mode' });
    if (displayName.length > 200) return res.status(400).json({ error: 'module_display_name too long (max 200)' });
    if (!slugify(displayName)) return res.status(400).json({ error: 'module_display_name produced empty slug' });
  }

  const client = await authzPool.connect();
  try {
    await client.query('BEGIN');

    // Load all candidate rows in one shot (plus their current parent type).
    const rowsRes = await client.query(
      `SELECT ar.resource_id, ar.resource_type, ar.parent_id, ar.is_active,
              parent.resource_type AS parent_resource_type
         FROM authz_resource ar
         LEFT JOIN authz_resource parent ON parent.resource_id = ar.parent_id
        WHERE ar.resource_id = ANY($1::text[])`,
      [resourceIds],
    );
    const byId = new Map<string, any>(rowsRes.rows.map(r => [r.resource_id, r]));

    // Validate/resolve module target if needed.
    let moduleId: string | null = null;
    let resolvedDisplayName: string | null = null;
    let moduleCreated = false;

    if (mode === 'attach') {
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
    } else if (mode === 'create_attach') {
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
      const slug = slugify(displayName);
      const baseId = parentModuleId ? `${parentModuleId}.${slug}` : `module:${slug}`;
      moduleId = baseId;
      for (let i = 0; i < 50; i++) {
        const exists = await client.query(`SELECT 1 FROM authz_resource WHERE resource_id = $1`, [moduleId]);
        if (exists.rows.length === 0) break;
        moduleId = `${baseId}_${i + 2}`;
      }
      // Module is created below, only if there are applicable rows.
      resolvedDisplayName = displayName;
    }

    // Classify each requested id against the mode's precondition.
    const applied: string[] = [];
    const skipped: { resource_id: string; reason: string }[] = [];

    for (const id of resourceIds) {
      const row = byId.get(id);
      if (!row) { skipped.push({ resource_id: id, reason: 'not_found' }); continue; }
      if (!row.is_active) { skipped.push({ resource_id: id, reason: 'inactive' }); continue; }
      if (!['table', 'view', 'function'].includes(row.resource_type)) {
        skipped.push({ resource_id: id, reason: `wrong_type:${row.resource_type}` });
        continue;
      }
      const isMapped = row.parent_resource_type === 'module';
      if (mode === 'detach') {
        if (!isMapped) { skipped.push({ resource_id: id, reason: 'not_mapped' }); continue; }
      } else {
        if (isMapped) { skipped.push({ resource_id: id, reason: 'already_mapped' }); continue; }
      }
      applied.push(id);
    }

    if (applied.length === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({
        mode, applied_count: 0, skipped_count: skipped.length, applied: [], skipped,
        module_id: null, module_created: false,
      });
    }

    // In create_attach, only create the new module now that we know
    // there's at least one applicable row — avoids stranding empty modules.
    if (mode === 'create_attach') {
      await client.query(
        `INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
         VALUES ($1, 'module', $2, $3, $4::jsonb)`,
        [
          moduleId,
          parentModuleId,
          displayName,
          JSON.stringify({ promoted_from_bulk: applied, promoted_by: userId }),
        ],
      );
      moduleCreated = true;
    }

    // Single UPDATE handles all applied rows.
    const newParent = mode === 'detach' ? null : moduleId;
    await client.query(
      `UPDATE authz_resource SET parent_id = $1, updated_at = now() WHERE resource_id = ANY($2::text[])`,
      [newParent, applied],
    );

    await client.query('COMMIT');

    // Side effects (post-commit).
    try {
      await authzPool.query('SELECT refresh_module_tree_stats()');
    } catch (e) {
      console.warn('[discover/bulk] refresh_module_tree_stats failed:', e);
    }
    const auditAction = mode === 'create_attach'
      ? 'BULK_PROMOTE_TO_MODULE'
      : mode === 'attach'
        ? 'BULK_ATTACH_TO_MODULE'
        : 'BULK_DETACH_FROM_MODULE';
    await logAdminAction(authzPool, {
      userId,
      action: auditAction,
      resourceType: 'module',
      resourceId: moduleId || 'bulk-detach',
      details: {
        mode,
        applied_count: applied.length,
        skipped_count: skipped.length,
        applied,
        module_created: moduleCreated,
        parent_module_id: parentModuleId,
      },
    });

    res.json({
      mode,
      applied_count: applied.length,
      skipped_count: skipped.length,
      applied,
      skipped,
      module_id: moduleId,
      module_display_name: resolvedDisplayName,
      module_created: moduleCreated,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleApiError(res, err);
  } finally {
    client.release();
  }
});

// ─── Bottom-up: re-run discovery rule engine across resources ───
// Useful when admin adds/edits rules in authz_discovery_rule and wants to
// back-fill suggestions across already-discovered resources.
//
// Body: { data_source_id?: string }  // optional scope; omit = all sources
discoverRouter.post('/run-rules', async (req, res) => {
  try {
    const dataSourceId = (req.body?.data_source_id as string | undefined)?.trim() || undefined;
    const result = await runDiscoveryRules({
      pool: authzPool,
      dataSourceId,
      createdBy: getUserId(req) ?? 'discover-engine',
    });
    logAdminAction(authzPool, {
      userId: getUserId(req),
      action: 'RUN_DISCOVERY_RULES',
      resourceType: dataSourceId ? 'data_source' : 'system',
      resourceId: dataSourceId ?? 'all',
      details: result,
      ip: undefined,
    });
    res.json(result);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Bottom-up: list suggested (pending_review) policies for review UI ───
// Powers the Discover Pending Review tab. Filters: data_source_id, rule_type.
discoverRouter.get('/suggestions', async (req, res) => {
  try {
    const dataSourceId = String(req.query.data_source_id || '').trim() || null;
    const ruleType = String(req.query.rule_type || '').trim() || null; // 'column_mask'|'row_filter'|null

    const sql = `
      SELECT
        p.policy_id,
        p.policy_name,
        p.description,
        p.column_mask_rules,
        p.rls_expression,
        p.suggested_by_rule,
        p.suggested_at,
        p.suggested_reason,
        p.status,
        p.resource_condition,
        r.rule_type,
        r.suggested_label,
        r.match_pattern,
        -- pull the first targeted resource for display
        (p.resource_condition->'resource_ids'->>0) AS target_resource_id,
        tgt.display_name                            AS target_display_name,
        tgt.resource_type                           AS target_resource_type,
        tgt.attributes->>'data_source_id'           AS target_data_source_id,
        ds.display_name                             AS target_data_source_name
      FROM authz_policy p
      LEFT JOIN authz_discovery_rule r ON r.rule_id = p.suggested_by_rule
      LEFT JOIN authz_resource tgt
             ON tgt.resource_id = (p.resource_condition->'resource_ids'->>0)
      LEFT JOIN authz_data_source ds
             ON ds.source_id = tgt.attributes->>'data_source_id'
     WHERE p.status = 'pending_review'
       AND p.suggested_by_rule IS NOT NULL
       AND ($1::text IS NULL OR tgt.attributes->>'data_source_id' = $1)
       AND ($2::text IS NULL OR r.rule_type = $2)
     ORDER BY p.suggested_at DESC NULLS LAST, p.policy_id DESC
     LIMIT 500`;

    const result = await authzPool.query(sql, [dataSourceId, ruleType]);
    res.json(result.rows);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Bottom-up: approve or reject a suggested policy ───
// PATCH /api/discover/suggestions/:policy_id  body: { action: 'approve'|'reject',
//   subject_condition?: object }
discoverRouter.patch('/suggestions/:policy_id', async (req, res) => {
  try {
    const policyId = Number(req.params.policy_id);
    if (!Number.isFinite(policyId)) return res.status(400).json({ error: 'invalid policy_id' });
    const action = String(req.body?.action || '').toLowerCase();
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }
    const subjectCondition = req.body?.subject_condition;

    if (action === 'approve') {
      const r = await authzPool.query(
        `UPDATE authz_policy
            SET status         = 'active',
                approved_by    = $2,
                subject_condition = COALESCE($3::jsonb, subject_condition),
                updated_at     = now()
          WHERE policy_id = $1
            AND status    = 'pending_review'
          RETURNING policy_id, policy_name, status`,
        [policyId, getUserId(req), subjectCondition ? JSON.stringify(subjectCondition) : null],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'policy not found or not pending' });
      logAdminAction(authzPool, {
        userId: getUserId(req),
        action: 'APPROVE_SUGGESTED_POLICY',
        resourceType: 'policy',
        resourceId: String(policyId),
        details: { policy_name: r.rows[0].policy_name },
        ip: undefined,
      });
      res.json(r.rows[0]);
    } else {
      const r = await authzPool.query(
        `UPDATE authz_policy
            SET status     = 'rejected',
                updated_at = now()
          WHERE policy_id = $1
            AND status    = 'pending_review'
          RETURNING policy_id, policy_name, status`,
        [policyId],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'policy not found or not pending' });
      logAdminAction(authzPool, {
        userId: getUserId(req),
        action: 'REJECT_SUGGESTED_POLICY',
        resourceType: 'policy',
        resourceId: String(policyId),
        details: { policy_name: r.rows[0].policy_name },
        ip: undefined,
      });
      res.json(r.rows[0]);
    }
  } catch (err) {
    handleApiError(res, err);
  }
});
