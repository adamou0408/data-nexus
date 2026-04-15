import { Router } from 'express';
import { Pool } from 'pg';
import { pool as authzPool, evictDataSourcePool } from '../db';
import { audit } from '../audit';
import { encrypt, decrypt } from '../lib/crypto';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';

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
    handleApiError(res, err);
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
    handleApiError(res, err);
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
    handleApiError(res, err);
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
    handleApiError(res, err);
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
    handleApiError(res, err);
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
    handleApiError(res, err);
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
    handleApiError(res, err);
  } finally {
    client.release();
  }
});

// ─── Test connection ───
datasourceRouter.post('/:id/test', async (req, res) => {
  try {
    const dsResult = await authzPool.query(
      'SELECT source_id, host, port, database_name, connector_user, connector_password, schemas FROM authz_data_source WHERE source_id = $1',
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
    handleApiError(res, err);
  }
});

// ─── Discover schema → auto-create authz_resource entries ───
datasourceRouter.post('/:id/discover', async (req, res) => {
  try {
    const dsResult = await authzPool.query(
      'SELECT source_id, host, port, database_name, connector_user, connector_password, schemas FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
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

      // ── Phase 1: Scan target database ──
      const [tablesResult, columnsResult, commentsResult, functionsResult] = await Promise.all([
        dsPool.query(`
          SELECT table_schema, table_name, table_type
          FROM information_schema.tables
          WHERE table_schema = ANY($1) AND table_type IN ('BASE TABLE', 'VIEW')
          ORDER BY table_schema, table_name
        `, [ds.schemas]),
        dsPool.query(`
          SELECT table_schema, table_name, column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = ANY($1)
          ORDER BY table_schema, table_name, ordinal_position
        `, [ds.schemas]),
        dsPool.query(`
          SELECT c.relname AS table_name, n.nspname AS table_schema,
                 obj_description(c.oid, 'pg_class') AS table_comment
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1)
            AND c.relkind IN ('r', 'v', 'p')
            AND obj_description(c.oid, 'pg_class') IS NOT NULL
        `, [ds.schemas]),
        dsPool.query(`
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
        `, [ds.schemas]),
      ]);

      const tables = tablesResult.rows;
      const columns = columnsResult.rows;

      const commentMap = new Map<string, string>();
      for (const row of commentsResult.rows) {
        commentMap.set(`${row.table_schema}.${row.table_name}`, row.table_comment);
      }

      // ── Phase 2: Prepare batch arrays ──

      // Tables/views arrays
      const tblIds: string[] = [], tblTypes: string[] = [], tblDisplays: string[] = [];
      const tblAttrs: string[] = [], tblAutoNames: string[] = [];
      for (const table of tables) {
        const isView = table.table_type === 'VIEW';
        const resourceId = `${isView ? 'view' : 'table'}:${table.table_name}`;
        const prefixMatch = table.table_name.match(/^([a-z]+)/i);
        const tablePrefix = prefixMatch ? prefixMatch[1].toLowerCase() : null;
        const tableComment = commentMap.get(`${table.table_schema}.${table.table_name}`) || null;
        const autoName = `${table.table_schema}.${table.table_name}`;

        tblIds.push(resourceId);
        tblTypes.push(isView ? 'view' : 'table');
        tblDisplays.push(tableComment || autoName);
        tblAttrs.push(JSON.stringify({
          data_source_id: ds.source_id,
          table_schema: table.table_schema,
          ...(tablePrefix ? { table_prefix: tablePrefix } : {}),
          ...(tableComment ? { table_comment: tableComment } : {}),
        }));
        tblAutoNames.push(autoName);
      }

      // Column arrays — build parent_id mapping from table resource IDs
      const tableResourceMap = new Map<string, string>(); // "schema.table" → resource_id
      for (let i = 0; i < tables.length; i++) {
        tableResourceMap.set(`${tables[i].table_schema}.${tables[i].table_name}`, tblIds[i]);
      }

      const colIds: string[] = [], colParents: string[] = [], colDisplays: string[] = [];
      const colAttrs: string[] = [];
      for (const col of columns) {
        const parentId = tableResourceMap.get(`${col.table_schema}.${col.table_name}`);
        if (!parentId) continue; // column belongs to a table outside our schemas
        colIds.push(`column:${col.table_name}.${col.column_name}`);
        colParents.push(parentId);
        colDisplays.push(`${col.table_name}.${col.column_name}`);
        colAttrs.push(JSON.stringify({ data_source_id: ds.source_id, data_type: col.data_type }));
      }

      // Function arrays
      const fnIds: string[] = [], fnDisplays: string[] = [], fnAttrs: string[] = [];
      for (const fn of functionsResult.rows) {
        fnIds.push(`function:${fn.schema_name}.${fn.function_name}`);
        fnDisplays.push(`${fn.schema_name}.${fn.function_name}(${fn.arguments})`);
        fnAttrs.push(JSON.stringify({
          data_source_id: ds.source_id,
          arguments: fn.arguments,
          return_type: fn.return_type,
          volatility: fn.volatility,
        }));
      }

      // ── Phase 3: Batch upsert inside transaction ──
      const client = await authzPool.connect();
      let created: string[] = [];
      try {
        await client.query('BEGIN');

        // Batch upsert tables/views (smart display_name: only overwrite auto-generated names)
        if (tblIds.length > 0) {
          const tblResult = await client.query(`
            WITH input AS (
              SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[], $5::text[])
                AS t(r_id, r_type, d_name, attrs, auto_name)
            )
            INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes)
            SELECT r_id, r_type, d_name, attrs FROM input
            ON CONFLICT (resource_id) DO UPDATE SET
              attributes = authz_resource.attributes || EXCLUDED.attributes,
              display_name = CASE
                WHEN authz_resource.display_name IS NULL THEN EXCLUDED.display_name
                WHEN authz_resource.display_name = (SELECT i.auto_name FROM input i WHERE i.r_id = authz_resource.resource_id)
                  THEN EXCLUDED.display_name
                ELSE authz_resource.display_name
              END,
              updated_at = now()
            RETURNING resource_id, (xmax = 0) AS is_new
          `, [tblIds, tblTypes, tblDisplays, tblAttrs, tblAutoNames]);
          created.push(...tblResult.rows.filter((r: any) => r.is_new).map((r: any) => r.resource_id));
        }

        // Batch upsert columns
        if (colIds.length > 0) {
          const colResult = await client.query(`
            INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
            SELECT unnest($1::text[]), 'column', unnest($2::text[]), unnest($3::text[]), unnest($4::jsonb[])
            ON CONFLICT (resource_id) DO UPDATE SET
              attributes = authz_resource.attributes || EXCLUDED.attributes,
              updated_at = now()
            RETURNING resource_id, (xmax = 0) AS is_new
          `, [colIds, colParents, colDisplays, colAttrs]);
          created.push(...colResult.rows.filter((r: any) => r.is_new).map((r: any) => r.resource_id));
        }

        // Batch upsert functions
        if (fnIds.length > 0) {
          const fnResult = await client.query(`
            INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes)
            SELECT unnest($1::text[]), 'function', unnest($2::text[]), unnest($3::jsonb[])
            ON CONFLICT (resource_id) DO UPDATE SET
              attributes = authz_resource.attributes || EXCLUDED.attributes,
              updated_at = now()
            RETURNING resource_id, (xmax = 0) AS is_new
          `, [fnIds, fnDisplays, fnAttrs]);
          created.push(...fnResult.rows.filter((r: any) => r.is_new).map((r: any) => r.resource_id));
        }

        // Update last_synced_at inside the same transaction
        await client.query(
          'UPDATE authz_data_source SET last_synced_at = now() WHERE source_id = $1',
          [ds.source_id]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      const viewCount = tables.filter((t: any) => t.table_type === 'VIEW').length;
      const tableCount = tables.length - viewCount;
      const totalResources = tblIds.length + colIds.length + fnIds.length;
      audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_discover', resource_id: ds.source_id, decision: 'allow', context: { tables_found: tableCount, views_found: viewCount, functions_found: functionsResult.rows.length, resources_created: created.length } });
      logAdminAction(authzPool, { userId: getUserId(req), action: 'DISCOVER_DATASOURCE', resourceType: 'data_source', resourceId: ds.source_id, details: { tables_found: tableCount, views_found: viewCount, functions_found: functionsResult.rows.length, resources_created: created.length }, ip: getClientIp(req) });

      res.json({
        source_id: ds.source_id,
        tables_found: tableCount,
        views_found: viewCount,
        functions_found: functionsResult.rows.length,
        columns_found: columns.length,
        resources_created: created.length,
        resources_updated: totalResources - created.length,
        created,
      });
    } finally {
      await dsPool.end();
    }
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── List schemas in a data source (for SSOT dropdown) ───
datasourceRouter.get('/:id/schemas', async (req, res) => {
  try {
    const dsResult = await authzPool.query(
      'SELECT source_id, host, port, database_name, connector_user, connector_password, schemas FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
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
    handleApiError(res, err);
  }
});

// ─── Lifecycle status for a single data source (SSOT) ───
datasourceRouter.get('/:id/lifecycle', async (req, res) => {
  try {
    const result = await authzPool.query(`
      WITH tables AS (
        SELECT count(*) AS total,
               count(*) FILTER (WHERE resource_type = 'table') AS table_count,
               count(*) FILTER (WHERE resource_type = 'view') AS view_count,
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
      functions AS (
        SELECT count(*) AS total FROM authz_resource
        WHERE resource_type = 'function' AND is_active = TRUE
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
             t.total AS tables, t.table_count, t.view_count, t.mapped, t.unmapped,
             c.total AS columns, f.total AS functions,
             p.total AS profile_count, p.ids AS profile_ids,
             cs.credentialed, cs.uncredentialed, cs.next_rotation
      FROM authz_data_source ds, tables t, columns c, functions f, profiles p, cred_status cs
      WHERE ds.source_id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    const r = result.rows[0];
    const tables = Number(r.table_count);
    const views = Number(r.view_count);
    const totalObjects = Number(r.tables);
    const mapped = Number(r.mapped);
    const unmapped = Number(r.unmapped);
    const columns = Number(r.columns);
    const functions = Number(r.functions);
    const profileCount = Number(r.profile_count);
    const credentialed = Number(r.credentialed);
    const uncredentialed = Number(r.uncredentialed);

    type PhaseStatus = 'not_started' | 'done' | 'action_needed';

    const connectionStatus: PhaseStatus = r.is_active ? 'done' : 'not_started';
    const discoveryStatus: PhaseStatus = totalObjects > 0 ? 'done' : 'not_started';
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
        discovery:    { status: discoveryStatus, tables, views, columns, functions, last_discovered: r.last_synced_at },
        organization: { status: organizationStatus, mapped, unmapped },
        profiles:     { status: profilesStatus, count: profileCount, profile_ids: r.profile_ids || [] },
        credentials:  { status: credentialsStatus, credentialed, uncredentialed, next_rotation: r.next_rotation },
        deployment:   { status: deploymentStatus, last_sync: r.last_synced_at },
      },
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── List tables in a data source ───
datasourceRouter.get('/:id/tables', async (req, res) => {
  try {
    const dsResult = await authzPool.query(
      'SELECT source_id, host, port, database_name, connector_user, connector_password, schemas FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
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
    handleApiError(res, err);
  }
});
