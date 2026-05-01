// ============================================================
// dag-auto-cast smoke test (DAG-AUTOCAST-V01).
//
// Pure function under test — no DB, no HTTP. Asserts:
//   1. numeric → text mismatch triggers a visible cast insert
//   2. text → numeric mismatch (whitelist miss) leaves the edge untouched
//   3. same-family edge produces zero inserts (no-op fast path)
//   4. operator passthrough (__upstream / __rowset) is skipped
//   5. idempotence: applying twice on the result yields no further inserts
//      (first pass already widened to text, second pass sees same-family)
// ============================================================
import { applyAutoCasts } from '../src/lib/dag-auto-cast';
import type { DagDoc } from '../src/lib/dag-validate';

let ok = true;
const fail = (m: string) => { console.error('FAIL:', m); ok = false; };
const pass = (m: string) => console.log('PASS:', m);

function fnNode(id: string, outs: Array<{ name: string; pgType: string }>, ins: Array<{ name: string; pgType: string }>) {
  return {
    id,
    type: 'fn',
    data: {
      resource_id: `function:public.${id}`,
      inputs: ins,
      outputs: outs,
    },
  };
}

function main() {
  // ── Test 1: numeric → text triggers insert ──
  {
    const doc: DagDoc = {
      nodes: [
        fnNode('a', [{ name: 'qty', pgType: 'numeric' }], []),
        fnNode('b', [], [{ name: 'note', pgType: 'text' }]),
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'qty', targetHandle: 'note' }],
    };
    const r = applyAutoCasts(doc);
    if (r.inserted.length !== 1) fail(`T1: expected 1 insert, got ${r.inserted.length}`);
    else if (r.inserted[0].from_pgtype !== 'numeric' || r.inserted[0].to_pgtype !== 'text') {
      fail(`T1: wrong types ${r.inserted[0].from_pgtype}→${r.inserted[0].to_pgtype}`);
    } else if (r.doc.nodes.length !== 3) fail(`T1: expected 3 nodes after insert, got ${r.doc.nodes.length}`);
    else if (r.doc.edges.length !== 2) fail(`T1: expected 2 edges after rewire, got ${r.doc.edges.length}`);
    else {
      const cast = r.doc.nodes.find((n) => n.id === r.inserted[0].inserted_node_id);
      if (!cast || cast.type !== 'cast') fail('T1: inserted node missing or not cast');
      else if ((cast.data?.outputs?.[0] as any)?.pgType !== 'text') fail('T1: cast output pgType not text');
      else pass('T1: numeric → text widening inserts visible cast node');
    }
  }

  // ── Test 2: text → numeric (narrowing/parse) — whitelist miss, no insert ──
  {
    const doc: DagDoc = {
      nodes: [
        fnNode('a', [{ name: 'note', pgType: 'text' }], []),
        fnNode('b', [], [{ name: 'qty', pgType: 'numeric' }]),
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'note', targetHandle: 'qty' }],
    };
    const r = applyAutoCasts(doc);
    if (r.inserted.length !== 0) fail(`T2: expected 0 inserts (text→numeric is unsafe), got ${r.inserted.length}`);
    else if (r.doc.edges.length !== 1) fail(`T2: edges should be untouched`);
    else pass('T2: text → numeric (narrowing) leaves edge alone, DV-01 will flag it');
  }

  // ── Test 3: same-family no-op ──
  {
    const doc: DagDoc = {
      nodes: [
        fnNode('a', [{ name: 'qty', pgType: 'int4' }], []),
        fnNode('b', [], [{ name: 'qty', pgType: 'numeric' }]),
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'qty', targetHandle: 'qty' }],
    };
    const r = applyAutoCasts(doc);
    if (r.inserted.length !== 0) fail(`T3: int4→numeric same family, expected 0 inserts`);
    else pass('T3: int4 → numeric (same number family) is a no-op');
  }

  // ── Test 4: operator passthrough (__upstream / __rowset) skipped ──
  {
    const doc: DagDoc = {
      nodes: [
        fnNode('a', [{ name: 'qty', pgType: 'numeric' }], []),
        {
          id: 'op',
          type: 'filter',
          data: {
            op_kind: 'filter',
            inputs: [{ name: '__upstream', semantic_type: '__rowset' }],
            outputs: [{ name: '__downstream', semantic_type: '__rowset' }],
          },
        },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'op', sourceHandle: 'qty', targetHandle: '__upstream' }],
    };
    const r = applyAutoCasts(doc);
    if (r.inserted.length !== 0) fail(`T4: operator passthrough should be skipped`);
    else pass('T4: __upstream / __rowset edges left alone (operator passthrough)');
  }

  // ── Test 5: idempotence — 2nd pass over output is a no-op ──
  {
    const doc: DagDoc = {
      nodes: [
        fnNode('a', [{ name: 'qty', pgType: 'numeric' }], []),
        fnNode('b', [], [{ name: 'note', pgType: 'text' }]),
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'qty', targetHandle: 'note' }],
    };
    const r1 = applyAutoCasts(doc);
    const r2 = applyAutoCasts(r1.doc);
    if (r1.inserted.length !== 1) fail('T5: first pass expected 1 insert');
    else if (r2.inserted.length !== 0) fail(`T5: second pass should be a no-op (got ${r2.inserted.length} inserts — stacked casts)`);
    else if (r2.doc.nodes.length !== r1.doc.nodes.length) fail('T5: 2nd pass mutated node count');
    else if (r2.doc.edges.length !== r1.doc.edges.length) fail('T5: 2nd pass mutated edge count');
    else pass('T5: applyAutoCasts is idempotent — running twice yields no extra casts');
  }

  if (!ok) process.exit(1);
  console.log('\nAll dag-auto-cast smoke tests passed.');
}

main();
