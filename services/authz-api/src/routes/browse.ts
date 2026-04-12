import { Router } from 'express';
import { pool } from '../db';

export const browseRouter = Router();

browseRouter.get('/subjects', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, array_agg(sr.role_id) FILTER (WHERE sr.role_id IS NOT NULL) AS roles
      FROM authz_subject s
      LEFT JOIN authz_subject_role sr ON sr.subject_id = s.subject_id AND sr.is_active = TRUE
      GROUP BY s.subject_id
      ORDER BY s.subject_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/roles', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*,
        (SELECT count(*) FROM authz_subject_role sr WHERE sr.role_id = r.role_id AND sr.is_active) AS assignment_count,
        (SELECT count(*) FROM authz_role_permission rp WHERE rp.role_id = r.role_id AND rp.is_active) AS permission_count
      FROM authz_role r
      ORDER BY r.role_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/resources', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM authz_resource WHERE is_active = TRUE ORDER BY resource_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/policies', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM authz_policy ORDER BY policy_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseRouter.get('/actions', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM authz_action WHERE is_active = TRUE ORDER BY action_id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
