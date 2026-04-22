// ============================================================
// Backfill authz_resource.attributes with structured function metadata.
// Idempotent: only updates rows missing parsed_args/return_shape/subtype.
//
// Usage (from services/authz-api/):
//   npx tsx scripts/backfill-function-metadata.ts
// ============================================================

import { Pool } from 'pg';
import { extractFunctionMetadata } from '../src/lib/function-metadata';

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
  let skipped = 0;

  for (const r of rows) {
    const attrs = r.attributes || {};

    // Always re-run (idempotent): keeps parsed data in sync with lib fixes.

    const rid = r.resource_id as string;
    const schemaAndName = rid.startsWith('function:') ? rid.slice('function:'.length) : rid;
    const name = schemaAndName.split('.').pop() || schemaAndName;

    const meta = extractFunctionMetadata({
      name,
      arguments: attrs.arguments || '',
      return_type: attrs.return_type || '',
      volatility: (attrs.volatility || 'VOLATILE') as 'IMMUTABLE' | 'STABLE' | 'VOLATILE',
    });

    const merged = {
      ...attrs,
      parsed_args: meta.parsed_args,
      return_shape: meta.return_shape,
      subtype: meta.subtype,
      idempotent: meta.idempotent,
      side_effects: meta.side_effects,
    };

    await pool.query(
      `UPDATE authz_resource SET attributes = $1::jsonb WHERE resource_id = $2`,
      [JSON.stringify(merged), rid]
    );
    updated++;
    console.log(`✓ ${rid} → subtype=${meta.subtype}, shape=${meta.return_shape.shape}`);
  }

  console.log(`\nDone. Updated=${updated}  Skipped=${skipped}  Total=${rows.length}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
