/* eslint-disable no-console */
// DS-CASCADE-01 E2E driver — verify /datasources/:id/purge cascade-cleans
// authz_ui_descriptor + authz_ui_page + authz_role_permission alongside the
// existing resource / pool_profile cleanup.
//
// Usage: cd services/authz-api && npx tsx src/scripts/ds-cascade-e2e.ts
//
// All test artifacts use ds:_agent_dscascade prefix per Constitution Article 8.

import express from 'express';
import { Pool } from 'pg';
import { datasourceRouter } from '../routes/datasource';
import { encrypt } from '../lib/crypto';

const TEST_DS_ID = 'ds:_agent_dscascade';
const TEST_TABLE_RES = `table:_agent_dscascade_widget`;
const TEST_COL_RES = `column:_agent_dscascade_widget.id`;
const TEST_PAGE_ID = `auto:${TEST_DS_ID}:public._agent_dscascade_widget`;
const TEST_DESC_ID = `${TEST_PAGE_ID}:default`;
const TEST_PROFILE_ID = `_agent_dscascade_profile`;
const TEST_ROLE_ID = '_agent_dscascade_role';
const TEST_ACTION_ID = 'read';

const PG_HOST = process.env.PGHOST || 'localhost';
const PG_PORT = Number(process.env.PGPORT || 15432);
const PG_USER = process.env.PGUSER || 'nexus_admin';
const PG_PASSWORD = process.env.PGPASSWORD || 'nexus_dev_password';

const authzPool = new Pool({
  host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD,
  database: 'nexus_authz',
});

function fail(msg: string): never {
  console.error(`\n[FAIL] ${msg}`);
  process.exit(1);
}

async function cleanup(): Promise<void> {
  await authzPool.query(`DELETE FROM authz_role_permission WHERE role_id = $1`, [TEST_ROLE_ID]);
  await authzPool.query(`DELETE FROM authz_ui_descriptor WHERE descriptor_id = $1`, [TEST_DESC_ID]);
  await authzPool.query(`DELETE FROM authz_ui_page WHERE page_id = $1`, [TEST_PAGE_ID]);
  await authzPool.query(`DELETE FROM authz_resource WHERE resource_id IN ($1, $2)`, [TEST_TABLE_RES, TEST_COL_RES]);
  await authzPool.query(`DELETE FROM authz_role WHERE role_id = $1`, [TEST_ROLE_ID]);
  await authzPool.query(`DELETE FROM authz_db_pool_assignment WHERE profile_id = $1`, [TEST_PROFILE_ID]);
  await authzPool.query(`DELETE FROM authz_db_pool_profile WHERE profile_id = $1`, [TEST_PROFILE_ID]);
  await authzPool.query(`DELETE FROM authz_data_source WHERE source_id = $1`, [TEST_DS_ID]);
}

async function setup(): Promise<void> {
  console.log('\n[setup] Cleaning prior artifacts...');
  await cleanup();

  console.log('[setup] Creating test data source + role + resources + permission + page + descriptor + pool profile');

  // Data source (active)
  await authzPool.query(
    `INSERT INTO authz_data_source (
       source_id, db_type, host, port, database_name,
       connector_user, connector_password, schemas, is_active,
       display_name, registered_by
     ) VALUES ($1, 'postgresql', $2, $3, 'nexus_data', $4, $5, ARRAY['public'], TRUE,
               'DS-CASCADE-01 e2e (auto-created, safe to delete)', 'ds-cascade-e2e')`,
    [TEST_DS_ID, PG_HOST, PG_PORT, PG_USER, encrypt(PG_PASSWORD)]
  );

  // Two resources tagged with this data source
  await authzPool.query(
    `INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
     VALUES ($1, 'table', NULL, 'DS-Cascade test table',
             jsonb_build_object('data_source_id', $2::text, 'schema', 'public'), TRUE)`,
    [TEST_TABLE_RES, TEST_DS_ID]
  );
  await authzPool.query(
    `INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
     VALUES ($1, 'column', $2, 'DS-Cascade test col',
             jsonb_build_object('data_source_id', $3::text, 'schema', 'public', 'table', '_agent_dscascade_widget'), TRUE)`,
    [TEST_COL_RES, TEST_TABLE_RES, TEST_DS_ID]
  );

  // Role + role_permission pointing at the table resource
  await authzPool.query(
    `INSERT INTO authz_role (role_id, display_name, description) VALUES ($1, 'ds-cascade test role', 'agent test')`,
    [TEST_ROLE_ID]
  );
  await authzPool.query(
    `INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect, is_active)
     VALUES ($1, $2, $3, 'allow', TRUE), ($1, $2, $4, 'deny', TRUE)`,
    [TEST_ROLE_ID, TEST_ACTION_ID, TEST_TABLE_RES, TEST_COL_RES]
  );

  // UI page + descriptor (mimics what /generate-app produces)
  await authzPool.query(
    `INSERT INTO authz_ui_page (page_id, title, layout, resource_id, data_table, columns_override, filters_config, is_active)
     VALUES ($1, 'DS-Cascade test page', 'table', $2, 'public._agent_dscascade_widget', '{}'::jsonb, '[]'::jsonb, TRUE)`,
    [TEST_PAGE_ID, TEST_TABLE_RES]
  );
  await authzPool.query(
    `INSERT INTO authz_ui_descriptor (descriptor_id, page_id, section_key, section_label, columns, render_hints, is_active)
     VALUES ($1, $2, 'default', 'Default', '[]'::jsonb, '{}'::jsonb, TRUE)`,
    [TEST_DESC_ID, TEST_PAGE_ID]
  );

  // Pool profile (existing cascade scope). No assignment needed for this test.
  await authzPool.query(
    `INSERT INTO authz_db_pool_profile (
       profile_id, pg_role, allowed_schemas, connection_mode, data_source_id, description
     ) VALUES ($1, 'role_dscascade_dummy', ARRAY['public'], 'readonly'::db_connection_mode, $2, 'agent test pool')`,
    [TEST_PROFILE_ID, TEST_DS_ID]
  );

  // Deactivate the source so /purge will accept it
  await authzPool.query(
    `UPDATE authz_data_source SET is_active = FALSE WHERE source_id = $1`,
    [TEST_DS_ID]
  );
}

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/datasources', datasourceRouter);
  return app;
}

