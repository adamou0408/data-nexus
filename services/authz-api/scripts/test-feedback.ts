// ============================================================
// feedback route smoke test (Tier A primitive #3 AC-8).
//
// Hits the running authz-api on http://localhost:13001 with
// X-User-Id headers (POC auth). Cleans up rows after run.
//
// Cases:
//   1. POST create returns 201 + status='open' + curator_id NULL
//   2. POST bad kind → 400
//   3. POST bad target_path → 400
//   4. POST empty body → 400
//   5. GET /mine self-scope (other user's row not visible)
//   6. GET /inbox non-admin → 403
//   7. GET /inbox admin sees ≥ N rows
//   8. PATCH triaged (admin) → 200 + curator_id + resolved_at
//   9. PATCH non-admin → 403
//  10. audit_log captures tier_a_feedback_create + triaged
// ============================================================
import { authzPool } from '../src/db';

const API = process.env.AUTHZ_API_URL || 'http://localhost:13001';
const USER_A = `_test_fb_a_${Date.now()}`;
const USER_B = `_test_fb_b_${Date.now()}`;
const ADMIN = 'sys_admin';
const PAGE = `_test_fb_page_${Date.now()}`;

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
    `DELETE FROM authz_feedback WHERE user_id IN ($1, $2) OR page_id = $3`,
    [USER_A, USER_B, PAGE]
  );
  await authzPool.query(
    `DELETE FROM authz_admin_audit_log
      WHERE (user_id IN ($1, $2, $3)) AND action LIKE 'tier_a_feedback_%'`,
    [USER_A, USER_B, ADMIN]
  );
}

