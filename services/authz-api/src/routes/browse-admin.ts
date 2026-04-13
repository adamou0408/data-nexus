import { Router } from 'express';
import { pool } from '../db';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp } from '../lib/request-helpers';

export const browseAdminRouter = Router();

// --- Subjects CRUD ---
browseAdminRouter.post('/subjects', async (req, res) => {
  const { subject_id, subject_type, display_name, ldap_dn, attributes } = req.body;
  if (!subject_id || !subject_type || !display_name) {
    return res.status(400).json({ error: 'subject_id, subject_type, and display_name are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn, attributes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [subject_id, subject_type, display_name, ldap_dn || null, JSON.stringify(attributes || {})]
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_SUBJECT', resourceType: 'subject', resourceId: subject_id, details: { subject_type, display_name }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.put('/subjects/:id', async (req, res) => {
  const { display_name, ldap_dn, attributes, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_subject SET display_name = COALESCE($2, display_name),
        ldap_dn = COALESCE($3, ldap_dn), attributes = COALESCE($4::jsonb, attributes),
        is_active = COALESCE($5, is_active), updated_at = now()
       WHERE subject_id = $1 RETURNING *`,
      [req.params.id, display_name, ldap_dn, attributes ? JSON.stringify(attributes) : null, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });
    logAdminAction(pool, { userId: getUserId(req), action: 'UPDATE_SUBJECT', resourceType: 'subject', resourceId: req.params.id, details: { display_name, is_active }, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/subjects/:id', async (req, res) => {
  try {
    await pool.query('UPDATE authz_subject SET is_active = FALSE, updated_at = now() WHERE subject_id = $1', [req.params.id]);
    logAdminAction(pool, { userId: getUserId(req), action: 'DELETE_SUBJECT', resourceType: 'subject', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Subject group membership
browseAdminRouter.post('/subjects/:id/groups', async (req, res) => {
  const { group_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO authz_group_member (group_id, user_id, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [group_id, req.params.id, 'manual']
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'ADD_GROUP_MEMBER', resourceType: 'subject', resourceId: req.params.id, details: { group_id }, ip: getClientIp(req) });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/subjects/:id/groups/:groupId', async (req, res) => {
  try {
    await pool.query('DELETE FROM authz_group_member WHERE group_id = $1 AND user_id = $2', [req.params.groupId, req.params.id]);
    logAdminAction(pool, { userId: getUserId(req), action: 'REMOVE_GROUP_MEMBER', resourceType: 'subject', resourceId: req.params.id, details: { group_id: req.params.groupId }, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Subject role assignment
browseAdminRouter.post('/subjects/:id/roles', async (req, res) => {
  const { role_id, valid_from, valid_until, granted_by } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO authz_subject_role (subject_id, role_id, valid_from, valid_until, granted_by)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4::timestamptz, $5)
       ON CONFLICT (subject_id, role_id) DO UPDATE SET is_active = TRUE, valid_from = COALESCE($3::timestamptz, now()), valid_until = $4::timestamptz
       RETURNING *`,
      [req.params.id, role_id, valid_from || null, valid_until || null, granted_by || 'admin_ui']
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'ASSIGN_ROLE', resourceType: 'subject', resourceId: req.params.id, details: { role_id, valid_from, valid_until }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/subjects/:id/roles/:roleId', async (req, res) => {
  try {
    await pool.query(
      'UPDATE authz_subject_role SET is_active = FALSE WHERE subject_id = $1 AND role_id = $2',
      [req.params.id, req.params.roleId]
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'REVOKE_ROLE', resourceType: 'subject', resourceId: req.params.id, details: { role_id: req.params.roleId }, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Roles CRUD ---
browseAdminRouter.post('/roles', async (req, res) => {
  const { role_id, display_name, description, is_system } = req.body;
  if (!role_id || !display_name) {
    return res.status(400).json({ error: 'role_id and display_name are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO authz_role (role_id, display_name, description, is_system) VALUES ($1, $2, $3, $4) RETURNING *',
      [role_id, display_name, description || null, is_system ?? false]
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_ROLE', resourceType: 'role', resourceId: role_id, details: { display_name, is_system }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.put('/roles/:id', async (req, res) => {
  const { display_name, description, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_role SET display_name = COALESCE($2, display_name),
        description = COALESCE($3, description), is_active = COALESCE($4, is_active)
       WHERE role_id = $1 RETURNING *`,
      [req.params.id, display_name, description, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Role not found' });
    logAdminAction(pool, { userId: getUserId(req), action: 'UPDATE_ROLE', resourceType: 'role', resourceId: req.params.id, details: { display_name, description, is_active }, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/roles/:id', async (req, res) => {
  try {
    await pool.query('UPDATE authz_role SET is_active = FALSE WHERE role_id = $1', [req.params.id]);
    logAdminAction(pool, { userId: getUserId(req), action: 'DELETE_ROLE', resourceType: 'role', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Role permissions
browseAdminRouter.post('/roles/:id/permissions', async (req, res) => {
  const { action_id, resource_id, effect } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (role_id, action_id, resource_id) DO UPDATE SET effect = $4, is_active = TRUE
       RETURNING *`,
      [req.params.id, action_id, resource_id, effect || 'allow']
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'SET_PERMISSION', resourceType: 'role', resourceId: req.params.id, details: { action_id, resource_id, effect: effect || 'allow' }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/roles/:id/permissions/:permId', async (req, res) => {
  try {
    await pool.query('UPDATE authz_role_permission SET is_active = FALSE WHERE id = $1 AND role_id = $2', [req.params.permId, req.params.id]);
    logAdminAction(pool, { userId: getUserId(req), action: 'REVOKE_PERMISSION', resourceType: 'role', resourceId: req.params.id, details: { permission_id: req.params.permId }, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Resources ---
browseAdminRouter.put('/resources/bulk-parent', async (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return res.status(400).json({ error: 'mappings array required: [{resource_id, parent_id}]' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let updated = 0;
    for (const m of mappings) {
      const result = await client.query(
        'UPDATE authz_resource SET parent_id = $2, updated_at = now() WHERE resource_id = $1 AND is_active = TRUE',
        [m.resource_id, m.parent_id || null]
      );
      updated += result.rowCount || 0;
    }
    await client.query('COMMIT');
    logAdminAction(pool, { userId: getUserId(req), action: 'BULK_MAP_RESOURCES', resourceType: 'resource', details: { count: updated, mappings }, ip: getClientIp(req) });
    res.json({ updated });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: String(err) });
  } finally {
    client.release();
  }
});

browseAdminRouter.post('/resources', async (req, res) => {
  const { resource_id, resource_type, display_name, parent_id, attributes } = req.body;
  if (!resource_id || !resource_type || !display_name) {
    return res.status(400).json({ error: 'resource_id, resource_type, and display_name are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [resource_id, resource_type, parent_id || null, display_name, JSON.stringify(attributes || {})]
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_RESOURCE', resourceType: 'resource', resourceId: resource_id, details: { resource_type, display_name }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.put('/resources/:id', async (req, res) => {
  const { display_name, parent_id, attributes, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_resource SET display_name = COALESCE($2, display_name),
        parent_id = COALESCE($3, parent_id), attributes = COALESCE($4::jsonb, attributes),
        is_active = COALESCE($5, is_active), updated_at = now()
       WHERE resource_id = $1 RETURNING *`,
      [req.params.id, display_name, parent_id, attributes ? JSON.stringify(attributes) : null, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found' });
    logAdminAction(pool, { userId: getUserId(req), action: 'UPDATE_RESOURCE', resourceType: 'resource', resourceId: req.params.id, details: { display_name, is_active }, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/resources/:id', async (req, res) => {
  try {
    await pool.query('UPDATE authz_resource SET is_active = FALSE, updated_at = now() WHERE resource_id = $1', [req.params.id]);
    logAdminAction(pool, { userId: getUserId(req), action: 'DELETE_RESOURCE', resourceType: 'resource', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Policies CRUD ---
browseAdminRouter.post('/policies', async (req, res) => {
  const { policy_name, description, granularity, priority, effect, status, applicable_paths,
    subject_condition, resource_condition, action_condition, environment_condition,
    rls_expression, column_mask_rules, created_by } = req.body;
  if (!policy_name || !granularity) {
    return res.status(400).json({ error: 'policy_name and granularity are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO authz_policy (policy_name, description, granularity, priority, effect, status,
        applicable_paths, subject_condition, resource_condition, action_condition,
        environment_condition, rls_expression, column_mask_rules, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [policy_name, description, granularity, priority || 100, effect || 'allow',
        status || 'active', applicable_paths || ['A','B','C'],
        JSON.stringify(subject_condition || {}), JSON.stringify(resource_condition || {}),
        JSON.stringify(action_condition || {}), JSON.stringify(environment_condition || {}),
        rls_expression || null, column_mask_rules ? JSON.stringify(column_mask_rules) : null,
        created_by || 'admin_ui']
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_POLICY', resourceType: 'policy', resourceId: String(result.rows[0].policy_id), details: { policy_name, granularity, effect }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.put('/policies/:id', async (req, res) => {
  const { description, priority, effect, status, applicable_paths,
    subject_condition, resource_condition, action_condition, environment_condition,
    rls_expression, column_mask_rules } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_policy SET
        description = COALESCE($2, description), priority = COALESCE($3, priority),
        effect = COALESCE($4, effect), status = COALESCE($5, status),
        applicable_paths = COALESCE($6, applicable_paths),
        subject_condition = COALESCE($7::jsonb, subject_condition),
        resource_condition = COALESCE($8::jsonb, resource_condition),
        action_condition = COALESCE($9::jsonb, action_condition),
        environment_condition = COALESCE($10::jsonb, environment_condition),
        rls_expression = COALESCE($11, rls_expression),
        column_mask_rules = COALESCE($12::jsonb, column_mask_rules),
        updated_at = now()
       WHERE policy_id = $1 RETURNING *`,
      [req.params.id, description, priority, effect, status,
        applicable_paths, subject_condition ? JSON.stringify(subject_condition) : null,
        resource_condition ? JSON.stringify(resource_condition) : null,
        action_condition ? JSON.stringify(action_condition) : null,
        environment_condition ? JSON.stringify(environment_condition) : null,
        rls_expression, column_mask_rules ? JSON.stringify(column_mask_rules) : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Policy not found' });
    logAdminAction(pool, { userId: getUserId(req), action: 'UPDATE_POLICY', resourceType: 'policy', resourceId: req.params.id, details: { status, priority, effect }, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/policies/:id', async (req, res) => {
  try {
    await pool.query("UPDATE authz_policy SET status = 'inactive', updated_at = now() WHERE policy_id = $1", [req.params.id]);
    logAdminAction(pool, { userId: getUserId(req), action: 'DELETE_POLICY', resourceType: 'policy', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Actions CRUD ---
browseAdminRouter.post('/actions', async (req, res) => {
  const { action_id, display_name, description, applicable_paths } = req.body;
  if (!action_id || !display_name) {
    return res.status(400).json({ error: 'action_id and display_name are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO authz_action (action_id, display_name, description, applicable_paths) VALUES ($1, $2, $3, $4) RETURNING *',
      [action_id, display_name, description || null, applicable_paths || ['A','B','C']]
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_ACTION', resourceType: 'action', resourceId: action_id, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.put('/actions/:id', async (req, res) => {
  const { display_name, description, applicable_paths, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_action SET display_name = COALESCE($2, display_name),
        description = COALESCE($3, description), applicable_paths = COALESCE($4, applicable_paths),
        is_active = COALESCE($5, is_active)
       WHERE action_id = $1 RETURNING *`,
      [req.params.id, display_name, description, applicable_paths, is_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Action not found' });
    logAdminAction(pool, { userId: getUserId(req), action: 'UPDATE_ACTION', resourceType: 'action', resourceId: req.params.id, ip: getClientIp(req) });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/actions/:id', async (req, res) => {
  try {
    await pool.query('UPDATE authz_action SET is_active = FALSE WHERE action_id = $1', [req.params.id]);
    logAdminAction(pool, { userId: getUserId(req), action: 'DELETE_ACTION', resourceType: 'action', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Policy Assignments ---
browseAdminRouter.post('/policies/:id/assignments', async (req, res) => {
  const { assignment_type, assignment_value, is_exception } = req.body;
  if (!assignment_type || !assignment_value) {
    return res.status(400).json({ error: 'assignment_type and assignment_value are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO authz_policy_assignment (policy_id, assignment_type, assignment_value, is_exception)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, assignment_type, assignment_value, is_exception ?? false]
    );
    logAdminAction(pool, { userId: getUserId(req), action: 'CREATE_POLICY_ASSIGNMENT', resourceType: 'policy_assignment', resourceId: String(result.rows[0].id), details: { policy_id: req.params.id, assignment_type, assignment_value, is_exception }, ip: getClientIp(req) });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

browseAdminRouter.delete('/policy-assignments/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM authz_policy_assignment WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    logAdminAction(pool, { userId: getUserId(req), action: 'DELETE_POLICY_ASSIGNMENT', resourceType: 'policy_assignment', resourceId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Classification ---
browseAdminRouter.put('/resources/:id/classify', async (req, res) => {
  const { classification_id } = req.body;
  if (classification_id === undefined) {
    return res.status(400).json({ error: 'classification_id required' });
  }
  try {
    if (classification_id !== null) {
      const cls = await pool.query(
        'SELECT name FROM authz_data_classification WHERE classification_id = $1',
        [classification_id]
      );
      if (cls.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid classification_id' });
      }
    }

    const result = await pool.query(
      `UPDATE authz_resource
       SET attributes = attributes || jsonb_build_object('classification_id', $2::text),
           updated_at = now()
       WHERE resource_id = $1
       RETURNING resource_id, resource_type, display_name, attributes`,
      [req.params.id, classification_id !== null ? String(classification_id) : null]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    logAdminAction(pool, {
      userId: getUserId(req), action: 'CLASSIFY_RESOURCE', resourceType: 'resource',
      resourceId: req.params.id, details: { classification_id }, ip: getClientIp(req),
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Role clearance ---
browseAdminRouter.put('/roles/:id/clearance', async (req, res) => {
  const { security_clearance, job_level } = req.body;
  try {
    const result = await pool.query(
      `UPDATE authz_role SET
        security_clearance = COALESCE($2::security_clearance, security_clearance),
        job_level = COALESCE($3, job_level)
       WHERE role_id = $1 RETURNING role_id, security_clearance, job_level`,
      [req.params.id, security_clearance || null, job_level ?? null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Role not found' });
    logAdminAction(pool, {
      userId: getUserId(req), action: 'UPDATE_ROLE_CLEARANCE', resourceType: 'role',
      resourceId: req.params.id, details: { security_clearance, job_level }, ip: getClientIp(req),
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
