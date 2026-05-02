// ============================================================
// PERM-SLIM-V01-PATH2 verification — exercises role-pack.ts lib
// against the live DB so we can catch ON CONFLICT / trigger /
// FK errors that wouldn't surface from typecheck alone.
//
// Run:  npx tsx scripts/verify-role-pack.ts
//
// Cleans up its own test rows on success AND on failure (finally).
// All test fixtures use the `_test_pack_*` prefix.
//
// Cases:
//   1. Empty pack apply → assignment row exists, 0 role_permission rows
//   2. Add member → resync → row appears with pack_source set
//   3. Apply pack to second role → both roles converge
//   4. Edit member effect (allow→deny) → resync updates row in place
//   5. Remove member → resync deletes the row, manual rows untouched
//   6. Manual row coexists with pack member on different (resource,action)
//   7. Manual row blocks pack expansion on same (resource,action)
//   8. Cross-pack collision: pack B's expansion no-ops on pack A's row
//   9. Unexpand pack → all pack-tagged rows for that role gone, manual stays
//  10. fn_role_perm_pack_source_guard refuses pack_source row without assignment
//  11. DELETE pack cascade clears member + assignment + tags pack_source NULL
// ============================================================

import { authzPool } from '../src/db';
import {
  expandPackToRole,
  unexpandPackFromRole,
  resyncPackMembers,
  previewExpansion,
} from '../src/lib/role-pack';

// pack_id format constraint: ^[a-z][a-z0-9_]{2,63}$ — must start with a letter.
const TS = Date.now();
const ACTOR = `tpack_actor_${TS}`;
const PACK_A = `tpack_a_${TS}`;
const PACK_B = `tpack_b_${TS}`;
const ROLE_X = `_TEST_PACK_X_${TS}`;
const ROLE_Y = `_TEST_PACK_Y_${TS}`;

// Reuse pre-existing seed resources/actions so we don't have to
// fixture authz_resource / authz_action (those tables are FK-strict).
const RES_AI = 'ai_provider:*';
const RES_PAGE = 'page:smoke_test_publish';
const ACT_USE = 'use';
const ACT_READ = 'read';

let failures = 0;
const fail = (msg: string) => { console.error(`  ✗ FAIL: ${msg}`); failures++; };
const pass = (msg: string) => console.log(`  ✓ ${msg}`);

async function setup() {
  // Roles need to pre-exist (FK target). Insert with is_active=true.
  await authzPool.query(
    `INSERT INTO authz_role (role_id, display_name, is_active)
     VALUES ($1, $1, true), ($2, $2, true)
     ON CONFLICT (role_id) DO NOTHING`,
    [ROLE_X, ROLE_Y],
  );

  await authzPool.query(
    `INSERT INTO authz_role_pack (pack_id, display_name, created_by)
     VALUES ($1, 'test pack A', $3), ($2, 'test pack B', $3)
     ON CONFLICT (pack_id) DO NOTHING`,
    [PACK_A, PACK_B, ACTOR],
  );
}

async function cleanup() {
  // Pack delete cascades to members + assignments. role_permission rows
  // tagged with the pack get pack_source set to NULL via FK SET NULL,
  // then we delete those by role_id below.
  await authzPool.query(
    `DELETE FROM authz_role_pack WHERE pack_id IN ($1, $2)`,
    [PACK_A, PACK_B],
  );
  await authzPool.query(
    `DELETE FROM authz_role_permission WHERE role_id IN ($1, $2)`,
    [ROLE_X, ROLE_Y],
  );
  await authzPool.query(
    `DELETE FROM authz_role WHERE role_id IN ($1, $2)`,
    [ROLE_X, ROLE_Y],
  );
  await authzPool.query(
    `DELETE FROM authz_admin_audit_log
      WHERE user_id = $1
        AND action IN ('EXPAND_ROLE_PACK', 'UNEXPAND_ROLE_PACK')`,
    [ACTOR],
  ).catch(() => { /* table may not exist in some envs */ });
}

