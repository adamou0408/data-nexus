// Test script for V1 operator additions: array_agg / sort / limit / projection
// + compound filter. Mirrors test-aggregator.ts conventions (PASS/FAIL print +
// process.exit). Run via: npx tsx scripts/test-operators.ts
import { runOperator } from '../src/lib/dag-operators';

let ok = true;
const fail = (m: string) => { console.error('FAIL:', m); ok = false; };
const pass = (m: string) => console.log('PASS:', m);

const inbound = [{ source: 'src1', sourceHandle: '__downstream', targetHandle: '__upstream' }];

// ==========================================================================
// array_agg tests
// ==========================================================================
console.log('\n── array_agg ─────────────────────────────────────');
{
  const upstream = {
    src1: {
      columns: [
        { name: 'group', pgType: 'text' },
        { name: 'keyword', pgType: 'varchar' },
      ],
      rows: [
        { group: 'A', keyword: 'k1' },
        { group: 'A', keyword: 'k2' },
        { group: 'A', keyword: null },
        { group: 'B', keyword: 'k3' },
        { group: 'C', keyword: null },
        { group: 'C', keyword: null },
      ],
    },
  };

  // Test 1: happy path — collect by group, varchar → varchar[]
  {
    const r = runOperator({
      op_kind: 'aggregate',
      op_config: { group_by: ['group'], aggregations: [{ fn: 'array_agg', column: 'keyword' }] },
      inbound,
      upstream,
      node_id: 'agg_arr_1',
    });
    if (r.row_count !== 3) fail(`array_agg group_by: expected 3 rows, got ${r.row_count}`);
    const a = r.rows.find((x) => x.group === 'A');
    if (!Array.isArray(a?.array_agg_keyword) || (a?.array_agg_keyword as unknown[]).length !== 2) {
      fail(`A group should collect 2 non-null vals, got ${JSON.stringify(a?.array_agg_keyword)}`);
    } else {
      pass(`array_agg(keyword) for A=${JSON.stringify(a.array_agg_keyword)}`);
    }
    // Edge case: empty group (after non-null filter) → [] not null
    const c = r.rows.find((x) => x.group === 'C');
    if (!Array.isArray(c?.array_agg_keyword)) {
      fail(`C array_agg should be array, got ${JSON.stringify(c?.array_agg_keyword)}`);
    } else if ((c?.array_agg_keyword as unknown[]).length !== 0) {
      fail(`C array_agg should be empty array (length 0), got ${JSON.stringify(c?.array_agg_keyword)}`);
    } else if (c?.array_agg_keyword === null) {
      fail(`C array_agg must NOT be null — must be []`);
    } else {
      pass('empty group → [] (not null) per spec divergence from PG');
    }
    // Output column type check
    const col = r.columns.find((c) => c.name === 'array_agg_keyword');
    if (col?.pgType !== 'varchar[]') fail(`array_agg pgType: expected varchar[], got ${col?.pgType}`);
    else pass(`array_agg upstream varchar → varchar[] column`);
  }

  // Test 2: error path — bad config (no aggregations)
  {
    try {
      runOperator({
        op_kind: 'aggregate',
        op_config: { group_by: ['group'], aggregations: [] },
        inbound,
        upstream,
        node_id: 'agg_arr_err',
      });
      fail('empty aggregations should have thrown');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('aggregations')) pass('empty aggregations throws');
      else fail(`wrong error: ${msg}`);
    }
  }

  // Test 3: array_agg with no upstream pgType → defaults to text[]
  {
    const upstreamNoType = {
      src1: {
        columns: [{ name: 'group', pgType: 'text' }, { name: 'val' }],
        rows: [{ group: 'X', val: 'a' }],
      },
    };
    const r = runOperator({
      op_kind: 'aggregate',
      op_config: { group_by: ['group'], aggregations: [{ fn: 'array_agg', column: 'val' }] },
      inbound,
      upstream: upstreamNoType,
      node_id: 'agg_arr_default',
    });
    const col = r.columns.find((c) => c.name === 'array_agg_val');
    if (col?.pgType !== 'text[]') fail(`array_agg default pgType: expected text[], got ${col?.pgType}`);
    else pass(`array_agg unknown upstream type → text[] default`);
  }
}

