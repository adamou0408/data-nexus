// ============================================================
// sink-runtime smoke test (sink-as-node-kind plan AC-10).
//
// Runs against the local authz_dev DB. Creates synthetic page rows and
// cleans them up at the end so the test is idempotent and harmless to
// share state.
//
// Tested:
//   1. emitPageSnapshot creates a new authz_ui_page row
//   2. emitPageSnapshot rejects bad page_id with 400
//   3. emitPageSnapshot detects existing page_id without overwrite (409)
//   4. emitPageSnapshot overwrites when overwrite:true
//   5. deriveSinkUpstreamFn walks edges to fn ancestor
//   6. deriveSinkUpstreamFn returns null when no fn upstream exists
//   7. validateDag accepts a sink-only DAG (no errors, only orphan-warn skipped for n=1)
//   8. JSONB roundtrip: sink node.type + data.sink_config persist verbatim (AC-8)
// ============================================================
import { authzPool } from '../src/db';
import {
  emitPageSnapshot,
  deriveSinkUpstreamFn,
  SinkValidationError,
} from '../src/lib/sink-runtime';
import { validateDag } from '../src/lib/dag-validate';

let ok = true;
const fail = (m: string) => { console.error('FAIL:', m); ok = false; };
const pass = (m: string) => console.log('PASS:', m);

const TEST_PAGE_ID = `sink_smoke_${Date.now()}`;
const TEST_PAGE_ID_2 = `${TEST_PAGE_ID}_2`;
const TEST_DAG_ID = `dag:_sink_rt_${Date.now()}`;

async function cleanup() {
  await authzPool.query(
    `DELETE FROM authz_ui_page WHERE page_id IN ($1, $2)`,
    [TEST_PAGE_ID, TEST_PAGE_ID_2],
  );
  await authzPool.query(
    `DELETE FROM authz_resource WHERE resource_id = $1 AND resource_type = 'dag'`,
    [TEST_DAG_ID],
  );
}