async function countPackRows(roleId: string, packId: string | null): Promise<number> {
  const r = await authzPool.query<{ n: string }>(
    packId === null
      ? `SELECT COUNT(*)::int AS n FROM authz_role_permission
            WHERE role_id = $1 AND pack_source IS NULL`
      : `SELECT COUNT(*)::int AS n FROM authz_role_permission
            WHERE role_id = $1 AND pack_source = $2`,
    packId === null ? [roleId] : [roleId, packId],
  );
  return Number(r.rows[0].n);
}

async function getRow(roleId: string, resourceId: string, actionId: string) {
  const r = await authzPool.query(
    `SELECT effect::text AS effect, pack_source FROM authz_role_permission
      WHERE role_id = $1 AND resource_id = $2 AND action_id = $3`,
    [roleId, resourceId, actionId],
  );
  return r.rows[0] ?? null;
}

async function addMember(packId: string, resourceId: string, actionId: string, effect: 'allow' | 'deny') {
  await authzPool.query(
    `INSERT INTO authz_role_pack_member (pack_id, resource_id, action_id, effect, added_by)
     VALUES ($1, $2, $3, $4::authz_effect, $5)
     ON CONFLICT (pack_id, resource_id, action_id) DO UPDATE SET effect = EXCLUDED.effect`,
    [packId, resourceId, actionId, effect, ACTOR],
  );
}

async function removeMember(packId: string, resourceId: string, actionId: string) {
  await authzPool.query(
    `DELETE FROM authz_role_pack_member
      WHERE pack_id = $1 AND resource_id = $2 AND action_id = $3`,
    [packId, resourceId, actionId],
  );
}