// ==========================================================================
// sort tests
// ==========================================================================
console.log('\n── sort ──────────────────────────────────────────');
{
  const upstream = {
    src1: {
      columns: [
        { name: 'priority', pgType: 'integer' },
        { name: 'name', pgType: 'text' },
        { name: 'score', pgType: 'numeric' },
      ],
      rows: [
        { priority: 2, name: 'Charlie', score: 80 },
        { priority: 1, name: 'Alice', score: null },
        { priority: 1, name: 'Bob', score: 90 },
        { priority: null, name: 'Dan', score: 75 },
        { priority: 2, name: 'Alice', score: 70 },
      ],
    },
  };

  // Test 1: multi-key stable sort (priority asc, then name asc)
  {
    const r = runOperator({
      op_kind: 'sort',
      op_config: { order_by: [{ column: 'priority', dir: 'asc' }, { column: 'name', dir: 'asc' }] },
      inbound, upstream, node_id: 'sort_1',
    });
    const names = r.rows.map((x) => x.name);
    // Expected: priority 1 (Alice, Bob), priority 2 (Alice, Charlie), null (Dan) last
    if (JSON.stringify(names) !== JSON.stringify(['Alice', 'Bob', 'Alice', 'Charlie', 'Dan'])) {
      fail(`multi-key sort order wrong: ${JSON.stringify(names)}`);
    } else {
      pass(`multi-key stable sort: ${names.join(', ')}`);
    }
  }

  // Test 2: nulls always last regardless of dir
  {
    const r = runOperator({
      op_kind: 'sort',
      op_config: { order_by: [{ column: 'priority', dir: 'desc' }] },
      inbound, upstream, node_id: 'sort_2',
    });
    const last = r.rows[r.rows.length - 1];
    if (last.priority !== null) {
      fail(`desc sort: null should still be last, got ${JSON.stringify(last)}`);
    } else {
      pass('null sorts last under desc (vs PG default NULLS-FIRST-on-DESC)');
    }
  }

  // Test 3: numeric vs string detection
  {
    // priority is integer → numeric compare (10 > 2)
    const upstreamNumeric = {
      src1: {
        columns: [{ name: 'p', pgType: 'integer' }],
        rows: [{ p: 2 }, { p: 10 }, { p: 1 }],
      },
    };
    const r = runOperator({
      op_kind: 'sort',
      op_config: { order_by: [{ column: 'p', dir: 'asc' }] },
      inbound, upstream: upstreamNumeric, node_id: 'sort_num',
    });
    const ps = r.rows.map((x) => x.p);
    if (JSON.stringify(ps) !== JSON.stringify([1, 2, 10])) {
      fail(`numeric sort: expected [1,2,10], got ${JSON.stringify(ps)}`);
    } else {
      pass(`numeric column sorted as numbers: ${JSON.stringify(ps)}`);
    }

    // string compare on text column
    const upstreamStr = {
      src1: {
        columns: [{ name: 'p', pgType: 'text' }],
        rows: [{ p: '2' }, { p: '10' }, { p: '1' }],
      },
    };
    const r2 = runOperator({
      op_kind: 'sort',
      op_config: { order_by: [{ column: 'p', dir: 'asc' }] },
      inbound, upstream: upstreamStr, node_id: 'sort_str',
    });
    const ps2 = r2.rows.map((x) => x.p);
    if (JSON.stringify(ps2) !== JSON.stringify(['1', '10', '2'])) {
      fail(`string sort: expected ['1','10','2'], got ${JSON.stringify(ps2)}`);
    } else {
      pass(`text column sorted lexicographically: ${JSON.stringify(ps2)}`);
    }
  }

  // Test 4: error path — empty order_by
  {
    try {
      runOperator({ op_kind: 'sort', op_config: { order_by: [] }, inbound, upstream, node_id: 'sort_err' });
      fail('empty order_by should have thrown');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('order_by')) pass('empty order_by throws');
      else fail(`wrong error: ${msg}`);
    }
  }
}

// ==========================================================================
// limit tests
// ==========================================================================
console.log('\n── limit ─────────────────────────────────────────');
{
  const upstream = {
    src1: {
      columns: [{ name: 'i', pgType: 'integer' }],
      rows: [{ i: 1 }, { i: 2 }, { i: 3 }],
    },
  };

  // Test 1: n=0 → empty rows but columns preserved
  {
    const r = runOperator({
      op_kind: 'limit',
      op_config: { n: 0 },
      inbound, upstream, node_id: 'limit_0',
    });
    if (r.row_count !== 0) fail(`n=0: expected 0 rows, got ${r.row_count}`);
    if (r.columns.length !== 1 || r.columns[0].name !== 'i') fail(`n=0: columns should be preserved`);
    else pass('n=0 → empty rows, columns preserved');
  }

  // Test 2: n=1
  {
    const r = runOperator({
      op_kind: 'limit',
      op_config: { n: 1 },
      inbound, upstream, node_id: 'limit_1',
    });
    if (r.row_count !== 1) fail(`n=1: expected 1 row, got ${r.row_count}`);
    else if (r.rows[0].i !== 1) fail(`n=1: expected first row, got ${JSON.stringify(r.rows[0])}`);
    else pass(`n=1 → first row: ${JSON.stringify(r.rows[0])}`);
  }

  // Test 3: n larger than rows → returns all
  {
    const r = runOperator({
      op_kind: 'limit',
      op_config: { n: 100 },
      inbound, upstream, node_id: 'limit_big',
    });
    if (r.row_count !== 3) fail(`n=100 over 3 rows: expected 3, got ${r.row_count}`);
    else pass(`n=100 over 3 rows → returns all 3`);
  }

  // Test 4: error path — negative
  {
    try {
      runOperator({ op_kind: 'limit', op_config: { n: -1 }, inbound, upstream, node_id: 'limit_neg' });
      fail('negative n should have thrown');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('non-negative integer')) pass('negative n throws expected error');
      else fail(`wrong error: ${msg}`);
    }
  }

  // Test 5: error path — non-integer
  {
    try {
      runOperator({ op_kind: 'limit', op_config: { n: 1.5 }, inbound, upstream, node_id: 'limit_float' });
      fail('non-integer n should have thrown');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('non-negative integer')) pass('non-integer n throws expected error');
      else fail(`wrong error: ${msg}`);
    }
  }
}

