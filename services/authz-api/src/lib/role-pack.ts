// ============================================================
// Role Pack — sync engine (Permission Slimming · 路 2)
//
// A "pack" groups (resource_id, action_id) tuples. Applying a pack to a
// role expands the pack into authz_role_permission rows tagged with
// pack_source = pack_id. The expansion is computed by the diff between:
//
//   desired = { (role_id, m.resource_id, m.action_id) | m ∈ pack members
//                                                       AND pack assigned to role }
//   current = role_permission rows where pack_source = pack_id AND role_id = role_id
//
// Sync writes (desired - current) and deletes (current - desired). Manual
// rows (pack_source IS NULL) are ALWAYS untouched — pack and manual coexist
// on the same (role_id, resource_id, action_id) triplet without conflict
// because the table is keyed differently per source.
//
// authz_role_permission has UNIQUE (role_id, action_id, resource_id) —
// effect is NOT part of the unique key. So a manual row and a pack-tagged
// row CAN'T both exist for the same (role, action, resource) triplet. That's
// intentional: if a pack would expand into a triplet that already has a
// manual row, the pack expansion silently no-ops on that one tuple
// (we INSERT ... ON CONFLICT DO NOTHING) so the manual row wins, including
// its effect. This means pack assignment is upper-bounded by what's already
// manual; that's fine semantically (manual = "I really meant this") and the
// API surfaces it via the preview endpoint so admin sees what will/won't
// change.
// ============================================================

import { Pool, PoolClient } from 'pg';
import { logAdminAction } from './admin-audit';

export interface PackMember {
  resource_id: string;
  action_id: string;
  effect: 'allow' | 'deny';
}

export interface PackExpansionResult {
  pack_id: string;
  role_id: string;
  inserted: number;
  deleted: number;
  skipped_due_to_manual: number;  // how many pack tuples lost to a pre-existing manual row
}

// ─── Internal: open a transactional client and SET LOCAL the actor so any
// nested admin_audit insert can pick it up.
async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── expandPackToRole ─────────────────────────────────────────
// Idempotent: re-running with the same (pack, role) is a no-op apart from
// audit. Caller is responsible for verifying the assignment row exists
// (the trigger fn_role_perm_pack_source_guard will refuse INSERTs without
// one, but we insert the assignment first inside the same transaction).
export async function expandPackToRole(
  pool: Pool,
  packId: string,
  roleId: string,
  actor: string,
): Promise<PackExpansionResult> {
  return withTx(pool, async (client) => {
    // Lock the pack so concurrent member edits don't interleave with us.
    // Advisory lock keyed by hash of pack_id is cheap and avoids row locks
    // across many tables.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [packId]);

    // Verify pack + role exist (FK already does this on assignment INSERT
    // but we want a clean error message for the API caller).
    const pack = await client.query(
      `SELECT pack_id FROM authz_role_pack WHERE pack_id = $1`, [packId],
    );
    if (pack.rowCount === 0) throw new PackNotFoundError(packId);
    const role = await client.query(
      `SELECT role_id FROM authz_role WHERE role_id = $1`, [roleId],
    );
    if (role.rowCount === 0) throw new RoleNotFoundError(roleId);

    // Upsert the assignment row (so the guard trigger lets pack_source rows
    // through). ON CONFLICT keeps applied_by / applied_at on the original.
    await client.query(
      `INSERT INTO authz_role_pack_assignment (pack_id, role_id, applied_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (pack_id, role_id) DO NOTHING`,
      [packId, roleId, actor],
    );

    // Compute desired set.
    const desired = await client.query<{ resource_id: string; action_id: string; effect: string }>(
      `SELECT resource_id, action_id, effect
         FROM authz_role_pack_member
        WHERE pack_id = $1`,
      [packId],
    );

    // Insert each member as a pack-tagged row. The DO UPDATE … WHERE
    // pack_source = EXCLUDED.pack_source clause means:
    //   - existing row is OUR pack's row → update effect (member edits propagate)
    //   - existing row is manual (pack_source IS NULL) → WHERE fails → skip
    //     (manual wins; "I really meant this" is preserved)
    //   - existing row is another pack's row → WHERE fails → skip (cross-pack
    //     collision; preview surfaces this for the admin)
    // RETURNING only returns rows actually inserted-or-updated, so rowCount=0
    // means we skipped.
    let inserted = 0;
    let skipped = 0;
    for (const m of desired.rows) {
      const r = await client.query(
        `INSERT INTO authz_role_permission
           (role_id, resource_id, action_id, effect, pack_source)
         VALUES ($1, $2, $3, $4::authz_effect, $5)
         ON CONFLICT (role_id, action_id, resource_id) DO UPDATE
            SET effect = EXCLUDED.effect
          WHERE authz_role_permission.pack_source = EXCLUDED.pack_source
         RETURNING 1`,
        [roleId, m.resource_id, m.action_id, m.effect, packId],
      );
      if (r.rowCount && r.rowCount > 0) inserted++;
      else skipped++;
    }

    // Delete pack-tagged rows that are NO LONGER in desired (member removed
    // from the pack since last expansion).
    const del = await client.query(
      `DELETE FROM authz_role_permission
        WHERE role_id = $1
          AND pack_source = $2
          AND (resource_id, action_id) NOT IN (
            SELECT resource_id, action_id
              FROM authz_role_pack_member
             WHERE pack_id = $2
          )
        RETURNING 1`,
      [roleId, packId],
    );
    const deleted = del.rowCount ?? 0;

    await logAdminAction(pool, {
      userId: actor,
      action: 'EXPAND_ROLE_PACK',
      resourceType: 'role_pack',
      resourceId: packId,
      details: {
        pack_id: packId,
        role_id: roleId,
        inserted,
        deleted,
        skipped_due_to_manual: skipped,
        members_total: desired.rowCount ?? 0,
      },
    });

    return {
      pack_id: packId,
      role_id: roleId,
      inserted,
      deleted,
      skipped_due_to_manual: skipped,
    };
  });
}

