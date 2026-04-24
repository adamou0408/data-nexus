import { authzPool, getDataSourceClient, getLocalDataClient } from '../db';
import { audit } from '../audit';

// ── Types ──

export interface SyncAction {
  action: string;
  detail: string;
  data_source_id: string;
  profile_id: string;
  status: 'ok' | 'error';
  error?: string;
}

export interface DriftItem {
  pg_role: string;
  type: 'role_missing' | 'role_extra_privilege' | 'grant_missing' | 'grant_extra' | 'column_grant_extra';
  detail: string;
}

export interface DriftReport {
  data_source_id: string;
  checked_at: string;
  items: DriftItem[];
}

// ── Helpers ──

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function maskPassword(sql: string): string {
  return sql.replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '***'");
}

// ── Module → Table expansion ──

export async function expandModulesToTables(modules: string[], dataSourceId: string): Promise<string[]> {
  if (!modules || modules.length === 0) return [];
  const result = await authzPool.query(`
    WITH RECURSIVE descendants AS (
      SELECT resource_id, resource_type
      FROM authz_resource
      WHERE resource_id = ANY($1) AND is_active = TRUE
      UNION ALL
      SELECT r.resource_id, r.resource_type
      FROM authz_resource r
      JOIN descendants d ON r.parent_id = d.resource_id
      WHERE r.is_active = TRUE
    )
    SELECT resource_id FROM descendants
    WHERE resource_type IN ('table', 'view')
      AND resource_id IN (
        SELECT resource_id FROM authz_resource
        WHERE attributes->>'data_source_id' = $2
      )
  `, [modules, dataSourceId]);
  return result.rows.map((r: any) => r.resource_id.replace(/^table:/, ''));
}

// ── Core: Sync External Grants ──

export async function syncExternalGrants(sourceId?: string, requestUserId = 'system'): Promise<SyncAction[]> {
  const actions: SyncAction[] = [];

  // 1. Get all active profiles linked to external data sources
  const profileQuery = sourceId
    ? `SELECT dp.*, ds.source_id AS ds_id, ds.db_type AS db_type
       FROM authz_db_pool_profile dp
       JOIN authz_data_source ds ON dp.data_source_id = ds.source_id
       WHERE dp.is_active AND ds.is_active AND ds.source_id = $1`
    : `SELECT dp.*, ds.source_id AS ds_id, ds.db_type AS db_type
       FROM authz_db_pool_profile dp
       JOIN authz_data_source ds ON dp.data_source_id = ds.source_id
       WHERE dp.is_active AND ds.is_active`;

  const profiles = sourceId
    ? (await authzPool.query(profileQuery, [sourceId])).rows
    : (await authzPool.query(profileQuery)).rows;

  if (profiles.length === 0) {
    actions.push({ action: 'SKIP', detail: 'No external profiles to sync', data_source_id: sourceId || '', profile_id: '', status: 'ok' });
    return actions;
  }

  // 2. Group by data_source_id
  const grouped = new Map<string, typeof profiles>();
  for (const p of profiles) {
    const list = grouped.get(p.ds_id) || [];
    list.push(p);
    grouped.set(p.ds_id, list);
  }

  // 3. Process each data source
  for (const [dsId, dsProfiles] of grouped) {
    let client;
    const isOracle = dsProfiles[0].db_type === 'oracle';
    try {
      // Oracle sources: grants run on local nexus_data (CDC schema), not on Oracle
      client = isOracle ? await getLocalDataClient() : await getDataSourceClient(dsId);
    } catch (err) {
      // Connection failed — mark all profiles for this DS as failed
      for (const p of dsProfiles) {
        const errMsg = err instanceof Error ? err.message : String(err);
        actions.push({ action: 'CONNECT_FAILED', detail: errMsg, data_source_id: dsId, profile_id: p.profile_id, status: 'error', error: errMsg });
        await logSync('external_db_grant', dsId, p.profile_id, null, 'error', errMsg);
      }
      continue;
    }

    try {
      for (const profile of dsProfiles) {
        try {
          const profileActions = await syncProfileGrants(client, profile);
          for (const a of profileActions) {
            actions.push({ ...a, data_source_id: dsId, profile_id: profile.profile_id, status: 'ok' });
          }
          await logSync('external_db_grant', dsId, profile.profile_id, profileActions.map(a => a.detail).join('; '), 'synced', null);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          actions.push({ action: 'SYNC_FAILED', detail: errMsg, data_source_id: dsId, profile_id: profile.profile_id, status: 'error', error: errMsg });
          await logSync('external_db_grant', dsId, profile.profile_id, null, 'error', errMsg);
        }
      }

      // Update last_grant_sync_at
      await authzPool.query('UPDATE authz_data_source SET last_grant_sync_at = now() WHERE source_id = $1', [dsId]);
    } finally {
      await client.end();
    }
  }

  audit({
    access_path: 'B', subject_id: requestUserId,
    action_id: 'sync_external_grants', resource_id: sourceId || 'all',
    decision: 'allow',
    context: { profiles_total: profiles.length, actions_count: actions.length },
  });

  return actions;
}

