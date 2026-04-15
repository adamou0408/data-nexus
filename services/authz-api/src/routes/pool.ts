import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { pool, getDataSourcePool } from '../db';
import { audit } from '../audit';
import { syncExternalGrants, syncRemoteCredential, detectRemoteDrift } from '../lib/remote-sync';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';

export const poolRouter = Router();

// List roles that don't have credentials yet (for SSOT dropdown)
poolRouter.get('/uncredentialed-roles', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT dp.pg_role, dp.profile_id, dp.connection_mode, dp.data_source_id
      FROM authz_db_pool_profile dp
      LEFT JOIN authz_pool_credentials pc ON pc.pg_role = dp.pg_role AND pc.is_active = TRUE
      WHERE dp.is_active = TRUE AND pc.pg_role IS NULL
      ORDER BY dp.pg_role
    `);
    res.json(result.rows);
  } catch (err) {
    handleApiError(res, err);
  }
});

// List all pool profiles
poolRouter.get('/profiles', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT dp.*,
        (SELECT count(*)::int FROM authz_db_pool_assignment da
         WHERE da.profile_id = dp.profile_id AND da.is_active) AS assignment_count
      FROM authz_db_pool_profile dp
      ORDER BY dp.profile_id
    `);
    res.json(result.rows);
  } catch (err) {
    handleApiError(res, err);
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
    handleApiError(res, err);
  }
});

// Create pool profile
poolRouter.post('/profiles', async (req, res) => {
  const {
    profile_id, pg_role, allowed_schemas, allowed_tables,
    denied_columns, connection_mode, max_connections = 5,
    ip_whitelist, valid_hours, rls_applies = true, description,
    data_source_id, allowed_modules,
  } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO authz_db_pool_profile
        (profile_id, pg_role, allowed_schemas, allowed_tables,
         denied_columns, connection_mode, max_connections,
         ip_whitelist, valid_hours, rls_applies, description, data_source_id, allowed_modules)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      profile_id, pg_role, allowed_schemas, allowed_tables,
      denied_columns ? JSON.stringify(denied_columns) : null,
      connection_mode, max_connections,
      ip_whitelist, valid_hours, rls_applies, description,
      data_source_id || null,
      allowed_modules || null,
    ]);
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'pool_profile_create', resource_id: profile_id, decision: 'allow', context: { pg_role, connection_mode } });
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_PROFILE', resourceType: 'pool_profile', resourceId: profile_id, details: { pg_role, connection_mode }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
  }
});

