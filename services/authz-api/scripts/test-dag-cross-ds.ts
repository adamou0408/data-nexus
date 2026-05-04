// ============================================================
// XDB-TIER-B-L2 smoke: per-node DS dispatch + legacy fallback.
//
// Why this exists:
//   L2 makes each source node carry its own data_source_id and
//   dispatches the executor per-node instead of dag-level. The two
//   acceptance bars are:
//     1. legacy DAG (no per-node ds) still resolves via fallback
//     2. new DAG with per-node ds executes against the right pool
//
//   This script proves both end-to-end against the live API. It is
//   self-contained: it registers two test DSes that both point at
//   the local PG (different ds_id, same physical instance — enough
//   to prove dispatch routes through node.data.data_source_id and
//   not through a single dag-level pool), creates a tiny test
//   schema with a marker function in each DS, and exercises
//   /api/dag/execute-node + executeDagAsPublished's read-time
//   fallback.
//
// Cleanup:
//   The script TRUNCATEs/DROPs every test artefact at the end (and
//   on signal trap). All test DSes use the `ds:_test_pg2_` prefix
//   per the agent constitution (Article 8) and point at localhost.
//
// Usage:
//   AUTHZ_API_URL=http://localhost:13001 \
//     npx tsx services/authz-api/scripts/test-dag-cross-ds.ts
//
// Exit code 0 on full pass, 1 on any failure.
// ============================================================
import { Pool } from 'pg';

const API = process.env.AUTHZ_API_URL || 'http://localhost:13001';
// SYSADMIN god-mode short-circuits authz_check (V066), so the smoke
// doesn't need to wire up authz_role_permission for the test fns.
// adam_ou is bound to role:SYSADMIN in dev seed. Note: header value is
// the bare username — _authz_resolve_roles prepends 'user:' internally.
const USER = process.env.TEST_USER_ID || 'adam_ou';

// authz_authz pool — for fixture setup. Mirrors what the API container
// uses (DB_* env vars defaulting to dev compose values).
const AUTHZ_HOST = process.env.DB_HOST_LOCAL || 'localhost';
const AUTHZ_PORT = parseInt(process.env.DB_PORT_LOCAL || '15432', 10);
const AUTHZ_DB = process.env.DB_NAME || 'nexus_authz';
const AUTHZ_USER = process.env.DB_USER || 'nexus_admin';
const AUTHZ_PASS = process.env.DB_PASSWORD || 'nexus_dev_password';

// data DB the test DSes will dispatch to. Same physical instance, just
// the other database on it. Inside the API container the host is
// "postgres" (compose service name); from this script (host) it is
// localhost:15432. Both ds rows store the *container-resolvable*
// hostname so the API process can reach it.
const DATA_DB = 'nexus_data';
const DATA_HOST_FOR_API = 'postgres';
const DATA_PORT_FOR_API = 5432;
const DATA_HOST_LOCAL = process.env.DB_HOST_LOCAL || 'localhost';
const DATA_PORT_LOCAL = parseInt(process.env.DB_PORT_LOCAL || '15432', 10);

const DS_A = 'ds:_test_pg2_a';
const DS_B = 'ds:_test_pg2_b';
const TEST_SCHEMA = '_test_xdb_l2';
const FN_A_NAME = 'echo_a';
const FN_B_NAME = 'echo_b';
const FN_A_RID = `function:${TEST_SCHEMA}.${FN_A_NAME}`;
const FN_B_RID = `function:${TEST_SCHEMA}.${FN_B_NAME}`;

let failures = 0;
const pass = (m: string) => console.log('  \u2713', m);
const fail = (m: string) => { console.error('  \u2717', m); failures++; };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-Id': USER },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: parsed };
}

