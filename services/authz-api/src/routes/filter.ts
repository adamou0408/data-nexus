import { Router } from 'express';
import { pool } from '../db';
import { handleApiError } from '../lib/request-helpers';

export const filterRouter = Router();

filterRouter.post('/', async (req, res) => {
  const { user_id, groups = [], attributes = {}, resource_type, path = null } = req.body;
  try {
    const result = await pool.query(
      'SELECT authz_filter($1, $2, $3, $4, $5) AS filter_clause',
      [user_id, groups, JSON.stringify(attributes), resource_type, path]
    );
    res.json({ filter_clause: result.rows[0].filter_clause });
  } catch (err) {
    handleApiError(res, err);
  }
});
