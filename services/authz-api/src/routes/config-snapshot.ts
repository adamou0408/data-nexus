import { Router } from 'express';
import { pool } from '../db';

export const configSnapshotRouter = Router();

// ============================================================
// GET /api/config/snapshot
// Export full AuthZ configuration as structured JSON.
// Designed for AI analysis and environment migration.
// Passwords/secrets are NEVER included.
// ============================================================

configSnapshotRouter.get('/', async (req, res) => {
  try {
    const sections = req.query.sections
      ? String(req.query.sections).split(',').map(s => s.trim())
      : null; // null = all sections

    const include = (name: string) => !sections || sections.includes(name);

    const snapshot: Record<string, any> = {
      _meta: {
        exported_at: new Date().toISOString(),
        system: 'Phison Data Nexus AuthZ',
        format_version: '1.0',
        description: 'Read-only configuration snapshot. Use POST /api/config/bulk to apply changes.',
      },
    };

    // Run all independent queries in parallel
    const [
      actionsR, rolesR, permissionsR, subjectsR,
      subjectRolesR, groupMembersR, resourcesR,
      policiesR, policyAssignmentsR, dataSourcesR,
      dsResourceCountsR, poolProfilesR, poolAssignmentsR,
      credentialsR, uiPagesR, clearanceMappingsR,
    ] = await Promise.all([
      include('actions')    ? pool.query('SELECT action_id, display_name, description, applicable_paths, is_active FROM authz_action ORDER BY action_id') : null,
      include('roles')      ? pool.query('SELECT role_id, display_name, description, is_system, is_active, security_clearance, job_level FROM authz_role ORDER BY role_id') : null,
      include('roles')      ? pool.query(`SELECT rp.role_id, rp.action_id, rp.resource_id, rp.effect, rp.is_active
                                           FROM authz_role_permission rp ORDER BY rp.role_id, rp.resource_id, rp.action_id`) : null,
      include('subjects')   ? pool.query(`SELECT subject_id, subject_type, display_name, ldap_dn, attributes, is_active FROM authz_subject ORDER BY subject_type, subject_id`) : null,
      include('subjects')   ? pool.query(`SELECT sr.subject_id, sr.role_id, sr.valid_from, sr.valid_until, sr.granted_by, sr.is_active FROM authz_subject_role sr ORDER BY sr.subject_id, sr.role_id`) : null,
      include('subjects')   ? pool.query(`SELECT group_id, user_id, source FROM authz_group_member ORDER BY group_id, user_id`) : null,
      include('resources')  ? pool.query(`SELECT resource_id, resource_type, parent_id, display_name, attributes, is_active FROM authz_resource ORDER BY resource_type, resource_id`) : null,
      include('policies')   ? pool.query(`SELECT policy_id, policy_name, description, granularity, priority, effect, status, applicable_paths,
                                                  subject_condition, resource_condition, action_condition, environment_condition,
                                                  rls_expression, column_mask_rules, created_by, effective_from, effective_until
                                           FROM authz_policy ORDER BY priority, policy_name`) : null,
      include('policies')   ? pool.query(`SELECT pa.id, pa.policy_id, pa.assignment_type, pa.assignment_value, pa.is_exception FROM authz_policy_assignment pa ORDER BY pa.policy_id`) : null,
      include('data_sources') ? pool.query(`SELECT source_id, display_name, description, db_type, host, port, database_name, schemas,
                                                    connector_user, owner_subject, is_active, cdc_target_schema,
                                                    CASE WHEN oracle_connection IS NOT NULL
                                                         THEN jsonb_build_object('host', oracle_connection->>'host', 'port', oracle_connection->>'port', 'service_name', oracle_connection->>'service_name', 'user', oracle_connection->>'user')
                                                         ELSE NULL END AS oracle_connection_safe
                                             FROM authz_data_source ORDER BY source_id`) : null,
      include('data_sources') ? pool.query(`SELECT attributes->>'data_source_id' AS ds_id, resource_type, count(*) AS cnt
                                             FROM authz_resource WHERE attributes ? 'data_source_id' AND is_active = TRUE
                                             GROUP BY attributes->>'data_source_id', resource_type ORDER BY ds_id`) : null,
      include('pool_profiles') ? pool.query(`SELECT profile_id, pg_role, allowed_schemas, allowed_tables, denied_columns, connection_mode,
                                                     max_connections, ip_whitelist, valid_hours, rls_applies, description, is_active,
                                                     data_source_id, allowed_modules
                                              FROM authz_db_pool_profile ORDER BY profile_id`) : null,
      include('pool_profiles') ? pool.query(`SELECT pa.subject_id, pa.profile_id, pa.granted_by, pa.valid_from, pa.valid_until, pa.is_active
                                              FROM authz_db_pool_assignment pa ORDER BY pa.profile_id, pa.subject_id`) : null,
      include('pool_profiles') ? pool.query(`SELECT pg_role, is_active, last_rotated, rotate_interval FROM authz_pool_credentials ORDER BY pg_role`) : null,
      include('ui_pages')    ? pool.query(`SELECT page_id, title, subtitle, layout, resource_id, data_table, order_by, row_limit,
                                                   row_drilldown, columns_override, filters_config, parent_page_id, icon, description, display_order, is_active
                                            FROM authz_ui_page ORDER BY display_order, page_id`) : null,
      include('roles')       ? pool.query(`SELECT min_job_level, max_job_level, clearance FROM authz_clearance_mapping ORDER BY min_job_level`) : null,
    ]);

    // ── Actions ──
    if (actionsR) {
      snapshot.actions = actionsR.rows;
    }

    // ── Roles (with nested permissions) ──
    if (rolesR && permissionsR) {
      const permsByRole = new Map<string, any[]>();
      for (const p of permissionsR.rows) {
        if (!permsByRole.has(p.role_id)) permsByRole.set(p.role_id, []);
        permsByRole.get(p.role_id)!.push({
          action: p.action_id, resource: p.resource_id,
          effect: p.effect, is_active: p.is_active,
        });
      }
      snapshot.roles = rolesR.rows.map(r => ({
        ...r,
        permissions: permsByRole.get(r.role_id) || [],
      }));
      if (clearanceMappingsR) {
        snapshot.clearance_mappings = clearanceMappingsR.rows;
      }
    }

    // ── Subjects (with nested role assignments + group memberships) ──
    if (subjectsR && subjectRolesR && groupMembersR) {
      const rolesBySubject = new Map<string, any[]>();
      for (const sr of subjectRolesR.rows) {
        if (!rolesBySubject.has(sr.subject_id)) rolesBySubject.set(sr.subject_id, []);
        rolesBySubject.get(sr.subject_id)!.push({
          role_id: sr.role_id, valid_from: sr.valid_from, valid_until: sr.valid_until,
          granted_by: sr.granted_by, is_active: sr.is_active,
        });
      }
      const groupsByUser = new Map<string, string[]>();
      const membersByGroup = new Map<string, string[]>();
      for (const gm of groupMembersR.rows) {
        if (!groupsByUser.has(gm.user_id)) groupsByUser.set(gm.user_id, []);
        groupsByUser.get(gm.user_id)!.push(gm.group_id);
        if (!membersByGroup.has(gm.group_id)) membersByGroup.set(gm.group_id, []);
        membersByGroup.get(gm.group_id)!.push(gm.user_id);
      }
      snapshot.subjects = subjectsR.rows.map(s => ({
        ...s,
        roles: rolesBySubject.get(s.subject_id) || [],
        ...(s.subject_type === 'user'
          ? { groups: groupsByUser.get(s.subject_id) || [] }
          : { members: membersByGroup.get(s.subject_id) || [] }),
      }));
    }

    // ── Resources ──
    if (resourcesR) {
      snapshot.resources = resourcesR.rows;
    }

    // ── Policies (with nested assignments) ──
    if (policiesR && policyAssignmentsR) {
      const assignsByPolicy = new Map<number, any[]>();
      for (const pa of policyAssignmentsR.rows) {
        if (!assignsByPolicy.has(pa.policy_id)) assignsByPolicy.set(pa.policy_id, []);
        assignsByPolicy.get(pa.policy_id)!.push({
          assignment_type: pa.assignment_type,
          assignment_value: pa.assignment_value,
          is_exception: pa.is_exception,
        });
      }
      snapshot.policies = policiesR.rows.map(p => ({
        ...p,
        assignments: assignsByPolicy.get(p.policy_id) || [],
      }));
    }

    // ── Data Sources (no passwords) ──
    if (dataSourcesR) {
      const countsByDs = new Map<string, Record<string, number>>();
      if (dsResourceCountsR) {
        for (const row of dsResourceCountsR.rows) {
          if (!countsByDs.has(row.ds_id)) countsByDs.set(row.ds_id, {});
          countsByDs.get(row.ds_id)![row.resource_type] = parseInt(row.cnt);
        }
      }
      snapshot.data_sources = dataSourcesR.rows.map(ds => ({
        source_id: ds.source_id,
        display_name: ds.display_name,
        description: ds.description,
        db_type: ds.db_type,
        host: ds.host,
        port: ds.port,
        database_name: ds.database_name,
        schemas: ds.schemas,
        connector_user: ds.connector_user,
        owner_subject: ds.owner_subject,
        is_active: ds.is_active,
        cdc_target_schema: ds.cdc_target_schema,
        oracle_connection: ds.oracle_connection_safe,
        discovered_resources: countsByDs.get(ds.source_id) || {},
      }));
    }

    // ── Pool Profiles (with assignments + credential status) ──
    if (poolProfilesR && poolAssignmentsR) {
      const assignsByProfile = new Map<string, any[]>();
      for (const pa of poolAssignmentsR.rows) {
        if (!assignsByProfile.has(pa.profile_id)) assignsByProfile.set(pa.profile_id, []);
        assignsByProfile.get(pa.profile_id)!.push({
          subject_id: pa.subject_id, granted_by: pa.granted_by,
          valid_from: pa.valid_from, valid_until: pa.valid_until, is_active: pa.is_active,
        });
      }
      const credMap = new Map<string, any>();
      if (credentialsR) {
        for (const c of credentialsR.rows) {
          credMap.set(c.pg_role, { is_active: c.is_active, last_rotated: c.last_rotated, rotate_interval: c.rotate_interval });
        }
      }
      snapshot.pool_profiles = poolProfilesR.rows.map(p => ({
        ...p,
        assignments: assignsByProfile.get(p.profile_id) || [],
        credential_status: credMap.get(p.pg_role) || null,
      }));
    }

    // ── UI Pages ──
    if (uiPagesR) {
      snapshot.ui_pages = uiPagesR.rows;
    }

    // ── Summary ──
    snapshot.summary = {
      actions: snapshot.actions?.length ?? '(not exported)',
      roles: snapshot.roles?.length ?? '(not exported)',
      total_permissions: snapshot.roles?.reduce((sum: number, r: any) => sum + r.permissions.length, 0) ?? '(not exported)',
      subjects: snapshot.subjects?.length ?? '(not exported)',
      subjects_by_type: snapshot.subjects
        ? snapshot.subjects.reduce((acc: Record<string, number>, s: any) => { acc[s.subject_type] = (acc[s.subject_type] || 0) + 1; return acc; }, {})
        : '(not exported)',
      resources: snapshot.resources?.length ?? '(not exported)',
      resources_by_type: snapshot.resources
        ? snapshot.resources.reduce((acc: Record<string, number>, r: any) => { acc[r.resource_type] = (acc[r.resource_type] || 0) + 1; return acc; }, {})
        : '(not exported)',
      policies: snapshot.policies?.length ?? '(not exported)',
      data_sources: snapshot.data_sources?.length ?? '(not exported)',
      pool_profiles: snapshot.pool_profiles?.length ?? '(not exported)',
      ui_pages: snapshot.ui_pages?.length ?? '(not exported)',
    };

    res.json(snapshot);
  } catch (err) {
    console.error('Config snapshot error:', err);
    res.status(500).json({ error: 'Failed to export configuration snapshot' });
  }
});
