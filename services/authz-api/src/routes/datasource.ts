import { Router } from 'express';
import { Pool } from 'pg';
import oracledb from 'oracledb';
import { pool as authzPool, evictDataSourcePool, getLocalDataPool, getOracleConnection } from '../db';
import { audit } from '../audit';
import { encrypt, decrypt } from '../lib/crypto';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';
import { extractFunctionMetadata, classifyType } from '../lib/function-metadata';
import { runDiscoveryRules } from '../lib/discovery-rule-engine';

export const datasourceRouter = Router();

// Lightweight list for non-admin consumers (Flow Composer, Data Query, etc.)
// Returns only catalog identity — no host/port/credentials/connector fields.
// Mounted separately in index.ts behind requireAuth (not requireRole).
export async function listDataSourcesLite(_req: any, res: any) {
  try {
    const result = await authzPool.query(`
      SELECT source_id, display_name, db_type
      FROM authz_data_source
      WHERE is_active = TRUE
      ORDER BY display_name
    `);
    res.json(result.rows);
  } catch (err) {
    handleApiError(res, err);
  }
}

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
              last_synced_at, created_at, updated_at,
              cdc_target_schema, oracle_connection
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
    // Oracle-specific fields
    oracle_host, oracle_port = 1521, oracle_service_name,
    oracle_user, oracle_password, cdc_target_schema,
  } = req.body;

  const isOracle = db_type === 'oracle';

  // ── Oracle: resolve PG-side connection automatically ──
  const effectiveHost = isOracle ? (process.env.DB_HOST || 'localhost') : host;
  const effectivePort = isOracle ? parseInt(process.env.DB_PORT || '5432') : port;
  const effectiveDbName = isOracle ? (process.env.DATA_DB_NAME || 'nexus_data') : database_name;
  const effectiveSchemas = isOracle ? [cdc_target_schema] : schemas;
  const effectiveUser = isOracle ? (process.env.DB_USER || 'nexus_admin') : connector_user;
  const effectivePassword = isOracle ? (process.env.DB_PASSWORD || 'nexus_dev_password') : connector_password;

  if (isOracle && !cdc_target_schema) {
    return res.status(400).json({ error: 'cdc_target_schema is required for Oracle data sources' });
  }

  // Step 1: Connection test
  if (!isOracle) {
    // PG/Greenplum: test direct connection
    const testPool = new Pool({
      host, port, database: database_name,
      user: connector_user,
      ...(connector_password ? { password: connector_password } : {}),
      max: 1, connectionTimeoutMillis: 5000,
    });
    try {
      await testPool.query('SELECT 1');
    } catch (err) {
      await testPool.end();
      return res.status(400).json({ error: 'Connection test failed', detail: String(err) });
    }
    await testPool.end();
  }
  // Oracle: connection test is deferred — CDC schema may not exist yet

  // Step 2: Oracle — create CDC target schema in nexus_data
  if (isOracle) {
    try {
      const localPool = getLocalDataPool();
      await localPool.query('SELECT _nexus_create_cdc_schema($1)', [cdc_target_schema]);
    } catch (err) {
      return res.status(500).json({
        error: 'Failed to create CDC target schema in nexus_data',
        detail: String(err),
      });
    }
  }

  // Step 3: Build oracle_connection JSONB (encrypted password)
  const oracleConnection = isOracle ? {
    host: oracle_host,
    port: oracle_port,
    service_name: oracle_service_name,
    user: oracle_user,
    password_enc: oracle_password ? encrypt(oracle_password) : null,
  } : null;

  // Step 4: Save to authz_data_source
  try {
    const result = await authzPool.query(`
      INSERT INTO authz_data_source (
        source_id, display_name, description,
        db_type, host, port, database_name, schemas,
        connector_user, connector_password,
        owner_subject, registered_by,
        cdc_target_schema, oracle_connection
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING source_id, display_name, db_type, host, port, database_name, schemas, cdc_target_schema, created_at
    `, [
      source_id, display_name, description,
      db_type, effectiveHost, effectivePort, effectiveDbName, effectiveSchemas,
      effectiveUser, effectivePassword ? encrypt(effectivePassword) : null,
      owner_subject, registered_by,
      isOracle ? cdc_target_schema : null,
      oracleConnection ? JSON.stringify(oracleConnection) : null,
    ]);

    const context = isOracle
      ? { oracle_host, oracle_port, oracle_service_name, cdc_target_schema }
      : { host, port, database_name };
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_register', resource_id: source_id, decision: 'allow', context });
    logAdminAction(authzPool, { userId: getUserId(req), action: 'CREATE_DATASOURCE', resourceType: 'data_source', resourceId: source_id, details: context, ip: getClientIp(req) });
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

    // ── Cascade cleanup (DS-CASCADE-01) ──
    // FK refs into authz_resource have no ON DELETE CASCADE (V002, V022, V035), so
    // we must clear dependents in dependency order before the resource DELETE.
    // Dependent chain:
    //   authz_ui_descriptor.page_id  → authz_ui_page.page_id
    //   authz_ui_page.resource_id    → authz_resource.resource_id
    //   authz_role_permission.resource_id → authz_resource.resource_id
    // Subquery scope = resources tagged with this data_source_id (covers tables
    // AND columns AND views AND functions, since /generate-app + Discover write
    // attributes->>'data_source_id' on all of them).

    // 0a. Drop descriptors of pages tied to this DS's resources
    const descResult = await client.query(
      `DELETE FROM authz_ui_descriptor
        WHERE page_id IN (
          SELECT page_id FROM authz_ui_page
           WHERE resource_id IN (
             SELECT resource_id FROM authz_resource
              WHERE attributes->>'data_source_id' = $1
           )
        )`,
      [req.params.id]
    );

    // 0b. Drop UI pages tied to this DS's resources (auto:* pages from /generate-app
    //     and any hand-bound pages whose resource_id points at this source)
    const pageResult = await client.query(
      `DELETE FROM authz_ui_page
        WHERE resource_id IN (
          SELECT resource_id FROM authz_resource
           WHERE attributes->>'data_source_id' = $1
        )`,
      [req.params.id]
    );

    // 0c. Drop role permissions on this DS's resources (table-level + column-level
    //     allow/deny). Without this, step 1/2 raises FK violation.
    const permResult = await client.query(
      `DELETE FROM authz_role_permission
        WHERE resource_id IN (
          SELECT resource_id FROM authz_resource
           WHERE attributes->>'data_source_id' = $1
        )`,
      [req.params.id]
    );

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
      `DELETE FROM authz_db_pool_assignment
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
    const purgeContext = {
      descriptors_deleted: descResult.rowCount,
      pages_deleted: pageResult.rowCount,
      permissions_deleted: permResult.rowCount,
      columns_deleted: colResult.rowCount,
      tables_deleted: tblResult.rowCount,
      profiles_deleted: profResult.rowCount,
    };
    audit({
      access_path: 'B', subject_id: getUserId(req),
      action_id: 'datasource_purge', resource_id: req.params.id,
      decision: 'allow',
      context: purgeContext,
    });
    logAdminAction(authzPool, { userId: getUserId(req), action: 'PURGE_DATASOURCE', resourceType: 'data_source', resourceId: req.params.id, details: purgeContext, ip: getClientIp(req) });

    res.json({
      purged: req.params.id,
      ...purgeContext,
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
      `SELECT source_id, host, port, database_name, connector_user, connector_password,
              schemas, db_type, cdc_target_schema, oracle_connection
       FROM authz_data_source WHERE source_id = $1`,
      [req.params.id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }
    const ds = dsResult.rows[0];

    // ── Oracle: test PG replica (CDC schema) + Oracle connection ──
    if (ds.db_type === 'oracle') {
      const results: Record<string, any> = {
        pg_replica: 'skipped', oracle: 'skipped', details: {},
      };

      // Test PG replica — CDC schema exists in nexus_data
      try {
        const localPool = getLocalDataPool();
        const schemaCheck = await localPool.query(
          `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
          [ds.cdc_target_schema]
        );
        if (schemaCheck.rows.length > 0) {
          results.pg_replica = 'ok';
          results.details.cdc_schema = ds.cdc_target_schema;
          const tableCount = await localPool.query(
            `SELECT count(*) AS cnt FROM information_schema.tables
             WHERE table_schema = $1 AND table_type IN ('BASE TABLE', 'VIEW')`,
            [ds.cdc_target_schema]
          );
          results.details.cdc_tables = parseInt(tableCount.rows[0].cnt, 10);
        } else {
          results.pg_replica = 'error';
          results.details.pg_error = `CDC schema '${ds.cdc_target_schema}' not found in nexus_data`;
        }
      } catch (err) {
        results.pg_replica = 'error';
        results.details.pg_error = String(err);
      }

      // Test Oracle connection
      if (ds.oracle_connection) {
        let conn: oracledb.Connection | null = null;
        try {
          conn = await getOracleConnection(ds.source_id);
          await conn.execute('SELECT 1 FROM DUAL');
          results.oracle = 'ok';
          results.details.oracle_host = ds.oracle_connection.host;
          results.details.oracle_service = ds.oracle_connection.service_name;
        } catch (err) {
          results.oracle = 'error';
          results.details.oracle_error = String(err);
        } finally {
          if (conn) await conn.close().catch(() => {});
        }
      } else {
        results.details.oracle_note = 'No Oracle connection configured';
      }

      const status = results.pg_replica === 'ok' ? 'ok' : 'partial';
      return res.json({ status, ...results });
    }

    // ── PG/Greenplum ──
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
      `SELECT source_id, host, port, database_name, connector_user, connector_password,
              schemas, db_type, cdc_target_schema, oracle_connection
       FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE`,
      [req.params.id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found or inactive' });
    }
    const ds = dsResult.rows[0];
    const schemas = ds.db_type === 'oracle' ? [ds.cdc_target_schema] : ds.schemas;

    // Connect to the target data source
    const dsPool = new Pool({
      host: ds.host, port: ds.port, database: ds.database_name,
      user: ds.connector_user, ...(ds.connector_password ? { password: decrypt(ds.connector_password) } : {}),
      max: 1, connectionTimeoutMillis: 15000,
    });

    try {
      await dsPool.query("SET statement_timeout = '90s'");

      // ── Detect if pg_proc.prokind exists (PG 11+ / Greenplum 7+)
      // PG <=10 and Greenplum <=6 use proisagg + proiswindow instead.
      const prokindCheck = await dsPool.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'pg_catalog'
            AND table_name = 'pg_proc'
            AND column_name = 'prokind'
        ) AS has_prokind
      `);
      const hasProkind = prokindCheck.rows[0]?.has_prokind === true;
      const functionFilter = hasProkind
        ? "AND p.prokind IN ('f', 'p')"                   // PG 11+
        : "AND NOT p.proisagg AND NOT p.proiswindow";      // PG 9.4-10 / Greenplum 5/6

      // ── Phase 1: Scan target database ──
      const [tablesResult, columnsResult, commentsResult, functionsResult] = await Promise.all([
        dsPool.query(`
          SELECT table_schema, table_name, table_type
          FROM information_schema.tables
          WHERE table_schema = ANY($1) AND table_type IN ('BASE TABLE', 'VIEW')
          ORDER BY table_schema, table_name
        `, [schemas]),
        dsPool.query(`
          SELECT table_schema, table_name, column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = ANY($1)
          ORDER BY table_schema, table_name, ordinal_position
        `, [schemas]),
        dsPool.query(`
          SELECT c.relname AS table_name, n.nspname AS table_schema,
                 obj_description(c.oid, 'pg_class') AS table_comment
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1)
            AND c.relkind IN ('r', 'v', 'p')
            AND obj_description(c.oid, 'pg_class') IS NOT NULL
        `, [schemas]),
        dsPool.query(`
          SELECT p.proname AS function_name, n.nspname AS schema_name,
                 pg_get_function_arguments(p.oid) AS arguments,
                 pg_get_function_result(p.oid) AS return_type,
                 CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = ANY($1)
            ${functionFilter}
            AND p.proname NOT LIKE 'pg_%'
          ORDER BY n.nspname, p.proname
        `, [schemas]),
      ]);

      const tables = tablesResult.rows;
      const columns = columnsResult.rows;

      const commentMap = new Map<string, string>();
      for (const row of commentsResult.rows) {
        commentMap.set(`${row.table_schema}.${row.table_name}`, row.table_comment);
      }

      // ── Phase 2: Prepare batch arrays ──

      // Build column map keyed by "schema.table" for output-column derivation.
      const columnsByTable = new Map<string, Array<{ name: string; pgType: string; kind: ReturnType<typeof classifyType> }>>();
      for (const col of columns) {
        const key = `${col.table_schema}.${col.table_name}`;
        if (!columnsByTable.has(key)) columnsByTable.set(key, []);
        columnsByTable.get(key)!.push({
          name: col.column_name,
          pgType: col.data_type,
          kind: classifyType(col.data_type),
        });
      }

      // Tables/views arrays — unified node model (inputs/outputs/side_effects/idempotent)
      const tblIds: string[] = [], tblTypes: string[] = [], tblDisplays: string[] = [];
      const tblAttrs: string[] = [], tblAutoNames: string[] = [];
      for (const table of tables) {
        const isView = table.table_type === 'VIEW';
        const resourceId = `${isView ? 'view' : 'table'}:${table.table_name}`;
        const prefixMatch = table.table_name.match(/^([a-z]+)/i);
        const tablePrefix = prefixMatch ? prefixMatch[1].toLowerCase() : null;
        const tableComment = commentMap.get(`${table.table_schema}.${table.table_name}`) || null;
        const autoName = `${table.table_schema}.${table.table_name}`;
        const outputs = columnsByTable.get(autoName) || [];

        tblIds.push(resourceId);
        tblTypes.push(isView ? 'view' : 'table');
        tblDisplays.push(tableComment || autoName);
        tblAttrs.push(JSON.stringify({
          data_source_id: ds.source_id,
          table_schema: table.table_schema,
          ...(tablePrefix ? { table_prefix: tablePrefix } : {}),
          ...(tableComment ? { table_comment: tableComment } : {}),
          // Unified node model (DAG-ready)
          node_kind: isView ? 'view' : 'table',
          inputs: [],
          outputs,
          side_effects: false,
          idempotent: true,
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
        const meta = extractFunctionMetadata({
          name: fn.function_name,
          arguments: fn.arguments,
          return_type: fn.return_type,
          volatility: fn.volatility,
        });
        fnIds.push(`function:${fn.schema_name}.${fn.function_name}`);
        fnDisplays.push(`${fn.schema_name}.${fn.function_name}(${fn.arguments})`);
        fnAttrs.push(JSON.stringify({
          data_source_id: ds.source_id,
          arguments: meta.arguments,
          return_type: meta.return_type,
          volatility: meta.volatility,
          parsed_args: meta.parsed_args,
          return_shape: meta.return_shape,
          subtype: meta.subtype,
          idempotent: meta.idempotent,
          side_effects: meta.side_effects,
        }));
      }

      // ── Oracle: scan Oracle-side callable functions ──
      if (ds.db_type === 'oracle' && ds.oracle_connection) {
        let oraConn: oracledb.Connection | null = null;
        try {
          oraConn = await getOracleConnection(ds.source_id);
          const oracleSchema = ds.oracle_connection.user;

          // Get callable functions/procedures owned by the Oracle user
          const fnListResult = await oraConn.execute(
            `SELECT OBJECT_NAME, OWNER, OBJECT_TYPE
             FROM ALL_PROCEDURES
             WHERE OWNER = UPPER(:schema)
               AND OBJECT_TYPE IN ('FUNCTION', 'PROCEDURE')
               AND PROCEDURE_NAME IS NULL
             ORDER BY OBJECT_NAME`,
            { schema: oracleSchema },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );

          // Get arguments for all functions in the schema
          const argsResult = await oraConn.execute(
            `SELECT OBJECT_NAME, ARGUMENT_NAME, DATA_TYPE, POSITION, IN_OUT
             FROM ALL_ARGUMENTS
             WHERE OWNER = UPPER(:schema)
             ORDER BY OBJECT_NAME, POSITION`,
            { schema: oracleSchema },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );

          // Build argument map: function_name → "arg1 TYPE, ..."
          const argMap = new Map<string, string[]>();
          const returnMap = new Map<string, string>();
          for (const arg of (argsResult.rows || []) as any[]) {
            if (arg.POSITION === 0) {
              returnMap.set(arg.OBJECT_NAME, arg.DATA_TYPE);
            } else {
              if (!argMap.has(arg.OBJECT_NAME)) argMap.set(arg.OBJECT_NAME, []);
              const dir = arg.IN_OUT !== 'IN' ? ` ${arg.IN_OUT}` : '';
              argMap.get(arg.OBJECT_NAME)!.push(
                `${arg.ARGUMENT_NAME || `p${arg.POSITION}`} ${arg.DATA_TYPE}${dir}`
              );
            }
          }

          // Merge into function arrays
          for (const fn of (fnListResult.rows || []) as any[]) {
            const args = argMap.get(fn.OBJECT_NAME)?.join(', ') || '';
            const retType = returnMap.get(fn.OBJECT_NAME) || fn.OBJECT_TYPE;
            fnIds.push(`function:${ds.cdc_target_schema}.${fn.OBJECT_NAME.toLowerCase()}`);
            fnDisplays.push(`${fn.OWNER}.${fn.OBJECT_NAME}(${args})`);
            fnAttrs.push(JSON.stringify({
              data_source_id: ds.source_id,
              oracle: true,
              arguments: args,
              return_type: retType,
              object_type: fn.OBJECT_TYPE,
            }));
          }
        } catch (oraErr) {
          // Non-fatal: Oracle function scan failure shouldn't block table/column discovery
          console.warn(`Oracle function discovery failed for ${ds.source_id}:`, oraErr);
        } finally {
          if (oraConn) await oraConn.close().catch(() => {});
        }
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

      // ── Phase 4: Auto-suggest masks/filters/classifications for the just-created resources.
      // Runs against authz_discovery_rule (V046). Failures here are non-fatal — the scan
      // already committed; we only log the engine error and move on.
      let suggestionResult: Awaited<ReturnType<typeof runDiscoveryRules>> | null = null;
      let suggestionError: string | null = null;
      if (created.length > 0) {
        try {
          suggestionResult = await runDiscoveryRules({
            pool: authzPool,
            resourceIds: created,
            createdBy: getUserId(req) ?? 'discover-engine',
          });
        } catch (sugErr) {
          suggestionError = (sugErr as Error).message;
          console.warn(`Discovery rule engine failed for ${ds.source_id}:`, sugErr);
        }
      }

      audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_discover', resource_id: ds.source_id, decision: 'allow', context: { tables_found: tableCount, views_found: viewCount, functions_found: fnIds.length, resources_created: created.length, suggestions: suggestionResult ?? undefined } });
      logAdminAction(authzPool, { userId: getUserId(req), action: 'DISCOVER_DATASOURCE', resourceType: 'data_source', resourceId: ds.source_id, details: { tables_found: tableCount, views_found: viewCount, functions_found: fnIds.length, resources_created: created.length, suggestions: suggestionResult ?? undefined, suggestion_error: suggestionError ?? undefined }, ip: getClientIp(req) });

      res.json({
        source_id: ds.source_id,
        tables_found: tableCount,
        views_found: viewCount,
        functions_found: fnIds.length,
        columns_found: columns.length,
        resources_created: created.length,
        resources_updated: totalResources - created.length,
        created,
        suggestions: suggestionResult,
        suggestion_error: suggestionError,
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
      // Exclude system schemas. Greenplum creates one pg_temp_N / pg_toast_temp_N
      // per backend PID per segment, which can explode to 100k+ entries on a busy
      // cluster — enough to freeze the UI if rendered as chips. Pattern filter + a
      // hard cap prevents future surprises from a runaway data source.
      const result = await dsPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'gp_toolkit')
          AND schema_name NOT LIKE 'pg_temp_%'
          AND schema_name NOT LIKE 'pg_toast%'
        ORDER BY schema_name
        LIMIT 500
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
