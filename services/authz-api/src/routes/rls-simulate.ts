import { Router } from 'express';
import { pool } from '../db';

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
    const filterResult = await pool.query(
      'SELECT authz_filter($1, $2, $3, $4, $5) AS filter_clause',
      [user_id, groups, JSON.stringify(attributes), tableConfig.resourceType, path]
    );
    const filterClause = filterResult.rows[0].filter_clause;

    const query = `SELECT * FROM ${table} WHERE ${filterClause} ORDER BY ${tableConfig.orderBy}`;
    const dataResult = await pool.query(query);

    const totalResult = await pool.query(`SELECT count(*)::int AS total FROM ${table}`);

    res.json({
      table,
      filter_clause: filterClause,
      filtered_rows: dataResult.rows,
      filtered_count: dataResult.rowCount,
      total_count: totalResult.rows[0].total,
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
    const result = await pool.query(`SELECT * FROM ${table} ORDER BY ${tableConfig.orderBy}`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
