import { Router } from 'express';
import { pool } from '../db';

export const checkRouter = Router();

// Single check
checkRouter.post('/', async (req, res) => {
  const { user_id, groups = [], action, resource } = req.body;
  try {
    const result = await pool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [user_id, groups, action, resource]
    );
    res.json({ allowed: result.rows[0].allowed });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Batch check
checkRouter.post('/batch', async (req, res) => {
  const { user_id, groups = [], checks } = req.body;
  // checks: Array<{ action: string, resource: string }>
  try {
    const results = await Promise.all(
      checks.map(async (c: { action: string; resource: string }) => {
        const r = await pool.query(
          'SELECT authz_check($1, $2, $3, $4) AS allowed',
          [user_id, groups, c.action, c.resource]
        );
        return { action: c.action, resource: c.resource, allowed: r.rows[0].allowed };
      })
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
