import ldap, { SearchEntry } from 'ldapjs';
import { Pool } from 'pg';

// ============================================================
// Configuration (env vars with dev defaults)
// ============================================================

const config = {
  ldap: {
    url: process.env.LDAP_URL || 'ldap://localhost:389',
    bindDN: process.env.LDAP_BIND_DN || 'cn=admin,dc=phison,dc=com',
    bindPassword: process.env.LDAP_BIND_PASSWORD || 'nexus_ldap_dev',
    baseDN: process.env.LDAP_BASE_DN || 'dc=phison,dc=com',
    groupsOU: process.env.LDAP_GROUPS_OU || 'ou=groups,dc=phison,dc=com',
    peopleOU: process.env.LDAP_PEOPLE_OU || 'ou=people,dc=phison,dc=com',
  },
  pg: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '15432'),
    database: process.env.PG_DATABASE || 'nexus_authz',
    user: process.env.PG_USER || 'nexus_admin',
    password: process.env.PG_PASSWORD || 'nexus_dev_password',
  },
};

// ============================================================
// LDAP helpers
// ============================================================

function createLdapClient(): ldap.Client {
  return ldap.createClient({ url: config.ldap.url });
}

function bindClient(client: ldap.Client): Promise<void> {
  return new Promise((resolve, reject) => {
    client.bind(config.ldap.bindDN, config.ldap.bindPassword, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function ldapSearch(client: ldap.Client, base: string, filter: string, attributes: string[]): Promise<SearchEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: SearchEntry[] = [];
    client.search(base, { filter, scope: 'one', attributes }, (err, res) => {
      if (err) return reject(err);
      res.on('searchEntry', (entry) => entries.push(entry));
      res.on('error', (err) => reject(err));
      res.on('end', () => resolve(entries));
    });
  });
}

function getAttr(entry: SearchEntry, name: string): string | undefined {
  const attr = entry.ppiAttributes?.find(a => a.type === name)
    ?? (entry as any).attributes?.find((a: any) => a.type === name);
  if (!attr) {
    // Try the object form
    const obj = entry.ppiObject ?? (entry as any).object;
    return obj?.[name] as string | undefined;
  }
  const vals = attr.values ?? attr.vals;
  return vals?.[0];
}

function getAttrAll(entry: SearchEntry, name: string): string[] {
  const attr = entry.ppiAttributes?.find(a => a.type === name)
    ?? (entry as any).attributes?.find((a: any) => a.type === name);
  if (!attr) {
    const obj = entry.ppiObject ?? (entry as any).object;
    const val = obj?.[name];
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') return [val];
    return [];
  }
  return attr.values ?? attr.vals ?? [];
}

// ============================================================
// Sync logic
// ============================================================

interface LdapUser {
  uid: string;
  cn: string;
  dn: string;
  mail?: string;
  employeeNumber?: string;
  departmentNumber?: string;
  title?: string;
}

interface LdapGroup {
  cn: string;
  dn: string;
  description?: string;
  memberDNs: string[];
}

async function fetchUsers(client: ldap.Client): Promise<LdapUser[]> {
  const entries = await ldapSearch(
    client,
    config.ldap.peopleOU,
    '(objectClass=inetOrgPerson)',
    ['uid', 'cn', 'mail', 'employeeNumber', 'departmentNumber', 'title']
  );

  return entries.map((e) => ({
    uid: getAttr(e, 'uid') || '',
    cn: getAttr(e, 'cn') || '',
    dn: e.objectName?.toString() || (e as any).dn || '',
    mail: getAttr(e, 'mail'),
    employeeNumber: getAttr(e, 'employeeNumber'),
    departmentNumber: getAttr(e, 'departmentNumber'),
    title: getAttr(e, 'title'),
  }));
}

async function fetchGroups(client: ldap.Client): Promise<LdapGroup[]> {
  const entries = await ldapSearch(
    client,
    config.ldap.groupsOU,
    '(objectClass=groupOfNames)',
    ['cn', 'description', 'member']
  );

  return entries.map((e) => ({
    cn: getAttr(e, 'cn') || '',
    dn: e.objectName?.toString() || (e as any).dn || '',
    description: getAttr(e, 'description'),
    memberDNs: getAttrAll(e, 'member'),
  }));
}

/**
 * Extract uid from a member DN like "uid=wang_pe,ou=people,dc=phison,dc=com"
 */
function uidFromDN(dn: string): string | null {
  const match = dn.match(/^uid=([^,]+)/i);
  return match ? match[1] : null;
}

async function syncToDatabase(users: LdapUser[], groups: LdapGroup[]): Promise<void> {
  const pgPool = new Pool(config.pg);

  try {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      // --- Upsert users ---
      for (const user of users) {
        const subjectId = user.uid.startsWith('svc:') ? user.uid : `user:${user.uid}`;
        const subjectType = user.uid.startsWith('etl_') ? 'service_account' : 'user';
        const attributes: Record<string, string> = {};
        if (user.employeeNumber) attributes.employee_id = user.employeeNumber;
        if (user.departmentNumber) attributes.dept = user.departmentNumber;

        await client.query(
          `INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn, attributes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (subject_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             ldap_dn = EXCLUDED.ldap_dn,
             updated_at = now()`,
          [subjectId, subjectType, user.cn, user.dn, JSON.stringify(attributes)]
        );
      }

      // --- Upsert groups ---
      for (const group of groups) {
        const subjectId = `group:${group.cn}`;

        await client.query(
          `INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn)
           VALUES ($1, 'ldap_group', $2, $3)
           ON CONFLICT (subject_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             ldap_dn = EXCLUDED.ldap_dn,
             updated_at = now()`,
          [subjectId, group.description || group.cn, group.dn]
        );
      }

      // --- Sync group membership ---
      // Build a map of DN → subject_id for users
      const dnToUserId = new Map<string, string>();
      for (const user of users) {
        const subjectId = user.uid.startsWith('svc:') ? user.uid : `user:${user.uid}`;
        dnToUserId.set(user.dn.toLowerCase(), subjectId);
      }

      // Clear existing ldap_sync memberships and re-insert
      await client.query(
        `DELETE FROM authz_group_member WHERE source = 'ldap_sync'`
      );

      for (const group of groups) {
        const groupId = `group:${group.cn}`;

        for (const memberDN of group.memberDNs) {
          const userId = dnToUserId.get(memberDN.toLowerCase());
          if (!userId) {
            // Try extracting uid directly
            const uid = uidFromDN(memberDN);
            if (uid) {
              const fallbackId = uid.startsWith('etl_') ? `svc:${uid}` : `user:${uid}`;
              await client.query(
                `INSERT INTO authz_group_member (group_id, user_id, source)
                 VALUES ($1, $2, 'ldap_sync')
                 ON CONFLICT DO NOTHING`,
                [groupId, fallbackId]
              );
            }
            continue;
          }

          await client.query(
            `INSERT INTO authz_group_member (group_id, user_id, source)
             VALUES ($1, $2, 'ldap_sync')
             ON CONFLICT DO NOTHING`,
            [groupId, userId]
          );
        }
      }

      await client.query('COMMIT');

      console.log(`[ldap-sync] Synced ${users.length} users, ${groups.length} groups`);
      const memberCount = groups.reduce((sum, g) => sum + g.memberDNs.length, 0);
      console.log(`[ldap-sync] Total membership entries: ${memberCount}`);

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pgPool.end();
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`[ldap-sync] Starting sync from ${config.ldap.url}`);
  console.log(`[ldap-sync] Base DN: ${config.ldap.baseDN}`);

  const client = createLdapClient();

  try {
    await bindClient(client);
    console.log('[ldap-sync] LDAP bind successful');

    const [users, groups] = await Promise.all([
      fetchUsers(client),
      fetchGroups(client),
    ]);

    console.log(`[ldap-sync] Found ${users.length} users, ${groups.length} groups in LDAP`);

    await syncToDatabase(users, groups);
    console.log('[ldap-sync] Sync completed successfully');

  } catch (err) {
    console.error('[ldap-sync] Sync failed:', err);
    process.exit(1);
  } finally {
    client.unbind();
  }
}

main();