// ==========================================================================
// projection tests
// ==========================================================================
console.log('\n── projection ────────────────────────────────────');
{
  const upstream = {
    src1: {
      columns: [
        { name: 'order_id', pgType: 'integer' },
        { name: 'name', pgType: 'text' },
        { name: 'noise', pgType: 'text' },
      ],
      rows: [
        { order_id: 100, name: 'Alice', noise: 'x' },
        { order_id: 200, name: 'Bob', noise: 'y' },
      ],
    },
  };

  // Test 1: keep → rename → add ordering, drops unmentioned
  {
    const r = runOperator({
      op_kind: 'projection',
      op_config: {
        keep: ['order_id', 'name'],
        rename: { name: 'customer_name' },
        add: [{ name: 'label', expr: 'Order: ${order_id} for ${customer_name}', pgType: 'text' }],
      },
      inbound, upstream, node_id: 'proj_1',
    });
    // Note: rename happens BEFORE add evaluates, but expr references work on
    // the upstream column names (because keptCols is iterated by oldName).
    // Actually — the spec says "keep first, then rename, then add". The add
    // expr references the columns in the row at point of evaluation. Since
    // we copy old→new in the row first, expr should reference NEW names.
    const colNames = r.columns.map((c) => c.name);
    if (JSON.stringify(colNames) !== JSON.stringify(['order_id', 'customer_name', 'label'])) {
      fail(`projection columns: expected [order_id, customer_name, label], got ${JSON.stringify(colNames)}`);
    } else {
      pass(`column order: ${colNames.join(', ')}`);
    }
    // noise dropped
    if (r.rows[0].noise !== undefined) fail('noise should have been dropped by keep');
    else pass('keep dropped unmentioned column');
    // Substitution worked using NEW name
    if (r.rows[0].label !== 'Order: 100 for Alice') {
      fail(`label substitution wrong: ${JSON.stringify(r.rows[0].label)}`);
    } else {
      pass(`template subst with renamed column: ${r.rows[0].label}`);
    }
  }

  // Test 2: missing column reference → null + lineage warning
  {
    const r = runOperator({
      op_kind: 'projection',
      op_config: {
        add: [{ name: 'oops', expr: 'X=${does_not_exist}' }],
      },
      inbound, upstream, node_id: 'proj_missing',
    });
    if (r.rows[0].oops !== null) fail(`missing-col ref should yield null, got ${JSON.stringify(r.rows[0].oops)}`);
    else pass('missing column ref → null (fail-soft)');
    const warned = r.lineage.some((l) => l.source.includes('warning') && l.source.includes('does_not_exist'));
    if (!warned) fail(`expected lineage warning about does_not_exist, got ${JSON.stringify(r.lineage)}`);
    else pass('lineage warning emitted for missing col');
  }

  // Test 3: no keep → upstream order, no rename, just add
  {
    const r = runOperator({
      op_kind: 'projection',
      op_config: {
        add: [{ name: 'x', expr: 'static text' }],
      },
      inbound, upstream, node_id: 'proj_addonly',
    });
    const colNames = r.columns.map((c) => c.name);
    if (JSON.stringify(colNames) !== JSON.stringify(['order_id', 'name', 'noise', 'x'])) {
      fail(`addonly cols wrong: ${JSON.stringify(colNames)}`);
    } else {
      pass(`no-keep: upstream order preserved + add appended`);
    }
    if (r.rows[0].x !== 'static text') fail(`literal expr: ${JSON.stringify(r.rows[0].x)}`);
    else pass('literal expr (no template) works');
  }

  // Test 4: pgType default for added columns when not specified
  {
    const r = runOperator({
      op_kind: 'projection',
      op_config: {
        keep: ['order_id'],
        add: [{ name: 'extra', expr: 'v' }],
      },
      inbound, upstream, node_id: 'proj_default_pg',
    });
    const extra = r.columns.find((c) => c.name === 'extra');
    if (extra?.pgType !== 'text') fail(`default added pgType: expected text, got ${extra?.pgType}`);
    else pass(`add column default pgType=text`);
  }
}

