// ============================================================
// XDB-TIER-B-L3 smoke: cross-DB edge compatibility at /execute-node.
//
// Why this exists:
//   L3 makes the backend reject (HTTP 422 + actionable body) when an
//   upstream column's logical_type is incompatible with the fn input
//   it's wired to. This script proves three acceptance bars:
//     1. Hard mismatch  → 422 with body { error, from, to, suggestedCast, hint }
//     2. Compatible     → 200 (upgrade matrix: int64 → decimal etc.)
//     3. Same type      → 200 (string → string vacuously passes)
//
// Deviation from the L3 plan (cross-db-tier-b-integration §10):
//   The plan called for a PG-Oracle pair so an Oracle source frame
//   feeds a PG fn. Local CI doesn't have Oracle reliably, and the L3
//   mechanism is a logical_type compat check that's source-agnostic —
//   the upstream payload arrives as JSON either way. We mirror the
//   pattern from test-dag-cross-ds.ts (two PG DSes, hand-crafted
//   upstream frames in the request body) so the smoke runs in any
//   dev container without an Oracle dependency. The end-to-end Oracle
//   path is exercised by L2's existing smoke; L3's mechanism doesn't
//   add any Oracle-specific code.
//
// Cleanup: as test-dag-cross-ds.ts. All artefacts use the
// `ds:_test_pg2_` / `_test_xdb_l3` prefix per agent constitution Article 8.
//
// Usage:
//   AUTHZ_API_URL=http://localhost:13001 \
//     npx tsx services/authz-api/scripts/test-cross-ds-edge.ts
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

const DS_X = 'ds:_test_pg2_l3_x';
const DS_Y = 'ds:_test_pg2_l3_y';
const TEST_SCHEMA = '_test_xdb_l3';
// fn_emit_ts emits a TIMESTAMP column we'll use as the cross-DB upstream frame.
const FN_EMIT_TS = 'emit_ts';
// fn_take_string accepts a TEXT input — mismatch with TIMESTAMP upstream → 422.
const FN_TAKE_STRING = 'take_string';
// fn_take_decimal accepts a NUMERIC input — int64 upstream upgrades cleanly → 200.
const FN_TAKE_DECIMAL = 'take_decimal';
const FN_EMIT_TS_RID = `function:${TEST_SCHEMA}.${FN_EMIT_TS}`;
const FN_TAKE_STRING_RID = `function:${TEST_SCHEMA}.${FN_TAKE_STRING}`;
const FN_TAKE_DECIMAL_RID = `function:${TEST_SCHEMA}.${FN_TAKE_DECIMAL}`;

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
    // Three test fns: emit_ts (returns timestamp), take_string (text input),
    // take_decimal (numeric input). The "edge" we exercise is upstream→input;
    // we craft upstream frames in the request body so the fn doesn't need
    // to actually be called over an upstream chain.
    await data.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await data.query(`DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.${FN_EMIT_TS}() CASCADE`);
    await data.query(`DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.${FN_TAKE_STRING}(text) CASCADE`);
    await data.query(`DROP FUNCTION IF EXISTS ${TEST_SCHEMA}.${FN_TAKE_DECIMAL}(numeric) CASCADE`);
    await data.query(`
      CREATE OR REPLACE FUNCTION ${TEST_SCHEMA}.${FN_EMIT_TS}()
      RETURNS TABLE(ts_col timestamptz) LANGUAGE sql STABLE AS $$
        SELECT NOW()
      $$
    `);
    await data.query(`
      CREATE OR REPLACE FUNCTION ${TEST_SCHEMA}.${FN_TAKE_STRING}(p_arg text)
      RETURNS TABLE(echoed text) LANGUAGE sql STABLE AS $$
        SELECT p_arg
      $$
    `);
    await data.query(`
      CREATE OR REPLACE FUNCTION ${TEST_SCHEMA}.${FN_TAKE_DECIMAL}(p_arg numeric)
      RETURNS TABLE(doubled numeric) LANGUAGE sql STABLE AS $$
        SELECT p_arg * 2
      $$
    `);
    pass('test fns created');

    // Two test DSes (cleanup-safe prefix).
    await authz.query(`DELETE FROM authz_data_source WHERE source_id LIKE 'ds:_test_pg2_l3_%'`);
    const insertDs = `
      INSERT INTO authz_data_source (
        source_id, db_type, host, port, database_name,
        connector_user, connector_password, schemas,
        display_name, is_active, registered_by
      ) VALUES ($1, 'postgres', $2, $3, $4, $5, $6, $7, $8, TRUE, 'xdb-l3-smoke')
    `;
    await authz.query(insertDs, [
      DS_X, DATA_HOST_FOR_API, DATA_PORT_FOR_API, DATA_DB,
      AUTHZ_USER, AUTHZ_PASS, [TEST_SCHEMA],
      '_test_pg2_l3_x (XDB-L3 smoke)',
    ]);
    await authz.query(insertDs, [
      DS_Y, DATA_HOST_FOR_API, DATA_PORT_FOR_API, DATA_DB,
      AUTHZ_USER, AUTHZ_PASS, [TEST_SCHEMA],
      '_test_pg2_l3_y (XDB-L3 smoke)',
    ]);
    pass(`registered ${DS_X} and ${DS_Y}`);

    // Register fns. Note inputs[].pgType — backend pgTypeStringToLogical
    // resolves 'text' → 'string' and 'numeric' → 'decimal'.
    await authz.query(
      `DELETE FROM authz_resource WHERE resource_id IN ($1, $2, $3)`,
      [FN_EMIT_TS_RID, FN_TAKE_STRING_RID, FN_TAKE_DECIMAL_RID],
    );
    const emitTsAttrs = JSON.stringify({
      data_source_id: DS_X,
      function_name: FN_EMIT_TS,
      schema_name: TEST_SCHEMA,
      arguments: '',
      inputs: [],
      outputs: [{ name: 'ts_col', pgType: 'timestamptz', logical_type: 'timestamp' }],
      return_shape: { shape: 'table', columns: [{ name: 'ts_col', pgType: 'timestamptz', logical_type: 'timestamp' }] },
    });
    const takeStringAttrs = JSON.stringify({
      data_source_id: DS_Y,
      function_name: FN_TAKE_STRING,
      schema_name: TEST_SCHEMA,
      arguments: 'p_arg text',
      inputs: [{ name: 'p_arg', pgType: 'text', logical_type: 'string' }],
      outputs: [{ name: 'echoed', pgType: 'text', logical_type: 'string' }],
      return_shape: { shape: 'table', columns: [{ name: 'echoed', pgType: 'text', logical_type: 'string' }] },
    });
    const takeDecimalAttrs = JSON.stringify({
      data_source_id: DS_Y,
      function_name: FN_TAKE_DECIMAL,
      schema_name: TEST_SCHEMA,
      arguments: 'p_arg numeric',
      inputs: [{ name: 'p_arg', pgType: 'numeric', logical_type: 'decimal' }],
      outputs: [{ name: 'doubled', pgType: 'numeric', logical_type: 'decimal' }],
      return_shape: { shape: 'table', columns: [{ name: 'doubled', pgType: 'numeric', logical_type: 'decimal' }] },
    });
    await authz.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'function', $2, $3::jsonb, TRUE)`,
      [FN_EMIT_TS_RID, FN_EMIT_TS, emitTsAttrs],
    );
    await authz.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'function', $2, $3::jsonb, TRUE)`,
      [FN_TAKE_STRING_RID, FN_TAKE_STRING, takeStringAttrs],
    );
    await authz.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'function', $2, $3::jsonb, TRUE)`,
      [FN_TAKE_DECIMAL_RID, FN_TAKE_DECIMAL, takeDecimalAttrs],
    );
    pass(`registered fn metadata for ${FN_EMIT_TS_RID}, ${FN_TAKE_STRING_RID}, ${FN_TAKE_DECIMAL_RID}`);
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
      `DELETE FROM authz_resource WHERE resource_id IN ($1, $2, $3)`,
      [FN_EMIT_TS_RID, FN_TAKE_STRING_RID, FN_TAKE_DECIMAL_RID],
    ).catch(() => {});
    await authz.query(
      `DELETE FROM authz_data_source WHERE source_id LIKE 'ds:_test_pg2_l3_%'`,
    ).catch(() => {});
    await data.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`).catch(() => {});
    pass('test artefacts removed');
  } finally {
    await authz.end();
    await data.end();
  }
}

