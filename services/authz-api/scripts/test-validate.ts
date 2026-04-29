// ============================================================
// dag-validate smoke test — locks AC-2 validate-message format
// for the composer-operator-and-sink plan.
//
// Pure function under test (no DB). Asserts:
//   1. type_mismatch (semantic-strict): msg renders both sides as
//      `(<sem>/<pgType>)` and includes a "Hint: insert a Cast node"
//      pointer when both sides have non-'unknown' semantic_type.
//   2. type_mismatch (pgType-fallback): when one side lacks semantic
//      info, sides render `(unclassified/<pg>)` and hint mentions the
//      kind family coercion (e.g., text → number).
//   3. operator passthrough: __rowset / __upstream / __downstream
//      edges produce zero type_mismatch, even on incompatible types.
//   4. cycle detection still fires on a self-loop chain.
//   5. unknown_handle / missing_input regression guards.
//
// Sink-only DAG acceptance is covered by test-sink.ts (Test 7); not
// duplicated here.
// ============================================================
import { validateDag, type DagNode, type DagEdge } from '../src/lib/dag-validate';

let ok = true;
const fail = (m: string) => { console.error('FAIL:', m); ok = false; };
const pass = (m: string) => console.log('PASS:', m);

function findError(issues: ReturnType<typeof validateDag>['issues'], code: string) {
  return issues.find((i) => i.code === code && i.severity === 'error');
}

