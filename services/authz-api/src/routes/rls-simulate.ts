import { Router } from 'express';
import { pool, getDataSourcePool, resolveDataSource } from '../db';
import { buildMaskedSelect } from '../lib/masked-query';
import { handleApiError } from '../lib/request-helpers';

export const rlsRouter = Router();

// ARCH-02 (2026-05-04): allowed-table cache is now keyed by
// data_source_id. The previous implementation enumerated tables via
// the internal nexus_data pool with no data_source_id parameter,
// which is no longer valid post-cleanup. Callers must supply
// data_source_id; tables are listed against that DS only.
type TableMeta = { resourceType: string; orderBy: string };
const ALLOWED_TABLES_BY_DS: Map<string, { tables: Record<string, TableMeta>; loadedAt: number }> = new Map();
const CACHE_TTL = 60_000;

async function loadAllowedTables(dataSourceId: string): Promise<Record<string, TableMeta>> {
  const cached = ALLOWED_TABLES_BY_DS.get(dataSourceId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL) {
    return cached.tables;
  }

  const dataPool = await getDataSourcePool(dataSourceId);
  const tablesResult = await dataPool.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type IN ('BASE TABLE', 'VIEW')
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_name NOT LIKE 'authz_%'
    ORDER BY table_schema, table_name
  `);

  const newTables: Record<string, TableMeta> = {};
  for (const row of tablesResult.rows as { table_schema: string; table_name: string }[]) {
    const tableName = row.table_name;
    const qualified = `${row.table_schema}.${row.table_name}`;
    const pkResult = await dataPool.query(`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      LIMIT 1
    `, [qualified]).catch(() => ({ rows: [] }));

    const orderBy = pkResult.rows.length > 0
      ? (pkResult.rows[0] as { column_name: string }).column_name
      : tableName + '_id';

    newTables[tableName] = {
      resourceType: `table:${tableName}`,
      orderBy,
    };
  }

  ALLOWED_TABLES_BY_DS.set(dataSourceId, { tables: newTables, loadedAt: Date.now() });
  return newTables;
}

rlsRouter.post('/simulate', async (req, res) => {
  const { user_id, groups = [], attributes = {}, table, path = 'A', data_source_id } = req.body;

  if (!table) {
    return res.status(400).json({ error: 'table is required' });
  }
  // ARCH-02: explicit data_source_id required (no internal-pool fallback).
  // Either pass it directly, or we resolve via authz_resource binding.
  const sourceId = data_source_id || await resolveDataSource(table);
  if (!sourceId) {
    return res.status(400).json({
      error: 'data_source_id is required',
      hint: `Pass data_source_id in body, or bind authz_resource.attributes->>'data_source_id' for table:${table}.`,
    });
  }

  try {
    const allowedTables = await loadAllowedTables(sourceId);
    const tableConfig = allowedTables[table];
    if (!tableConfig) {
      return res.status(400).json({ error: `Unknown table on ${sourceId}: ${table}` });
    }

    const dataPool = await getDataSourcePool(sourceId);

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
      data_source_id: sourceId,
      filter_clause: result.filterClause,
      filtered_rows: result.rows,
      filtered_count: result.filteredCount,
      total_count: result.totalCount,
      column_masks: result.columnMasks,
      resolved_roles: result.resolvedRoles,
      rewritten_sql: result.rewrittenSql,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

rlsRouter.get('/data', async (req, res) => {
  const table = req.query.table as string | undefined;
  const dataSourceId = req.query.data_source_id as string | undefined;

  if (!table) {
    return res.status(400).json({ error: 'table query parameter is required' });
  }

  // ARCH-02: explicit data_source_id required (no internal-pool fallback).
  const sourceId = dataSourceId || await resolveDataSource(table);
  if (!sourceId) {
    return res.status(400).json({
      error: 'data_source_id is required',
      hint: `Pass ?data_source_id=ds:... or bind authz_resource for table:${table}.`,
    });
  }

  try {
    const allowedTables = await loadAllowedTables(sourceId);
    const tableConfig = allowedTables[table];
    if (!tableConfig) {
      return res.status(400).json({ error: `Unknown table on ${sourceId}: ${table}` });
    }

    const dataPool = await getDataSourcePool(sourceId);
    const result = await dataPool.query(`SELECT * FROM ${table} ORDER BY ${tableConfig.orderBy}`);
    res.json(result.rows);
  } catch (err) {
    handleApiError(res, err);
  }
});
