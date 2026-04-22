// ============================================================
// Backfill attributes.inputs/outputs with semantic_type so the
// DAG canvas can type-check edges (W3-1 of the L3 composition
// roadmap). Rules are keyword-based on the parameter/column name.
//
// Idempotent: re-run safely to pick up new functions or rule changes.
//
// Usage (from services/authz-api/):
//   npx tsx scripts/backfill-semantic-types.ts
// ============================================================

import { Pool } from 'pg';

type SemanticType =
  | 'material_no'
  | 'product_family'
  | 'make_buy_flag'
  | 'wo_no'
  | 'shipment_no'
  | 'customer_code'
  | 'keyword'
  | 'limit'
  | 'date'
  | 'datetime'
  | 'count'
  | 'quantity'
  | 'status'
  | 'unknown';

// ── Name → semantic_type rules (order matters: first match wins) ──
const RULES: Array<[RegExp, SemanticType]> = [
  [/^(p_)?(sub_)?material(_no)?$/i, 'material_no'],
  [/^tc_ima001$|^ima0?1$|^料號$/i, 'material_no'],
  [/^(p_)?family(_code)?$|^tc_ima007$/i, 'product_family'],
  [/^(p_)?make_buy$|^tc_ima004$/i, 'make_buy_flag'],
  [/^(p_)?wo(_no)?$|^工單號碼$/i, 'wo_no'],
  [/^(p_)?searchkey$/i, 'wo_no'], // work order search context
  [/^出貨單號$|^shipment_no$/i, 'shipment_no'],
  [/^帳戶客戶$|^customer(_code)?$/i, 'customer_code'],
  [/^(p_)?keywords?$/i, 'keyword'],
  [/^(p_)?limit$/i, 'limit'],
  [/^(doc_|synced_)?date$|日期$/i, 'date'],
  [/_at$|timestamp/i, 'datetime'],
  [/_count$|count$/i, 'count'],
  [/^qty$|數量$|^quantity$/i, 'quantity'],
  [/status$|狀態$|flag$/i, 'status'],
];

function classifySemantic(name: string): SemanticType {
  for (const [re, tag] of RULES) {
    if (re.test(name)) return tag;
  }
  return 'unknown';
}

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '15432'),
    database: process.env.DB_NAME || 'nexus_authz',
    user: process.env.DB_USER || 'nexus_admin',
    password: process.env.DB_PASSWORD || 'nexus_dev_password',
  });

  const { rows } = await pool.query(
    `SELECT resource_id, attributes
     FROM authz_resource
     WHERE resource_type = 'function' AND is_active = TRUE`
  );

  let updated = 0;
  for (const r of rows) {
    const attrs = r.attributes || {};
    const parsed_args: Array<{ name: string; kind: string; pgType: string; mode: string; hasDefault: boolean; semantic_type?: string }> = attrs.parsed_args || [];
    const return_shape = attrs.return_shape || { shape: 'unknown' };

    const inputs = parsed_args
      .filter((a) => a.mode !== 'OUT')
      .map((a) => ({ ...a, semantic_type: classifySemantic(a.name) }));

    let outputs: Array<{ name: string; kind: string; pgType: string; semantic_type: string }> = [];
    if (return_shape.shape === 'table') {
      outputs = (return_shape.columns || []).map((c: any) => ({
        ...c,
        semantic_type: classifySemantic(c.name),
      }));
    } else if (return_shape.shape === 'setof' || return_shape.shape === 'scalar') {
      outputs = [{
        name: 'value',
        kind: return_shape.kind,
        pgType: return_shape.pgType,
        semantic_type: classifySemantic(return_shape.pgType || 'value'),
      }];
    }

    const merged = {
      ...attrs,
      parsed_args: inputs,
      inputs,
      outputs,
      return_shape: return_shape.shape === 'table'
        ? { ...return_shape, columns: outputs }
        : return_shape,
    };

    await pool.query(
      `UPDATE authz_resource SET attributes = $1::jsonb WHERE resource_id = $2`,
      [JSON.stringify(merged), r.resource_id]
    );
    updated++;
    const inSummary = inputs.map((i) => `${i.name}:${i.semantic_type}`).join(', ');
    const outSummary = outputs.map((o) => `${o.name}:${o.semantic_type}`).slice(0, 4).join(', ');
    console.log(`✓ ${r.resource_id}`);
    console.log(`   in  [${inSummary}]`);
    console.log(`   out [${outSummary}${outputs.length > 4 ? ', …' : ''}]`);
  }

  console.log(`\nDone. Updated=${updated}/${rows.length}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
