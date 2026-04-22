import { Router } from 'express';
import { pool } from '../db';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';

export const configBulkRouter = Router();

// ============================================================
// POST /api/config/bulk
// Bulk upsert for AuthZ configuration entities.
// Supports dry_run mode for preview before applying.
//
// Designed for:
// - AI-suggested configuration changes
// - Environment migration (dev → staging → prod)
// - Batch setup from JSON/YAML
// ============================================================

interface BulkResult {
  section: string;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

configBulkRouter.post('/', async (req, res) => {
  const { dry_run = false, ...sections } = req.body;
  const userId = getUserId(req);
  const ip = getClientIp(req);
  const results: BulkResult[] = [];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Dependency order: actions → resources → roles → permissions → subjects → assignments → policies ──

    if (sections.actions) {
      results.push(await bulkActions(client, sections.actions));
    }
    if (sections.resources) {
      results.push(await bulkResources(client, sections.resources));
    }
    if (sections.roles) {
      results.push(await bulkRoles(client, sections.roles));
    }
    if (sections.subjects) {
      results.push(await bulkSubjects(client, sections.subjects));
    }
    if (sections.policies) {
      results.push(await bulkPolicies(client, sections.policies, userId));
    }

    if (dry_run) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      logAdminAction(pool, {
        userId, action: 'BULK_IMPORT', resourceType: 'config',
        resourceId: 'bulk', details: { sections: results.map(r => ({ section: r.section, created: r.created, updated: r.updated })), dry_run },
        ip,
      });
    }

    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    res.json({
      dry_run,
      status: totalErrors > 0 ? 'partial' : 'ok',
      results,
      totals: {
        created: results.reduce((s, r) => s + r.created, 0),
        updated: results.reduce((s, r) => s + r.updated, 0),
        skipped: results.reduce((s, r) => s + r.skipped, 0),
        errors: totalErrors,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    handleApiError(res, err);
  } finally {
    client.release();
  }
});

// ── Actions ──────────────────────────────────────────────────

async function bulkActions(client: any, actions: any[]): Promise<BulkResult> {
  const result: BulkResult = { section: 'actions', created: 0, updated: 0, skipped: 0, errors: [] };
  for (const a of actions) {
    if (!a.action_id || !a.display_name) {
      result.errors.push(`Action missing action_id or display_name: ${JSON.stringify(a)}`);
      continue;
    }
    try {
      const r = await client.query(
        `INSERT INTO authz_action (action_id, display_name, description, applicable_paths, is_active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (action_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = COALESCE(EXCLUDED.description, authz_action.description),
           applicable_paths = COALESCE(EXCLUDED.applicable_paths, authz_action.applicable_paths),
           is_active = COALESCE(EXCLUDED.is_active, authz_action.is_active)
         RETURNING (xmax = 0) AS inserted`,
        [a.action_id, a.display_name, a.description || null, a.applicable_paths || '{A,B,C}', a.is_active ?? true]
      );
      if (r.rows[0].inserted) result.created++; else result.updated++;
    } catch (err) {
      result.errors.push(`Action "${a.action_id}": ${String(err)}`);
    }
  }
  return result;
}

// ── Resources ────────────────────────────────────────────────

async function bulkResources(client: any, resources: any[]): Promise<BulkResult> {
  const result: BulkResult = { section: 'resources', created: 0, updated: 0, skipped: 0, errors: [] };

  // Sort: parents first (no parent_id → first), then children
  const sorted = [...resources].sort((a, b) => {
    if (!a.parent_id && b.parent_id) return -1;
    if (a.parent_id && !b.parent_id) return 1;
    return 0;
  });

  for (const r of sorted) {
    if (!r.resource_id || !r.resource_type || !r.display_name) {
      result.errors.push(`Resource missing required fields: ${JSON.stringify(r)}`);
      continue;
    }
    try {
      const q = await client.query(
        `INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (resource_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           parent_id = COALESCE(EXCLUDED.parent_id, authz_resource.parent_id),
           attributes = authz_resource.attributes || COALESCE(EXCLUDED.attributes, '{}'::jsonb),
           is_active = COALESCE(EXCLUDED.is_active, authz_resource.is_active),
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [r.resource_id, r.resource_type, r.parent_id || null, r.display_name,
         JSON.stringify(r.attributes || {}), r.is_active ?? true]
      );
      if (q.rows[0].inserted) result.created++; else result.updated++;
    } catch (err) {
      result.errors.push(`Resource "${r.resource_id}": ${String(err)}`);
    }
  }
  return result;
}

// ── Roles (with nested permissions) ──────────────────────────

async function bulkRoles(client: any, roles: any[]): Promise<BulkResult> {
  const result: BulkResult = { section: 'roles', created: 0, updated: 0, skipped: 0, errors: [] };

  for (const role of roles) {
    if (!role.role_id || !role.display_name) {
      result.errors.push(`Role missing role_id or display_name: ${JSON.stringify(role)}`);
      continue;
    }
    try {
      // Upsert role
      const r = await client.query(
        `INSERT INTO authz_role (role_id, display_name, description, is_system, is_active, security_clearance, job_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (role_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = COALESCE(EXCLUDED.description, authz_role.description),
           is_active = COALESCE(EXCLUDED.is_active, authz_role.is_active),
           security_clearance = COALESCE(EXCLUDED.security_clearance, authz_role.security_clearance),
           job_level = COALESCE(EXCLUDED.job_level, authz_role.job_level)
         RETURNING (xmax = 0) AS inserted`,
        [role.role_id, role.display_name, role.description || null,
         role.is_system ?? false, role.is_active ?? true,
         role.security_clearance || 'PUBLIC', role.job_level ?? 0]
      );
      if (r.rows[0].inserted) result.created++; else result.updated++;

      // Upsert permissions
      if (Array.isArray(role.permissions)) {
        for (const perm of role.permissions) {
          if (!perm.action || !perm.resource) continue;
          try {
            await client.query(
              `INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect, is_active)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (role_id, action_id, resource_id) DO UPDATE SET
                 effect = EXCLUDED.effect,
                 is_active = EXCLUDED.is_active`,
              [role.role_id, perm.action, perm.resource, perm.effect || 'allow', perm.is_active ?? true]
            );
          } catch (err) {
            result.errors.push(`Permission ${role.role_id}/${perm.action}/${perm.resource}: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      result.errors.push(`Role "${role.role_id}": ${String(err)}`);
    }
  }
  return result;
}

// ── Subjects (with nested role assignments + group memberships) ──

async function bulkSubjects(client: any, subjects: any[]): Promise<BulkResult> {
  const result: BulkResult = { section: 'subjects', created: 0, updated: 0, skipped: 0, errors: [] };

  // Sort: groups first (so they exist before membership assignment)
  const sorted = [...subjects].sort((a, b) => {
    if (a.subject_type === 'ldap_group' && b.subject_type !== 'ldap_group') return -1;
    if (a.subject_type !== 'ldap_group' && b.subject_type === 'ldap_group') return 1;
    return 0;
  });

  for (const subj of sorted) {
    if (!subj.subject_id || !subj.subject_type || !subj.display_name) {
      result.errors.push(`Subject missing required fields: ${JSON.stringify(subj)}`);
      continue;
    }

    // Convention: subject_id uses 'user:' or 'group:' prefix in DB
    const prefix = subj.subject_type === 'ldap_group' ? 'group:' : 'user:';
    const fullSubjectId = subj.subject_id.startsWith(prefix) ? subj.subject_id : prefix + subj.subject_id;

    try {
      // Upsert subject
      const r = await client.query(
        `INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn, attributes, is_active)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (subject_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           ldap_dn = COALESCE(EXCLUDED.ldap_dn, authz_subject.ldap_dn),
           attributes = authz_subject.attributes || COALESCE(EXCLUDED.attributes, '{}'::jsonb),
           is_active = COALESCE(EXCLUDED.is_active, authz_subject.is_active),
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [fullSubjectId, subj.subject_type, subj.display_name,
         subj.ldap_dn || null, JSON.stringify(subj.attributes || {}), subj.is_active ?? true]
      );
      if (r.rows[0].inserted) result.created++; else result.updated++;
      if (Array.isArray(subj.roles)) {
        for (const ra of subj.roles) {
          const roleId = typeof ra === 'string' ? ra : ra.role_id;
          if (!roleId) continue;
          try {
            await client.query(
              `INSERT INTO authz_subject_role (subject_id, role_id, granted_by, valid_from, valid_until, is_active)
               VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6)
               ON CONFLICT (subject_id, role_id) DO UPDATE SET
                 is_active = EXCLUDED.is_active,
                 valid_until = EXCLUDED.valid_until`,
              [fullSubjectId, roleId, typeof ra === 'object' ? ra.granted_by || 'bulk_import' : 'bulk_import',
               typeof ra === 'object' ? ra.valid_from || null : null,
               typeof ra === 'object' ? ra.valid_until || null : null,
               typeof ra === 'object' ? ra.is_active ?? true : true]
            );
          } catch (err) {
            result.errors.push(`Role assignment ${subj.subject_id}→${roleId}: ${String(err)}`);
          }
        }
      }

      // Upsert group memberships (for users: groups they belong to)
      if (Array.isArray(subj.groups) && subj.subject_type === 'user') {
        for (const gid of subj.groups) {
          const fullGroupId = gid.startsWith('group:') ? gid : 'group:' + gid;
          try {
            await client.query(
              `INSERT INTO authz_group_member (group_id, user_id, source) VALUES ($1, $2, 'bulk_import')
               ON CONFLICT DO NOTHING`,
              [fullGroupId, fullSubjectId]
            );
          } catch (err) {
            result.errors.push(`Group membership ${subj.subject_id}→${groupId}: ${String(err)}`);
          }
        }
      }

      // Upsert members (for groups: users in this group)
      if (Array.isArray(subj.members) && subj.subject_type === 'ldap_group') {
        for (const uid of subj.members) {
          const fullUserId = uid.startsWith('user:') ? uid : 'user:' + uid;
          try {
            await client.query(
              `INSERT INTO authz_group_member (group_id, user_id, source) VALUES ($1, $2, 'bulk_import')
               ON CONFLICT DO NOTHING`,
              [fullSubjectId, fullUserId]
            );
          } catch (err) {
            result.errors.push(`Group member ${subj.subject_id}←${userId}: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      result.errors.push(`Subject "${subj.subject_id}": ${String(err)}`);
    }
  }
  return result;
}

// ── Policies (with nested assignments) ───────────────────────

async function bulkPolicies(client: any, policies: any[], userId: string): Promise<BulkResult> {
  const result: BulkResult = { section: 'policies', created: 0, updated: 0, skipped: 0, errors: [] };

  for (const pol of policies) {
    if (!pol.policy_name || !pol.granularity || !pol.effect) {
      result.errors.push(`Policy missing required fields: ${JSON.stringify(pol)}`);
      continue;
    }
    try {
      const r = await client.query(
        `INSERT INTO authz_policy (
           policy_name, description, granularity, priority, effect, status, applicable_paths,
           subject_condition, resource_condition, action_condition, environment_condition,
           rls_expression, column_mask_rules, created_by, effective_from, effective_until
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15, $16)
         ON CONFLICT (policy_name) DO UPDATE SET
           description = COALESCE(EXCLUDED.description, authz_policy.description),
           priority = EXCLUDED.priority,
           effect = EXCLUDED.effect,
           status = COALESCE(EXCLUDED.status, authz_policy.status),
           subject_condition = EXCLUDED.subject_condition,
           resource_condition = EXCLUDED.resource_condition,
           action_condition = EXCLUDED.action_condition,
           environment_condition = EXCLUDED.environment_condition,
           rls_expression = EXCLUDED.rls_expression,
           column_mask_rules = EXCLUDED.column_mask_rules,
           updated_at = now()
         RETURNING policy_id, (xmax = 0) AS inserted`,
        [pol.policy_name, pol.description || null, pol.granularity,
         pol.priority ?? 100, pol.effect, pol.status || 'active',
         pol.applicable_paths || '{A,B,C}',
         JSON.stringify(pol.subject_condition || {}),
         JSON.stringify(pol.resource_condition || {}),
         JSON.stringify(pol.action_condition || {}),
         JSON.stringify(pol.environment_condition || {}),
         pol.rls_expression || null,
         pol.column_mask_rules ? JSON.stringify(pol.column_mask_rules) : null,
         userId, pol.effective_from || null, pol.effective_until || null]
      );
      const policyId = r.rows[0].policy_id;
      if (r.rows[0].inserted) result.created++; else result.updated++;

      // Upsert assignments
      if (Array.isArray(pol.assignments)) {
        for (const pa of pol.assignments) {
          if (!pa.assignment_type || !pa.assignment_value) continue;
          try {
            await client.query(
              `INSERT INTO authz_policy_assignment (policy_id, assignment_type, assignment_value, is_exception)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (policy_id, assignment_type, assignment_value, is_exception) DO NOTHING`,
              [policyId, pa.assignment_type, pa.assignment_value, pa.is_exception ?? false]
            );
          } catch (err) {
            result.errors.push(`Policy assignment ${pol.policy_name}→${pa.assignment_value}: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      result.errors.push(`Policy "${pol.policy_name}": ${String(err)}`);
    }
  }
  return result;
}
