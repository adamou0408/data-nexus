// ============================================================
// business-term route smoke test (BIZ-TERM-V01 AC-8).
//
// Hits the running authz-api on http://localhost:13001 with
// X-User-Id headers (POC auth). Creates _test_ authz_resource
// rows then cleans up.
//
// Cases:
//   1. GET / non-admin → 403
//   2. GET / admin lists test rows
//   3. GET /:id 404 on nonexistent
//   4. PATCH updates term/definition/formula
//   5. PATCH bad term length → 400
//   6. POST /transition draft→under_review (bless fields stay NULL)
//   7. POST /transition under_review→blessed (bless fields populated)
//   8. POST /transition another row to blessed with same term → 409
//   9. POST /transition blessed→deprecated (bless fields preserved per V044 §3)
//  10. POST /transition deprecated→draft (bless fields cleared)
//  11. POST /transition to blessed without business_term → 422
//  12. audit_log captures tier_a_business_term_*
// ============================================================
import { authzPool } from '../src/db';

const API = process.env.AUTHZ_API_URL || 'http://localhost:13001';
const ADMIN = 'sys_admin';
const NON_ADMIN = `_test_bt_user_${Date.now()}`;
const SUFFIX = Date.now().toString();
const RID_A = `_test_bt_a_${SUFFIX}`;
const RID_B = `_test_bt_b_${SUFFIX}`;
const TERM_X = `_test_term_x_${SUFFIX}`;

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

async function setup() {
  await authzPool.query(
    `INSERT INTO authz_resource (resource_id, resource_type, display_name, status)
     VALUES ($1, 'db_table', 'Test row A', 'draft'),
            ($2, 'db_table', 'Test row B', 'draft')
     ON CONFLICT (resource_id) DO NOTHING`,
    [RID_A, RID_B]
  );
}