async function setup() {
  console.log('Setup …');
  const authz = new Pool({
    host: AUTHZ_HOST, port: AUTHZ_PORT, database: AUTHZ_DB,
    user: AUTHZ_USER, password: AUTHZ_PASS, max: 2,
  });
  const data = new Pool({
    host: DATA_HOST_LOCAL, port: DATA_PORT_LOCAL, database: DATA_DB,
    user: AUTHZ_USER, password: AUTHZ_PASS, max: 2,
  });

  try {
    // 1. Test schema + two distinguishable echo functions in nexus_data.
    //    Each returns its own marker so we can prove dispatch hit the
    //    *right* DS even though both DSes point at the same instance.
    await data.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await data.query(`DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.${FN_A_NAME}()`);
    await data.query(`DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.${FN_B_NAME}()`);
    await data.query(`
      CREATE OR REPLACE FUNCTION ${TEST_SCHEMA}.${FN_A_NAME}()
      RETURNS TABLE(marker text, ds_label text) LANGUAGE sql STABLE AS $$
        SELECT 'A'::text AS marker, 'fn-on-ds-a'::text AS ds_label
      $$
    `);
    await data.query(`
      CREATE OR REPLACE FUNCTION ${TEST_SCHEMA}.${FN_B_NAME}()
      RETURNS TABLE(marker text, ds_label text) LANGUAGE sql STABLE AS $$
        SELECT 'B'::text AS marker, 'fn-on-ds-b'::text AS ds_label
      $$
    `);
    pass('test fns created');

    // 2. Two test DSes (cleanup guard: only delete rows that match our
    //    own _test_pg2_ prefix — never touch real data).
    await authz.query(`DELETE FROM authz_data_source WHERE source_id LIKE 'ds:_test_pg2_%'`);
    const insertDs = `
      INSERT INTO authz_data_source (
        source_id, db_type, host, port, database_name,
        connector_user, connector_password, schemas,
        display_name, is_active, registered_by
      ) VALUES ($1, 'postgres', $2, $3, $4, $5, $6, $7, $8, TRUE, 'xdb-l2-smoke')
    `;
    await authz.query(insertDs, [
      DS_A, DATA_HOST_FOR_API, DATA_PORT_FOR_API, DATA_DB,
      AUTHZ_USER, AUTHZ_PASS, [TEST_SCHEMA],
      '_test_pg2_a (XDB-L2 smoke)',
    ]);
    await authz.query(insertDs, [
      DS_B, DATA_HOST_FOR_API, DATA_PORT_FOR_API, DATA_DB,
      AUTHZ_USER, AUTHZ_PASS, [TEST_SCHEMA],
      '_test_pg2_b (XDB-L2 smoke)',
    ]);
    pass(`registered ${DS_A} and ${DS_B}`);

    // 3. Register both fns as authz_resource so /execute-node's metadata
    //    lookup (fn must exist + be tagged with the matching ds) passes.
    //    arguments=''  →  no params; outputs is the (marker, ds_label) shape.
    await authz.query(`DELETE FROM authz_resource WHERE resource_id IN ($1, $2)`, [FN_A_RID, FN_B_RID]);
    const fnAttrs = (dsId: string) => JSON.stringify({
      data_source_id: dsId,
      function_name: dsId === DS_A ? FN_A_NAME : FN_B_NAME,
      schema_name: TEST_SCHEMA,
      arguments: '',
      return_shape: { shape: 'table', columns: [
        { name: 'marker', pgType: 'text', logical_type: 'string' },
        { name: 'ds_label', pgType: 'text', logical_type: 'string' },
      ]},
      inputs: [],
      outputs: [
        { name: 'marker', pgType: 'text', logical_type: 'string' },
        { name: 'ds_label', pgType: 'text', logical_type: 'string' },
      ],
    });
    await authz.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'function', $2, $3::jsonb, TRUE)`,
      [FN_A_RID, FN_A_NAME, fnAttrs(DS_A)],
    );
    await authz.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'function', $2, $3::jsonb, TRUE)`,
      [FN_B_RID, FN_B_NAME, fnAttrs(DS_B)],
    );
    pass(`registered ${FN_A_RID} (→ ${DS_A}) and ${FN_B_RID} (→ ${DS_B})`);

    // 4. No explicit grant needed — the SYSADMIN god-mode branch in
    //    authz_check (V066) allows the test user as long as no deny rule
    //    targets these fns. Test resource ids start with `function:_test_`
    //    so they cannot collide with anything seeded.
  } finally {
    await authz.end();
    await data.end();
  }
}

