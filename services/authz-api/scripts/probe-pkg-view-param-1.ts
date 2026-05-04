// Probe PKG_VIEW_PARAM_1 package members + GET_PARAM signature.
// Goal: discover args/return type so we can register
//   function:ps55.pkg_view_param_1.get_param
// in the seed once oracle_package support lands in oracle-direct.ts.
import { getOracleReadOnlyDriver } from '../src/lib/db-driver';

async function main() {
  const drv = await getOracleReadOnlyDriver('ds:tiptop_oracle');
  const probe = async (label: string, sql: string) => {
    try {
      const r = await drv.execute(sql, {}, { maxRows: 50 });
      console.log(`\n--- ${label} (count=${r.rowCount}) ---`);
      console.log('  columns:', r.columns.map(c => c.name).join(', '));
      for (const row of r.rows) console.log(' ', row);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`\n--- ${label} FAILED: ${msg}`);
    }
  };
  try {
    await probe(
      'PKG_VIEW_PARAM_1 members',
      `SELECT PROCEDURE_NAME, OBJECT_TYPE FROM ALL_PROCEDURES
       WHERE OWNER='PS55' AND OBJECT_NAME='PKG_VIEW_PARAM_1' ORDER BY PROCEDURE_NAME`,
    );
    await probe(
      'GET_PARAM arguments',
      `SELECT ARGUMENT_NAME, POSITION, IN_OUT, DATA_TYPE, DATA_LENGTH
       FROM ALL_ARGUMENTS
       WHERE OWNER='PS55' AND PACKAGE_NAME='PKG_VIEW_PARAM_1' AND OBJECT_NAME='GET_PARAM'
       ORDER BY POSITION`,
    );
    await probe(
      'All PKG_VIEW_PARAM_1 member arguments',
      `SELECT OBJECT_NAME, ARGUMENT_NAME, POSITION, IN_OUT, DATA_TYPE
       FROM ALL_ARGUMENTS
       WHERE OWNER='PS55' AND PACKAGE_NAME='PKG_VIEW_PARAM_1'
       ORDER BY OBJECT_NAME, POSITION`,
    );
  } finally {
    await drv.close();
  }
}

main().then(() => process.exit(0), (e) => { console.error('ERR', e?.message || e); process.exit(1); });
