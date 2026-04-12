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

browseRouter.get('/audit-logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
  const offset = parseInt(req.query.offset as string) || 0;
  const subject = req.query.subject as string | undefined;
  const action = req.query.action as string | undefined;
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
    query += ` ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