async function main() {
  try {
    const hz = await fetch(`${API}/healthz`).then(r => r.json()).catch(() => null);
    if (!hz || hz.status !== 'ok') {
      fail('authz-api not reachable; start it with `npm --prefix services/authz-api run dev`');
      return;
    }

    await cleanup();

    // ── 1. POST create
    const c1 = await call('POST', '/api/feedback', USER_A, {
      page_id: PAGE, target_path: 'page', kind: 'data_wrong', body: 'lot_id 顯示錯誤',
    });
    if (c1.status !== 201) { fail(`create expected 201, got ${c1.status} ${JSON.stringify(c1.body)}`); }
    else if (!c1.body?.feedback?.feedback_id) { fail('create missing feedback_id'); }
    else if (c1.body.feedback.status !== 'open') { fail(`expected status=open, got ${c1.body.feedback.status}`); }
    else if (c1.body.feedback.curator_id !== null) { fail(`expected curator_id NULL, got ${c1.body.feedback.curator_id}`); }
    else if (c1.body.feedback.resolved_at !== null) { fail(`expected resolved_at NULL, got ${c1.body.feedback.resolved_at}`); }
    else pass(`create returned feedback_id=${c1.body.feedback.feedback_id} (status=open, curator_id NULL)`);
    const fbId1 = c1.body?.feedback?.feedback_id;

    // ── 2. bad kind
    const b1 = await call('POST', '/api/feedback', USER_A, {
      page_id: PAGE, target_path: 'page', kind: 'unknown', body: 'x',
    });
    if (b1.status !== 400) fail(`bad kind expected 400, got ${b1.status}`);
    else pass('bad kind returns 400');

    // ── 3. bad target_path
    const b2 = await call('POST', '/api/feedback', USER_A, {
      page_id: PAGE, target_path: 'garbage', kind: 'other', body: 'x',
    });
    if (b2.status !== 400) fail(`bad target_path expected 400, got ${b2.status}`);
    else pass('bad target_path returns 400');

    // ── 4. empty body
    const b3 = await call('POST', '/api/feedback', USER_A, {
      page_id: PAGE, target_path: 'page', kind: 'other', body: '   ',
    });
    if (b3.status !== 400) fail(`empty body expected 400, got ${b3.status}`);
    else pass('empty body returns 400');

    // Insert a second feedback under USER_B for self-scope check
    const c2 = await call('POST', '/api/feedback', USER_B, {
      page_id: PAGE, target_path: 'column:lot_id', kind: 'confusing', body: 'lot_id 命名看不懂',
    });
    if (c2.status !== 201) fail(`USER_B create expected 201, got ${c2.status}`);

    // ── 5. /mine self-scope
    const mineA = await call('GET', `/api/feedback/mine?page_id=${PAGE}`, USER_A);
    if (mineA.status !== 200) fail(`/mine expected 200, got ${mineA.status}`);
    else if (!Array.isArray(mineA.body?.feedback)) fail('/mine missing feedback array');
    else {
      const visible = mineA.body.feedback as any[];
      const hasOwn = visible.some(f => f.user_id === USER_A);
      const hasOther = visible.some(f => f.user_id === USER_B);
      if (!hasOwn) fail('/mine USER_A should see own row');
      else if (hasOther) fail('/mine USER_A should NOT see USER_B row');
      else pass(`/mine self-scope: ${visible.length} row(s), all user_id=USER_A`);
    }

    // ── 6. /inbox non-admin → 403
    const inboxA = await call('GET', '/api/feedback/inbox', USER_A);
    if (inboxA.status !== 403) fail(`/inbox non-admin expected 403, got ${inboxA.status}`);
    else pass('/inbox non-admin returns 403');

    // ── 7. /inbox admin
    const inboxAdmin = await call('GET', `/api/feedback/inbox?page_id=${PAGE}`, ADMIN);
    if (inboxAdmin.status !== 200) fail(`/inbox admin expected 200, got ${inboxAdmin.status} ${JSON.stringify(inboxAdmin.body)}`);
    else if (!Array.isArray(inboxAdmin.body?.feedback)) fail('/inbox missing feedback array');
    else if (inboxAdmin.body.feedback.length < 2) fail(`/inbox expected ≥ 2 rows for PAGE, got ${inboxAdmin.body.feedback.length}`);
    else pass(`/inbox admin sees ${inboxAdmin.body.feedback.length} row(s) for PAGE`);

    // ── 8. PATCH triaged (admin)
    const pat = await call('PATCH', `/api/feedback/${fbId1}/status`, ADMIN, { status: 'triaged' });
    if (pat.status !== 200) fail(`PATCH expected 200, got ${pat.status} ${JSON.stringify(pat.body)}`);
    else if (pat.body?.feedback?.status !== 'triaged') fail(`expected status=triaged, got ${pat.body?.feedback?.status}`);
    else if (pat.body?.feedback?.curator_id !== ADMIN) fail(`expected curator_id=${ADMIN}, got ${pat.body?.feedback?.curator_id}`);
    else if (!pat.body?.feedback?.resolved_at) fail('expected resolved_at to be set');
    else pass(`PATCH triaged → curator_id=${ADMIN}, resolved_at set`);

    // ── 9. PATCH non-admin → 403
    const patBad = await call('PATCH', `/api/feedback/${fbId1}/status`, USER_A, { status: 'resolved' });
    if (patBad.status !== 403) fail(`PATCH non-admin expected 403, got ${patBad.status}`);
    else pass('PATCH non-admin returns 403');

    // ── 10. audit_log captured create + triaged
    await new Promise(r => setTimeout(r, 250));
    const audit = await authzPool.query(
      `SELECT action FROM authz_admin_audit_log
        WHERE resource_id = $1 AND action LIKE 'tier_a_feedback_%'
        ORDER BY action`,
      [fbId1]
    );
    const actions = audit.rows.map((r: any) => r.action);
    if (!actions.includes('tier_a_feedback_create')) fail(`audit missing tier_a_feedback_create (got ${actions.join(',')})`);
    else if (!actions.includes('tier_a_feedback_triaged')) fail(`audit missing tier_a_feedback_triaged (got ${actions.join(',')})`);
    else pass(`audit_log captured: ${actions.join(', ')}`);

  } finally {
    await cleanup();
    await authzPool.end();
  }

  if (!ok) { console.error('\n❌ feedback smoke FAILED'); process.exit(1); }
  console.log('\n✅ feedback smoke ALL PASS');
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
