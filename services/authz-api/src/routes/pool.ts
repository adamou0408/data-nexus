import { Router } from 'express';
import { pool, getDataSourcePool } from '../db';

export const poolRouter = Router();

// List all pool profiles
poolRouter.get('/profiles', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT dp.*,
        (SELECT count(*) FROM authz_db_pool_assignment da
         WHERE da.profile_id = dp.profile_id AND da.is_active) AS assignment_count
      FROM authz_db_pool_profile dp
      ORDER BY dp.profile_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Get single pool profile
poolRouter.get('/profiles/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM authz_db_pool_profile WHERE profile_id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Create pool profile
poolRouter.post('/profiles', async (req, res) => {
  const {
    profile_id, pg_role, allowed_schemas, allowed_tables,
    denied_columns, connection_mode, max_connections = 5,
    ip_whitelist, valid_hours, rls_applies = true, description,
  } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO authz_db_pool_profile
        (profile_id, pg_role, allowed_schemas, allowed_tables,
         denied_columns, connection_mode, max_connections,
         ip_whitelist, valid_hours, rls_applies, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      profile_id, pg_role, allowed_schemas, allowed_tables,
      denied_columns ? JSON.stringify(denied_columns) : null,
      connection_mode, max_connections,
      ip_whitelist, valid_hours, rls_applies, description,
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Update pool profile
poolRouter.put('/profiles/:id', async (req, res) => {
  const {
    allowed_schemas, allowed_tables, denied_columns,
    connection_mode, max_connections, ip_whitelist,
    valid_hours, rls_applies, description, is_active,
  } = req.body;
  try {
    const result = await pool.query(`
      UPDATE authz_db_pool_profile SET
        allowed_schemas = COALESCE($2, allowed_schemas),
        allowed_tables = COALESCE($3, allowed_tables),
        denied_columns = COALESCE($4, denied_columns),
        connection_mode = COALESCE($5, connection_mode),
        max_connections = COALESCE($6, max_connections),
        ip_whitelist = COALESCE($7, ip_whitelist),
        valid_hours = COALESCE($8, valid_hours),
        rls_applies = COALESCE($9, rls_applies),
        description = COALESCE($10, description),
        is_active = COALESCE($11, is_active),
        updated_at = now()
      WHERE profile_id = $1
      RETURNING *
    `, [
      req.params.id, allowed_schemas, allowed_tables,
      denied_columns ? JSON.stringify(denied_columns) : null,
      connection_mode, max_connections, ip_whitelist,
      valid_hours, rls_applies, description, is_active,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Delete (soft) pool profile
poolRouter.delete('/profiles/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE authz_db_pool_profile SET is_active = FALSE, updated_at = now() WHERE profile_id = $1 RETURNING profile_id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Pool Assignments ---

// List assignments for a profile
poolRouter.get('/profiles/:id/assignments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT da.*, s.display_name AS subject_name
      FROM authz_db_pool_assignment da
      JOIN authz_subject s ON s.subject_id = da.subject_id
      WHERE da.profile_id = $1
      ORDER BY da.subject_id
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Assign subject to pool
poolRouter.post('/assignments', async (req, res) => {
  const { subject_id, profile_id, granted_by = 'api' } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO authz_db_pool_assignment (subject_id, profile_id, granted_by)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [subject_id, profile_id, granted_by]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Remove assignment (soft delete)
poolRouter.delete('/assignments/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE authz_db_pool_assignment SET is_active = FALSE WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Pool Credentials ---

// List credentials (without password_hash)
poolRouter.get('/credentials', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT pg_role, is_active, last_rotated, rotate_interval
      FROM authz_pool_credentials
      ORDER BY pg_role
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Rotate credential password
poolRouter.post('/credentials/:pg_role/rotate', async (req, res) => {
  const { new_password } = req.body;
  const { pg_role } = req.params;
  try {
    const hash = `md5${require('crypto').createHash('md5').update(new_password + pg_role).digest('hex')}`;
    const result = await pool.query(`
      UPDATE authz_pool_credentials
      SET password_hash = $2, last_rotated = now()
      WHERE pg_role = $1
      RETURNING pg_role, is_active, last_rotated
    `, [pg_role, hash]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Sync operations ---

// Trigger DB grant sync
poolRouter.post('/sync/grants', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM authz_sync_db_grants()');
    res.json({ actions: result.rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Generate pgbouncer config
// Accepts optional data_source_id to read connection info from registry
poolRouter.post('/sync/pgbouncer', async (req, res) => {
  let { db_host, db_port, db_name, data_source_id } = req.body;

  // If data_source_id provided, read connection info from registry
  if (data_source_id) {
    try {
      const dsResult = await pool.query(
        'SELECT host, port, database_name FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
        [data_source_id]
      );
      if (dsResult.rows.length > 0) {
        const ds = dsResult.rows[0];
        db_host = db_host || ds.host;
        db_port = db_port || ds.port;
        db_name = db_name || ds.database_name;
      }
    } catch { /* fall through to defaults */ }
  }

  db_host = db_host || 'localhost';
  db_port = db_port || 5432;
  db_name = db_name || 'nexus_data';

  try {
    const result = await pool.query(
      'SELECT authz_sync_pgbouncer_config($1, $2, $3) AS config',
      [db_host, db_port, db_name]
    );
    res.json({ config: result.rows[0].config });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
