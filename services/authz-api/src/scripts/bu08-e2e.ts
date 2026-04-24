/* eslint-disable no-console */
// BU-08 E2E driver — exercise schema-driven UI generation end-to-end.
// Usage: cd services/authz-api && npx tsx src/scripts/bu08-e2e.ts
//
// What this proves against the real dev DB:
//   1. POST /api/discover/generate-app introspects a real table
//   2. Inserts authz_ui_page (with derived columns_override) + authz_ui_descriptor
//      (status='derived', derived_from JSONB populated)
//   3. Returns 409 on re-run (idempotency guard)
//   4. Returns 412 when target resource hasn't been scanned
//
// All test artifacts use ds:_agent_bu08_test prefix and are cleaned up
// before exit, per docs/constitution.md Article 8 agent-created test data rules.

import express from 'express';
import { Pool } from 'pg';
import { discoverRouter } from '../routes/discover';
import { encrypt } from '../lib/crypto';

const TEST_DS_ID = 'ds:_agent_bu08_test';
const TEST_TABLE = 'bu08_e2e_widget';
const TEST_RESOURCE_ID = `table:${TEST_TABLE}`;
const TEST_PAGE_ID = `auto:${TEST_DS_ID}:public.${TEST_TABLE}`;
const TEST_DESCRIPTOR_ID = `${TEST_PAGE_ID}:default`;

const PG_HOST = process.env.PGHOST || 'localhost';
const PG_PORT = Number(process.env.PGPORT || 15432);
const PG_USER = process.env.PGUSER || 'nexus_admin';
const PG_PASSWORD = process.env.PGPASSWORD || 'nexus_dev_password';

const authzPool = new Pool({
  host: PG_HOST,
  port: PG_PORT,
  user: PG_USER,
  password: PG_PASSWORD,
  database: 'nexus_authz',
});
const dataPool = new Pool({
  host: PG_HOST,
  port: PG_PORT,
  user: PG_USER,
  password: PG_PASSWORD,
  database: 'nexus_data',
});

function fail(msg: string): never {
  console.error(`\n[FAIL] ${msg}`);
  process.exit(1);
}

async function setup(): Promise<void> {
  console.log('\n[setup] Cleaning any prior test artifacts...');
  await cleanup();

  console.log('[setup] Creating test data source ds:_agent_bu08_test → localhost nexus_data');
  await authzPool.query(
    `INSERT INTO authz_data_source (
       source_id, db_type, host, port, database_name,
       connector_user, connector_password, schemas, is_active,
       display_name, registered_by
     ) VALUES ($1, 'postgresql', $2, $3, 'nexus_data', $4, $5, ARRAY['public'], TRUE,
               'BU-08 E2E test source (auto-created, safe to delete)', 'bu08-e2e')`,
    [TEST_DS_ID, PG_HOST, PG_PORT, PG_USER, encrypt(PG_PASSWORD)],
  );

  console.log('[setup] Creating test table public.bu08_e2e_widget in nexus_data');
  await dataPool.query(`DROP TABLE IF EXISTS public.${TEST_TABLE}`);
  await dataPool.query(`
    CREATE TABLE public.${TEST_TABLE} (
      widget_id     SERIAL PRIMARY KEY,
      widget_code   TEXT NOT NULL,
      owner_email   TEXT,
      cost          NUMERIC(10, 2),
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      tags          TEXT[],
      meta          JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_on  DATE
    )
  `);
  await dataPool.query(
    `INSERT INTO public.${TEST_TABLE} (widget_code, owner_email, cost, tags, meta, delivered_on)
     VALUES ('W-001', 'alice@example.com', 12.50, ARRAY['demo','poc'], '{"k":"v"}'::jsonb, '2026-01-15')`,
  );

  console.log('[setup] Inserting authz_resource row (simulating Discover scan output)');
  await authzPool.query(
    `INSERT INTO authz_resource (
       resource_id, resource_type, parent_id, display_name, attributes, is_active
     ) VALUES ($1, 'table', NULL, 'Widget (BU-08 e2e)',
               jsonb_build_object('data_source_id', $2::text, 'schema', 'public'), TRUE)`,
    [TEST_RESOURCE_ID, TEST_DS_ID],
  );
}

