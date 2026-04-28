import { runOperator } from '../src/lib/dag-operators';

const upstream = {
  src1: {
    columns: [
      { name: 'product_line', pgType: 'text' },
      { name: 'site', pgType: 'text' },
      { name: 'cost', pgType: 'numeric' },
      { name: 'lot_id', pgType: 'text' },
    ],
    rows: [
      { product_line: 'eMMC', site: 'HQ', cost: 1.8, lot_id: 'L1' },
      { product_line: 'eMMC', site: 'HQ', cost: 1.7, lot_id: 'L2' },
      { product_line: 'eMMC', site: 'HK', cost: 1.65, lot_id: 'L3' },
      { product_line: 'PCIe', site: 'HQ', cost: 4.8, lot_id: 'L4' },
      { product_line: 'PCIe', site: 'HQ', cost: 4.6, lot_id: 'L5' },
      { product_line: 'SD', site: 'JP', cost: null, lot_id: 'L6' },
    ],
  },
};
const inbound = [{ source: 'src1', sourceHandle: '__downstream', targetHandle: '__upstream' }];

let ok = true;
const fail = (m: string) => { console.error('FAIL:', m); ok = false; };
const pass = (m: string) => console.log('PASS:', m);

// Test 1: group by product_line, sum cost
{
  const r = runOperator({
    op_kind: 'aggregate',
    op_config: { group_by: ['product_line'], aggregations: [{ fn: 'sum', column: 'cost' }] },
    inbound,
    upstream,
    node_id: 'agg1',
  });
  if (r.row_count !== 3) fail(`grp by product_line: expected 3 rows, got ${r.row_count}`);
  const eMMC = r.rows.find((row) => row.product_line === 'eMMC');
  const sum = Number(eMMC?.sum_cost);
  if (Math.abs(sum - 5.15) > 0.01) fail(`sum(cost) for eMMC: expected 5.15, got ${sum}`);
  else pass(`group_by product_line + sum(cost): eMMC=${sum}, 3 groups`);

  const sd = r.rows.find((row) => row.product_line === 'SD');
  if (sd?.sum_cost !== null) fail(`SD sum should be null (only NULLs), got ${sd?.sum_cost}`);
  else pass('SD sum=null (all-null group)');
}

// Test 2: group by 2 cols, count + avg
{
  const r = runOperator({
    op_kind: 'aggregate',
    op_config: {
      group_by: ['product_line', 'site'],
      aggregations: [
        { fn: 'count', column: 'lot_id', alias: 'lot_count' },
        { fn: 'avg', column: 'cost' },
      ],
    },
    inbound, upstream, node_id: 'agg2',
  });
  if (r.row_count !== 4) fail(`2-col group: expected 4 rows, got ${r.row_count}`);
  else pass(`group_by 2 cols → ${r.row_count} groups`);
  const cols = r.columns.map((c) => `${c.name}:${c.pgType}`);
  if (!cols.includes('lot_count:bigint')) fail(`count column should be bigint, got ${cols.join(',')}`);
  else pass('count column inferred as bigint');
  if (!cols.includes('avg_cost:numeric')) fail(`avg column should be numeric, got ${cols.join(',')}`);
  else pass('avg column inferred as numeric');
}

// Test 3: no group_by → 1 row aggregate over all
{
  const r = runOperator({
    op_kind: 'aggregate',
    op_config: { group_by: [], aggregations: [{ fn: 'count', column: 'lot_id' }, { fn: 'min', column: 'cost' }, { fn: 'max', column: 'cost' }] },
    inbound, upstream, node_id: 'agg3',
  });
  if (r.row_count !== 1) fail(`no group_by: expected 1 row, got ${r.row_count}`);
  const row = r.rows[0];
  if (row.count_lot_id !== 6) fail(`count(lot_id)=${row.count_lot_id}, expected 6`);
  if (Math.abs(Number(row.min_cost) - 1.65) > 0.01) fail(`min(cost)=${row.min_cost}, expected 1.65`);
  if (Math.abs(Number(row.max_cost) - 4.8) > 0.01) fail(`max(cost)=${row.max_cost}, expected 4.8`);
  if (ok) pass(`no group_by: count=6, min=1.65, max=4.8`);
}

// Test 4: empty aggregations should throw
{
  try {
    runOperator({ op_kind: 'aggregate', op_config: { group_by: [], aggregations: [] }, inbound, upstream, node_id: 'agg4' });
    fail('empty aggregations did not throw');
  } catch (e: any) {
    if (e.message.includes('aggregations')) pass('empty aggregations throws');
    else fail(`wrong error: ${e.message}`);
  }
}

process.exit(ok ? 0 : 1);