// ─── unexpandPackFromRole ────────────────────────────────────
// Removes the assignment AND deletes all pack-tagged rows for (pack, role).
// Manual rows (pack_source IS NULL) are untouched.
export async function unexpandPackFromRole(
  pool: Pool,
  packId: string,
  roleId: string,
  actor: string,
): Promise<{ deleted: number }> {
  return withTx(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [packId]);

    // Delete pack-tagged rows BEFORE removing the assignment. The order
    // doesn't matter for correctness (the guard trigger only fires on
    // INSERT/UPDATE OF pack_source, not DELETE) but doing rows first means
    // an aborted transaction leaves the assignment intact for retry.
    const del = await client.query(
      `DELETE FROM authz_role_permission
        WHERE role_id = $1 AND pack_source = $2
        RETURNING 1`,
      [roleId, packId],
    );

    await client.query(
      `DELETE FROM authz_role_pack_assignment
        WHERE pack_id = $1 AND role_id = $2`,
      [packId, roleId],
    );

    const deleted = del.rowCount ?? 0;
    await logAdminAction(pool, {
      userId: actor,
      action: 'UNEXPAND_ROLE_PACK',
      resourceType: 'role_pack',
      resourceId: packId,
      details: { pack_id: packId, role_id: roleId, deleted },
    });
    return { deleted };
  });
}

// ─── resyncPackMembers ───────────────────────────────────────
// Called after the pack's member set changes. Re-runs expandPackToRole
// for every currently-assigned role so the new member set is mirrored
// everywhere. Wraps each role in its own transaction so a failure on
// role-A doesn't block role-B (no all-or-nothing tax for slow writes).
export async function resyncPackMembers(
  pool: Pool,
  packId: string,
  actor: string,
): Promise<PackExpansionResult[]> {
  const assignments = await pool.query<{ role_id: string }>(
    `SELECT role_id FROM authz_role_pack_assignment WHERE pack_id = $1
     ORDER BY role_id`,
    [packId],
  );
  const results: PackExpansionResult[] = [];
  for (const a of assignments.rows) {
    results.push(await expandPackToRole(pool, packId, a.role_id, actor));
  }
  return results;
}

// ─── previewExpansion ────────────────────────────────────────
// Read-only: what would expandPackToRole do? Used by the UI before the
// admin clicks "Apply". Doesn't write anything, doesn't touch the
// assignment table.
export async function previewExpansion(
  pool: Pool,
  packId: string,
  roleId: string,
): Promise<{
  to_insert: PackMember[];
  to_delete: PackMember[];
  conflicts_with_manual: PackMember[];
}> {
  // What the pack wants on this role.
  const desired = await pool.query<PackMember>(
    `SELECT resource_id, action_id, effect::text
       FROM authz_role_pack_member
      WHERE pack_id = $1`,
    [packId],
  );

  // What's already on the role, partitioned by pack_source.
  const current = await pool.query<{
    resource_id: string; action_id: string; effect: string; pack_source: string | null;
  }>(
    `SELECT resource_id, action_id, effect::text, pack_source
       FROM authz_role_permission
      WHERE role_id = $1`,
    [roleId],
  );

  // Unique key on authz_role_permission is (role_id, action_id, resource_id) —
  // effect is NOT part of it. So we compare on (resource_id, action_id) only.
  const keyOf = (resource_id: string, action_id: string): string =>
    `${resource_id}|${action_id}`;
  const desiredKeys = new Set<string>(desired.rows.map(m => keyOf(m.resource_id, m.action_id)));
  const currentByKey = new Map<string, typeof current.rows[number]>(
    current.rows.map(r => [keyOf(r.resource_id, r.action_id), r]),
  );

  const to_insert: PackMember[] = [];
  const conflicts_with_manual: PackMember[] = [];
  for (const m of desired.rows) {
    const key = keyOf(m.resource_id, m.action_id);
    const ex = currentByKey.get(key);
    if (!ex) {
      to_insert.push(m);
    } else if (ex.pack_source === null) {
      // Manual row blocks this pack member entirely.
      conflicts_with_manual.push(m);
    } else if (ex.pack_source !== packId) {
      // Another pack already owns this triplet — surface as a conflict.
      conflicts_with_manual.push(m);
    }
    // else: ex.pack_source === packId → ours, expand will (re-)update effect
  }

  // What would be deleted: this pack's tagged rows that aren't in desired.
  const to_delete: PackMember[] = current.rows
    .filter(r => r.pack_source === packId
                 && !desiredKeys.has(keyOf(r.resource_id, r.action_id)))
    .map(r => ({ resource_id: r.resource_id, action_id: r.action_id, effect: r.effect as 'allow' | 'deny' }));

  return { to_insert, to_delete, conflicts_with_manual };
}

// ─── Custom error types so the route layer can map cleanly to HTTP codes ─
export class PackNotFoundError extends Error {
  constructor(public packId: string) { super(`pack not found: ${packId}`); }
}
export class RoleNotFoundError extends Error {
  constructor(public roleId: string) { super(`role not found: ${roleId}`); }
}