// Build a /execute-node payload for the *downstream* fn (take_string /
// take_decimal) with a hand-crafted upstream frame whose columns carry
// the LogicalType we want to test.
function buildPayload(opts: {
  dagDsId: string;
  fnRid: string;
  upstreamLogicalType: 'timestamp' | 'int64' | 'string';
  upstreamColumnName: string;
  upstreamRowValue: unknown;
  inputName: string;
  nodeDsId?: string;
}) {
  const upstreamPgType =
    opts.upstreamLogicalType === 'timestamp' ? 'timestamptz' :
    opts.upstreamLogicalType === 'int64' ? 'int8' : 'text';
  return {
    data_source_id: opts.dagDsId,
    node: {
      id: 'n_downstream',
      type: 'fn',
      data: {
        resource_id: opts.fnRid,
        ...(opts.nodeDsId ? { data_source_id: opts.nodeDsId } : {}),
        inputs: [],
        bound_params: {},
      },
    },
    upstream: {
      n_upstream: {
        columns: [{
          name: opts.upstreamColumnName,
          pgType: upstreamPgType,
          logical_type: opts.upstreamLogicalType,
        }],
        row0: { [opts.upstreamColumnName]: opts.upstreamRowValue },
      },
    },
    upstream_resources: { n_upstream: FN_EMIT_TS_RID },
    edges: [{
      source: 'n_upstream',
      target: 'n_downstream',
      sourceHandle: opts.upstreamColumnName,
      targetHandle: opts.inputName,
    }],
  };
}