// ── Sync a single profile's grants on the remote DB ──

async function syncProfileGrants(client: any, profile: any): Promise<{ action: string; detail: string }[]> {
  const log: { action: string; detail: string }[] = [];
  const role = quoteIdent(profile.pg_role);

  // Get credential hash
  const credResult = await authzPool.query(
    'SELECT password_hash FROM authz_pool_credentials WHERE pg_role = $1 AND is_active = TRUE',
    [profile.pg_role]
  );

  // 1. Create role if not exists
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${profile.pg_role.replace(/'/g, "''")}') THEN
        EXECUTE 'CREATE ROLE ' || ${pgLiteral(role)} || ' LOGIN';
      END IF;
    END $$;
  `);
  log.push({ action: 'ENSURE_ROLE', detail: `Role ${profile.pg_role} ensured` });

  // 2. Set password if credential exists
  if (credResult.rows.length > 0) {
    const hash = credResult.rows[0].password_hash;
    await client.query(`ALTER ROLE ${role} WITH PASSWORD '${hash.replace(/'/g, "''")}'`);
    log.push({ action: 'SET_PASSWORD', detail: maskPassword(`ALTER ROLE ${profile.pg_role} WITH PASSWORD '***'`) });
  }

  // 3. Set RLS (skip on Greenplum which doesn't support BYPASSRLS)
  const rlsMode = profile.rls_applies ? 'NOBYPASSRLS' : 'BYPASSRLS';
  try {
    await client.query(`ALTER ROLE ${role} ${rlsMode}`);
    log.push({ action: 'SET_RLS', detail: `${profile.pg_role} ${rlsMode}` });
  } catch (rlsErr) {
    const msg = rlsErr instanceof Error ? rlsErr.message : String(rlsErr);
    if (msg.includes('unrecognized role option') || msg.includes('bypassrls')) {
      log.push({ action: 'SKIP_RLS', detail: `${profile.pg_role}: RLS not supported on this DB (${msg.substring(0, 60)})` });
    } else {
      throw rlsErr;
    }
  }

  // 4. Resolve effective tables: union of allowed_tables + expanded allowed_modules
  let effectiveTables: string[] = [...(profile.allowed_tables || [])];
  if (profile.allowed_modules && profile.allowed_modules.length > 0 && profile.ds_id) {
    const moduleTables = await expandModulesToTables(profile.allowed_modules, profile.ds_id);
    effectiveTables = [...new Set([...effectiveTables, ...moduleTables])];
    if (moduleTables.length > 0) {
      log.push({ action: 'EXPAND_MODULES', detail: `Modules ${profile.allowed_modules.join(',')} → ${moduleTables.length} tables` });
    }
  }

  // 5. Grant schemas and tables
  const schemas = profile.allowed_schemas || ['public'];
  for (const schema of schemas) {
    const qs = quoteIdent(schema);

    // Revoke all first (clean slate for this schema)
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${qs} FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${qs} TO ${role}`);
    log.push({ action: 'GRANT_SCHEMA', detail: `GRANT USAGE ON SCHEMA ${schema} TO ${profile.pg_role}` });

    if (effectiveTables.length > 0) {
      // Grant specific tables
      const grants = getGrantsForMode(profile.connection_mode);
      for (const table of effectiveTables) {
        const qt = quoteIdent(table);
        await client.query(`GRANT ${grants} ON ${qs}.${qt} TO ${role}`);
        log.push({ action: 'GRANT_TABLE', detail: `GRANT ${grants} ON ${schema}.${table} TO ${profile.pg_role}` });
      }
    } else {
      // Grant all tables in schema
      const grants = getGrantsForMode(profile.connection_mode);
      await client.query(`GRANT ${grants} ON ALL TABLES IN SCHEMA ${qs} TO ${role}`);
      log.push({ action: 'GRANT_ALL_TABLES', detail: `GRANT ${grants} ON ALL TABLES IN SCHEMA ${schema} TO ${profile.pg_role}` });
    }

    // Sequence grants for readwrite/admin
    if (profile.connection_mode !== 'readonly') {
      await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${qs} TO ${role}`);
      log.push({ action: 'GRANT_SEQUENCES', detail: `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${profile.pg_role}` });
    }
  }

  // 5. Revoke denied columns (merge SSOT + static override)
  // Only revoke columns on tables that were granted above (skip non-existent tables on remote)
  const deniedCols = await getMergedDeniedColumns(profile.profile_id, profile.denied_columns);
  const grantedTableSet = new Set(effectiveTables.map(t => t.toLowerCase()));
  for (const [table, columns] of Object.entries(deniedCols)) {
    // Skip denied columns for tables not in this profile's effective grants
    if (effectiveTables.length > 0 && !grantedTableSet.has(table.toLowerCase())) continue;
    for (const col of columns as string[]) {
      const qt = quoteIdent(table);
      const qc = quoteIdent(col);
      try {
        await client.query(`REVOKE SELECT (${qc}) ON ${qt} FROM ${role}`);
        log.push({ action: 'REVOKE_COLUMN', detail: `REVOKE SELECT (${col}) ON ${table} FROM ${profile.pg_role}` });
      } catch (revokeErr) {
        const msg = revokeErr instanceof Error ? revokeErr.message : String(revokeErr);
        if (msg.includes('does not exist')) {
          log.push({ action: 'SKIP_REVOKE', detail: `Skip: ${table}.${col} not found on remote` });
        } else {
          throw revokeErr;
        }
      }
    }
  }

  return log;
}