async function cleanup() {
  await authzPool.query(
    `DELETE FROM authz_resource WHERE resource_id IN ($1, $2)`,
    [RID_A, RID_B]
  );
  await authzPool.query(
    `DELETE FROM authz_admin_audit_log
      WHERE resource_type = 'authz_resource'
        AND resource_id IN ($1, $2)
        AND action LIKE 'tier_a_business_term_%'`,
    [RID_A, RID_B]
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
    await setup();

    // ── 1. GET / non-admin → 403
    const r1 = await call('GET', '/api/business-term', NON_ADMIN);
    if (r1.status !== 403) fail(`GET / non-admin expected 403, got ${r1.status}`);
    else pass('GET / non-admin returns 403');

    // ── 2. GET / admin
    const r2 = await call('GET', '/api/business-term?status=draft', ADMIN);
    if (r2.status !== 200) fail(`GET / admin expected 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    else if (!Array.isArray(r2.body?.rows)) fail('GET / missing rows array');
    else {
      const ids = (r2.body.rows as any[]).map(r => r.resource_id);
      if (!ids.includes(RID_A) || !ids.includes(RID_B)) fail(`GET / missing test rows in ${ids.length} returned`);
      else pass(`GET / admin sees test rows (${r2.body.rows.length} draft rows total)`);
    }

    // ── 3. GET /:id 404
    const r3 = await call('GET', `/api/business-term/_test_bt_nonexistent_${SUFFIX}`, ADMIN);
    if (r3.status !== 404) fail(`GET /:id nonexistent expected 404, got ${r3.status}`);
    else pass('GET /:id nonexistent returns 404');

    // ── 4. PATCH update fields
    const r4 = await call('PATCH', `/api/business-term/${RID_A}`, ADMIN, {
      business_term: TERM_X,
      definition: 'test definition',
      formula: 'count(*)',
    });
    if (r4.status !== 200) fail(`PATCH expected 200, got ${r4.status} ${JSON.stringify(r4.body)}`);
    else if (r4.body?.row?.business_term !== TERM_X) fail(`PATCH didn't set business_term`);
    else if (r4.body?.row?.definition !== 'test definition') fail(`PATCH didn't set definition`);
    else if (r4.body?.row?.formula !== 'count(*)') fail(`PATCH didn't set formula`);
    else pass('PATCH updates term/definition/formula');

    // ── 5. PATCH bad length
    const r5 = await call('PATCH', `/api/business-term/${RID_A}`, ADMIN, {
      business_term: 'x'.repeat(300),
    });
    if (r5.status !== 400) fail(`PATCH bad length expected 400, got ${r5.status}`);
    else pass('PATCH bad length returns 400');

    // ── 6. transition draft → under_review
    const r6 = await call('POST', `/api/business-term/${RID_A}/transition`, ADMIN, {
      status: 'under_review',
    });
    if (r6.status !== 200) fail(`transition draft→under_review expected 200, got ${r6.status} ${JSON.stringify(r6.body)}`);
    else if (r6.body?.row?.status !== 'under_review') fail(`status not under_review (got ${r6.body?.row?.status})`);
    else if (r6.body?.row?.blessed_at !== null) fail(`under_review should have blessed_at NULL (got ${r6.body?.row?.blessed_at})`);
    else if (r6.body?.row?.blessed_by !== null) fail(`under_review should have blessed_by NULL (got ${r6.body?.row?.blessed_by})`);
    else pass('transition draft→under_review keeps bless fields NULL');

    // ── 7. transition under_review → blessed
    const r7 = await call('POST', `/api/business-term/${RID_A}/transition`, ADMIN, {
      status: 'blessed',
    });
    const expectedBlessedBy = `user:${ADMIN}`;
    if (r7.status !== 200) fail(`transition under_review→blessed expected 200, got ${r7.status} ${JSON.stringify(r7.body)}`);
    else if (r7.body?.row?.status !== 'blessed') fail(`status not blessed (got ${r7.body?.row?.status})`);
    else if (!r7.body?.row?.blessed_at) fail(`blessed should have blessed_at set`);
    else if (r7.body?.row?.blessed_by !== expectedBlessedBy) fail(`blessed_by should be ${expectedBlessedBy} (got ${r7.body?.row?.blessed_by})`);
    else pass(`transition →blessed populates blessed_at + blessed_by=${expectedBlessedBy}`);

    // ── 8. duplicate-bless → 409 (partial unique index on business_term WHERE status='blessed')
    const r8a = await call('PATCH', `/api/business-term/${RID_B}`, ADMIN, { business_term: TERM_X });
    if (r8a.status !== 200) fail(`setup r8: PATCH B with TERM_X expected 200, got ${r8a.status}`);
    const r8 = await call('POST', `/api/business-term/${RID_B}/transition`, ADMIN, { status: 'blessed' });
    if (r8.status !== 409) fail(`duplicate bless expected 409, got ${r8.status} ${JSON.stringify(r8.body)}`);
    else pass('duplicate blessed business_term returns 409');

    // ── 9. transition blessed → deprecated (bless fields preserved per V044 §3)
    const r9 = await call('POST', `/api/business-term/${RID_A}/transition`, ADMIN, {
      status: 'deprecated',
    });
    if (r9.status !== 200) fail(`transition blessed→deprecated expected 200, got ${r9.status}`);
    else if (r9.body?.row?.status !== 'deprecated') fail(`status not deprecated`);
    else if (!r9.body?.row?.blessed_at) fail(`deprecated should preserve blessed_at (audit history) — got NULL`);
    else if (!r9.body?.row?.blessed_by) fail(`deprecated should preserve blessed_by — got NULL`);
    else pass('transition blessed→deprecated preserves bless fields (audit history)');

    // ── 10. transition deprecated → draft (bless fields cleared per V044 invariant)
    const r10 = await call('POST', `/api/business-term/${RID_A}/transition`, ADMIN, {
      status: 'draft',
    });
    if (r10.status !== 200) fail(`transition deprecated→draft expected 200, got ${r10.status} ${JSON.stringify(r10.body)}`);
    else if (r10.body?.row?.status !== 'draft') fail(`status not draft`);
    else if (r10.body?.row?.blessed_at !== null) fail(`draft should have blessed_at NULL (got ${r10.body?.row?.blessed_at})`);
    else if (r10.body?.row?.blessed_by !== null) fail(`draft should have blessed_by NULL`);
    else pass('transition deprecated→draft clears bless fields');

    // ── 11. bless without business_term → 422
    // RID_B had TERM_X set in step 8a; clear it first.
    await call('PATCH', `/api/business-term/${RID_B}`, ADMIN, { business_term: null });
    const r11 = await call('POST', `/api/business-term/${RID_B}/transition`, ADMIN, { status: 'blessed' });
    if (r11.status !== 422) fail(`bless without term expected 422, got ${r11.status} ${JSON.stringify(r11.body)}`);
    else pass('bless without business_term returns 422');

    // ── 12. audit_log captured
    await new Promise(r => setTimeout(r, 250));
    const audit = await authzPool.query(
      `SELECT action FROM authz_admin_audit_log
        WHERE resource_id = $1 AND action LIKE 'tier_a_business_term_%'
        ORDER BY id`,
      [RID_A]
    );
    const actions = audit.rows.map((r: any) => r.action);
    const required = [
      'tier_a_business_term_update',
      'tier_a_business_term_transition_under_review',
      'tier_a_business_term_transition_blessed',
      'tier_a_business_term_transition_deprecated',
      'tier_a_business_term_transition_draft',
    ];
    const missing = required.filter(a => !actions.includes(a));
    if (missing.length > 0) fail(`audit_log missing: ${missing.join(', ')} (got: ${actions.join(', ')})`);
    else pass(`audit_log captured: ${required.length}/${required.length} actions on RID_A`);

  } finally {
    await cleanup();
    await authzPool.end();
  }

  if (!ok) { console.error('\n❌ business-term smoke FAILED'); process.exit(1); }
  console.log('\n✅ business-term smoke ALL PASS');
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
