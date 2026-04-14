import { Router } from 'express';
import { Pool } from 'pg';
import { pool as authzPool, evictDataSourcePool } from '../db';
import { audit } from '../audit';
import { encrypt, decrypt } from '../lib/crypto';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp } from '../lib/request-helpers';

export const datasourceRouter = Router();

// ─── List all data sources ───
datasourceRouter.get('/', async (_req, res) => {
  try {
    const result = await authzPool.query(`
      SELECT source_id, display_name, description, db_type,
             host, port, database_name, schemas,
             connector_user,
             owner_subject, registered_by, is_active,
             last_synced_at, created_at, updated_at
      FROM authz_data_source
      ORDER BY created_at
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Lifecycle summary for all data sources ───
datasourceRouter.get('/lifecycle-summary', async (_req, res) => {
  try {
    const result = await authzPool.query(`
      SELECT ds.source_id, ds.display_name, ds.db_type, ds.host, ds.port,
             ds.database_name, ds.is_active, ds.last_synced_at,
             coalesce(t.total, 0) AS tables,
             coalesce(t.mapped, 0) AS mapped,
             coalesce(t.unmapped, 0) AS unmapped,
             coalesce(p.total, 0) AS profile_count,
             coalesce(cs.credentialed, 0) AS credentialed,
             coalesce(cs.uncredentialed, 0) AS uncredentialed
      FROM authz_data_source ds
      LEFT JOIN LATERAL (
        SELECT count(*) AS total,
               count(*) FILTER (WHERE parent_id IS NULL) AS unmapped,
               count(*) FILTER (WHERE parent_id IS NOT NULL) AS mapped
        FROM authz_resource
        WHERE resource_type = 'table' AND is_active = TRUE
          AND attributes->>'data_source_id' = ds.source_id
      ) t ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS total
        FROM authz_db_pool_profile
        WHERE data_source_id = ds.source_id AND is_active = TRUE
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE pc.pg_role IS NOT NULL) AS credentialed,
          count(*) FILTER (WHERE pc.pg_role IS NULL) AS uncredentialed
        FROM authz_db_pool_profile dp
        LEFT JOIN authz_pool_credentials pc ON pc.pg_role = dp.pg_role AND pc.is_active = TRUE
        WHERE dp.data_source_id = ds.source_id AND dp.is_active = TRUE
      ) cs ON true
      ORDER BY ds.created_at
    `);

    const summaries = result.rows.map((r: any) => {
      const tables = Number(r.tables);
      const mapped = Number(r.mapped);
      const unmapped = Number(r.unmapped);
      const profileCount = Number(r.profile_count);
      const credentialed = Number(r.credentialed);
      const uncredentialed = Number(r.uncredentialed);

      let done = 0;
      if (r.is_active) done++;
      if (tables > 0) done++;
      if (tables > 0 && unmapped === 0) done++;
      if (profileCount > 0) done++;
      if (profileCount > 0 && uncredentialed === 0 && credentialed > 0) done++;
      if (r.last_synced_at) done++;

      let next_action = 'Complete';
      if (!r.is_active) next_action = 'Activate Connection';
      else if (tables === 0) next_action = 'Run Discovery';
      else if (unmapped > 0) next_action = `Map ${unmapped} Tables`;
      else if (profileCount === 0) next_action = 'Create Profiles';
      else if (uncredentialed > 0) next_action = `Set ${uncredentialed} Credentials`;
      else if (!r.last_synced_at) next_action = 'Run Sync';

      return {
        source_id: r.source_id,
        display_name: r.display_name,
        db_type: r.db_type,
        host: r.host,
        port: r.port,
        database_name: r.database_name,
        is_active: r.is_active,
        phases_done: done,
        phases_total: 6,
        next_action,
      };
    });

    res.json(summaries);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Get single data source ───
datasourceRouter.get('/:id', async (req, res) => {
  try {
    const result = await authzPool.query(
      `SELECT source_id, display_name, description, db_type,
              host, port, database_name, schemas,
              connector_user,
              owner_subject, registered_by, is_active,
              last_synced_at, created_at, updated_at
       FROM authz_data_source WHERE source_id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Register new data source ───
datasourceRouter.post('/', async (req, res) => {
  const {
    source_id, display_name, description,
    db_type = 'postgresql', host, port = 5432,
    database_name, schemas = ['public'],
    connector_user, connector_password,
    owner_subject, registered_by = 'api',
  } = req.body;

  // Step 1: Test connection
  const testPool = new Pool({
    host, port, database: database_name,
    user: connector_user,
    ...(connector_password ? { password: connector_password } : {}),
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    await testPool.query('SELECT 1');
  } catch (err) {
    await testPool.end();
    return res.status(400).json({
      error: 'Connection test failed',
      detail: String(err),
    });
  }
  await testPool.end();

  // Step 2: Save to authz_data_source
  try {
    const result = await authzPool.query(`
      INSERT INTO authz_data_source (
        source_id, display_name, description,
        db_type, host, port, database_name, schemas,
        connector_user, connector_password,
        owner_subject, registered_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING source_id, display_name, host, port, database_name, schemas, created_at
    `, [
      source_id, display_name, description,
      db_type, host, port, database_name, schemas,
      connector_user, connector_password ? encrypt(connector_password) : null, // SEC-04: encrypt before storage
      owner_subject, registered_by,
    ]);

    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_register', resource_id: source_id, decision: 'allow', context: { host, port, database_name } });
    logAdminAction(authzPool, { userId: getUserId(req), action: 'CREATE_DATASOURCE', resourceType: 'data_source', resourceId: source_id, details: { host, port, database_name }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Update data source ───
datasourceRouter.put('/:id', async (req, res) => {
  const {
    display_name, description, host, port,
    database_name, schemas, connector_user,
    connector_password, owner_subject, is_active,
  } = req.body;

  try {
    const result = await authzPool.query(`
      UPDATE authz_data_source SET
        display_name = COALESCE($2, display_name),
        description = COALESCE($3, description),
        host = COALESCE($4, host),
        port = COALESCE($5, port),
        database_name = COALESCE($6, database_name),
        schemas = COALESCE($7, schemas),
        connector_user = COALESCE($8, connector_user),
        connector_password = COALESCE($9, connector_password),
        owner_subject = COALESCE($10, owner_subject),
        is_active = COALESCE($11, is_active),
        updated_at = now()
      WHERE source_id = $1
      RETURNING source_id, display_name, host, port, database_name, updated_at
    `, [
      req.params.id, display_name, description,
      host, port, database_name, schemas,
      connector_user, connector_password ? encrypt(connector_password) : undefined, // SEC-04
      owner_subject, is_active,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    evictDataSourcePool(req.params.id);
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_update', resource_id: req.params.id, decision: 'allow' });
    logAdminAction(authzPool, { userId: getUserId(req), action: 'UPDATE_DATASOURCE', resourceType: 'data_source', resourceId: req.params.id, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Deactivate data source ───
datasourceRouter.delete('/:id', async (req, res) => {
  try {
    const result = await authzPool.query(
      `UPDATE authz_data_source SET is_active = FALSE, updated_at = now()
       WHERE source_id = $1 RETURNING source_id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }
    evictDataSourcePool(req.params.id);
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_deactivate', resource_id: req.params.id, decision: 'allow' });
    logAdminAction(authzPool, { userId: getUserId(req), action: 'DEACTIVATE_DATASOURCE', resourceType: 'data_source', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ deactivated: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Purge data source (hard delete, only if inactive) ───
datasourceRouter.delete('/:id/purge', async (req, res) => {
  const client = await authzPool.connect();
  try {
    // Verify source exists and is inactive
    const check = await client.query(
      'SELECT source_id, is_active FROM authz_data_source WHERE source_id = $1',
      [req.params.id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }
    if (check.rows[0].is_active) {
      return res.status(400).json({ error: 'Cannot purge an active data source. Deactivate it first.' });
    }

    await client.query('BEGIN');

    // 1. Delete discovered column resources
    const colResult = await client.query(
      `DELETE FROM authz_resource
       WHERE resource_type = 'column' AND attributes->>'data_source_id' = $1`,
      [req.params.id]
    );

    // 2. Delete discovered table, view, and function resources
    const tblResult = await client.query(
      `DELETE FROM authz_resource
       WHERE resource_type IN ('table', 'view', 'function') AND attributes->>'data_source_id' = $1`,
      [req.params.id]
    );

    // 3. Delete pool profile assignments for this DS's profiles
    await client.query(
      `DELETE FROM authz_pool_assignment
       WHERE profile_id IN (
         SELECT profile_id FROM authz_db_pool_profile WHERE data_source_id = $1
       )`,
      [req.params.id]
    );

    // 4. Delete pool profiles linked to this DS
    const profResult = await client.query(
      'DELETE FROM authz_db_pool_profile WHERE data_source_id = $1',
      [req.params.id]
    );

    // 5. Delete the data source record
    await client.query(
      'DELETE FROM authz_data_source WHERE source_id = $1',
      [req.params.id]
    );

    await client.query('COMMIT');

    evictDataSourcePool(req.params.id);
    audit({
      access_path: 'B', subject_id: getUserId(req),
      action_id: 'datasource_purge', resource_id: req.params.id,
      decision: 'allow',
      context: {
        columns_deleted: colResult.rowCount,
        tables_deleted: tblResult.rowCount,
        profiles_deleted: profResult.rowCount,
      },
    });
    logAdminAction(authzPool, { userId: getUserId(req), action: 'PURGE_DATASOURCE', resourceType: 'data_source', resourceId: req.params.id, details: { columns_deleted: colResult.rowCount, tables_deleted: tblResult.rowCount, profiles_deleted: profResult.rowCount }, ip: getClientIp(req) });

    res.json({
      purged: req.params.id,
      columns_deleted: colResult.rowCount,
      tables_deleted: tblResult.rowCount,
      profiles_deleted: profResult.rowCount,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: String(err) });
  } finally {
    client.release();
  }
});

// ─── Test connection ───
datasourceRouter.post('/:id/test', async (req, res) => {
  try {
    const dsResult = await authzPool.query(
      'SELECT * FROM authz_data_source WHERE source_id = $1',
      [req.params.id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }
    const ds = dsResult.rows[0];

    const testPool = new Pool({
      host: ds.host, port: ds.port, database: ds.database_name,
      user: ds.connector_user, ...(ds.connector_password ? { password: decrypt(ds.connector_password) } : {}),
      max: 1, connectionTimeoutMillis: 5000,
    });

    try {
      const versionResult = await testPool.query('SELECT version()');
      res.json({
        status: 'ok',
        version: versionResult.rows[0].version,
        host: ds.host,
        port: ds.port,
        database: ds.database_name,
      });
    } catch (err) {
      res.status(400).json({ status: 'failed', error: String(err) });
    } finally {
      await testPool.end();
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Discover schema → auto-create authz_resource entries ───
datasourceRouter.post('/:id/discover', async (req, res) => {
  try {
    const dsResult = await authzPool.query(
      'SELECT * FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
      [req.params.id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found or inactive' });
    }
    const ds = dsResult.rows[0];

    // Connect to the target data source
    const dsPool = new Pool({
      host: ds.host, port: ds.port, database: ds.database_name,
      user: ds.connector_user, ...(ds.connector_password ? { password: decrypt(ds.connector_password) } : {}),
      max: 1, connectionTimeoutMillis: 15000,
    });

    try {
      await dsPool.query("SET statement_timeout = '90s'");

      // Get tables and views from allowed schemas
      const tablesResult = await dsPool.query(`
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = ANY($1)
          AND table_type IN ('BASE TABLE', 'VIEW')
        ORDER BY table_schema, table_name
      `, [ds.schemas]);

      // Get columns for each table
      const columnsResult = await dsPool.query(`
        SELECT table_schema, table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = ANY($1)
        ORDER BY table_schema, table_name, ordinal_position
      `, [ds.schemas]);

      // Build discovered structure
      const tables = tablesResult.rows;
      const columns = columnsResult.rows;

      // Auto-create authz_resource entries
      const created: string[] = [];
      const skipped: string[] = [];

      for (const table of tables) {
        const isView = table.table_type === 'VIEW';
        const resourcePrefix = isView ? 'view' : 'table';
        const resourceId = `${resourcePrefix}:${table.table_name}`;
        const resourceType = isView ? 'view' : 'table';
        // Extract alphabetic prefix for mapping UI grouping (e.g. azf_file → azf)
        const prefixMatch = table.table_name.match(/^([a-z]+)/i);
        const tablePrefix = prefixMatch ? prefixMatch[1].toLowerCase() : null;
        const attrs = JSON.stringify({
          data_source_id: ds.source_id,
          table_schema: table.table_schema,
          ...(tablePrefix ? { table_prefix: tablePrefix } : {}),
        });

        const upsertResult = await authzPool.query(`
          INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes)
          VALUES ($1, $4, $2, $3)
          ON CONFLICT (resource_id) DO UPDATE SET
            attributes = authz_resource.attributes || $3::jsonb,
            updated_at = now()
          RETURNING (xmax = 0) AS is_new
        `, [resourceId, `${table.table_schema}.${table.table_name}`, attrs, resourceType]);

        if (upsertResult.rows[0].is_new) {
          created.push(resourceId);
        } else {
          skipped.push(resourceId);
        }

        // Create column resources (for both tables and views)
        const tableCols = columns.filter(
          (c: any) => c.table_schema === table.table_schema && c.table_name === table.table_name
        );
        for (const col of tableCols) {
          const colResourceId = `column:${table.table_name}.${col.column_name}`;
          const colAttrs = JSON.stringify({
            data_source_id: ds.source_id,
            data_type: col.data_type,
          });

          const colResult = await authzPool.query(`
            INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
            VALUES ($1, 'column', $2, $3, $4)
            ON CONFLICT (resource_id) DO UPDATE SET
              attributes = authz_resource.attributes || $4::jsonb,
              updated_at = now()
            RETURNING (xmax = 0) AS is_new
          `, [colResourceId, resourceId, `${table.table_name}.${col.column_name}`, colAttrs]);

          if (colResult.rows[0].is_new) {
            created.push(colResourceId);
          }
        }
      }

      // Discover functions and procedures
      const functionsResult = await dsPool.query(`
        SELECT p.proname AS function_name, n.nspname AS schema_name,
               pg_get_function_arguments(p.oid) AS arguments,
               pg_get_function_result(p.oid) AS return_type,
               CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1)
          AND p.prokind IN ('f', 'p')
          AND p.proname NOT LIKE 'pg_%'
        ORDER BY n.nspname, p.proname
      `, [ds.schemas]);

      for (const fn of functionsResult.rows) {
        const fnResourceId = `function:${fn.schema_name}.${fn.function_name}`;
        const fnAttrs = JSON.stringify({
          data_source_id: ds.source_id,
          arguments: fn.arguments,
          return_type: fn.return_type,
          volatility: fn.volatility,
        });

        const fnResult = await authzPool.query(`
          INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes)
          VALUES ($1, 'function', $2, $3)
          ON CONFLICT (resource_id) DO UPDATE SET
            attributes = authz_resource.attributes || $3::jsonb,
            updated_at = now()
          RETURNING (xmax = 0) AS is_new
        `, [fnResourceId, `${fn.schema_name}.${fn.function_name}(${fn.arguments})`, fnAttrs]);

        if (fnResult.rows[0].is_new) {
          created.push(fnResourceId);
        }
      }

      // Update last_synced_at
      await authzPool.query(
        'UPDATE authz_data_source SET last_synced_at = now() WHERE source_id = $1',
        [ds.source_id]
      );

      const viewCount = tables.filter((t: any) => t.table_type === 'VIEW').length;
      const tableCount = tables.length - viewCount;
      audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_discover', resource_id: ds.source_id, decision: 'allow', context: { tables_found: tableCount, views_found: viewCount, functions_found: functionsResult.rows.length, resources_created: created.length } });
      logAdminAction(authzPool, { userId: getUserId(req), action: 'DISCOVER_DATASOURCE', resourceType: 'data_source', resourceId: ds.source_id, details: { tables_found: tableCount, views_found: viewCount, functions_found: functionsResult.rows.length, resources_created: created.length }, ip: getClientIp(req) });

      res.json({
        source_id: ds.source_id,
        tables_found: tableCount,
        views_found: viewCount,
        functions_found: functionsResult.rows.length,
        columns_found: columns.length,
        resources_created: created.length,
        resources_updated: skipped.length,
        created,
      });
    } finally {
      await dsPool.end();
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── List schemas in a data source (for SSOT dropdown) ───
datasourceRouter.get('/:id/schemas', async (req, res) => {
  try {
    const dsResult = await authzPool.query(
      'SELECT * FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
      [req.params.id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found or inactive' });
    }
    const ds = dsResult.rows[0];
    const dsPool = new Pool({
      host: ds.host, port: ds.port, database: ds.database_name,
      user: ds.connector_user, ...(ds.connector_password ? { password: decrypt(ds.connector_password) } : {}),
      max: 1, connectionTimeoutMillis: 10000,
    });
    try {
      const result = await dsPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'gp_toolkit')
        ORDER BY schema_name
      `);
      res.json(result.rows.map((r: any) => r.schema_name));
    } finally {
      await dsPool.end();
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Lifecycle status for a single data source (SSOT) ───
datasourceRouter.get('/:id/lifecycle', async (req, res) => {
  try {
    const result = await authzPool.query(`
      WITH tables AS (
        SELECT count(*) AS total,
               count(*) FILTER (WHERE parent_id IS NULL) AS unmapped,
               count(*) FILTER (WHERE parent_id IS NOT NULL) AS mapped
        FROM authz_resource
        WHERE resource_type IN ('table', 'view') AND is_active = TRUE
          AND attributes->>'data_source_id' = $1
      ),
      columns AS (
        SELECT count(*) AS total FROM authz_resource
        WHERE resource_type = 'column' AND is_active = TRUE
          AND attributes->>'data_source_id' = $1
      ),
      profiles AS (
        SELECT count(*) AS total,
               coalesce(array_agg(profile_id) FILTER (WHERE profile_id IS NOT NULL), '{}') AS ids,
               coalesce(array_agg(pg_role) FILTER (WHERE pg_role IS NOT NULL), '{}') AS roles
        FROM authz_db_pool_profile
        WHERE data_source_id = $1 AND is_active = TRUE
      ),
      cred_status AS (
        SELECT
          count(*) FILTER (WHERE pc.pg_role IS NOT NULL) AS credentialed,
          count(*) FILTER (WHERE pc.pg_role IS NULL) AS uncredentialed,
          min(pc.last_rotated + pc.rotate_interval) FILTER (WHERE pc.is_active) AS next_rotation
        FROM authz_db_pool_profile dp
        LEFT JOIN authz_pool_credentials pc ON pc.pg_role = dp.pg_role AND pc.is_active = TRUE
        WHERE dp.data_source_id = $1 AND dp.is_active = TRUE
      )
      SELECT ds.source_id, ds.display_name, ds.db_type, ds.host, ds.port,
             ds.database_name, ds.is_active, ds.last_synced_at,
             t.total AS tables, t.mapped, t.unmapped,
             c.total AS columns, p.total AS profile_count, p.ids AS profile_ids,
             cs.credentialed, cs.uncredentialed, cs.next_rotation
      FROM authz_data_source ds, tables t, columns c, profiles p, cred_status cs
      WHERE ds.source_id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    const r = result.rows[0];
    const tables = Number(r.tables);
    const mapped = Number(r.mapped);
    const unmapped = Number(r.unmapped);
    const columns = Number(r.columns);
    const profileCount = Number(r.profile_count);
    const credentialed = Number(r.credentialed);
    const uncredentialed = Number(r.uncredentialed);

    type PhaseStatus = 'not_started' | 'done' | 'action_needed';

    const connectionStatus: PhaseStatus = r.is_active ? 'done' : 'not_started';
    const discoveryStatus: PhaseStatus = tables > 0 ? 'done' : 'not_started';
    const organizationStatus: PhaseStatus =
      tables === 0 ? 'not_started' :
      unmapped > 0 ? 'action_needed' : 'done';
    const profilesStatus: PhaseStatus = profileCount > 0 ? 'done' : 'not_started';
    const credentialsStatus: PhaseStatus =
      profileCount === 0 ? 'not_started' :
      uncredentialed > 0 ? 'action_needed' : 'done';
    const deploymentStatus: PhaseStatus = r.last_synced_at ? 'done' : 'not_started';

    res.json({
      source_id: r.source_id,
      display_name: r.display_name,
      db_type: r.db_type,
      host: r.host,
      port: r.port,
      database_name: r.database_name,
      is_active: r.is_active,
      phases: {
        connection:   { status: connectionStatus },
        discovery:    { status: discoveryStatus, tables, columns, last_discovered: r.last_synced_at },
        organization: { status: organizationStatus, mapped, unmapped },
        profiles:     { status: profilesStatus, count: profileCount, profile_ids: r.profile_ids || [] },
        credentials:  { status: credentialsStatus, credentialed, uncredentialed, next_rotation: r.next_rotation },
        deployment:   { status: deploymentStatus, last_sync: r.last_synced_at },
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── List tables in a data source ───
datasourceRouter.get('/:id/tables', async (req, res) => {
  try {
    const dsResult = await authzPool.query(
      'SELECT * FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
      [req.params.id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found or inactive' });
    }
    const ds = dsResult.rows[0];

    const dsPool = new Pool({
      host: ds.host, port: ds.port, database: ds.database_name,
      user: ds.connector_user, ...(ds.connector_password ? { password: decrypt(ds.connector_password) } : {}),
      max: 1, connectionTimeoutMillis: 15000,
    });

    try {
      await dsPool.query("SET statement_timeout = '60s'");

      // Two-step query: avoids correlated subquery (slow on Greenplum)
      const tablesResult = await dsPool.query(`
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = ANY($1) AND table_type IN ('BASE TABLE', 'VIEW')
        ORDER BY table_schema, table_name
      `, [ds.schemas]);

      const colCounts = await dsPool.query(`
        SELECT table_schema, table_name, count(*) AS column_count
        FROM information_schema.columns
        WHERE table_schema = ANY($1)
        GROUP BY table_schema, table_name
      `, [ds.schemas]);

      const countMap = new Map<string, string>();
      for (const row of colCounts.rows) {
        countMap.set(`${row.table_schema}.${row.table_name}`, row.column_count);
      }

      const tables = tablesResult.rows.map((t: any) => ({
        table_schema: t.table_schema,
        table_name: t.table_name,
        table_type: t.table_type,
        column_count: countMap.get(`${t.table_schema}.${t.table_name}`) || '0',
      }));

      res.json({
        source_id: ds.source_id,
        database: ds.database_name,
        tables,
      });
    } finally {
      await dsPool.end();
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
