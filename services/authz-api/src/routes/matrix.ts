import { Router } from 'express';
import { pool } from '../db';

export const matrixRouter = Router();

matrixRouter.get('/', async (req, res) => {
  const actionFilter = req.query.action as string | undefined;
  try {
    let query = `
      SELECT rp.role_id, rp.action_id, rp.resource_id, rp.effect::text
      FROM authz_role_permission rp
      WHERE rp.is_active = TRUE
    `;
    const params: string[] = [];
    if (actionFilter) {
      params.push(actionFilter);
      query += ` AND rp.action_id = $1`;
    }
    query += ' ORDER BY rp.role_id, rp.resource_id, rp.action_id';

    const result = await pool.query(query, params);

    // Also fetch roles and resources for headers
    const roles = await pool.query('SELECT role_id, display_name FROM authz_role WHERE is_active = TRUE ORDER BY role_id');
    const resources = await pool.query("SELECT resource_id, display_name, resource_type FROM authz_resource WHERE is_active = TRUE ORDER BY resource_id");
    const actions = await pool.query('SELECT action_id, display_name FROM authz_action WHERE is_active = TRUE ORDER BY action_id');

    res.json({
      permissions: result.rows,
      roles: roles.rows,
      resources: resources.rows,
      actions: actions.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