function getGrantsForMode(mode: string): string {
  switch (mode) {
    case 'readonly': return 'SELECT';
    case 'readwrite': return 'SELECT, INSERT, UPDATE, DELETE';
    case 'admin': return 'ALL';
    default: return 'SELECT';
  }
}

// Helper to get the PG literal for dynamic SQL inside DO blocks
function pgLiteral(quotedIdent: string): string {
  return `'${quotedIdent.replace(/'/g, "''")}'`;
}

// Merge SSOT-derived denied columns with static override
async function getMergedDeniedColumns(profileId: string, staticOverride: Record<string, string[]> | null): Promise<Record<string, string[]>> {
  // Try to get SSOT denied columns from the PG function
  try {
    const result = await authzPool.query(
      'SELECT _authz_pool_ssot_denied_columns($1) AS denied',
      [profileId]
    );
    const ssot = result.rows[0]?.denied || {};
    // Merge: SSOT + static override (union of columns)
    const merged: Record<string, string[]> = { ...ssot };
    if (staticOverride) {
      for (const [table, cols] of Object.entries(staticOverride)) {
        merged[table] = [...new Set([...(merged[table] || []), ...cols])];
      }
    }
    return merged;
  } catch {
    // If SSOT function doesn't exist or fails, fall back to static
    return staticOverride || {};
  }
}

// ── Sync Remote Credential (after rotation) ──

export async function syncRemoteCredential(pgRole: string, passwordHash: string, requestUserId = 'system'): Promise<SyncAction[]> {
  const actions: SyncAction[] = [];

  // Find all data sources linked to profiles using this pg_role
  const dsResult = await authzPool.query(`
    SELECT DISTINCT ds.source_id, ds.db_type
    FROM authz_db_pool_profile dp
    JOIN authz_data_source ds ON dp.data_source_id = ds.source_id
    WHERE dp.pg_role = $1 AND dp.is_active AND ds.is_active AND dp.data_source_id IS NOT NULL
  `, [pgRole]);

  for (const row of dsResult.rows) {
    let client;
    try {
      // Oracle sources: credential sync on local nexus_data, not Oracle
      client = row.db_type === 'oracle' ? await getLocalDataClient() : await getDataSourceClient(row.source_id);
      const role = quoteIdent(pgRole);
      await client.query(`ALTER ROLE ${role} WITH PASSWORD '${passwordHash.replace(/'/g, "''")}'`);
      actions.push({ action: 'CREDENTIAL_SYNC', detail: `Password updated for ${pgRole} on ${row.source_id}`, data_source_id: row.source_id, profile_id: pgRole, status: 'ok' });
      await logSync('external_credential_sync', row.source_id, pgRole, maskPassword(`ALTER ROLE ${pgRole} WITH PASSWORD '***'`), 'synced', null);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      actions.push({ action: 'CREDENTIAL_SYNC_FAILED', detail: errMsg, data_source_id: row.source_id, profile_id: pgRole, status: 'error', error: errMsg });
      await logSync('external_credential_sync', row.source_id, pgRole, null, 'error', errMsg);
    } finally {
      if (client) await client.end();
    }
  }

  return actions;
}