// ==========================================================================
// compound filter tests
// ==========================================================================
console.log('\n── compound filter ───────────────────────────────');
{
  const upstream = {
    src1: {
      columns: [
        { name: 'status', pgType: 'text' },
        { name: 'qty', pgType: 'integer' },
        { name: 'region', pgType: 'text' },
      ],
      rows: [
        { status: 'open', qty: 5, region: 'TW' },
        { status: 'closed', qty: 3, region: 'JP' },
        { status: 'open', qty: 2, region: 'TW' },
        { status: 'open', qty: 10, region: 'US' },
        { status: 'pending', qty: 1, region: 'TW' },
      ],
    },
  };

  // Test 1: backward compat — single-condition payload still works
  {
    const r = runOperator({
      op_kind: 'filter',
      op_config: { column: 'status', op: 'eq', value: 'open' },
      inbound, upstream, node_id: 'filt_legacy',
    });
    if (r.row_count !== 3) fail(`legacy single-cond: expected 3, got ${r.row_count}`);
    else pass(`legacy single-cond payload still works: ${r.row_count} rows`);
  }

  // Test 2: AND short-circuit
  {
    const r = runOperator({
      op_kind: 'filter',
      op_config: {
        and: [
          { column: 'status', op: 'eq', value: 'open' },
          { column: 'region', op: 'eq', value: 'TW' },
        ],
      },
      inbound, upstream, node_id: 'filt_and',
    });
    if (r.row_count !== 2) fail(`AND: expected 2 (open+TW), got ${r.row_count}`);
    else pass(`AND filter: status=open AND region=TW → ${r.row_count} rows`);
  }

  // Test 3: OR short-circuit
  {
    const r = runOperator({
      op_kind: 'filter',
      op_config: {
        or: [
          { column: 'status', op: 'eq', value: 'closed' },
          { column: 'status', op: 'eq', value: 'pending' },
        ],
      },
      inbound, upstream, node_id: 'filt_or',
    });
    if (r.row_count !== 2) fail(`OR: expected 2 (closed+pending), got ${r.row_count}`);
    else pass(`OR filter: status=closed OR status=pending → ${r.row_count} rows`);
  }

  // Test 4: depth-3 nesting accepted: (A AND B) OR (C AND D)
  {
    const r = runOperator({
      op_kind: 'filter',
      op_config: {
        or: [
          {
            and: [
              { column: 'status', op: 'eq', value: 'open' },
              { column: 'qty', op: 'gt', value: '5' },
            ],
          },
          {
            and: [
              { column: 'status', op: 'eq', value: 'pending' },
              { column: 'region', op: 'eq', value: 'TW' },
            ],
          },
        ],
      },
      inbound, upstream, node_id: 'filt_depth3',
    });
    // (open AND qty>5) → row {open, 10, US}
    // (pending AND region=TW) → row {pending, 1, TW}
    if (r.row_count !== 2) fail(`depth-3: expected 2 rows, got ${r.row_count}`);
    else pass(`depth-3 nesting accepted: (A AND B) OR (C AND D) → ${r.row_count} rows`);
  }

  // Test 5: depth-4 throws
  {
    try {
      runOperator({
        op_kind: 'filter',
        op_config: {
          or: [{
            and: [{
              or: [{
                and: [
                  { column: 'status', op: 'eq', value: 'open' },
                ],
              }],
            }],
          }],
        },
        inbound, upstream, node_id: 'filt_depth4',
      });
      fail('depth-4 should have thrown');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('depth exceeds 3')) pass('depth-4 throws expected error');
      else fail(`wrong error: ${msg}`);
    }
  }

  // Test 6: AND with empty conditions → all rows match (vacuous truth)
  {
    const r = runOperator({
      op_kind: 'filter',
      op_config: { and: [] },
      inbound, upstream, node_id: 'filt_empty_and',
    });
    if (r.row_count !== 5) fail(`empty AND: expected all 5 rows (vacuous truth), got ${r.row_count}`);
    else pass('empty AND → all rows match (vacuous truth)');
  }
}

console.log(`\n── ${ok ? 'ALL TESTS PASSED' : 'TESTS FAILED'} ──`);
process.exit(ok ? 0 : 1);