async function main() {
  console.log(`XDB-TIER-B-L3 cross-DB edge compat smoke`);
  console.log(`  API:  ${API}`);
  console.log(`  USER: ${USER}`);
  console.log('');

  await setup();
  console.log('');

  try {
    // ── Test 1: hard mismatch — timestamp upstream → string fn input.
    //   Acceptance: 422 with { error: 'type-mismatch', from: 'timestamp',
    //   to: 'string', suggestedCast: [...], hint: '...' }.
    console.log('Test 1 — timestamp → string is rejected with 422 + suggestedCast');
    {
      const r = await call('POST', '/api/dag/execute-node', buildPayload({
        dagDsId: DS_Y, fnRid: FN_TAKE_STRING_RID, nodeDsId: DS_Y,
        upstreamLogicalType: 'timestamp',
        upstreamColumnName: 'ts_col',
        upstreamRowValue: '2026-05-05T12:00:00.000Z',
        inputName: 'p_arg',
      }));
      if (r.status !== 422) {
        fail(`expected 422, got ${r.status}: ${JSON.stringify(r.body)}`);
      } else if (r.body?.error !== 'type-mismatch') {
        fail(`expected error='type-mismatch', got ${r.body?.error}`);
      } else if (r.body?.from !== 'timestamp' || r.body?.to !== 'string') {
        fail(`from/to wrong: ${r.body?.from} → ${r.body?.to}`);
      } else if (!Array.isArray(r.body?.suggestedCast) || r.body.suggestedCast.length === 0) {
        fail(`suggestedCast missing/empty: ${JSON.stringify(r.body?.suggestedCast)}`);
      } else if (!r.body?.hint || !r.body.hint.includes('cast')) {
        fail(`hint missing or malformed: ${r.body?.hint}`);
      } else {
        pass(`422 type-mismatch (suggestedCast=${JSON.stringify(r.body.suggestedCast)})`);
      }
    }

    // ── Test 2: compatible upgrade — int64 upstream → decimal fn input.
    //   Acceptance: 200 (UPGRADES['int64'] includes 'decimal').
    console.log('\nTest 2 — int64 → decimal is allowed (upgrade matrix)');
    {
      const r = await call('POST', '/api/dag/execute-node', buildPayload({
        dagDsId: DS_Y, fnRid: FN_TAKE_DECIMAL_RID, nodeDsId: DS_Y,
        upstreamLogicalType: 'int64',
        upstreamColumnName: 'count_col',
        upstreamRowValue: 42,
        inputName: 'p_arg',
      }));
      if (r.status !== 200) {
        fail(`expected 200 (upgrade allowed), got ${r.status}: ${JSON.stringify(r.body)}`);
      } else if (r.body?.rows?.[0]?.doubled === undefined) {
        fail(`expected doubled column in result, got: ${JSON.stringify(r.body?.rows?.[0])}`);
      } else {
        pass(`int64 → decimal upgrade allowed (doubled=${r.body.rows[0].doubled})`);
      }
    }

    // ── Test 3: same type — string upstream → string fn input.
    //   Acceptance: 200 vacuously.
    console.log('\nTest 3 — string → string passes through unchanged');
    {
      const r = await call('POST', '/api/dag/execute-node', buildPayload({
        dagDsId: DS_Y, fnRid: FN_TAKE_STRING_RID, nodeDsId: DS_Y,
        upstreamLogicalType: 'string',
        upstreamColumnName: 'name_col',
        upstreamRowValue: 'hello',
        inputName: 'p_arg',
      }));
      if (r.status !== 200) {
        fail(`expected 200 (same type), got ${r.status}: ${JSON.stringify(r.body)}`);
      } else if (r.body?.rows?.[0]?.echoed !== 'hello') {
        fail(`expected echoed='hello', got: ${JSON.stringify(r.body?.rows?.[0])}`);
      } else {
        pass(`string → string passed through (echoed=hello)`);
      }
    }

    // ── Test 4: unknown upstream — should pass (advisory until both typed).
    console.log('\nTest 4 — unknown upstream is permissive (legacy back-compat)');
    {
      const r = await call('POST', '/api/dag/execute-node', {
        data_source_id: DS_Y,
        node: {
          id: 'n_downstream',
          type: 'fn',
          data: { resource_id: FN_TAKE_STRING_RID, data_source_id: DS_Y, inputs: [], bound_params: {} },
        },
        upstream: {
          n_upstream: {
            columns: [{ name: 'mystery', pgType: 'unknown', logical_type: 'unknown' }],
            row0: { mystery: 'whatever' },
          },
        },
        upstream_resources: { n_upstream: FN_EMIT_TS_RID },
        edges: [{ source: 'n_upstream', target: 'n_downstream', sourceHandle: 'mystery', targetHandle: 'p_arg' }],
      });
      if (r.status !== 200) {
        fail(`expected 200 (unknown is permissive), got ${r.status}: ${JSON.stringify(r.body)}`);
      } else {
        pass(`unknown upstream allowed through (advisory)`);
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
  console.log('\u2713 All XDB-L3 acceptance tests passed.');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('\nUnexpected error:', e);
  try { await teardown(); } catch { /* ignore */ }
  process.exit(2);
});
