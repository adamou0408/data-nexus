import { Router } from 'express';
import { pool } from '../db';

export const browseRouter = Router();

browseRouter.get('/subjects', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, array_agg(sr.role_id) FILTER (WHERE sr.role_id IS NOT NULL) AS roles
      FROM authz_subject s
      LEFT JOIN authz_subject_role sr ON sr.subject_id = s.subject_id AND sr.is_active = TRUE
      GROUP BY s.subject_id
      ORDER BY s.subject_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/roles', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*,
        (SELECT count(*) FROM authz_subject_role sr WHERE sr.role_id = r.role_id AND sr.is_active) AS assignment_count,
        (SELECT count(*) FROM authz_role_permission rp WHERE rp.role_id = r.role_id AND rp.is_active) AS permission_count
      FROM authz_role r
      ORDER BY r.role_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/resources', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM authz_resource WHERE is_active = TRUE ORDER BY resource_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/policies', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM authz_policy ORDER BY policy_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/actions', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM authz_action WHERE is_active = TRUE ORDER BY action_id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Data Explorer: permission-aware table view ---

// Returns table schema + column access status + filtered sample data + mask functions
browseRouter.post('/data-explorer', async (req, res) => {
  const { user_id, groups = [], attributes = {}, table } = req.body;

  if (!table || table.startsWith('authz_')) {
    return res.status(400).json({ error: 'Invalid or internal table' });
  }

  try {
    // 1. Column schema
    const schemaResult = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default,
             character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);

    if (schemaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Table not found' });
    }

    // 2. Resolve user permissions (L0/L2)
    const resolveResult = await pool.query(
      'SELECT authz_resolve($1, $2, $3) AS config',
      [user_id, groups, JSON.stringify(attributes)]
    );
    const config = resolveResult.rows[0]?.config || {};
    const columnMasks: Record<string, Record<string, { mask_type: string; function: string }>> = config.L2_column_masks || {};

    // Build mask map for this table
    const tableMasks: Record<string, { mask_type: string; function: string }> = {};
    for (const [, rules] of Object.entries(columnMasks)) {
      for (const [colKey, maskDef] of Object.entries(rules as Record<string, { mask_type: string; function: string }>)) {
        const [maskTable, maskCol] = colKey.split('.');
        if (maskTable === table && maskCol) {
          tableMasks[maskCol] = maskDef;
        }
      }
    }

    // 3. Resolve roles + find denied columns
    const rolesResult = await pool.query(
      'SELECT _authz_resolve_roles($1, $2) AS roles',
      [user_id, groups]
    );
    const roles: string[] = rolesResult.rows[0]?.roles || [];

    const denyResult = await pool.query(`
      SELECT rp.resource_id FROM authz_role_permission rp
      JOIN authz_resource ar ON ar.resource_id = rp.resource_id
      WHERE rp.role_id = ANY($1) AND rp.effect = 'deny' AND rp.is_active
        AND ar.resource_type = 'column'
        AND rp.resource_id LIKE $2
    `, [roles, `column:${table}.%`]);

    const deniedCols = new Set(
      denyResult.rows.map((r: { resource_id: string }) => r.resource_id.split('.').pop())
    );

    // 4. Build enriched column info
    const columns = schemaResult.rows.map((col: Record<string, unknown>) => {
      const colName = col.column_name as string;
      const mask = tableMasks[colName];
      const denied = deniedCols.has(colName);
      return {
        ...col,
        access: denied ? 'denied' : mask ? 'masked' : 'visible',
        mask_type: denied ? null : mask?.mask_type || null,
        mask_function: denied ? null : mask?.function || null,
      };
    });

    // 5. RLS filter
    const filterResult = await pool.query(
      'SELECT authz_filter($1, $2, $3, $4) AS filter_clause',
      [user_id, groups, JSON.stringify(attributes), `table:${table}`]
    );
    const filterClause = filterResult.rows[0]?.filter_clause || 'TRUE';

    // 6. Build SELECT with masks/denies applied
    const selectParts = columns.map((col: { column_name: string; data_type: string; access: string; mask_function: string | null }) => {
      if (col.access === 'denied') return `'[DENIED]' AS ${col.column_name}`;
      if (col.access === 'masked' && col.mask_function) {
        const fn = col.mask_function;
        if (fn === 'fn_mask_range') return `${fn}(${col.column_name}::numeric) AS ${col.column_name}`;
        return `${fn}(${col.column_name}::text) AS ${col.column_name}`;
      }
      return col.column_name;
    });

    const dataResult = await pool.query(
      `SELECT ${selectParts.join(', ')} FROM "${table}" WHERE ${filterClause} ORDER BY 1 LIMIT 20`
    ).catch(() => ({ rows: [], rowCount: 0 }));

    const totalResult = await pool.query(`SELECT count(*)::int AS c FROM "${table}"`).catch(() => ({ rows: [{ c: 0 }] }));
    const filteredResult = await pool.query(`SELECT count(*)::int AS c FROM "${table}" WHERE ${filterClause}`).catch(() => ({ rows: [{ c: 0 }] }));

    // 7. Get mask function definitions used on this table
    const usedFns = [...new Set(columns.filter((c: { mask_function: string | null }) => c.mask_function).map((c: { mask_function: string }) => c.mask_function))];
    let maskFunctions: { function_name: string; description: string | null; example: string }[] = [];
    if (usedFns.length > 0) {
      const fnResult = await pool.query(`
        SELECT mf.function_name, mf.description,
               COALESCE(mf.example_output, '') AS example
        FROM authz_mask_function mf
        WHERE mf.function_name = ANY($1) AND mf.is_active = TRUE
      `, [usedFns]).catch(() => ({ rows: [] }));
      maskFunctions = fnResult.rows;

      // Fallback: if mask_function registry doesn't have entries, use pg_proc
      if (maskFunctions.length === 0) {
        const pgResult = await pool.query(`
          SELECT p.proname AS function_name,
                 d.description,
                 '' AS example
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          LEFT JOIN pg_description d ON d.objoid = p.oid
          WHERE n.nspname = 'public' AND p.proname = ANY($1)
        `, [usedFns]).catch(() => ({ rows: [] }));
        maskFunctions = pgResult.rows;
      }
    }

    res.json({
      table,
      columns,
      rls_filter: filterClause,
      sample_data: dataResult.rows,
      total_count: totalResult.rows[0].c,
      filtered_count: filteredResult.rows[0].c,
      mask_functions: maskFunctions,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Business Data: Tables & Functions ---

// List business data tables (exclude authz_* internal tables)
browseRouter.get('/tables', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name,
        (SELECT count(*) FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = t.table_name) AS column_count
      FROM information_schema.tables t
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE 'authz_%'
      ORDER BY table_name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Get schema + sample data for a business table
browseRouter.get('/tables/:table', async (req, res) => {
  const tableName = req.params.table;
  // Block access to authz internal tables
  if (tableName.startsWith('authz_')) {
    return res.status(403).json({ error: 'Cannot browse internal authz tables' });
  }
  try {
    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default,
             character_maximum_length, numeric_precision
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [tableName]);
    if (cols.rows.length === 0) {
      return res.status(404).json({ error: 'Table not found' });
    }
    const sample = await pool.query(
      `SELECT * FROM "${tableName}" LIMIT 20`
    ).catch(() => ({ rows: [] }));
    res.json({ table: tableName, columns: cols.rows, sample_data: sample.rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// List business-facing SQL functions (mask functions, excludes internal _authz_* helpers)
browseRouter.get('/functions', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.proname AS function_name,
             pg_get_function_arguments(p.oid) AS arguments,
             pg_get_function_result(p.oid) AS return_type,
             d.description,
             CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      LEFT JOIN pg_description d ON d.objoid = p.oid
      WHERE n.nspname = 'public'
        AND (p.proname LIKE 'fn_mask_%'
             OR p.proname IN ('authz_check', 'authz_filter', 'authz_resolve',
                              'authz_resolve_web_acl', 'authz_check_from_cache'))
      ORDER BY p.proname
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Action Items / Approval Queue ---

// Get pending action items for Overview dashboard
browseRouter.get('/action-items', async (req, res) => {
  const userId = req.query.user_id as string | undefined;
  const isAdmin = req.query.is_admin === 'true';
  try {
    const items: { type: string; severity: string; title: string; detail: string; meta?: unknown }[] = [];

    // Admin-only items: SSOT drift, expiring roles, credential rotation
    if (isAdmin) {
      // 1. SSOT drift check
      const drift = await pool.query(`
        SELECT profile_id, has_drift, static_denied, ssot_denied
        FROM v_pool_ssot_check
        WHERE has_drift = TRUE
      `).catch(() => ({ rows: [] }));
      for (const d of drift.rows) {
        items.push({
          type: 'ssot_drift', severity: 'warning',
          title: `Pool "${d.profile_id}" SSOT drift detected`,
          detail: 'Static denied_columns differs from SSOT-derived values',
          meta: { profile_id: d.profile_id, static: d.static_denied, ssot: d.ssot_denied },
        });
      }

      // 2. Expiring role assignments (within 7 days)
      const expiring = await pool.query(`
        SELECT subject_id, role_id, valid_until,
               EXTRACT(DAY FROM (valid_until - now())) AS days_remaining
        FROM authz_subject_role
        WHERE is_active = TRUE
          AND valid_until IS NOT NULL
          AND valid_until BETWEEN now() AND now() + interval '7 days'
        ORDER BY valid_until
      `).catch(() => ({ rows: [] }));
      for (const e of expiring.rows) {
        items.push({
          type: 'role_expiring', severity: 'info',
          title: `Role "${e.role_id}" for ${e.subject_id} expires in ${Math.ceil(e.days_remaining)} days`,
          detail: `Valid until: ${new Date(e.valid_until).toLocaleDateString()}`,
          meta: { subject_id: e.subject_id, role_id: e.role_id, valid_until: e.valid_until },
        });
      }

      // 3. Credential rotation due (within 14 days or overdue)
      const credDue = await pool.query(`
        SELECT pg_role, last_rotated, rotate_interval,
               EXTRACT(DAY FROM (last_rotated + rotate_interval - now())) AS days_remaining
        FROM authz_pool_credentials
        WHERE is_active = TRUE
          AND EXTRACT(DAY FROM (last_rotated + rotate_interval - now())) < 14
      `).catch(() => ({ rows: [] }));
      for (const c of credDue.rows) {
        const days = Math.ceil(c.days_remaining);
        items.push({
          type: 'credential_rotation', severity: days < 0 ? 'error' : 'warning',
          title: days < 0
            ? `Credential "${c.pg_role}" overdue for rotation by ${Math.abs(days)} days`
            : `Credential "${c.pg_role}" rotation due in ${days} days`,
          detail: `Last rotated: ${new Date(c.last_rotated).toLocaleDateString()}`,
          meta: { pg_role: c.pg_role },
        });
      }
    }

    // 4. Recent denied accesses for current user (last 24h) — all users
    if (userId) {
      const denials = await pool.query(`
        SELECT action_id, resource_id, timestamp
        FROM authz_audit_log
        WHERE subject_id = $1
          AND decision = 'deny'
          AND timestamp > now() - interval '24 hours'
        ORDER BY timestamp DESC
        LIMIT 5
      `, [`user:${userId}`]).catch(() => ({ rows: [] }));
      for (const d of denials.rows) {
        items.push({
          type: 'access_denied', severity: 'info',
          title: `Access denied: ${d.action_id} on ${d.resource_id}`,
          detail: new Date(d.timestamp).toLocaleString(),
          meta: { action_id: d.action_id, resource_id: d.resource_id },
        });
      }
    }

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/audit-logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
  const offset = parseInt(req.query.offset as string) || 0;
  const subject = req.query.subject as string | undefined;
  const action = req.query.action as string | undefined;
  const path = req.query.path as string | undefined;
  try {
    let query = 'SELECT * FROM authz_audit_log WHERE 1=1';
    const params: (string | number)[] = [];
    let idx = 1;
    if (subject) {
      query += ` AND subject_id = $${idx++}`;
      params.push(subject);
    }
    if (action) {
      query += ` AND action_id = $${idx++}`;
      params.push(action);
    }
    if (path && ['A', 'B', 'C'].includes(path)) {
      query += ` AND access_path = $${idx++}`;
      params.push(path);
    }
    query += ` ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
