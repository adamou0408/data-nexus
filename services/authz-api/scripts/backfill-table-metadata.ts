// ============================================================
// Backfill authz_resource.attributes for table/view rows with
// the unified node model (inputs/outputs/side_effects/idempotent).
// Outputs are derived from existing child column resources.
//
// Usage (from services/authz-api/):
//   npx tsx scripts/backfill-table-metadata.ts
// ============================================================

import { Pool } from 'pg';
import { classifyType } from '../src/lib/function-metadata';

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '15432'),
    database: process.env.DB_NAME || 'nexus_authz',
    user: process.env.DB_USER || 'nexus_admin',
    password: process.env.DB_PASSWORD || 'nexus_dev_password',
  });

  const { rows: tables } = await pool.query(
    `SELECT resource_id, resource_type, attributes
     FROM authz_resource
     WHERE resource_type IN ('table', 'view') AND is_active = TRUE`
  );

  let updated = 0;
  let skipped = 0;

  for (const t of tables) {
    const attrs = t.attributes || {};
    // Always re-run (idempotent): keeps outputs in sync with lib fixes.

    const { rows: cols } = await pool.query(
      `SELECT resource_id, display_name, attributes
       FROM authz_resource
       WHERE resource_type = 'column' AND parent_id = $1 AND is_active = TRUE
       ORDER BY resource_id`,
      [t.resource_id]
    );

    const outputs = cols.map((c) => {
      const colName = (c.resource_id as string).split('.').pop() || c.display_name;
      const pgType = c.attributes?.data_type || 'unknown';
      return { name: colName, pgType, kind: classifyType(pgType) };
    });

    const merged = {
      ...attrs,
      node_kind: t.resource_type,
      inputs: [],
      outputs,
      side_effects: false,
      idempotent: true,
    };

    await pool.query(
      `UPDATE authz_resource SET attributes = $1::jsonb WHERE resource_id = $2`,
      [JSON.stringify(merged), t.resource_id]
    );
    updated++;
    console.log(`✓ ${t.resource_id} → outputs=${outputs.length}`);
  }

  console.log(`\nDone. Updated=${updated}  Skipped=${skipped}  Total=${tables.length}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