async function cleanup(): Promise<void> {
  // Order matters: ui_descriptor → ui_page → resource → datasource → table
  await authzPool.query(`DELETE FROM authz_ui_descriptor WHERE descriptor_id = $1`, [TEST_DESCRIPTOR_ID]);
  await authzPool.query(`DELETE FROM authz_ui_page WHERE page_id = $1`, [TEST_PAGE_ID]);
  await authzPool.query(`DELETE FROM authz_resource WHERE resource_id = $1`, [TEST_RESOURCE_ID]);
  await authzPool.query(`DELETE FROM authz_data_source WHERE source_id = $1`, [TEST_DS_ID]);
  try {
    await dataPool.query(`DROP TABLE IF EXISTS public.${TEST_TABLE}`);
  } catch (err) {
    console.warn('  (cleanup) DROP TABLE warning:', String(err));
  }
}

function buildTestApp() {
  const app = express();
  app.use(express.json());
  // Stub the auth middleware that index.ts wraps discoverRouter with —
  // the route only needs an X-User-Id header for getUserId().
  app.use('/api/discover', discoverRouter);
  return app;
}

async function main() {
  console.log('=== BU-08 E2E ===');

  await setup();

  console.log('\n[1/5] Spinning up in-process express app...');
  const app = buildTestApp();
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const url = `http://localhost:${port}/api/discover/generate-app`;
  console.log(`  Listening on :${port}`);

  try {
    // ── Step 1: Happy path — generate app for the test table ──
    console.log('\n[2/5] POST /api/discover/generate-app (happy path)...');
    const resp1 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'bu08-e2e' },
      body: JSON.stringify({
        resource_id: TEST_RESOURCE_ID,
        source_id: TEST_DS_ID,
        schema: 'public',
        table_name: TEST_TABLE,
      }),
    });
    const body1 = await resp1.json() as any;
    console.log(`  Status: ${resp1.status}`);
    console.log(`  Body  :`, body1);
    if (resp1.status !== 201) fail(`Expected 201, got ${resp1.status}: ${JSON.stringify(body1)}`);
    if (body1.page_id !== TEST_PAGE_ID) fail(`page_id mismatch: ${body1.page_id} vs ${TEST_PAGE_ID}`);
    if (body1.column_count < 8) fail(`column_count too low: ${body1.column_count} (expected ≥8)`);

    // ── Step 2: Verify rows in DB ──
    console.log('\n[3/5] Verifying authz_ui_page + authz_ui_descriptor rows...');
    const pageRow = await authzPool.query<{
      page_id: string; layout: string; columns_override: any; resource_id: string; data_table: string;
    }>(
      `SELECT page_id, layout, columns_override, resource_id, data_table
         FROM authz_ui_page WHERE page_id = $1`,
      [TEST_PAGE_ID],
    );
    if (pageRow.rowCount !== 1) fail(`authz_ui_page row missing for ${TEST_PAGE_ID}`);
    const page = pageRow.rows[0];
    if (page.layout !== 'table') fail(`layout = '${page.layout}' (expected 'table')`);
    if (page.data_table !== `public.${TEST_TABLE}`) fail(`data_table = '${page.data_table}'`);
    const ovr = page.columns_override || {};
    if (!ovr.widget_id || !ovr.owner_email || !ovr.cost) {
      fail(`columns_override missing expected keys: ${Object.keys(ovr).join(',')}`);
    }
    if (ovr.owner_email.render !== 'email_link') fail(`owner_email.render = '${ovr.owner_email.render}'`);
    if (ovr.is_active.render !== 'active_badge') fail(`is_active.render = '${ovr.is_active.render}'`);
    if (ovr.tags.render !== 'array_pills') fail(`tags.render = '${ovr.tags.render}'`);
    if (ovr.meta.render !== 'json_truncate') fail(`meta.render = '${ovr.meta.render}'`);
    if (ovr.created_at.render !== 'relative_time') fail(`created_at.render = '${ovr.created_at.render}'`);
    if (ovr.delivered_on.render !== 'date') fail(`delivered_on.render = '${ovr.delivered_on.render}'`);
    if (ovr.widget_id.render !== 'mono') fail(`widget_id.render = '${ovr.widget_id.render}'`);
    console.log('  ✓ columns_override render hints map correctly per type');

    const descRow = await authzPool.query<{
      status: string; derived_from: any; columns: any; descriptor_id: string;
    }>(
      `SELECT descriptor_id, status, derived_from, columns
         FROM authz_ui_descriptor WHERE descriptor_id = $1`,
      [TEST_DESCRIPTOR_ID],
    );
    if (descRow.rowCount !== 1) fail(`authz_ui_descriptor row missing for ${TEST_DESCRIPTOR_ID}`);
    const desc = descRow.rows[0];
    if (desc.status !== 'derived') fail(`descriptor.status = '${desc.status}' (expected 'derived')`);
    const df = desc.derived_from || {};
    if (df.source_id !== TEST_DS_ID) fail(`derived_from.source_id = '${df.source_id}'`);
    if (df.schema !== 'public') fail(`derived_from.schema = '${df.schema}'`);
    if (df.table_name !== TEST_TABLE) fail(`derived_from.table_name = '${df.table_name}'`);
    if (!df.schema_hash || typeof df.schema_hash !== 'string' || df.schema_hash.length < 16) {
      fail(`derived_from.schema_hash invalid: ${df.schema_hash}`);
    }
    console.log('  ✓ descriptor.status=derived, derived_from JSONB populated with schema_hash');

    // ── Step 3: Re-run → expect 409 ──
    console.log('\n[4/5] Re-POST same payload → expect 409 app_already_generated...');
    const resp2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'bu08-e2e' },
      body: JSON.stringify({
        resource_id: TEST_RESOURCE_ID,
        source_id: TEST_DS_ID,
        schema: 'public',
        table_name: TEST_TABLE,
      }),
    });
    const body2 = await resp2.json() as any;
    console.log(`  Status: ${resp2.status}, error: ${body2.error}`);
    if (resp2.status !== 409) fail(`Expected 409, got ${resp2.status}: ${JSON.stringify(body2)}`);
    if (body2.error !== 'app_already_generated') fail(`Expected error 'app_already_generated', got '${body2.error}'`);
    console.log('  ✓ Idempotency guard fires correctly');

    // ── Step 4: Bogus resource_id → expect 412 ──
    console.log('\n[5/5] POST with unscanned resource → expect 412 discover_scan_required...');
    const resp3 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'bu08-e2e' },
      body: JSON.stringify({
        resource_id: 'table:_does_not_exist_bu08',
        source_id: TEST_DS_ID,
        schema: 'public',
        table_name: '_does_not_exist_bu08',
      }),
    });
    const body3 = await resp3.json() as any;
    console.log(`  Status: ${resp3.status}, error: ${body3.error}`);
    if (resp3.status !== 412) fail(`Expected 412, got ${resp3.status}: ${JSON.stringify(body3)}`);
    if (body3.error !== 'discover_scan_required') fail(`Expected error 'discover_scan_required', got '${body3.error}'`);
    console.log('  ✓ Precondition guard rejects unscanned resource');

    console.log('\n=== BU-08 E2E PASSED ===');
  } finally {
    server.close();
    console.log('\n[teardown] Cleaning test artifacts...');
    await cleanup();
    await authzPool.end();
    await dataPool.end();
  }
}

main().catch(async err => {
  console.error('\n[ERROR]', err);
  try { await cleanup(); } catch {}
  try { await authzPool.end(); } catch {}
  try { await dataPool.end(); } catch {}
  process.exit(1);
});
