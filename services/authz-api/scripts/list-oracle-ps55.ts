// Probe view readability + GET_ABMQ501 row-shape (NULL args, just to fetch metadata).
import { getOracleReadOnlyDriver } from '../src/lib/db-driver';

async function main() {
  const drv = await getOracleReadOnlyDriver('ds:tiptop_oracle');
  const tryQuery = async (label: string, sql: string, binds: Record<string, unknown> = {}) => {
    try {
      const r = await drv.execute(sql, binds, { maxRows: 5 });
      console.log(`\n--- ${label} (count=${r.rowCount}${r.truncated ? ', TRUNCATED' : ''}) ---`);
      console.log('  columns:', r.columns.map(c => `${c.name}:${c.type}`).join(', '));
      for (const row of r.rows) console.log(' ', row);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`\n--- ${label} FAILED: ${msg}`);
    }
  };

  try {
    // Probe several views — find one readable + columns
    for (const v of ['V002', 'V003', 'V004', 'V025', 'V146']) {
      await tryQuery(`PS55.${v} sample`, `SELECT * FROM PS55.${v} FETCH FIRST 3 ROWS ONLY`);
    }
    // GET_ABMQ501 metadata-only (NULL args — likely returns empty but shows columns)
    await tryQuery('GET_ABMQ501 column shape', `SELECT * FROM TABLE(PS55.GET_ABMQ501(NULL, NULL, NULL, NULL)) FETCH FIRST 1 ROWS ONLY`);
  } finally {
    await drv.close();
  }
}

main().then(() => process.exit(0), (e) => { console.error('ERR', e?.message || e); process.exit(1); });