function main() {
  // ── Test 1: type_mismatch — semantic-strict path ──
  {
    const nodes: DagNode[] = [
      {
        id: 'a',
        type: 'fn',
        data: {
          inputs: [],
          outputs: [{ name: 'out_mat', semantic_type: 'material_no', pgType: 'text' }],
        },
      },
      {
        id: 'b',
        type: 'fn',
        data: {
          inputs: [{ name: 'in_pf', semantic_type: 'product_family', pgType: 'text' }],
          outputs: [],
        },
      },
    ];
    const edges: DagEdge[] = [
      { id: 'e1', source: 'a', target: 'b', sourceHandle: 'out_mat', targetHandle: 'in_pf' },
    ];
    const r = validateDag({ nodes, edges });
    const tm = findError(r.issues, 'type_mismatch');
    if (!tm) {
      fail('semantic-strict: expected type_mismatch error, got none');
    } else {
      const msg = tm.message;
      const checks = [
        ["renders source as 'out_mat' (material_no/text)", msg.includes("'out_mat' (material_no/text)")],
        ["renders target as 'in_pf' (product_family/text)", msg.includes("'in_pf' (product_family/text)")],
        ['mentions semantic_type mismatch', msg.includes('semantic_type mismatch')],
        ['suggests Cast node', msg.includes('Hint: insert a Cast node')],
        ['names both semantics in mismatch reason', msg.includes('material_no') && msg.includes('product_family')],
      ] as const;
      const failed = checks.filter(([, c]) => !c);
      if (failed.length) {
        fail(`semantic-strict msg shape: missing -> ${failed.map(([d]) => d).join(' | ')}\n   actual: ${msg}`);
      } else {
        pass('semantic-strict: type_mismatch msg matches AC-2 spec');
      }
    }
  }

  // ── Test 2: type_mismatch — pgType-fallback path ──
  {
    const nodes: DagNode[] = [
      {
        id: 'a',
        type: 'fn',
        data: {
          inputs: [],
          outputs: [{ name: 'out_x', pgType: 'text' }],
        },
      },
      {
        id: 'b',
        type: 'fn',
        data: {
          inputs: [{ name: 'in_y', pgType: 'integer' }],
          outputs: [],
        },
      },
    ];
    const edges: DagEdge[] = [
      { id: 'e1', source: 'a', target: 'b', sourceHandle: 'out_x', targetHandle: 'in_y' },
    ];
    const r = validateDag({ nodes, edges });
    const tm = findError(r.issues, 'type_mismatch');
    if (!tm) {
      fail('pgType-fallback: expected type_mismatch error, got none');
    } else {
      const msg = tm.message;
      const checks = [
        ['renders source as (unclassified/text)', msg.includes('(unclassified/text)')],
        ['renders target as (unclassified/integer)', msg.includes('(unclassified/integer)')],
        ['mentions pgType family mismatch', msg.includes('pgType family mismatch')],
        ['hint mentions kind coercion (text/number)', /text\s*→\s*number/.test(msg)],
      ] as const;
      const failed = checks.filter(([, c]) => !c);
      if (failed.length) {
        fail(`pgType-fallback msg shape: missing -> ${failed.map(([d]) => d).join(' | ')}\n   actual: ${msg}`);
      } else {
        pass('pgType-fallback: type_mismatch msg matches AC-2 spec');
      }
    }
  }

  // ── Test 3a: operator passthrough — __rowset semantic_type ──
  {
    const nodes: DagNode[] = [
      {
        id: 'fn1',
        type: 'fn',
        data: {
          outputs: [{ name: 'out_rowset', semantic_type: '__rowset', pgType: 'record[]' }],
        },
      },
      {
        id: 'flt',
        type: 'filter',
        data: {
          inputs: [{ name: 'in_rowset', semantic_type: '__rowset', pgType: 'record[]' }],
          outputs: [{ name: 'out_rowset', semantic_type: '__rowset', pgType: 'record[]' }],
        },
      },
    ];
    const edges: DagEdge[] = [
      { id: 'e1', source: 'fn1', target: 'flt', sourceHandle: 'out_rowset', targetHandle: 'in_rowset' },
    ];
    const r = validateDag({ nodes, edges });
    if (findError(r.issues, 'type_mismatch')) {
      fail(`__rowset passthrough should not raise type_mismatch; issues=${JSON.stringify(r.issues)}`);
    } else {
      pass('__rowset semantic edges bypass strict type check');
    }
  }

  // ── Test 3b: operator passthrough — __upstream / __downstream handles ──
  {
    const nodes: DagNode[] = [
      {
        id: 'fn1',
        type: 'fn',
        data: {
          outputs: [{ name: '__downstream', pgType: 'text' }],
        },
      },
      {
        id: 'flt',
        type: 'filter',
        data: {
          inputs: [{ name: '__upstream', pgType: 'integer' }], // would mismatch text→integer
        },
      },
    ];
    const edges: DagEdge[] = [
      { id: 'e1', source: 'fn1', target: 'flt', sourceHandle: '__downstream', targetHandle: '__upstream' },
    ];
    const r = validateDag({ nodes, edges });
    if (findError(r.issues, 'type_mismatch')) {
      fail(`__downstream/__upstream passthrough should not raise type_mismatch; issues=${JSON.stringify(r.issues)}`);
    } else {
      pass('__upstream/__downstream operator handles bypass strict type check');
    }
  }

  // ── Test 4: cycle detection ──
  {
    const nodes: DagNode[] = [
      { id: 'a', type: 'fn', data: { outputs: [{ name: 'o' }], inputs: [{ name: 'i' }] } },
      { id: 'b', type: 'fn', data: { outputs: [{ name: 'o' }], inputs: [{ name: 'i' }] } },
    ];
    const edges: DagEdge[] = [
      { id: 'e1', source: 'a', target: 'b', sourceHandle: 'o', targetHandle: 'i' },
      { id: 'e2', source: 'b', target: 'a', sourceHandle: 'o', targetHandle: 'i' },
    ];
    const r = validateDag({ nodes, edges });
    if (!findError(r.issues, 'cycle')) {
      fail(`expected cycle error; issues=${JSON.stringify(r.issues)}`);
    } else {
      pass('cycle detection still fires on a→b→a');
    }
  }

  // ── Test 5a: unknown_handle ──
  {
    const nodes: DagNode[] = [
      { id: 'a', type: 'fn', data: { outputs: [{ name: 'real_out' }] } },
      { id: 'b', type: 'fn', data: { inputs: [{ name: 'real_in' }] } },
    ];
    const edges: DagEdge[] = [
      { id: 'e1', source: 'a', target: 'b', sourceHandle: 'ghost_out', targetHandle: 'real_in' },
    ];
    const r = validateDag({ nodes, edges });
    if (!findError(r.issues, 'unknown_handle')) {
      fail(`expected unknown_handle error; issues=${JSON.stringify(r.issues)}`);
    } else {
      pass('unknown_handle still detected (regression guard)');
    }
  }

  // ── Test 5b: missing_input ──
  {
    const nodes: DagNode[] = [
      {
        id: 'a',
        type: 'fn',
        data: {
          inputs: [{ name: 'p_required', hasDefault: false }],
        },
      },
    ];
    const r = validateDag({ nodes, edges: [] });
    if (!findError(r.issues, 'missing_input')) {
      fail(`expected missing_input error; issues=${JSON.stringify(r.issues)}`);
    } else {
      pass('missing_input still detected when neither connected nor bound');
    }
  }
}

try {
  main();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('UNEXPECTED:', err);
  process.exit(2);
}
