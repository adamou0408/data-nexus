import { Router, Request } from 'express';
import { Pool } from 'pg';
import { pool as authzPool, evictDataSourcePool } from '../db';
import { audit } from '../audit';

function getUserId(req: Request): string {
  return (req as any).authzUser?.user_id || 'unknown';
}

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
    user: connector_user, password: connector_password,
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
  } finally {
    await testPool.end();
  }

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
      connector_user, connector_password,
      owner_subject, registered_by,
    ]);

    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_register', resource_id: source_id, decision: 'allow', context: { host, port, database_name } });
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
      connector_user, connector_password,
      owner_subject, is_active,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    evictDataSourcePool(req.params.id);
    audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_update', resource_id: req.params.id, decision: 'allow' });
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
    res.json({ deactivated: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
      user: ds.connector_user, password: ds.connector_password,
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
      user: ds.connector_user, password: ds.connector_password,
      max: 1, connectionTimeoutMillis: 5000,
    });

    try {
      // Get tables from allowed schemas
      const tablesResult = await dsPool.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema = ANY($1)
          AND table_type = 'BASE TABLE'
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
        const resourceId = `table:${table.table_name}`;
        const attrs = JSON.stringify({
          data_source_id: ds.source_id,
          table_schema: table.table_schema,
        });

        const upsertResult = await authzPool.query(`
          INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes)
          VALUES ($1, 'table', $2, $3)
          ON CONFLICT (resource_id) DO UPDATE SET
            attributes = authz_resource.attributes || $3::jsonb,
            updated_at = now()
          RETURNING (xmax = 0) AS is_new
        `, [resourceId, `${table.table_schema}.${table.table_name}`, attrs]);

        if (upsertResult.rows[0].is_new) {
          created.push(resourceId);
        } else {
          skipped.push(resourceId);
        }

        // Create column resources
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

      // Update last_synced_at
      await authzPool.query(
        'UPDATE authz_data_source SET last_synced_at = now() WHERE source_id = $1',
        [ds.source_id]
      );

      audit({ access_path: 'B', subject_id: getUserId(req), action_id: 'datasource_discover', resource_id: ds.source_id, decision: 'allow', context: { tables_found: tables.length, resources_created: created.length } });

      res.json({
        source_id: ds.source_id,
        tables_found: tables.length,
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
      user: ds.connector_user, password: ds.connector_password,
      max: 1, connectionTimeoutMillis: 5000,
    });

    try {
      const result = await dsPool.query(`
        SELECT t.table_schema, t.table_name,
               (SELECT count(*) FROM information_schema.columns c
                WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS column_count
        FROM information_schema.tables t
        WHERE t.table_schema = ANY($1) AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_schema, t.table_name
      `, [ds.schemas]);

      res.json({
        source_id: ds.source_id,
        database: ds.database_name,
        tables: result.rows,
      });
    } finally {
      await dsPool.end();
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