async function main() {
  console.log('=== PERM-SLIM-V01-PATH2 verify-role-pack ===');
  await cleanup();
  await setup();
  try {
    // Case 1: empty pack apply
    console.log('\n[1] Empty pack apply → 0 role_permission rows');
    const r1 = await expandPackToRole(authzPool, PACK_A, ROLE_X, ACTOR);
    if (r1.inserted === 0 && r1.deleted === 0 && r1.skipped_due_to_manual === 0) {
      pass('expand returned all-zero counts');
    } else {
      fail(`expected zeros, got ${JSON.stringify(r1)}`);
    }
    const assn = await authzPool.query(
      `SELECT 1 FROM authz_role_pack_assignment WHERE pack_id=$1 AND role_id=$2`,
      [PACK_A, ROLE_X],
    );
    if (assn.rowCount === 1) pass('assignment row created');
    else fail('assignment row missing');
    if (await countPackRows(ROLE_X, PACK_A) === 0) pass('no pack_source rows in role_permission');
    else fail('unexpected pack_source rows for empty pack');

    // Case 2: add member, resync expands
    console.log('\n[2] Add member → resync expands into role_permission');
    await addMember(PACK_A, RES_AI, ACT_USE, 'allow');
    await resyncPackMembers(authzPool, PACK_A, ACTOR);
    const row2 = await getRow(ROLE_X, RES_AI, ACT_USE);
    if (row2 && row2.pack_source === PACK_A && row2.effect === 'allow') {
      pass('row materialised with pack_source and effect=allow');
    } else {
      fail(`expected pack_source=${PACK_A} effect=allow, got ${JSON.stringify(row2)}`);
    }

    // Case 3: assign same pack to second role
    console.log('\n[3] Apply pack to second role → both converge');
    await expandPackToRole(authzPool, PACK_A, ROLE_Y, ACTOR);
    const row3 = await getRow(ROLE_Y, RES_AI, ACT_USE);
    if (row3 && row3.pack_source === PACK_A) pass('role Y now has the pack row');
    else fail('role Y did not get the pack row');

    // Case 4: edit member effect → resync updates in place
    console.log('\n[4] Edit member effect allow→deny → resync updates row');
    await addMember(PACK_A, RES_AI, ACT_USE, 'deny'); // upsert effect
    await resyncPackMembers(authzPool, PACK_A, ACTOR);
    const row4x = await getRow(ROLE_X, RES_AI, ACT_USE);
    const row4y = await getRow(ROLE_Y, RES_AI, ACT_USE);
    if (row4x?.effect === 'deny' && row4y?.effect === 'deny') {
      pass('both roles updated to effect=deny');
    } else {
      fail(`X effect=${row4x?.effect}, Y effect=${row4y?.effect}`);
    }

    // Case 5: remove member → resync drops the row everywhere
    console.log('\n[5] Remove member → resync deletes pack-tagged rows');
    await removeMember(PACK_A, RES_AI, ACT_USE);
    await resyncPackMembers(authzPool, PACK_A, ACTOR);
    const gone5x = await getRow(ROLE_X, RES_AI, ACT_USE);
    const gone5y = await getRow(ROLE_Y, RES_AI, ACT_USE);
    if (gone5x === null && gone5y === null) pass('rows removed from both roles');
    else fail(`expected null, got X=${JSON.stringify(gone5x)} Y=${JSON.stringify(gone5y)}`);

    // Case 6: manual row coexists with pack member on different (res, act)
    console.log('\n[6] Manual row coexists when on different (resource, action)');
    // Manual row on (RES_PAGE, ACT_READ) for ROLE_X
    await authzPool.query(
      `INSERT INTO authz_role_permission (role_id, resource_id, action_id, effect)
       VALUES ($1, $2, $3, 'allow'::authz_effect)
       ON CONFLICT (role_id, action_id, resource_id) DO NOTHING`,
      [ROLE_X, RES_PAGE, ACT_READ],
    );
    // Pack member on (RES_AI, ACT_USE) — different triplet
    await addMember(PACK_A, RES_AI, ACT_USE, 'allow');
    await resyncPackMembers(authzPool, PACK_A, ACTOR);
    const manualRow6 = await getRow(ROLE_X, RES_PAGE, ACT_READ);
    const packRow6 = await getRow(ROLE_X, RES_AI, ACT_USE);
    if (manualRow6 && manualRow6.pack_source === null && packRow6 && packRow6.pack_source === PACK_A) {
      pass('manual + pack rows coexist on different triplets');
    } else {
      fail(`manual=${JSON.stringify(manualRow6)} pack=${JSON.stringify(packRow6)}`);
    }

    // Case 7: manual row blocks pack expansion on the SAME (res, act)
    console.log('\n[7] Manual row blocks pack expansion on same triplet');
    // Add a manual row on (RES_AI, ACT_READ) for ROLE_Y FIRST
    await authzPool.query(
      `INSERT INTO authz_role_permission (role_id, resource_id, action_id, effect)
       VALUES ($1, $2, $3, 'allow'::authz_effect)
       ON CONFLICT (role_id, action_id, resource_id) DO NOTHING`,
      [ROLE_Y, RES_AI, ACT_READ],
    );
    // Now pack adds the same triplet with effect=deny
    await addMember(PACK_A, RES_AI, ACT_READ, 'deny');
    const r7 = await expandPackToRole(authzPool, PACK_A, ROLE_Y, ACTOR);
    const row7 = await getRow(ROLE_Y, RES_AI, ACT_READ);
    if (r7.skipped_due_to_manual >= 1 && row7?.pack_source === null && row7.effect === 'allow') {
      pass(`manual row preserved (pack expansion skipped ${r7.skipped_due_to_manual})`);
    } else {
      fail(`expected manual row to win, got skipped=${r7.skipped_due_to_manual} row=${JSON.stringify(row7)}`);
    }
    // preview should report the conflict
    const preview7 = await previewExpansion(authzPool, PACK_A, ROLE_Y);
    if (preview7.conflicts_with_manual.some(c => c.resource_id === RES_AI && c.action_id === ACT_READ)) {
      pass('previewExpansion surfaces conflicts_with_manual');
    } else {
      fail(`preview missed manual conflict: ${JSON.stringify(preview7)}`);
    }

    // Case 8: cross-pack collision — pack B can't override pack A's row
    console.log('\n[8] Cross-pack collision → second pack no-ops on the triplet');
    // Pack A already owns (RES_AI, ACT_USE) on ROLE_X (from case 6).
    // Pack B tries the same triplet with effect=deny.
    await addMember(PACK_B, RES_AI, ACT_USE, 'deny');
    const r8 = await expandPackToRole(authzPool, PACK_B, ROLE_X, ACTOR);
    const row8 = await getRow(ROLE_X, RES_AI, ACT_USE);
    if (r8.skipped_due_to_manual >= 1 && row8?.pack_source === PACK_A && row8.effect === 'allow') {
      pass(`pack A row preserved (pack B skipped ${r8.skipped_due_to_manual})`);
    } else {
      fail(`expected pack A to win, got skipped=${r8.skipped_due_to_manual} row=${JSON.stringify(row8)}`);
    }

    // Case 9: unexpand pack from a role → its tags gone, manual stays
    console.log('\n[9] Unexpand pack → pack rows gone, manual rows preserved');
    // ROLE_X has: pack_A row on (RES_AI, ACT_USE), manual on (RES_PAGE, ACT_READ).
    const r9 = await unexpandPackFromRole(authzPool, PACK_A, ROLE_X, ACTOR);
    const packGone9 = await getRow(ROLE_X, RES_AI, ACT_USE);
    const manualStays9 = await getRow(ROLE_X, RES_PAGE, ACT_READ);
    const assn9 = await authzPool.query(
      `SELECT 1 FROM authz_role_pack_assignment WHERE pack_id=$1 AND role_id=$2`,
      [PACK_A, ROLE_X],
    );
    if (packGone9 === null && manualStays9?.pack_source === null && assn9.rowCount === 0 && r9.deleted >= 1) {
      pass('pack row deleted, manual row preserved, assignment removed');
    } else {
      fail(`packGone=${JSON.stringify(packGone9)} manual=${JSON.stringify(manualStays9)} assn=${assn9.rowCount} deleted=${r9.deleted}`);
    }

    // Case 10: fn_role_perm_pack_source_guard refuses orphan pack_source
    console.log('\n[10] Trigger refuses pack_source row without assignment');
    let raised = false;
    try {
      // ROLE_X no longer has PACK_A assigned — direct INSERT must fail.
      await authzPool.query(
        `INSERT INTO authz_role_permission (role_id, resource_id, action_id, effect, pack_source)
         VALUES ($1, $2, $3, 'allow'::authz_effect, $4)`,
        [ROLE_X, RES_AI, ACT_USE, PACK_A],
      );
    } catch (err) {
      raised = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no matching authz_role_pack_assignment')) {
        pass('trigger raised expected error');
      } else {
        fail(`trigger raised wrong error: ${msg}`);
      }
    }
    if (!raised) fail('trigger did NOT refuse orphan pack_source row');

    // Case 11: DELETE pack cascades — assignments + members + tags pack_source NULL
    console.log('\n[11] DELETE pack → cascade clears assignments + tags pack_source NULL');
    // Set up: ROLE_Y still has PACK_A's expansion on (RES_AI, ACT_USE) from case 6/3
    // (re-expand after we removed/re-added in earlier cases).
    await expandPackToRole(authzPool, PACK_A, ROLE_X, ACTOR); // re-assign
    const beforeDelete = await getRow(ROLE_X, RES_AI, ACT_USE);
    if (!beforeDelete || beforeDelete.pack_source !== PACK_A) {
      fail(`pre-condition failed: ${JSON.stringify(beforeDelete)}`);
    }
    await authzPool.query(`DELETE FROM authz_role_pack WHERE pack_id = $1`, [PACK_A]);
    const afterDelete = await getRow(ROLE_X, RES_AI, ACT_USE);
    const memberCount = await authzPool.query(
      `SELECT COUNT(*)::int AS n FROM authz_role_pack_member WHERE pack_id = $1`, [PACK_A],
    );
    const assnCount = await authzPool.query(
      `SELECT COUNT(*)::int AS n FROM authz_role_pack_assignment WHERE pack_id = $1`, [PACK_A],
    );
    if (
      afterDelete && afterDelete.pack_source === null &&
      memberCount.rows[0].n === 0 &&
      assnCount.rows[0].n === 0
    ) {
      pass('DELETE pack: row kept, pack_source nulled (FK SET NULL), members+assignments cascade-deleted');
    } else {
      fail(`row=${JSON.stringify(afterDelete)} members=${memberCount.rows[0].n} assn=${assnCount.rows[0].n}`);
    }
  } finally {
    console.log('\n=== cleanup ===');
    await cleanup();
    await authzPool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} case(s) FAILED`);
    process.exit(1);
  } else {
    console.log('\nAll cases passed ✓');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('verify-role-pack crashed:', err);
  process.exit(2);
});
