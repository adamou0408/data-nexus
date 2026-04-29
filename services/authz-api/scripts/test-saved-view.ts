// ============================================================
// saved-view route smoke test (Tier A primitive #2 AC-6).
//
// Hits the running authz-api on http://localhost:13001 with
// X-User-Id headers (POC auth). Cleans up rows after run.
//
// Cases:
//   1. POST create returns 201 with view_id
//   2. POST same (user, page, name) → 409 unique violation
//   3. GET list returns N rows for current user
//   4. POST set-default demotes prior default (partial unique index)
//   5. GET other-user's view → 404 (no leak)
//   6. PATCH rename + GET reflects new name
//   7. DELETE returns 200 + audit_log row
//   8. POST with bad config_json shape → 400
// ============================================================
import { authzPool } from '../src/db';

const API = process.env.AUTHZ_API_URL || 'http://localhost:13001';
const USER_A = `_test_sv_a_${Date.now()}`;
const USER_B = `_test_sv_b_${Date.now()}`;
const PAGE = `_test_sv_page_${Date.now()}`;

let ok = true;
const fail = (m: string) => { console.error('FAIL:', m); ok = false; };
const pass = (m: string) => console.log('PASS:', m);

async function call(
  method: string,
  path: string,
  user: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-Id': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed };
}

async function cleanup() {
  await authzPool.query(
    `DELETE FROM authz_user_view WHERE user_id IN ($1, $2)`,
    [USER_A, USER_B]
  );
  await authzPool.query(
    `DELETE FROM authz_admin_audit_log
      WHERE user_id IN ($1, $2) AND action LIKE 'tier_a_saved_view_%'`,
    [USER_A, USER_B]
  );
}

async function main() {
  try {
    // healthz
    const hz = await fetch(`${API}/healthz`).then(r => r.json()).catch(() => null);
    if (!hz || hz.status !== 'ok') {
      fail('authz-api not reachable; start it with `npm --prefix services/authz-api run dev`');
      return;
    }

    await cleanup();

    // ── 1. create
    const cfg1 = {
      filters: [{ field: 'status', op: 'eq', value: 'active' }],
      sort: { col: 'lot_id', dir: 'desc' as const },
      hidden_cols: ['raw_blob'],
    };
    const c1 = await call('POST', '/api/saved-view', USER_A, {
      page_id: PAGE, name: 'My active lots', config_json: cfg1, is_default: true,
    });
    if (c1.status !== 201) { fail(`create expected 201, got ${c1.status} ${JSON.stringify(c1.body)}`); }
    else if (!c1.body?.view?.view_id) { fail('create missing view_id'); }
    else pass(`create returned view_id=${c1.body.view.view_id}`);
    const viewId1 = c1.body?.view?.view_id;

    // ── 2. duplicate name → 409
    const c2 = await call('POST', '/api/saved-view', USER_A, {
      page_id: PAGE, name: 'My active lots', config_json: cfg1,
    });
    if (c2.status !== 409) fail(`duplicate expected 409, got ${c2.status}`);
    else pass('duplicate name returns 409');

    // ── 3. list
    const l1 = await call('GET', `/api/saved-view?page_id=${PAGE}`, USER_A);
    if (l1.status !== 200) fail(`list expected 200, got ${l1.status}`);
    else if (!Array.isArray(l1.body?.views) || l1.body.views.length !== 1) {
      fail(`list expected 1 view, got ${l1.body?.views?.length}`);
    } else pass(`list returned ${l1.body.views.length} view(s)`);

    // ── 4. set-default demotes prior
    const c4 = await call('POST', '/api/saved-view', USER_A, {
      page_id: PAGE, name: 'Second view', config_json: cfg1,
    });
    if (c4.status !== 201) { fail(`second create expected 201, got ${c4.status}`); }
    const viewId2 = c4.body?.view?.view_id;
    const sd = await call('POST', `/api/saved-view/${viewId2}/set-default`, USER_A);
    if (sd.status !== 200 || sd.body?.view?.is_default !== true) {
      fail(`set-default expected 200 + is_default=true, got ${sd.status} ${JSON.stringify(sd.body)}`);
    } else pass('set-default promotes target view');
    const dq = await authzPool.query(
      `SELECT view_id, is_default FROM authz_user_view WHERE user_id=$1 AND page_id=$2 AND is_default=true`,
      [USER_A, PAGE]
    );
    if (dq.rowCount !== 1 || dq.rows[0].view_id !== viewId2) {
      fail(`partial unique index broken: ${dq.rowCount} default rows, expected 1 = ${viewId2}`);
    } else pass('partial unique index keeps single default after demote-then-promote');

    // ── 5. cross-user 404
    const xu = await call('GET', `/api/saved-view/${viewId1}`, USER_B);
    if (xu.status !== 404) fail(`cross-user expected 404, got ${xu.status}`);
    else pass('cross-user fetch returns 404 (no enumeration leak)');

    // ── 6. PATCH rename
    const pr = await call('PATCH', `/api/saved-view/${viewId1}`, USER_A, { name: 'Renamed view' });
    if (pr.status !== 200 || pr.body?.view?.name !== 'Renamed view') {
      fail(`patch rename expected 200 + name change, got ${pr.status} ${JSON.stringify(pr.body)}`);
    } else pass('PATCH rename succeeds');

    // ── 7. DELETE + audit row
    const del = await call('DELETE', `/api/saved-view/${viewId1}`, USER_A);
    if (del.status !== 200) fail(`delete expected 200, got ${del.status}`);
    else pass('DELETE returns 200');
    // audit_log writes are fire-and-forget; give a small grace period
    await new Promise(r => setTimeout(r, 200));
    const audit = await authzPool.query(
      `SELECT action FROM authz_admin_audit_log
        WHERE user_id=$1 AND resource_id=$2 AND action='tier_a_saved_view_delete'`,
      [USER_A, viewId1]
    );
    if (audit.rowCount !== 1) fail(`expected 1 delete-audit row, got ${audit.rowCount}`);
    else pass('audit_log captured tier_a_saved_view_delete');

    // ── 8. bad config_json shape
    const bc = await call('POST', '/api/saved-view', USER_A, {
      page_id: PAGE, name: 'Bad shape', config_json: { filters: 'not-array' },
    });
    if (bc.status !== 400) fail(`bad shape expected 400, got ${bc.status}`);
    else pass('invalid config_json shape returns 400');

  } finally {
    await cleanup();
    await authzPool.end();
  }

  if (!ok) { console.error('\n❌ saved-view smoke FAILED'); process.exit(1); }
  console.log('\n✅ saved-view smoke ALL PASS');
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
