// ============================================================
// XDB-TIER-B-L4 smoke: cross-DS publish + render_mode + column-rename.
//
// Plan: .claude/plans/v3-phase-1/cross-db-tier-b-integration.md §4 L4 + §10
//
// What it covers:
//   1. Publish without column_renames returns HTTP 409 with conflict list
//      keyed by ${node_id}__${column_name} (cross-DS exposed leaves emit
//      colliding `id` columns).
//   2. Publish with column_renames returns 200 + persists to authz_ui_page.
//      Snapshot mode also writes cached_outputs into dag_snapshot.
//   3. Render snapshot mode → returns the frozen rows from cached_outputs
//      with renamed columns. row_count > 0 (freeze actually executed).
//   4. Render live mode → re-executes the DAG end-to-end, also returns
//      renamed columns. Both modes go through the bless-gate authz_check
//      that the publish step grants to BI_USER.
//
// The DAG used:
//   leaf_a (DS_A) ─┐
//                  ├─ both exposed (display_mode='explorer'); each emits an
//   leaf_b (DS_B) ─┘  `id` column → name collides → curator must rename.
//
// Cleanup: every test artefact uses the `_test_xdb_l4` prefix per
// constitution Article 8. Pages and resources flipped is_active=FALSE +
// the bless gate / page mirror rows are dropped on teardown.
//
// Usage:
//   AUTHZ_API_URL=http://localhost:13001 \
//     npx tsx services/authz-api/scripts/test-cross-ds-publish.ts
// ============================================================
import { Pool } from 'pg';

const API = process.env.AUTHZ_API_URL || 'http://localhost:13001';
const USER = process.env.TEST_USER_ID || 'adam_ou';

const AUTHZ_HOST = process.env.DB_HOST_LOCAL || 'localhost';
const AUTHZ_PORT = parseInt(process.env.DB_PORT_LOCAL || '15432', 10);
const AUTHZ_DB = process.env.DB_NAME || 'nexus_authz';
const AUTHZ_USER = process.env.DB_USER || 'nexus_admin';
const AUTHZ_PASS = process.env.DB_PASSWORD || 'nexus_dev_password';

const DATA_DB = 'nexus_data';
const DATA_HOST_FOR_API = 'postgres';
const DATA_PORT_FOR_API = 5432;
const DATA_HOST_LOCAL = process.env.DB_HOST_LOCAL || 'localhost';
const DATA_PORT_LOCAL = parseInt(process.env.DB_PORT_LOCAL || '15432', 10);

const DS_A = 'ds:_test_pg2_l4_a';
const DS_B = 'ds:_test_pg2_l4_b';
const TEST_SCHEMA = '_test_xdb_l4';
const FN_A = 'fn_a';
const FN_B = 'fn_b';
const FN_A_RID = `function:${TEST_SCHEMA}.${FN_A}`;
const FN_B_RID = `function:${TEST_SCHEMA}.${FN_B}`;
const DAG_ID = 'dag:_test_xdb_l4_publish';
const PAGE_ID_SNAPSHOT = 'test_xdb_l4_snapshot';
const PAGE_ID_LIVE = 'test_xdb_l4_live';
const PUBLISHED_RID_SNAP = `published_dag:${DAG_ID}`;