async function main() {
  console.log('=== DS-CASCADE-01 E2E ===');

  await setup();

  console.log('\n[1/3] Spinning up in-process express app...');
  const app = buildTestApp();
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const url = `http://localhost:${port}/api/datasources/${encodeURIComponent(TEST_DS_ID)}/purge`;
  console.log(`  Listening on :${port}`);

  try {
    console.log('\n[2/3] DELETE /api/datasources/:id/purge ...');
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { 'X-User-Id': 'ds-cascade-e2e' },
    });
    const body = await resp.json() as any;
    console.log(`  Status: ${resp.status}`);
    console.log(`  Body  :`, body);

    if (resp.status !== 200) fail(`Expected 200, got ${resp.status}: ${JSON.stringify(body)}`);
    if (body.descriptors_deleted !== 1) fail(`descriptors_deleted=${body.descriptors_deleted} (expected 1)`);
    if (body.pages_deleted !== 1) fail(`pages_deleted=${body.pages_deleted} (expected 1)`);
    if (body.permissions_deleted !== 2) fail(`permissions_deleted=${body.permissions_deleted} (expected 2)`);
    if (body.columns_deleted !== 1) fail(`columns_deleted=${body.columns_deleted} (expected 1)`);
    if (body.tables_deleted !== 1) fail(`tables_deleted=${body.tables_deleted} (expected 1)`);
    if (body.profiles_deleted !== 1) fail(`profiles_deleted=${body.profiles_deleted} (expected 1)`);
    console.log('  ✓ All 6 counters match expected values');

    console.log('\n[3/3] Verify rows actually deleted from DB...');
    const remainResource = await authzPool.query(
      `SELECT resource_id FROM authz_resource WHERE resource_id IN ($1, $2)`,
      [TEST_TABLE_RES, TEST_COL_RES]
    );
    if (remainResource.rowCount !== 0) fail(`authz_resource leftovers: ${JSON.stringify(remainResource.rows)}`);

    const remainPage = await authzPool.query(`SELECT page_id FROM authz_ui_page WHERE page_id = $1`, [TEST_PAGE_ID]);
    if (remainPage.rowCount !== 0) fail(`authz_ui_page leftover: ${TEST_PAGE_ID}`);

    const remainDesc = await authzPool.query(`SELECT descriptor_id FROM authz_ui_descriptor WHERE descriptor_id = $1`, [TEST_DESC_ID]);
    if (remainDesc.rowCount !== 0) fail(`authz_ui_descriptor leftover: ${TEST_DESC_ID}`);

    const remainPerm = await authzPool.query(`SELECT id FROM authz_role_permission WHERE role_id = $1`, [TEST_ROLE_ID]);
    if (remainPerm.rowCount !== 0) fail(`authz_role_permission leftovers (role still has ${remainPerm.rowCount} perms)`);

    const remainDs = await authzPool.query(`SELECT source_id FROM authz_data_source WHERE source_id = $1`, [TEST_DS_ID]);
    if (remainDs.rowCount !== 0) fail(`authz_data_source leftover: ${TEST_DS_ID}`);

    console.log('  ✓ All cascade-deleted rows confirmed gone');

    console.log('\n=== DS-CASCADE-01 E2E PASSED ===');
  } finally {
    server.close();
    console.log('\n[teardown] Cleaning any residual artifacts...');
    await cleanup();
    await authzPool.end();
  }
}

main().catch(async err => {
  console.error('\n[ERROR]', err);
  try { await cleanup(); } catch {}
  try { await authzPool.end(); } catch {}
  process.exit(1);
});
