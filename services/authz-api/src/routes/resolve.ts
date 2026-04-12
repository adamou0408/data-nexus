import { Router } from 'express';
import { pool } from '../db';

export const resolveRouter = Router();

resolveRouter.post('/', async (req, res) => {
  const { user_id, groups = [], attributes = {} } = req.body;
  try {
    const result = await pool.query(
      'SELECT authz_resolve($1, $2, $3) AS config',
      [user_id, groups, JSON.stringify(attributes)]
    );
    res.json(result.rows[0].config);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