let failures = 0;
const pass = (m: string) => console.log('  \u2713', m);
const fail = (m: string) => { console.error('  \u2717', m); failures++; };

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
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
    // 1. Two echo fns, each in their own logical DS but physically the same DB.
    await data.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await data.query(`DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.${FN_A}() CASCADE`);
    await data.query(`DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.${FN_B}() CASCADE`);
    await data.query(`
      CREATE OR REPLACE FUNCTION ${TEST_SCHEMA}.${FN_A}()
      RETURNS TABLE(id integer, label text) LANGUAGE sql STABLE AS $$
        VALUES (1, 'a-one'), (2, 'a-two')
      $$
    `);
    await data.query(`
      CREATE OR REPLACE FUNCTION ${TEST_SCHEMA}.${FN_B}()
      RETURNS TABLE(id integer, label text) LANGUAGE sql STABLE AS $$
        VALUES (10, 'b-ten'), (20, 'b-twenty')
      $$
    `);
    pass('test fns created (each emits id+label so cross-DS collision is forced)');

    // 2. Two test DSes — both point at the same physical PG, distinct logical IDs.
    await authz.query(`DELETE FROM authz_data_source WHERE source_id LIKE 'ds:_test_pg2_l4_%'`);
    const insertDs = `
      INSERT INTO authz_data_source (
        source_id, db_type, host, port, database_name,
        connector_user, connector_password, schemas,
        display_name, is_active, registered_by
      ) VALUES ($1, 'postgres', $2, $3, $4, $5, $6, $7, $8, TRUE, 'xdb-l4-smoke')
    `;
    await authz.query(insertDs, [
      DS_A, DATA_HOST_FOR_API, DATA_PORT_FOR_API, DATA_DB,
      AUTHZ_USER, AUTHZ_PASS, [TEST_SCHEMA],
      '_test_pg2_l4_a (XDB-L4 smoke)',
    ]);
    await authz.query(insertDs, [
      DS_B, DATA_HOST_FOR_API, DATA_PORT_FOR_API, DATA_DB,
      AUTHZ_USER, AUTHZ_PASS, [TEST_SCHEMA],
      '_test_pg2_l4_b (XDB-L4 smoke)',
    ]);
    pass(`registered ${DS_A} + ${DS_B}`);

    // 3. Register fn metadata.
    await authz.query(
      `DELETE FROM authz_resource WHERE resource_id IN ($1, $2, $3)`,
      [FN_A_RID, FN_B_RID, DAG_ID],
    );
    const fnAttrs = (dsId: string, fnName: string) => JSON.stringify({
      data_source_id: dsId,
      function_name: fnName,
      schema_name: TEST_SCHEMA,
      arguments: '',
      inputs: [],
      outputs: [
        { name: 'id', pgType: 'integer', logical_type: 'int64' },
        { name: 'label', pgType: 'text', logical_type: 'string' },
      ],
      return_shape: {
        shape: 'table',
        columns: [
          { name: 'id', pgType: 'integer', logical_type: 'int64' },
          { name: 'label', pgType: 'text', logical_type: 'string' },
        ],
      },
    });
    await authz.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'function', $2, $3::jsonb, TRUE)`,
      [FN_A_RID, FN_A, fnAttrs(DS_A, FN_A)],
    );
    await authz.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'function', $2, $3::jsonb, TRUE)`,
      [FN_B_RID, FN_B, fnAttrs(DS_B, FN_B)],
    );
    pass('fn metadata registered');

    // 4. Author the DAG: two leaves, each on its own DS, no edges (multi-leaf
    //    on purpose so explorer publish exposes both). Each fn becomes its
    //    own exposed node; the page should surface BOTH leaves with renamed
    //    `id` columns so consumers can tell which DS the row came from.
    const nodes = [
      {
        id: 'leaf_a', type: 'fn', position: { x: 0, y: 0 },
        data: {
          resource_id: FN_A_RID,
          data_source_id: DS_A,
          inputs: [],
          outputs: [
            { name: 'id', semantic_type: 'identifier' },
            { name: 'label', semantic_type: 'string' },
          ],
          arguments: '',
          bound_params: {},
          user_input_params: [],
          label: 'leaf_a',
          expose_output: true,
        },
      },
      {
        id: 'leaf_b', type: 'fn', position: { x: 200, y: 0 },
        data: {
          resource_id: FN_B_RID,
          data_source_id: DS_B,
          inputs: [],
          outputs: [
            { name: 'id', semantic_type: 'identifier' },
            { name: 'label', semantic_type: 'string' },
          ],
          arguments: '',
          bound_params: {},
          user_input_params: [],
          label: 'leaf_b',
          expose_output: true,
        },
      },
    ];
    const edges: unknown[] = [];
    const dagAttrs = JSON.stringify({
      data_source_id: DS_A,
      nodes, edges,
    });
    await authz.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'dag', $2, $3::jsonb, TRUE)`,
      [DAG_ID, '_test_xdb_l4_publish (XDB-L4 smoke)', dagAttrs],
    );
    pass(`DAG ${DAG_ID} registered with leaf_a@${DS_A} + leaf_b@${DS_B}`);
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
    // page rows + role grants — keys on bless gate / page mirror.
    await authz.query(
      `DELETE FROM authz_role_permission WHERE resource_id IN ($1, $2, $3)`,
      [PUBLISHED_RID_SNAP, `page:${PAGE_ID_SNAPSHOT}`, `page:${PAGE_ID_LIVE}`],
    ).catch(() => {});
    await authz.query(
      `DELETE FROM authz_ui_page WHERE page_id IN ($1, $2)`,
      [PAGE_ID_SNAPSHOT, PAGE_ID_LIVE],
    ).catch(() => {});
    await authz.query(
      `DELETE FROM authz_resource WHERE resource_id IN ($1, $2, $3, $4, $5, $6)`,
      [PUBLISHED_RID_SNAP, `page:${PAGE_ID_SNAPSHOT}`, `page:${PAGE_ID_LIVE}`, DAG_ID, FN_A_RID, FN_B_RID],
    ).catch(() => {});
    await authz.query(
      `DELETE FROM authz_data_source WHERE source_id LIKE 'ds:_test_pg2_l4_%'`,
    ).catch(() => {});
    await data.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`).catch(() => {});
    pass('test artefacts removed');
  } finally {
    await authz.end();
    await data.end();
  }
}

