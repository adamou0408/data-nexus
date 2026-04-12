import { Router } from 'express';
import { pool, getDataSourcePool, resolveDataSource } from '../db';

export const rlsRouter = Router();

// Allowed tables for RLS simulation (prevent SQL injection)
const ALLOWED_TABLES: Record<string, { resourceType: string; orderBy: string }> = {
  lot_status:  { resourceType: 'table:lot_status',  orderBy: 'lot_id' },
  sales_order: { resourceType: 'table:sales_order', orderBy: 'order_id' },
};

rlsRouter.post('/simulate', async (req, res) => {
  const { user_id, groups = [], attributes = {}, table = 'lot_status', path = 'A' } = req.body;

  const tableConfig = ALLOWED_TABLES[table];
  if (!tableConfig) {
    return res.status(400).json({ error: `Unknown table: ${table}` });
  }

  try {
    // Step 1: Get RLS filter
    const filterResult = await pool.query(
      'SELECT authz_filter($1, $2, $3, $4, $5) AS filter_clause',
      [user_id, groups, JSON.stringify(attributes), tableConfig.resourceType, path]
    );
    const filterClause = filterResult.rows[0].filter_clause;

    // Step 2: Get L2 column masks from authz_resolve()
    const resolveResult = await pool.query(
      'SELECT authz_resolve($1, $2, $3) AS config',
      [user_id, groups, JSON.stringify(attributes)]
    );
    const config = resolveResult.rows[0].config;
    const columnMasks = config.L2_column_masks || {};

    // Build mask map for this table: { column_name: { function, mask_type } }
    const tableMasks: Record<string, { function: string; mask_type: string }> = {};
    for (const [_policyName, rules] of Object.entries(columnMasks)) {
      for (const [colKey, maskDef] of Object.entries(rules as Record<string, { function: string; mask_type: string }>)) {
        // colKey format: "table_name.column_name"
        const [maskTable, maskCol] = colKey.split('.');
        if (maskTable === table && maskCol) {
          tableMasks[maskCol] = maskDef;
        }
      }
    }

    // Step 3: Build SELECT with mask functions applied
    // Resolve data source for this table and get column list
    const sourceId = await resolveDataSource(table);
    const dataPool = sourceId ? await getDataSourcePool(sourceId) : pool;

    const colResult = await dataPool.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);

    const selectParts = colResult.rows.map((col: { column_name: string; data_type: string }) => {
      const mask = tableMasks[col.column_name];
      if (mask) {
        // Apply mask function — cast numeric types for text mask functions
        const fn = mask.function;
        if (fn === 'fn_mask_range' && (col.data_type === 'numeric' || col.data_type === 'integer' || col.data_type === 'double precision')) {
          return `${fn}(${col.column_name}::numeric) AS ${col.column_name}`;
        } else if (fn === 'fn_mask_range') {
          return `${fn}(${col.column_name}::numeric) AS ${col.column_name}`;
        } else {
          return `${fn}(${col.column_name}::text) AS ${col.column_name}`;
        }
      }
      return col.column_name;
    });

    // Step 4: Also check column-level deny (L0)
    // If a column is denied at L0 level, replace with '****' regardless of mask
    const denyCheckResult = await pool.query(
      'SELECT _authz_resolve_roles($1, $2) AS roles',
      [user_id, groups]
    );
    const roles: string[] = denyCheckResult.rows[0].roles || [];

    // Find denied columns for this table
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

    // Override: denied columns show '****' (deny takes priority over mask)
    const finalSelectParts = selectParts.map((part: string) => {
      // Extract the column name (either plain name or "fn(...) AS name")
      const asMatch = part.match(/AS\s+(\w+)$/);
      const colName = asMatch ? asMatch[1] : part;
      if (deniedCols.has(colName)) {
        return `'[DENIED]' AS ${colName}`;
      }
      return part;
    });

    const query = `SELECT ${finalSelectParts.join(', ')} FROM ${table} WHERE ${filterClause} ORDER BY ${tableConfig.orderBy}`;
    const dataResult = await dataPool.query(query);
    const totalResult = await dataPool.query(`SELECT count(*)::int AS total FROM ${table}`);

    // Build mask info for UI display
    const appliedMasks: Record<string, string> = {};
    for (const [col, mask] of Object.entries(tableMasks)) {
      if (deniedCols.has(col)) {
        appliedMasks[col] = 'DENIED (L0 deny overrides mask)';
      } else {
        appliedMasks[col] = `${mask.mask_type} (${mask.function})`;
      }
    }
    for (const col of deniedCols) {
      if (!appliedMasks[col as string]) {
        appliedMasks[col as string] = 'DENIED (L0 column deny)';
      }
    }

    res.json({
      table,
      filter_clause: filterClause,
      filtered_rows: dataResult.rows,
      filtered_count: dataResult.rowCount,
      total_count: totalResult.rows[0].total,
      column_masks: appliedMasks,
      resolved_roles: roles,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

rlsRouter.get('/data', async (req, res) => {
  const table = (req.query.table as string) || 'lot_status';
  const tableConfig = ALLOWED_TABLES[table];
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
