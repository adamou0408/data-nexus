/* eslint-disable no-console */
// BU-06 E2E driver — run engine, approve a suggestion, exercise rewriter.
// Usage: cd services/authz-api && npx tsx src/scripts/bu06-e2e.ts
//
// Validates the full bottom-up loop against the real dev database:
//   1. Engine writes pending_review policies in the shape evaluator expects
//   2. Approving a suggestion flips status → 'active'
//   3. PolicyEvaluator + RewritePipeline rewrite a SELECT to apply the mask
//
// Fails loudly with non-zero exit if any step doesn't produce expected output.

import { Pool } from 'pg';
import { runDiscoveryRules } from '../lib/discovery-rule-engine';
import { PolicyEvaluator } from '../lib/policy-evaluator';
import { RewritePipeline } from '../lib/rewriter/pipeline';

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 15432),
  user: process.env.PGUSER || 'nexus_admin',
  password: process.env.PGPASSWORD || 'nexus_admin_pw',
  database: process.env.PGDATABASE || 'nexus_authz',
});

function fail(msg: string): never {
  console.error(`\n[FAIL] ${msg}`);
  process.exit(1);
}

async function main() {
  console.log('=== BU-06 E2E ===');

  // 1) Run engine
  console.log('\n[1/5] Running discovery engine...');
  const engineResult = await runDiscoveryRules({ pool, createdBy: 'bu06-e2e' });
  console.log('  →', engineResult);

  // 2) Inspect what got written
  console.log('\n[2/5] Inspecting pending suggestions...');
  const suggestions = await pool.query<{
    policy_id: number;
    policy_name: string;
    resource_condition: any;
    column_mask_rules: any;
    rls_expression: string | null;
    status: string;
  }>(
    `SELECT policy_id, policy_name, resource_condition, column_mask_rules,
            rls_expression, status
       FROM authz_policy
      WHERE suggested_by_rule IS NOT NULL
      ORDER BY policy_id`,
  );
  console.log(`  Found ${suggestions.rowCount} suggestion(s):`);
  for (const s of suggestions.rows) {
    console.log(`    #${s.policy_id} ${s.policy_name} [${s.status}]`);
    console.log(`      resource_condition: ${JSON.stringify(s.resource_condition)}`);
    console.log(`      column_mask_rules:  ${JSON.stringify(s.column_mask_rules)}`);
  }

  // Pick the cost mask (lot_status.cost) for the rewrite test.
  const costPolicy = suggestions.rows.find(s =>
    s.policy_name.includes('lot_status.cost'),
  );
  if (!costPolicy) {
    fail('Expected a suggestion for lot_status.cost — engine output missing.');
  }

  // Verify shape matches what evaluator wants
  const rc = costPolicy.resource_condition || {};
  if (rc.table !== 'lot_status') {
    fail(`resource_condition.table = '${rc.table}' (expected 'lot_status')`);
  }
  const maskRules = costPolicy.column_mask_rules || {};
  const expectedKey = 'lot_status.cost';
  const maskDef = maskRules[expectedKey];
  if (!maskDef || typeof maskDef !== 'object') {
    fail(`column_mask_rules['${expectedKey}'] missing or not an object: ${JSON.stringify(maskRules)}`);
  }
  if (!maskDef.function) {
    fail(`column_mask_rules['${expectedKey}'].function missing: ${JSON.stringify(maskDef)}`);
  }
  console.log(`  ✓ Engine output shape matches evaluator expectations.`);

  // 3) Approve the cost policy
  console.log('\n[3/5] Approving lot_status.cost suggestion...');
  const upd = await pool.query(
    `UPDATE authz_policy
        SET status = 'active', updated_at = now()
      WHERE policy_id = $1
      RETURNING policy_id, status`,
    [costPolicy.policy_id],
  );
  console.log('  →', upd.rows[0]);

  // 4) Run evaluator + rewriter against a SELECT
  console.log('\n[4/5] Evaluating policies for non-admin user against lot_status...');
  const evaluator = new PolicyEvaluator();
  const userCtx = {
    user_id: 'alice',
    department: 'sales',
    job_level: 1,
    security_clearance: 'INTERNAL' as const,
    roles: ['SALES_USER'],
    groups: ['sales_team'],
    attributes: {},
  };
  const evalResult = await evaluator.evaluate(pool, userCtx, 'lot_status');
  console.log('  →', {
    action: evalResult.action,
    mask_count: evalResult.mask_policies.length,
    filter_count: evalResult.filter_policies.length,
    applied: evalResult.applied_policy_names,
  });
  if (evalResult.mask_policies.length === 0) {
    fail('Evaluator did not load the cost mask policy as a mask_policy.');
  }

  console.log('\n[5/5] Rewriting SELECT cost FROM lot_status...');
  const pipeline = new RewritePipeline();
  const baseSql = 'SELECT cost, customer FROM lot_status';
  const rewritten = pipeline.rewrite(baseSql, evalResult, userCtx, 'lot_status');
  console.log('  Original :', baseSql);
  console.log('  Rewritten:', rewritten.rewritten_sql);
  console.log('  Modified :', rewritten.was_modified);
  console.log('  Applied  :', rewritten.applied_policies);

  if (!rewritten.was_modified) {
    fail(`Pipeline reported no modification — masking did not apply.`);
  }
  // Should reference one of the mask helpers (fn_mask_* or a CASE expression)
  if (!/fn_mask_|CASE\s+WHEN|'\*\*\*'/i.test(rewritten.rewritten_sql)) {
    fail(`Rewritten SQL does not appear to apply masking: ${rewritten.rewritten_sql}`);
  }
  console.log('  ✓ Rewriter applied mask to "cost" column.');

  // 6) Optional: actually execute the rewritten SQL against the data table
  //    to confirm the mask function is callable and returns a non-original value.
  console.log('\n[6/6] Executing rewritten SQL against the live table...');
  // lot_status lives in nexus_data; need a data pool. Reuse same creds.
  const dataPool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 15432),
    user: process.env.PGUSER || 'nexus_admin',
    password: process.env.PGPASSWORD || 'nexus_admin_pw',
    database: 'nexus_data',
  });
  try {
    const exists = await dataPool.query(
      `SELECT to_regclass('public.lot_status') AS t`,
    );
    if (!exists.rows[0]?.t) {
      console.log('  (skip) public.lot_status does not exist in nexus_data — only schema-level test.');
    } else {
      const baseRows = await dataPool.query('SELECT cost FROM lot_status LIMIT 3');
      console.log('  bare    :', baseRows.rows);
      const maskedRows = await dataPool.query(rewritten.rewritten_sql + ' LIMIT 3');
      console.log('  masked  :', maskedRows.rows);
      const sameValues = JSON.stringify(baseRows.rows) === JSON.stringify(maskedRows.rows);
      if (sameValues) {
        fail(`Masked values are identical to bare values — mask did not transform output.`);
      }
      console.log('  ✓ Masked output differs from bare output.');
    }
  } finally {
    await dataPool.end();
  }

  console.log('\n=== BU-06 E2E PASSED ===');
  await pool.end();
}

main().catch(err => {
  console.error('\n[ERROR]', err);
  process.exit(1);
});
