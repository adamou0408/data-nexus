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

browseRouter.get('/resources', async (req, res) => {
  try {
    const typeFilter = req.query.type as string | undefined;
    const result = typeFilter
      ? await pool.query('SELECT * FROM authz_resource WHERE is_active = TRUE AND resource_type = $1 ORDER BY resource_id', [typeFilter])
      : await pool.query('SELECT * FROM authz_resource WHERE is_active = TRUE ORDER BY resource_id');
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

// --- User profiles for frontend login selector ---
// Returns user subjects with their groups and attributes (replaces hardcoded TEST_USERS)
browseRouter.get('/subjects/profiles', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.subject_id,
             s.display_name,
             s.subject_type,
             s.attributes,
             COALESCE(
               (SELECT array_agg(replace(gm.group_id, 'group:', ''))
                FROM authz_group_member gm WHERE gm.user_id = s.subject_id),
               ARRAY[]::TEXT[]
             ) AS groups
      FROM authz_subject s
      WHERE s.subject_type IN ('user', 'service_account')
        AND s.is_active = TRUE
      ORDER BY s.subject_id
    `);

    // Transform to frontend UserProfile format
    const profiles = result.rows.map((r: { subject_id: string; display_name: string; subject_type: string; attributes: Record<string, string> | null; groups: string[] }) => {
      // Strip "user:" prefix but keep "svc:" prefix for service accounts
      let id = r.subject_id;
      if (id.startsWith('user:')) id = id.slice(5);
      return {
        id,
        label: r.display_name,
        groups: r.groups,
        attrs: r.attributes || {},
      };
    });

    res.json(profiles);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Batch checks: generate representative permission test cases from DB ---
browseRouter.get('/batch-checks', async (_req, res) => {
  try {
    // Get all active resources grouped by type, pick representative samples
    const resources = await pool.query(`
      SELECT resource_id, resource_type
      FROM authz_resource
      WHERE is_active = TRUE
      ORDER BY resource_type, resource_id
    `);

    // Get all active actions
    const actions = await pool.query(`
      SELECT action_id FROM authz_action WHERE is_active = TRUE ORDER BY action_id
    `);

    const actionIds = actions.rows.map((a: { action_id: string }) => a.action_id);

    // Build checks: for each resource type, pick up to N resources and pair with relevant actions
    const checks: { action: string; resource: string }[] = [];
    const byType: Record<string, string[]> = {};
    for (const r of resources.rows as { resource_id: string; resource_type: string }[]) {
      if (!byType[r.resource_type]) byType[r.resource_type] = [];
      byType[r.resource_type].push(r.resource_id);
    }

    // Action relevance by resource type
    const typeActions: Record<string, string[]> = {
      module: ['read', 'write', 'approve', 'export', 'connect'],
      table:  ['read', 'write'],
      column: ['read'],
      web_page: ['read'],
      web_api: ['read', 'execute'],
    };

    for (const [type, resourceIds] of Object.entries(byType)) {
      const relevantActions = (typeActions[type] || ['read']).filter(a => actionIds.includes(a));
      // Pick up to 5 resources per type
      const sample = resourceIds.slice(0, 5);
      for (const rid of sample) {
        for (const aid of relevantActions) {
          checks.push({ action: aid, resource: rid });
        }
      }
    }

    res.json(checks);
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
    // 0. Module permission gate: check if user can read this table (hierarchical walk)
    if (user_id) {
      const tableResource = `table:${table}`;
      const gateResult = await pool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [user_id, groups, 'read', tableResource]
      );
      if (!gateResult.rows[0]?.allowed) {
        return res.status(403).json({ error: `Access denied: ${user_id} cannot read ${tableResource}` });
      }
    }

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const columns: any[] = schemaResult.rows.map((col: Record<string, unknown>) => {
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
    const selectParts = columns.map(col => {
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
    const usedFns = [...new Set(columns.filter(c => c.mask_function).map(c => c.mask_function as string))];
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
// When user_id + groups provided: filter by module permission (authz_check)
browseRouter.get('/tables', async (req, res) => {
  const userId = req.query.user_id as string | undefined;
  const groups = req.query.groups ? (req.query.groups as string).split(',') : [];

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

    // If user context provided, filter by module permission
    if (userId) {
      const filtered = [];
      for (const row of result.rows as { table_name: string; column_count: string }[]) {
        const resourceId = `table:${row.table_name}`;
        const checkResult = await pool.query(
          'SELECT authz_check($1, $2, $3, $4) AS allowed',
          [userId, groups, 'read', resourceId]
        );
        if (checkResult.rows[0]?.allowed) {
          filtered.push(row);
        }
      }
      return res.json(filtered);
    }

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

// ============================================================
// CRUD Operations for AuthZ Entities (Admin only)
// ============================================================

// --- Subjects CRUD ---
browseRouter.post('/subjects', async (req, res) => {
  const { subject_id, subject_type, display_name, ldap_dn, attributes } = req.body;
  if (!subject_id || !subject_type || !display_name) {
    return res.status(400).json({ error: 'subject_id, subject_type, and display_name are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn, attributes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [subject_id, subject_type, display_name, ldap_dn || null, JSON.stringify(attributes || {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.put('/subjects/:id', async (req, res) => {
  const { display_name, ldap_dn, attributes, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_subject SET display_name = COALESCE($2, display_name),
        ldap_dn = COALESCE($3, ldap_dn), attributes = COALESCE($4::jsonb, attributes),
        is_active = COALESCE($5, is_active), updated_at = now()
       WHERE subject_id = $1 RETURNING *`,
      [req.params.id, display_name, ldap_dn, attributes ? JSON.stringify(attributes) : null, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.delete('/subjects/:id', async (req, res) => {
  try {
    await pool.query('UPDATE authz_subject SET is_active = FALSE, updated_at = now() WHERE subject_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Subject group membership
browseRouter.post('/subjects/:id/groups', async (req, res) => {
  const { group_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO authz_group_member (group_id, user_id, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [group_id, req.params.id, 'manual']
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.delete('/subjects/:id/groups/:groupId', async (req, res) => {
  try {
    await pool.query('DELETE FROM authz_group_member WHERE group_id = $1 AND user_id = $2', [req.params.groupId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Subject role assignment
browseRouter.post('/subjects/:id/roles', async (req, res) => {
  const { role_id, valid_from, valid_until, granted_by } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO authz_subject_role (subject_id, role_id, valid_from, valid_until, granted_by)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4::timestamptz, $5)
       ON CONFLICT (subject_id, role_id) DO UPDATE SET is_active = TRUE, valid_from = COALESCE($3::timestamptz, now()), valid_until = $4::timestamptz
       RETURNING *`,
      [req.params.id, role_id, valid_from || null, valid_until || null, granted_by || 'admin_ui']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.delete('/subjects/:id/roles/:roleId', async (req, res) => {
  try {
    await pool.query(
      'UPDATE authz_subject_role SET is_active = FALSE WHERE subject_id = $1 AND role_id = $2',
      [req.params.id, req.params.roleId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Roles CRUD ---
browseRouter.post('/roles', async (req, res) => {
  const { role_id, display_name, description, is_system } = req.body;
  if (!role_id || !display_name) {
    return res.status(400).json({ error: 'role_id and display_name are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO authz_role (role_id, display_name, description, is_system) VALUES ($1, $2, $3, $4) RETURNING *',
      [role_id, display_name, description || null, is_system ?? false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.put('/roles/:id', async (req, res) => {
  const { display_name, description, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_role SET display_name = COALESCE($2, display_name),
        description = COALESCE($3, description), is_active = COALESCE($4, is_active)
       WHERE role_id = $1 RETURNING *`,
      [req.params.id, display_name, description, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Role not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.delete('/roles/:id', async (req, res) => {
  try {
    await pool.query('UPDATE authz_role SET is_active = FALSE WHERE role_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Role permissions
browseRouter.get('/roles/:id/permissions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rp.*, ar.display_name AS resource_name, aa.display_name AS action_name
       FROM authz_role_permission rp
       LEFT JOIN authz_resource ar ON ar.resource_id = rp.resource_id
       LEFT JOIN authz_action aa ON aa.action_id = rp.action_id
       WHERE rp.role_id = $1 AND rp.is_active = TRUE
       ORDER BY rp.resource_id, rp.action_id`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.post('/roles/:id/permissions', async (req, res) => {
  const { action_id, resource_id, effect } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (role_id, action_id, resource_id) DO UPDATE SET effect = $4, is_active = TRUE
       RETURNING *`,
      [req.params.id, action_id, resource_id, effect || 'allow']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.delete('/roles/:id/permissions/:permId', async (req, res) => {
  try {
    await pool.query('UPDATE authz_role_permission SET is_active = FALSE WHERE id = $1 AND role_id = $2', [req.params.permId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Resources: Unmapped tables for a data source ---
browseRouter.get('/resources/unmapped', async (req, res) => {
  const dsId = req.query.data_source_id as string;
  if (!dsId) return res.status(400).json({ error: 'data_source_id query param required' });
  try {
    const result = await pool.query(`
      SELECT resource_id, resource_type, parent_id, display_name, attributes, is_active, created_at
      FROM authz_resource
      WHERE resource_type = 'table'
        AND parent_id IS NULL
        AND is_active = TRUE
        AND attributes->>'data_source_id' = $1
      ORDER BY resource_id
    `, [dsId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Resources: Mapped tables for a data source ---
browseRouter.get('/resources/mapped', async (req, res) => {
  const dsId = req.query.data_source_id as string;
  if (!dsId) return res.status(400).json({ error: 'data_source_id query param required' });
  try {
    const result = await pool.query(`
      SELECT r.resource_id, r.resource_type, r.parent_id, r.display_name, r.attributes,
             p.display_name AS module_name
      FROM authz_resource r
      LEFT JOIN authz_resource p ON p.resource_id = r.parent_id
      WHERE r.resource_type = 'table'
        AND r.parent_id IS NOT NULL
        AND r.is_active = TRUE
        AND r.attributes->>'data_source_id' = $1
      ORDER BY r.parent_id, r.resource_id
    `, [dsId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Resources: Bulk update parent_id (table-to-module mapping) ---
browseRouter.put('/resources/bulk-parent', async (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return res.status(400).json({ error: 'mappings array required: [{resource_id, parent_id}]' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let updated = 0;
    for (const m of mappings) {
      const result = await client.query(
        'UPDATE authz_resource SET parent_id = $2, updated_at = now() WHERE resource_id = $1 AND is_active = TRUE',
        [m.resource_id, m.parent_id || null]
      );
      updated += result.rowCount || 0;
    }
    await client.query('COMMIT');
    res.json({ updated });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: String(err) });
  } finally {
    client.release();
  }
});

// --- Resources CRUD ---
browseRouter.post('/resources', async (req, res) => {
  const { resource_id, resource_type, display_name, parent_id, attributes } = req.body;
  if (!resource_id || !resource_type || !display_name) {
    return res.status(400).json({ error: 'resource_id, resource_type, and display_name are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [resource_id, resource_type, parent_id || null, display_name, JSON.stringify(attributes || {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.put('/resources/:id', async (req, res) => {
  const { display_name, parent_id, attributes, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_resource SET display_name = COALESCE($2, display_name),
        parent_id = COALESCE($3, parent_id), attributes = COALESCE($4::jsonb, attributes),
        is_active = COALESCE($5, is_active), updated_at = now()
       WHERE resource_id = $1 RETURNING *`,
      [req.params.id, display_name, parent_id, attributes ? JSON.stringify(attributes) : null, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.delete('/resources/:id', async (req, res) => {
  try {
    await pool.query('UPDATE authz_resource SET is_active = FALSE, updated_at = now() WHERE resource_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Policies CRUD ---
browseRouter.post('/policies', async (req, res) => {
  const { policy_name, description, granularity, priority, effect, status, applicable_paths,
    subject_condition, resource_condition, action_condition, environment_condition,
    rls_expression, column_mask_rules, created_by } = req.body;
  if (!policy_name || !granularity) {
    return res.status(400).json({ error: 'policy_name and granularity are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO authz_policy (policy_name, description, granularity, priority, effect, status,
        applicable_paths, subject_condition, resource_condition, action_condition,
        environment_condition, rls_expression, column_mask_rules, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [policy_name, description, granularity, priority || 100, effect || 'allow',
        status || 'active', applicable_paths || ['A','B','C'],
        JSON.stringify(subject_condition || {}), JSON.stringify(resource_condition || {}),
        JSON.stringify(action_condition || {}), JSON.stringify(environment_condition || {}),
        rls_expression || null, column_mask_rules ? JSON.stringify(column_mask_rules) : null,
        created_by || 'admin_ui']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.put('/policies/:id', async (req, res) => {
  const { description, priority, effect, status, applicable_paths,
    subject_condition, resource_condition, action_condition, environment_condition,
    rls_expression, column_mask_rules } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_policy SET
        description = COALESCE($2, description), priority = COALESCE($3, priority),
        effect = COALESCE($4, effect), status = COALESCE($5, status),
        applicable_paths = COALESCE($6, applicable_paths),
        subject_condition = COALESCE($7::jsonb, subject_condition),
        resource_condition = COALESCE($8::jsonb, resource_condition),
        action_condition = COALESCE($9::jsonb, action_condition),
        environment_condition = COALESCE($10::jsonb, environment_condition),
        rls_expression = COALESCE($11, rls_expression),
        column_mask_rules = COALESCE($12::jsonb, column_mask_rules),
        updated_at = now()
       WHERE policy_id = $1 RETURNING *`,
      [req.params.id, description, priority, effect, status,
        applicable_paths, subject_condition ? JSON.stringify(subject_condition) : null,
        resource_condition ? JSON.stringify(resource_condition) : null,
        action_condition ? JSON.stringify(action_condition) : null,
        environment_condition ? JSON.stringify(environment_condition) : null,
        rls_expression, column_mask_rules ? JSON.stringify(column_mask_rules) : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Policy not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.delete('/policies/:id', async (req, res) => {
  try {
    await pool.query("UPDATE authz_policy SET status = 'inactive', updated_at = now() WHERE policy_id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Actions CRUD ---
browseRouter.post('/actions', async (req, res) => {
  const { action_id, display_name, description, applicable_paths } = req.body;
  if (!action_id || !display_name) {
    return res.status(400).json({ error: 'action_id and display_name are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO authz_action (action_id, display_name, description, applicable_paths) VALUES ($1, $2, $3, $4) RETURNING *',
      [action_id, display_name, description || null, applicable_paths || ['A','B','C']]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.put('/actions/:id', async (req, res) => {
  const { display_name, description, applicable_paths, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_action SET display_name = COALESCE($2, display_name),
        description = COALESCE($3, description), applicable_paths = COALESCE($4, applicable_paths),
        is_active = COALESCE($5, is_active)
       WHERE action_id = $1 RETURNING *`,
      [req.params.id, display_name, description, applicable_paths, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Action not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.delete('/actions/:id', async (req, res) => {
  try {
    await pool.query('UPDATE authz_action SET is_active = FALSE WHERE action_id = $1', [req.params.id]);
    res.json({ ok: true });
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