async function main() {
  try {
    // ── Test 1: create new ──
    {
      const r = await emitPageSnapshot(authzPool, {
        page_id: TEST_PAGE_ID,
        title: 'Sink smoke test',
        dag_id: 'dag:_sink_smoke',
        node_id: 's1',
        columns: [{ name: 'col_a', semantic_type: 'status' }, { name: 'col_b' }],
        rows: [{ col_a: 'ok', col_b: 1 }, { col_a: 'fail', col_b: 2 }],
        captured_by: 'sys_admin',
      });
      if (r.status !== 'created') fail(`expected 'created', got '${r.status}'`);
      else if (r.row_count !== 2) fail(`expected row_count=2, got ${r.row_count}`);
      else pass(`emitPageSnapshot create: page_id=${r.page_id}, rows=${r.row_count}`);

      const stored = await authzPool.query(
        `SELECT snapshot_data FROM authz_ui_page WHERE page_id = $1`,
        [TEST_PAGE_ID],
      );
      const sd = stored.rows[0]?.snapshot_data;
      if (!sd) fail('snapshot_data not persisted');
      else if (sd.origin?.dag_id !== 'dag:_sink_smoke') fail(`origin.dag_id mismatch: ${sd.origin?.dag_id}`);
      else if (sd.origin?.captured_by !== 'sys_admin') fail(`captured_by mismatch: ${sd.origin?.captured_by}`);
      else if (sd.columns?.[0]?.render !== 'status_badge') fail(`render not derived from semantic_type 'status'`);
      else pass('snapshot_data persisted with correct origin + column render');
    }

    // ── Test 2: bad page_id ──
    try {
      await emitPageSnapshot(authzPool, {
        page_id: 'BadPageId',  // uppercase, fails regex
        title: 'x',
        dag_id: 'dag:foo',
        node_id: 's1',
        columns: [],
        rows: [],
        captured_by: 'sys_admin',
      });
      fail('expected SinkValidationError on bad page_id');
    } catch (e) {
      if (e instanceof SinkValidationError && e.status === 400) {
        pass('bad page_id rejected with 400');
      } else {
        fail(`wrong error: ${(e as any).message}`);
      }
    }

    // ── Test 3: duplicate page_id without overwrite ──
    try {
      await emitPageSnapshot(authzPool, {
        page_id: TEST_PAGE_ID,
        title: 'dup',
        dag_id: 'dag:_sink_smoke',
        node_id: 's1',
        columns: [],
        rows: [],
        captured_by: 'sys_admin',
      });
      fail('expected SinkValidationError on duplicate page_id');
    } catch (e) {
      if (e instanceof SinkValidationError && e.status === 409) {
        pass('duplicate page_id rejected with 409 + overwrite hint');
      } else {
        fail(`wrong error: ${(e as any).message}`);
      }
    }

    // ── Test 4: overwrite ──
    {
      const r = await emitPageSnapshot(authzPool, {
        page_id: TEST_PAGE_ID,
        title: 'Sink smoke test (overwritten)',
        dag_id: 'dag:_sink_smoke',
        node_id: 's1',
        columns: [{ name: 'new_col' }],
        rows: [{ new_col: 'fresh' }],
        overwrite: true,
        captured_by: 'sys_admin',
      });
      if (r.status !== 'overwritten') fail(`expected 'overwritten', got '${r.status}'`);
      else pass(`emitPageSnapshot overwrite: ${r.page_id}, rows=${r.row_count}`);

      const stored = await authzPool.query(
        `SELECT title, snapshot_data FROM authz_ui_page WHERE page_id = $1`,
        [TEST_PAGE_ID],
      );
      if (stored.rows[0]?.title !== 'Sink smoke test (overwritten)') {
        fail(`title not overwritten: ${stored.rows[0]?.title}`);
      } else if (stored.rows[0]?.snapshot_data?.rows?.[0]?.new_col !== 'fresh') {
        fail('snapshot rows not overwritten');
      } else {
        pass('overwrite flushes title + rows correctly');
      }
    }

    // ── Test 5: deriveSinkUpstreamFn walks chain ──
    {
      const nodes = [
        { id: 'fn1', type: 'fn', data: { resource_id: 'function:public.fn_test' } },
        { id: 'op1', type: 'filter', data: {} },
        { id: 's1', type: 'sink', data: {} },
      ];
      const edges = [
        { source: 'fn1', target: 'op1' },
        { source: 'op1', target: 's1' },
      ];
      const rid = deriveSinkUpstreamFn(nodes, edges, 's1');
      if (rid !== 'function:public.fn_test') {
        fail(`expected 'function:public.fn_test', got '${rid}'`);
      } else {
        pass('deriveSinkUpstreamFn walks fn → op → sink');
      }
    }

    // ── Test 6: deriveSinkUpstreamFn returns null without fn ancestor ──
    {
      const nodes = [
        { id: 'lit1', type: 'literal', data: {} },
        { id: 's1', type: 'sink', data: {} },
      ];
      const edges = [{ source: 'lit1', target: 's1' }];
      const rid = deriveSinkUpstreamFn(nodes, edges, 's1');
      if (rid !== null) {
        fail(`expected null (no fn ancestor), got '${rid}'`);
      } else {
        pass('deriveSinkUpstreamFn returns null when no fn upstream');
      }
    }

    // ── Test 7: validateDag accepts sink-only DAG (advisor blocker #1) ──
    {
      const sinkNode = {
        id: 's1',
        type: 'sink' as const,
        data: {
          sink_kind: 'page' as const,
          sink_config: { page_id: 'rt_test', title: 'rt', overwrite: false },
        },
      };
      const r = validateDag({ nodes: [sinkNode], edges: [] });
      const errs = r.issues.filter((i) => i.severity === 'error');
      if (errs.length > 0) {
        fail(`validateDag rejected sink-only DAG: ${errs.map((e) => e.code).join(',')}`);
      } else {
        pass('validateDag accepts sink-only DAG (no errors)');
      }
    }

    // ── Test 8: JSONB roundtrip via authz_resource (AC-8) ──
    {
      const node = {
        id: 's1',
        type: 'sink',
        position: { x: 100, y: 100 },
        data: {
          label: 'Page sink',
          inputs: [],
          outputs: [],
          bound_params: {},
          sink_kind: 'page',
          sink_config: {
            page_id: 'rt_page_id',
            title: 'Roundtrip test',
            parent_page_id: 'modules_home',
            description: 'rt desc',
            overwrite: true,
          },
        },
      };
      const attrs = {
        data_source_id: 'ds:pg_k8',
        description: null,
        nodes: [node],
        edges: [],
        version: 1,
        authored_by: 'sys_admin',
        updated_at: new Date().toISOString(),
      };
      await authzPool.query(
        `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
         VALUES ($1, 'dag', $2, $3::jsonb, TRUE)
         ON CONFLICT (resource_id) DO UPDATE SET attributes = EXCLUDED.attributes, is_active = TRUE`,
        [TEST_DAG_ID, 'Sink Roundtrip', JSON.stringify(attrs)],
      );
      const got = await authzPool.query(
        `SELECT attributes FROM authz_resource WHERE resource_id = $1`,
        [TEST_DAG_ID],
      );
      const loaded = got.rows[0]?.attributes;
      const reloadedNode = loaded?.nodes?.[0];
      if (!reloadedNode) fail('roundtrip: nodes[] empty after reload');
      else if (reloadedNode.type !== 'sink') fail(`roundtrip: type lost (got '${reloadedNode.type}')`);
      else if (reloadedNode.data?.sink_kind !== 'page') fail(`roundtrip: sink_kind lost`);
      else if (reloadedNode.data?.sink_config?.page_id !== 'rt_page_id') {
        fail(`roundtrip: sink_config.page_id lost (got '${reloadedNode.data?.sink_config?.page_id}')`);
      } else if (reloadedNode.data?.sink_config?.overwrite !== true) {
        fail(`roundtrip: sink_config.overwrite lost`);
      } else {
        pass('JSONB roundtrip: type=sink + sink_config preserved verbatim');
      }
    }
  } finally {
    await cleanup();
    await authzPool.end();
  }
}

main().then(
  () => process.exit(ok ? 0 : 1),
  (err) => {
    console.error('UNEXPECTED:', err);
    process.exit(2);
  },
);
