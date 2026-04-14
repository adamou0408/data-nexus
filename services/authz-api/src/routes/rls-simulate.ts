import { Router } from 'express';
import { pool, getDataSourcePool, resolveDataSource } from '../db';
import { buildMaskedSelect } from '../lib/masked-query';

export const rlsRouter = Router();

// Dynamic allowed tables cache (refreshed from DB)
let ALLOWED_TABLES: Record<string, { resourceType: string; orderBy: string }> = {};
let _tablesCacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

async function loadAllowedTables(): Promise<Record<string, { resourceType: string; orderBy: string }>> {
  if (Date.now() - _tablesCacheTime < CACHE_TTL && Object.keys(ALLOWED_TABLES).length > 0) {
    return ALLOWED_TABLES;
  }

  // Get business tables and views (exclude authz_* internal tables)
  const tablesResult = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type IN ('BASE TABLE', 'VIEW')
      AND table_name NOT LIKE 'authz_%'
    ORDER BY table_name
  `);

  const newTables: Record<string, { resourceType: string; orderBy: string }> = {};
  for (const row of tablesResult.rows as { table_name: string }[]) {
    const tableName = row.table_name;
    const pkResult = await pool.query(`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      LIMIT 1
    `, [tableName]).catch(() => ({ rows: [] }));

    const orderBy = pkResult.rows.length > 0
      ? (pkResult.rows[0] as { column_name: string }).column_name
      : tableName + '_id';

    newTables[tableName] = {
      resourceType: `table:${tableName}`,
      orderBy,
    };
  }

  ALLOWED_TABLES = newTables;
  _tablesCacheTime = Date.now();
  return ALLOWED_TABLES;
}

rlsRouter.post('/simulate', async (req, res) => {
  const { user_id, groups = [], attributes = {}, table = 'lot_status', path = 'A' } = req.body;

  const allowedTables = await loadAllowedTables();
  const tableConfig = allowedTables[table];
  if (!tableConfig) {
    return res.status(400).json({ error: `Unknown table: ${table}` });
  }

  try {
    const sourceId = await resolveDataSource(table);
    const dataPool = sourceId ? await getDataSourcePool(sourceId) : pool;

    const result = await buildMaskedSelect({
      authzPool: pool,
      dataPool,
      table,
      userId: user_id,
      groups,
      attributes,
      orderBy: tableConfig.orderBy,
      path,
    });

    res.json({
      table,
      filter_clause: result.filterClause,
      filtered_rows: result.rows,
      filtered_count: result.filteredCount,
      total_count: result.totalCount,
      column_masks: result.columnMasks,
      resolved_roles: result.resolvedRoles,
      rewritten_sql: result.rewrittenSql,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

rlsRouter.get('/data', async (req, res) => {
  const table = (req.query.table as string) || 'lot_status';
  const allowedTables = await loadAllowedTables();
  const tableConfig = allowedTables[table];
  if (!tableConfig) {
    return res.status(400).json({ error: `Unknown table: ${table}` });
  }
  try {
    const sourceId = await resolveDataSource(table);
    const dataPool = sourceId ? await getDataSourcePool(sourceId) : pool;
    const result = await dataPool.query(`SELECT * FROM ${table} ORDER BY ${tableConfig.orderBy}`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