// Update pool profile
poolRouter.put('/profiles/:id', async (req, res) => {
  const {
    allowed_schemas, allowed_tables, denied_columns,
    connection_mode, max_connections, ip_whitelist,
    valid_hours, rls_applies, description, is_active,
    data_source_id, allowed_modules,
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
        data_source_id = COALESCE($12, data_source_id),
        allowed_modules = COALESCE($13, allowed_modules),
        updated_at = now()
      WHERE profile_id = $1
      RETURNING *
    `, [
      req.params.id, allowed_schemas, allowed_tables,
      denied_columns ? JSON.stringify(denied_columns) : null,
      connection_mode, max_connections, ip_whitelist,
      valid_hours, rls_applies, description, is_active,
      data_source_id, allowed_modules,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'pool_profile_update', resource_id: req.params.id, decision: 'allow' });
    logAdminAction(pool, { userId: getUserId(req), action: 'UPDATE_PROFILE', resourceType: 'pool_profile', resourceId: req.params.id, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
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
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'pool_profile_delete', resource_id: req.params.id, decision: 'allow' });
    logAdminAction(pool, { userId: getUserId(req), action: 'DELETE_PROFILE', resourceType: 'pool_profile', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ deleted: req.params.id });
  } catch (err) {
    handleApiError(res, err);
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
    handleApiError(res, err);
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
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'pool_assignment_create', resource_id: profile_id, decision: 'allow', context: { subject_id } });
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_ASSIGNMENT', resourceType: 'pool_assignment', resourceId: profile_id, details: { subject_id, granted_by }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
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
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'pool_assignment_delete', resource_id: `assignment:${req.params.id}`, decision: 'allow' });
    logAdminAction(pool, { userId: getUserId(req), action: 'DEACTIVATE_ASSIGNMENT', resourceType: 'pool_assignment', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ deleted: req.params.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

// Reactivate assignment
poolRouter.post('/assignments/:id/reactivate', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE authz_db_pool_assignment SET is_active = TRUE WHERE id = $1 RETURNING id, subject_id, profile_id, is_active',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'pool_assignment_reactivate', resource_id: `assignment:${req.params.id}`, decision: 'allow' });
    logAdminAction(pool, { userId: getUserId(req), action: 'REACTIVATE_ASSIGNMENT', resourceType: 'pool_assignment', resourceId: req.params.id, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
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
    handleApiError(res, err);
  }
});

// Create credential for a PG role
poolRouter.post('/credentials', async (req, res) => {
  const { pg_role, password, rotate_interval = '90 days' } = req.body;
  try {
    const hash = `md5${require('crypto').createHash('md5').update(password + pg_role).digest('hex')}`;
    const result = await pool.query(`
      INSERT INTO authz_pool_credentials (pg_role, password_hash, rotate_interval)
      VALUES ($1, $2, $3::interval)
      RETURNING pg_role, is_active, last_rotated, rotate_interval
    `, [pg_role, hash, rotate_interval]);
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'credential_create', resource_id: `credential:${pg_role}`, decision: 'allow' });
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_CREDENTIAL', resourceType: 'credential', resourceId: pg_role, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
  }
});

// Deactivate credential (soft delete)
poolRouter.delete('/credentials/:pg_role', async (req, res) => {
  const { pg_role } = req.params;
  try {
    const result = await pool.query(
      `UPDATE authz_pool_credentials SET is_active = FALSE WHERE pg_role = $1 RETURNING pg_role`,
      [pg_role]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'credential_deactivate', resource_id: `credential:${pg_role}`, decision: 'allow' });
    logAdminAction(pool, { userId: getUserId(req), action: 'DEACTIVATE_CREDENTIAL', resourceType: 'credential', resourceId: pg_role, ip: getClientIp(req) });
    res.json({ deactivated: pg_role });
  } catch (err) {
    handleApiError(res, err);
  }
});

// Reactivate credential
poolRouter.post('/credentials/:pg_role/reactivate', async (req, res) => {
  const { pg_role } = req.params;
  try {
    const result = await pool.query(
      `UPDATE authz_pool_credentials SET is_active = TRUE WHERE pg_role = $1 RETURNING pg_role, is_active, last_rotated, rotate_interval`,
      [pg_role]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'credential_reactivate', resource_id: `credential:${pg_role}`, decision: 'allow' });
    logAdminAction(pool, { userId: getUserId(req), action: 'REACTIVATE_CREDENTIAL', resourceType: 'credential', resourceId: pg_role, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    handleApiError(res, err);
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

    // Push new password to all linked remote DBs
    let remoteSync: any[] = [];
    try {
      remoteSync = await syncRemoteCredential(pg_role, hash, getUserId(req));
    } catch { /* remote sync failure should not block local rotation */ }

    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'credential_rotate', resource_id: `credential:${pg_role}`, decision: 'allow', context: { remote_sync_count: remoteSync.length } });
    logAdminAction(pool, { userId: getUserId(req), action: 'ROTATE_CREDENTIAL', resourceType: 'credential', resourceId: pg_role, details: { remote_sync_count: remoteSync.length }, ip: getClientIp(req) });
    res.json({ ...result.rows[0], remote_sync: remoteSync });
  } catch (err) {
    handleApiError(res, err);
  }
});

// --- Sync operations ---

// Trigger DB grant sync
poolRouter.post('/sync/grants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM authz_sync_db_grants()');
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'sync_grants', resource_id: 'system:db_grants', decision: 'allow', context: { actions_count: result.rows.length } });
    logAdminAction(pool, { userId: getUserId(req), action: 'SYNC_GRANTS', resourceType: 'system', resourceId: 'db_grants', details: { actions_count: result.rows.length }, ip: getClientIp(req) });
    res.json({ actions: result.rows });
  } catch (err) {
    handleApiError(res, err);
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
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'sync_pgbouncer', resource_id: `datasource:${data_source_id || 'default'}`, decision: 'allow', context: { db_host, db_port, db_name } });
    logAdminAction(pool, { userId: getUserId(req), action: 'SYNC_PGBOUNCER', resourceType: 'system', resourceId: data_source_id || 'default', details: { db_host, db_port, db_name }, ip: getClientIp(req) });
    res.json({ config: result.rows[0].config });
  } catch (err) {
    handleApiError(res, err);
  }
});

// Apply pgbouncer config + live reload
// 1. Generate config from SSOT (authz_db_pool_profile)
// 2. Write to pgbouncer.ini on the Docker volume
// 3. Send RELOAD via pgbouncer admin console
poolRouter.post('/sync/pgbouncer/apply', async (req, res) => {
  const pgbouncerHost = process.env.PGBOUNCER_HOST || 'localhost';
  const pgbouncerPort = parseInt(process.env.PGBOUNCER_PORT || '6432');
  const configPath = process.env.PGBOUNCER_CONFIG_PATH
    || path.resolve(__dirname, '../../../../deploy/docker-compose/pgbouncer/pgbouncer.ini');

  try {
    // Step 1: Generate [databases] section from SSOT
    const result = await pool.query(
      'SELECT authz_sync_pgbouncer_config($1, $2, $3) AS config',
      ['postgres', 5432, 'nexus_data']
    );
    const generatedDatabases = result.rows[0].config;

    // Step 2: Read existing config to preserve [pgbouncer] static settings
    let existingConfig = '';
    try { existingConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* first write */ }

    // Extract the [pgbouncer] section from existing config (keep static settings)
    const pgbouncerMatch = existingConfig.match(/\[pgbouncer\][\s\S]*/);
    const pgbouncerSection = pgbouncerMatch ? pgbouncerMatch[0] : `[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 20
max_client_conn = 200
admin_users = nexus_admin
stats_users = nexus_admin
`;

    // Extract only [databases] from generated config
    const dbMatch = generatedDatabases.match(/\[databases\][\s\S]*?(?=\[pgbouncer\]|$)/);
    const dbSection = dbMatch ? dbMatch[0].trim() : generatedDatabases.split('[pgbouncer]')[0].trim();

    // Merge: generated [databases] + static [pgbouncer]
    const finalConfig = dbSection + '\n\n' + pgbouncerSection;

    // Step 3: Write merged config file
    fs.writeFileSync(configPath, finalConfig, 'utf-8');

    // Step 3: Reload pgbouncer
    // Use docker exec to send SIGHUP (admin console requires special auth setup)
    let reloadResult = 'config_written';
    try {
      const { execSync } = require('child_process');
      const containerName = process.env.PGBOUNCER_CONTAINER || 'docker-compose-pgbouncer-1';
      execSync(`docker kill --signal=HUP ${containerName}`, { timeout: 5000 });
      reloadResult = 'ok';
    } catch (reloadErr) {
      // Config is written even if reload fails — manual restart will pick it up
      reloadResult = `config_written_reload_pending: ${String(reloadErr)}`;
    }

    audit({
      access_path: 'B',
      subject_id: getUserId(req),
      action_id: 'apply_pgbouncer',
      resource_id: 'system:pgbouncer',
      decision: 'allow',
      context: { configPath, reloadResult },
    });
    logAdminAction(pool, { userId: getUserId(req), action: 'APPLY_PGBOUNCER', resourceType: 'system', resourceId: 'pgbouncer', details: { configPath, reloadResult }, ip: getClientIp(req) });

    res.json({
      applied: true,
      config_path: configPath,
      reload: reloadResult,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// --- External DB Grant Sync ---

// Sync grants to external databases
poolRouter.post('/sync/external-grants', async (req, res) => {
  const { data_source_id } = req.body;
  try {
    const actions = await syncExternalGrants(data_source_id, getUserId(req));
    logAdminAction(pool, { userId: getUserId(req), action: 'SYNC_EXTERNAL_GRANTS', resourceType: 'system', resourceId: data_source_id || 'all', details: { actions_count: actions.length }, ip: getClientIp(req) });
    res.json({ actions });
  } catch (err) {
    handleApiError(res, err);
  }
});

// Detect drift between SSOT and remote DB grants
poolRouter.post('/sync/external-grants/drift', async (req, res) => {
  const { data_source_id } = req.body;
  if (!data_source_id) {
    return res.status(400).json({ error: 'data_source_id is required' });
  }
  try {
    const report = await detectRemoteDrift(data_source_id);
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'detect_drift', resource_id: `datasource:${data_source_id}`, decision: 'allow', context: { drift_items: report.items.length } });
    res.json(report);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ============================================================
// Metabase BI integration info (SSOT from pool profiles + data sources)
// Returns connection templates for each pool role — admin uses these to
// configure Metabase DB connections. No Metabase-specific data stored in DB.
// ============================================================
poolRouter.get('/metabase-connections', async (_req, res) => {
  try {
    // SSOT: pool profiles
    const profiles = await pool.query(`
      SELECT dp.profile_id, dp.pg_role, dp.description, dp.is_active,
             dp.allowed_tables, dp.denied_columns, dp.connection_mode,
             dp.data_source_id,
             ds.display_name AS ds_name, ds.host AS ds_host, ds.port AS ds_port, ds.database_name
      FROM authz_db_pool_profile dp
      LEFT JOIN authz_data_source ds ON ds.source_id = dp.data_source_id
      WHERE dp.is_active
      ORDER BY dp.profile_id
    `);

    const metabaseUrl = process.env.METABASE_URL || 'http://localhost:3100';
    const pgbouncerHost = process.env.PGBOUNCER_HOST || 'localhost';
    const pgbouncerPort = parseInt(process.env.PGBOUNCER_PORT || '6432');

    const connections = profiles.rows.map((p: any) => ({
      profile_id: p.profile_id,
      pg_role: p.pg_role,
      description: p.description,
      data_source: p.ds_name || 'default',
      database: p.database_name || 'nexus_data',
      // Connection template for Metabase setup
      metabase_config: {
        engine: 'postgres',
        host: pgbouncerHost,
        port: pgbouncerPort,
        dbname: p.database_name || 'nexus_data',
        user: p.pg_role,
        // Password not included — admin must look up from pgbouncer userlist
      },
      access_scope: {
        allowed_tables: p.allowed_tables,
        denied_columns: p.denied_columns,
        connection_mode: p.connection_mode,
      },
    }));

    res.json({
      metabase_url: metabaseUrl,
      pgbouncer: { host: pgbouncerHost, port: pgbouncerPort },
      connections,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});