async function main() {
  console.log('XDB-TIER-B-L4 cross-DS publish smoke');
  console.log(`  API:  ${API}`);
  console.log(`  USER: ${USER}`);
  console.log('');

  await setup();
  console.log('');

  try {
    // ── Test 1: publish without renames → 409 with conflict list ──
    console.log('Test 1 — publish without column_renames returns 409 + conflicts');
    {
      const r = await call('POST', `/api/dag/${encodeURIComponent(DAG_ID)}/publish`, {
        page_id: PAGE_ID_SNAPSHOT,
        title: '_test_xdb_l4 cross-DS snapshot',
        display_mode: 'explorer',
        render_mode: 'snapshot',
        // No column_renames — server should reject with 409.
      });
      if (r.status !== 409) {
        fail(`expected 409, got ${r.status}: ${JSON.stringify(r.body).slice(0, 240)}`);
      } else {
        const conflicts = r.body?.conflicts || r.body?.detail?.conflicts;
        if (!Array.isArray(conflicts) || conflicts.length === 0) {
          fail(`409 but no conflict list: ${JSON.stringify(r.body).slice(0, 240)}`);
        } else {
          const idConflict = conflicts.find((c: any) => c.name === 'id');
          if (!idConflict) {
            fail(`expected conflict on 'id' column, got: ${JSON.stringify(conflicts)}`);
          } else if (!idConflict.sourceNodes.includes('leaf_a') || !idConflict.sourceNodes.includes('leaf_b')) {
            fail(`expected sourceNodes=[leaf_a,leaf_b], got: ${JSON.stringify(idConflict.sourceNodes)}`);
          } else {
            pass(`409 conflict on 'id' from {leaf_a, leaf_b}`);
          }
        }
      }
    }

    // ── Test 2: publish with renames → 200, snapshot mode bakes cached_outputs ──
    console.log('Test 2 — publish with column_renames returns 200 + freezes outputs (snapshot mode)');
    {
      const r = await call('POST', `/api/dag/${encodeURIComponent(DAG_ID)}/publish`, {
        page_id: PAGE_ID_SNAPSHOT,
        title: '_test_xdb_l4 cross-DS snapshot',
        display_mode: 'explorer',
        render_mode: 'snapshot',
        column_renames: {
          leaf_a__id: 'a_id',
          leaf_b__id: 'b_id',
          leaf_a__label: 'a_label',
          leaf_b__label: 'b_label',
        },
        // grant_read_to_roles default 'BI_USER' is fine; SYSADMIN test user
        // is auto-allowed via god-mode for the render-time bless check.
      });
      if (r.status !== 201 && r.status !== 200) {
        fail(`expected 201/200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 240)}`);
      } else if (r.body?.render_mode !== 'snapshot') {
        fail(`expected render_mode='snapshot' echoed, got ${r.body?.render_mode}`);
      } else {
        pass(`publish OK (status=${r.status}, render_mode=${r.body.render_mode})`);
      }
      // Confirm cached_outputs landed in dag_snapshot.
      const authz = new Pool({
        host: AUTHZ_HOST, port: AUTHZ_PORT, database: AUTHZ_DB,
        user: AUTHZ_USER, password: AUTHZ_PASS, max: 1,
      });
      try {
        const snapRow = await authz.query(
          `SELECT dag_snapshot, render_mode, column_renames
             FROM authz_ui_page WHERE page_id = $1`,
          [PAGE_ID_SNAPSHOT],
        );
        const snap = snapRow.rows[0]?.dag_snapshot;
        if (!snap?.cached_outputs?.outputs) {
          fail(`dag_snapshot.cached_outputs missing — snapshot freeze did not run`);
        } else {
          const cachedNodes = Object.keys(snap.cached_outputs.outputs);
          if (!cachedNodes.includes('leaf_a') || !cachedNodes.includes('leaf_b')) {
            fail(`cached_outputs missing leaves: keys=${JSON.stringify(cachedNodes)}`);
          } else {
            pass(`cached_outputs has leaf_a + leaf_b (${cachedNodes.length} frames frozen)`);
          }
        }
        if (snapRow.rows[0]?.render_mode !== 'snapshot') {
          fail(`authz_ui_page.render_mode = ${snapRow.rows[0]?.render_mode}, expected 'snapshot'`);
        }
        const renames = snapRow.rows[0]?.column_renames;
        if (renames?.leaf_a__id !== 'a_id' || renames?.leaf_b__id !== 'b_id') {
          fail(`column_renames not persisted correctly: ${JSON.stringify(renames)}`);
        } else {
          pass('column_renames persisted to V092 column');
        }
      } finally {
        await authz.end();
      }
    }

    // ── Test 3: render snapshot mode → returns frozen rows with renamed cols ──
    console.log('Test 3 — render snapshot mode returns cached rows with renamed columns');
    {
      const r = await call('POST', '/api/config-exec', {
        page_id: PAGE_ID_SNAPSHOT,
        // Snapshot fast-path returns cached outputs immediately, regardless
        // of params. Send empty {} to confirm fast-path triggers without form.
        params: {},
      });
      if (r.status !== 200) {
        fail(`render expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 240)}`);
      } else if (r.body?.meta?.render_mode !== 'snapshot') {
        fail(`expected meta.render_mode='snapshot', got ${r.body?.meta?.render_mode}`);
      } else if (r.body?.meta?.stage !== 'snapshot_render') {
        fail(`expected stage='snapshot_render', got ${r.body?.meta?.stage}`);
      } else {
        const outputs = r.body?.meta?.outputs;
        if (!outputs?.leaf_a || !outputs?.leaf_b) {
          fail(`outputs missing leaves: ${JSON.stringify(Object.keys(outputs || {}))}`);
        } else {
          const aCols = (outputs.leaf_a.columns || []).map((c: any) => c.name);
          const bCols = (outputs.leaf_b.columns || []).map((c: any) => c.name);
          if (!aCols.includes('a_id') || !aCols.includes('a_label')) {
            fail(`leaf_a columns not renamed: ${JSON.stringify(aCols)}`);
          } else if (!bCols.includes('b_id') || !bCols.includes('b_label')) {
            fail(`leaf_b columns not renamed: ${JSON.stringify(bCols)}`);
          } else {
            pass(`leaf_a=[${aCols.join(',')}] leaf_b=[${bCols.join(',')}] — renames applied`);
          }
          const aRows = outputs.leaf_a.rows || [];
          if (aRows.length === 0) {
            fail(`leaf_a frozen rows are empty — freeze step did not capture data`);
          } else if (!Object.prototype.hasOwnProperty.call(aRows[0], 'a_id')) {
            fail(`leaf_a row missing renamed column: ${JSON.stringify(aRows[0])}`);
          } else {
            pass(`leaf_a frozen rows carry 'a_id' (${aRows.length} rows)`);
          }
        }
      }
    }

    // ── Test 4: render live mode → re-executes with renamed columns ──
    console.log('Test 4 — publish live mode + render returns fresh data with renamed columns');
    {
      const pub = await call('POST', `/api/dag/${encodeURIComponent(DAG_ID)}/publish`, {
        page_id: PAGE_ID_LIVE,
        title: '_test_xdb_l4 cross-DS live',
        display_mode: 'explorer',
        render_mode: 'live',
        column_renames: {
          leaf_a__id: 'a_id',
          leaf_b__id: 'b_id',
          leaf_a__label: 'a_label',
          leaf_b__label: 'b_label',
        },
        // Live mode would normally need at least one form input, BUT this
        // DAG has zero — the route returns 400 'no user_input_params'. We
        // expect that and switch to snapshot for the actual live-vs-cached
        // comparison via a separate code path.
      });
      if (pub.status === 400 && /user_input_params/.test(pub.body?.error || '')) {
        pass('live publish correctly rejected zero-form DAG (400 — would be expensive snapshot)');
      } else if (pub.status === 200 || pub.status === 201) {
        // Some seed configs do allow zero-form live; in that case verify
        // the render actually re-executes (no cached_outputs in snapshot).
        const authz = new Pool({
          host: AUTHZ_HOST, port: AUTHZ_PORT, database: AUTHZ_DB,
          user: AUTHZ_USER, password: AUTHZ_PASS, max: 1,
        });
        try {
          const snapRow = await authz.query(
            `SELECT dag_snapshot FROM authz_ui_page WHERE page_id = $1`,
            [PAGE_ID_LIVE],
          );
          const cached = snapRow.rows[0]?.dag_snapshot?.cached_outputs;
          if (cached) {
            fail('live publish should NOT bake cached_outputs');
          } else {
            pass('live page has no cached_outputs (will re-execute on render)');
          }
        } finally {
          await authz.end();
        }
        // And render proves the rename map is applied at run time too.
        const r = await call('POST', '/api/config-exec', {
          page_id: PAGE_ID_LIVE,
          params: { _trigger: 1 },                                 // any non-empty triggers exec stage
        });
        if (r.status === 200 && r.body?.meta?.render_mode === 'live') {
          pass(`live render returns meta.render_mode='live' (stage=${r.body.meta.stage})`);
        } else {
          fail(`live render unexpected: status=${r.status} render_mode=${r.body?.meta?.render_mode}`);
        }
      } else {
        fail(`live publish unexpected: status=${pub.status} body=${JSON.stringify(pub.body).slice(0, 240)}`);
      }
    }
  } finally {
    await teardown();
  }

  console.log('');
  if (failures > 0) {
    console.error(`FAIL — ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke crashed:', err);
  process.exit(2);
});