// ── Drift Detection ──
export async function detectRemoteDrift(sourceId: string): Promise<DriftReport> {
  const items: DriftItem[] = [];
  // Oracle sources: drift detection runs on local nexus_data (CDC schema)
  const dsInfo = await authzPool.query('SELECT db_type FROM authz_data_source WHERE source_id = $1', [sourceId]);
  const isOracle = dsInfo.rows[0]?.db_type === 'oracle';
  const client = isOracle ? await getLocalDataClient() : await getDataSourceClient(sourceId);

  try {
    // Get profiles for this data source
    const profiles = (await authzPool.query(`
      SELECT dp.* FROM authz_db_pool_profile dp
      WHERE dp.data_source_id = $1 AND dp.is_active
    `, [sourceId])).rows;

    for (const profile of profiles) {
      // Check if role exists on remote
      const roleCheck = await client.query(
        'SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = $1',
        [profile.pg_role]
      );

      if (roleCheck.rows.length === 0) {
        items.push({ pg_role: profile.pg_role, type: 'role_missing', detail: `Role ${profile.pg_role} does not exist on remote DB` });
        continue;
      }

      // BYPASSRLS column only exists on PG 9.5+. Query defensively so drift
      // detection still works on older PG or PG-compatible engines (Redshift).
      if (profile.rls_applies) {
        try {
          const rlsCheck = await client.query(
            'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1',
            [profile.pg_role]
          );
          if (rlsCheck.rows[0]?.rolbypassrls) {
            items.push({ pg_role: profile.pg_role, type: 'role_extra_privilege', detail: `Role has BYPASSRLS but profile requires NOBYPASSRLS` });
          }
        } catch {
          // rolbypassrls unavailable on this engine — skip the check
        }
      }

      // Check table grants
      const schemas = profile.allowed_schemas || ['public'];
      const expectedGrants = getGrantsForMode(profile.connection_mode).split(', ').map((g: string) => g.trim().toUpperCase());

      for (const schema of schemas) {
        const actualGrants = await client.query(`
          SELECT table_name, privilege_type
          FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_schema = $2
        `, [profile.pg_role, schema]);

        const actualMap = new Map<string, Set<string>>();
        for (const row of actualGrants.rows) {
          if (!actualMap.has(row.table_name)) actualMap.set(row.table_name, new Set());
          actualMap.get(row.table_name)!.add(row.privilege_type);
        }

        // Resolve effective tables (same logic as sync)
        let effectiveTables: string[] = [...(profile.allowed_tables || [])];
        if (profile.allowed_modules && profile.allowed_modules.length > 0) {
          const moduleTables = await expandModulesToTables(profile.allowed_modules, sourceId);
          effectiveTables = [...new Set([...effectiveTables, ...moduleTables])];
        }

        // If effective tables specified, check each
        if (effectiveTables.length > 0) {
          for (const table of effectiveTables) {
            const actual = actualMap.get(table);
            if (!actual) {
              items.push({ pg_role: profile.pg_role, type: 'grant_missing', detail: `No grants on ${schema}.${table}` });
            } else {
              for (const g of expectedGrants) {
                if (!actual.has(g)) {
                  items.push({ pg_role: profile.pg_role, type: 'grant_missing', detail: `Missing ${g} on ${schema}.${table}` });
                }
              }
            }
          }
        }
      }
    }
  } finally {
    await client.end();
  }

  return { data_source_id: sourceId, checked_at: new Date().toISOString(), items };
}

// ── Sync Log Helper ──

async function logSync(syncType: string, dsId: string, targetName: string, sql: string | null, status: string, error: string | null) {
  try {
    await authzPool.query(`
      INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, error_message, synced_at, data_source_id)
      VALUES ($1, $2, $3, $4::sync_status, $5, now(), $6)
    `, [syncType, targetName, sql ? maskPassword(sql) : null, status === 'synced' ? 'synced' : 'error', error, dsId]);
  } catch {
    // Don't let logging failures break the sync
  }
}
