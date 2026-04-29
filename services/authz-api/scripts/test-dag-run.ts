// ============================================================
// Tier 3 smoke: end-to-end DAG run against real ds:pg_k8.
//
// Why this exists:
//   The 2026-04-29 V081 / sink-as-authz-resource session shipped
//   without ever running `Run all` on the golden case DAG. Adam
//   hit "Error: Node execution failed" + "Unbound required input"
//   on the UI; we had no diagnostic surface, the toast had eaten
//   the server `detail`. This script is the cheap, deterministic
//   regression catcher we should have written first.
//
// What it does:
//   1. GET /api/dag/:id   → load nodes/edges/data_source_id
//   2. Topo-sort nodes
//   3. For each fn node: POST /api/dag/execute-node with bound_params
//      and accumulated upstream → assert 200 + ≥1 row
//   4. On any 4xx/5xx, dump server `detail` (PG real error) so the
//      root cause is obvious from CLI alone — no DevTools needed.
//
// Usage:
//   AUTHZ_API_URL=http://localhost:13001 \
//   TEST_DAG_ID=dag:material_search_fanout \
//   TEST_USER_ID=user:sys_admin \
//   tsx services/authz-api/scripts/test-dag-run.ts
//
// Exit code 0 on full pass, 1 on any failure.
// ============================================================

const API = process.env.AUTHZ_API_URL || 'http://localhost:13001';
const DAG_ID = process.env.TEST_DAG_ID || 'dag:material_search_fanout';
const USER = process.env.TEST_USER_ID || 'user:sys_admin';

interface NodeShape {
  id: string;
  type?: string;
  data: {
    resource_id?: string;
    label?: string;
    inputs?: any[];
    outputs?: any[];
    bound_params?: Record<string, unknown>;
    op_kind?: string;
    op_config?: any;
  };
}
interface EdgeShape {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

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

function topoSort(nodes: NodeShape[], edges: EdgeShape[]): string[] | null {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  nodes.forEach((n) => { indeg.set(n.id, 0); adj.set(n.id, []); });
  edges.forEach((e) => {
    if (!indeg.has(e.target) || !adj.has(e.source)) return;
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
    adj.get(e.source)!.push(e.target);
  });
  const q: string[] = [];
  indeg.forEach((d, id) => { if (d === 0) q.push(id); });
  const out: string[] = [];
  while (q.length) {
    const id = q.shift()!;
    out.push(id);
    for (const next of adj.get(id) || []) {
      const d = (indeg.get(next) || 1) - 1;
      indeg.set(next, d);
      if (d === 0) q.push(next);
    }
  }
  return out.length === nodes.length ? out : null;
}

async function main() {
  console.log(`Tier 3 DAG run smoke`);
  console.log(`  API:    ${API}`);
  console.log(`  DAG:    ${DAG_ID}`);
  console.log(`  USER:   ${USER}`);
  console.log('');

  // 1. Load DAG
  const dag = await call('GET', `/api/dag/${encodeURIComponent(DAG_ID)}`);
  if (dag.status !== 200) {
    fail(`GET /api/dag/${DAG_ID} → ${dag.status} ${JSON.stringify(dag.body)}`);
    process.exit(1);
  }
  pass(`Loaded DAG ${DAG_ID}`);
  const dataSourceId: string | undefined = dag.body.data_source_id;
  const nodes: NodeShape[] = dag.body.nodes || [];
  const edges: EdgeShape[] = dag.body.edges || [];
  if (!dataSourceId) { fail('DAG has no data_source_id'); process.exit(1); }
  if (nodes.length === 0) { fail('DAG has no nodes'); process.exit(1); }
  pass(`data_source_id=${dataSourceId}, ${nodes.length} nodes, ${edges.length} edges`);

  // 2. Topo-sort
  const order = topoSort(nodes, edges);
  if (!order) { fail('Cycle detected in DAG — abort'); process.exit(1); }
  pass(`Topo order: ${order.join(' \u2192 ')}`);

  // 3. Execute each fn node and collect upstream.
  // Mirror the client's executeNode payload shape verbatim (see DagTab.tsx:1053-1069).
  const upstream: Record<string, { columns: any[]; row0: any; rows: any[] }> = {};
  const upstream_resources: Record<string, string> = {};
  for (const n of nodes) {
    if (n.type === 'fn' && n.data.resource_id) {
      upstream_resources[n.id] = n.data.resource_id;
    }
  }

  console.log('');
  for (const id of order) {
    const node = nodes.find((n) => n.id === id)!;
    if (node.type === 'sink') { console.log(`  -- skip sink ${id} (sinks are explicit Run)`); continue; }
    if (node.type && node.type !== 'fn') {
      console.log(`  -- skip operator ${node.type} ${id} (not in golden case scope)`);
      continue;
    }

    const payload = {
      data_source_id: dataSourceId,
      node: {
        id: node.id,
        type: node.type,
        data: {
          resource_id: node.data.resource_id,
          inputs: node.data.inputs,
          bound_params: node.data.bound_params || {},
          op_kind: node.data.op_kind,
          op_config: node.data.op_config,
        },
      },
      upstream,
      upstream_resources,
      edges: edges.map((e) => ({
        source: e.source, target: e.target,
        sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
      })),
    };
    const r = await call('POST', '/api/dag/execute-node', payload);
    const label = node.data.label || node.data.resource_id || id;
    if (r.status !== 200) {
      fail(
        `[${id}] ${label} \u2192 ${r.status} ${r.body?.error || '(no error)'} | ` +
        `detail: ${r.body?.detail || '(no detail)'}` +
        (r.body?.lineage ? ` | lineage: ${JSON.stringify(r.body.lineage)}` : '')
      );
      // Don't bail — we want to see *which* nodes fail and how. Downstream nodes
      // will likely cascade-fail with "Unbound required input"; that's the signal.
      continue;
    }
    const rowCount = r.body.row_count ?? (r.body.rows?.length || 0);
    if (rowCount === 0) {
      fail(`[${id}] ${label} \u2192 200 but 0 rows (downstream will starve). ` +
           `bound_params=${JSON.stringify(node.data.bound_params || {})}`);
    } else {
      pass(`[${id}] ${label} \u2192 ${rowCount} rows in ${r.body.elapsed_ms || '?'}ms`);
    }
    upstream[id] = {
      columns: r.body.columns || [],
      row0: r.body.rows?.[0] || null,
      rows: r.body.rows || [],
    };
  }

  console.log('');
  if (failures > 0) {
    console.error(`\u2717 ${failures} failure(s) — see detail above.`);
    process.exit(1);
  }
  console.log('\u2713 All fn nodes ran clean — Tier 3 pass.');
  process.exit(0);
}

main().catch((e) => { console.error('Unexpected error:', e); process.exit(2); });
