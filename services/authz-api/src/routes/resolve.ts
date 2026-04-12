import { Router } from 'express';
import { pool } from '../db';
import { audit } from '../audit';

export const resolveRouter = Router();

// Path A: Config-SM resolve
resolveRouter.post('/', async (req, res) => {
  const { user_id, groups = [], attributes = {} } = req.body;
  try {
    const result = await pool.query(
      'SELECT authz_resolve($1, $2, $3) AS config',
      [user_id, groups, JSON.stringify(attributes)]
    );
    audit({
      access_path: 'A', subject_id: `user:${user_id}`,
      action_id: 'resolve', resource_id: '*', decision: 'allow',
      context: { groups, attributes },
    });
    res.json(result.rows[0].config);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Path B: Web ACL resolve
resolveRouter.post('/web-acl', async (req, res) => {
  const { user_id, groups = [] } = req.body;
  try {
    const result = await pool.query(
      'SELECT authz_resolve_web_acl($1, $2) AS config',
      [user_id, groups]
    );
    audit({
      access_path: 'B', subject_id: `user:${user_id}`,
      action_id: 'resolve_web_acl', resource_id: '*', decision: 'allow',
      context: { groups },
    });
    res.json(result.rows[0].config);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