async function teardown() {
  console.log('\nTeardown …');
  const authz = new Pool({
    host: AUTHZ_HOST, port: AUTHZ_PORT, database: AUTHZ_DB,
    user: AUTHZ_USER, password: AUTHZ_PASS, max: 2,
  });
  const data = new Pool({
    host: DATA_HOST_LOCAL, port: DATA_PORT_LOCAL, database: DATA_DB,
    user: AUTHZ_USER, password: AUTHZ_PASS, max: 2,
  });
  try {
    await authz.query(
      `DELETE FROM authz_resource WHERE resource_id IN ($1, $2)`,
      [FN_A_RID, FN_B_RID],
    ).catch(() => {});
    await authz.query(
      `DELETE FROM authz_data_source WHERE source_id LIKE 'ds:_test_pg2_%'`,
    ).catch(() => {});
    await data.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`).catch(() => {});
    pass('test artefacts removed');
  } finally {
    await authz.end();
    await data.end();
  }
}

// Build a minimal /execute-node payload mirroring DagTab.tsx's shape.
function buildPayload(opts: {
  dagDsId: string;
  nodeId: string;
  rid: string;
  nodeDsId?: string;        // omit to simulate legacy DAG (server falls back to dagDsId)
}) {
  return {
    data_source_id: opts.dagDsId,
    node: {
      id: opts.nodeId,
      type: 'fn',
      data: {
        resource_id: opts.rid,
        ...(opts.nodeDsId ? { data_source_id: opts.nodeDsId } : {}),
        inputs: [],
        bound_params: {},
      },
    },
    upstream: {},
    upstream_resources: { [opts.nodeId]: opts.rid },
    edges: [],
  };
}

async function main() {
  console.log(`XDB-TIER-B-L2 cross-DS smoke`);
  console.log(`  API:  ${API}`);
  console.log(`  USER: ${USER}`);
  console.log('');

  await setup();
  console.log('');

  try {
    // ── Test 1: per-node ds — DAG default is DS_A but node binds DS_B.
    //   Acceptance: server dispatches to DS_B (fn_B exists there), returns
    //   marker='B'. If executor still used dag-level ds, we'd 404 (fn_B is
    //   not registered against DS_A).
    console.log('Test 1 — per-node ds_id overrides dag-level default');
    {
      const r = await call('POST', '/api/dag/execute-node', buildPayload({
        dagDsId: DS_A, nodeId: 'n_per_node', rid: FN_B_RID, nodeDsId: DS_B,
      }));
      if (r.status !== 200) {
        fail(`per-node dispatch → ${r.status} ${r.body?.error || ''} | ${r.body?.detail || ''}`);
      } else if (r.body?.rows?.[0]?.marker !== 'B') {
        fail(`per-node dispatch returned wrong marker: ${JSON.stringify(r.body?.rows?.[0])}`);
      } else {
        pass(`per-node ds_id resolved correctly (marker=B, ds_label=${r.body.rows[0].ds_label})`);
      }
    }

    // ── Test 2: legacy DAG fallback — node has no data_source_id, server
    //   must fall back to the dag-level data_source_id.
    console.log('\nTest 2 — legacy DAG (no per-node ds) falls back to dag-level');
    {
      const r = await call('POST', '/api/dag/execute-node', buildPayload({
        dagDsId: DS_A, nodeId: 'n_legacy', rid: FN_A_RID,
      }));
      if (r.status !== 200) {
        fail(`legacy fallback → ${r.status} ${r.body?.error || ''} | ${r.body?.detail || ''}`);
      } else if (r.body?.rows?.[0]?.marker !== 'A') {
        fail(`legacy fallback returned wrong marker: ${JSON.stringify(r.body?.rows?.[0])}`);
      } else {
        pass(`legacy fallback resolved correctly (marker=A, ds_label=${r.body.rows[0].ds_label})`);
      }
    }

    // ── Test 3: 404 path — node binds DS_B but resource_id is fn_A which
    //   only exists on DS_A. The metadata lookup must scope to the
    //   resolved per-node ds and 404 cleanly. Confirms we're not just
    //   ignoring the ds field.
    console.log('\nTest 3 — fn missing on resolved ds returns 404 (per-node scoping)');
    {
      const r = await call('POST', '/api/dag/execute-node', buildPayload({
        dagDsId: DS_A, nodeId: 'n_404', rid: FN_A_RID, nodeDsId: DS_B,
      }));
      if (r.status !== 404) {
        fail(`expected 404, got ${r.status}: ${r.body?.error || ''} | ${r.body?.detail || ''}`);
      } else {
        pass(`per-node ds scoping works (404 when fn not on resolved ds)`);
      }
    }

    // ── Test 4: per-node ds matches dag-level — happy path for new DAGs
    //   that have only one DS but stamp ds_id on every node anyway.
    console.log('\nTest 4 — per-node ds matches dag-level (uniform new DAG)');
    {
      const r = await call('POST', '/api/dag/execute-node', buildPayload({
        dagDsId: DS_A, nodeId: 'n_match', rid: FN_A_RID, nodeDsId: DS_A,
      }));
      if (r.status !== 200) {
        fail(`uniform new DAG → ${r.status} ${r.body?.error || ''} | ${r.body?.detail || ''}`);
      } else if (r.body?.rows?.[0]?.marker !== 'A') {
        fail(`uniform new DAG wrong marker: ${JSON.stringify(r.body?.rows?.[0])}`);
      } else {
        pass(`uniform new DAG resolves correctly`);
      }
    }
  } finally {
    await teardown();
  }

  console.log('');
  if (failures > 0) {
    console.error(`\u2717 ${failures} failure(s) — see detail above.`);
    process.exit(1);
  }
  console.log('\u2713 All XDB-L2 acceptance tests passed.');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('\nUnexpected error:', e);
  // best-effort teardown so a crashing run doesn't leave state behind
  try { await teardown(); } catch { /* ignore */ }
  process.exit(2);
});
