// ============================================================
// Read-only query driver abstraction (spike for Oracle direct).
//
// Why this exists:
//   Path B currently routes all SELECT/function exec through
//   pg.Pool. We want one logical resource (e.g. view:ps55.foo)
//   to be queryable against EITHER the CDC replica (Postgres)
//   OR the upstream Oracle DB, picked per-request. The driver
//   surface lets data-query callers stay db_type-agnostic.
//
// Read-only contract (Oracle):
//   getOracleReadOnlyDriver() opens a connection and immediately
//   issues `SET TRANSACTION READ ONLY`. Any DML/DDL slipped
//   through later will be rejected by Oracle itself, even if a
//   future code path forgets to validate the SQL string.
//   This is belt-and-braces — we ALSO whitelist by resource
//   attributes upstream.
// ============================================================
import oracledb from 'oracledb';
import { getOracleConnection } from '../db';

// CLOB → string globally so result rows are JSON-serialisable.
// BLOB stays as Buffer (callers that need binary deal with it
// explicitly). Set once at module load — oracledb is process-wide.
oracledb.fetchAsString = [oracledb.CLOB];

export interface DriverColumn {
  name: string;
  /** Oracle column type (e.g. "VARCHAR2", "NUMBER"). */
  type?: string;
}

export interface DriverResult {
  rows: Record<string, unknown>[];
  columns: DriverColumn[];
  rowCount: number;
  /** True when the driver capped the row set; caller should hint truncation in UI. */
  truncated: boolean;
  /** Populated when SQL is an anonymous PL/SQL block with OUT binds. */
  outBinds?: Record<string, unknown>;
}

export interface ReadOnlyDriver {
  type: 'oracle';
  /**
   * Run a SELECT or PL/SQL block. Caller is responsible for SQL
   * construction — the driver does not parse or rewrite. Identifier
   * whitelisting and parameter validation must happen upstream.
   */
  execute(
    sql: string,
    binds?: Record<string, oracledb.BindParameter> | unknown[],
    opts?: { maxRows?: number },
  ): Promise<DriverResult>;
  close(): Promise<void>;
}

const DEFAULT_MAX_ROWS = 100;
const HARD_CAP_ROWS = 1000;

export async function getOracleReadOnlyDriver(sourceId: string): Promise<ReadOnlyDriver> {
  const conn = await getOracleConnection(sourceId);

  // Belt-and-braces: even if a future code path crafts a DML string,
  // Oracle will reject it for the lifetime of this connection's
  // first transaction. This stays in effect until COMMIT/ROLLBACK,
  // and we never issue either — the connection is closed at end.
  await conn.execute('SET TRANSACTION READ ONLY');

  return {
    type: 'oracle',
    async execute(sql, binds, opts) {
      const requested = opts?.maxRows ?? DEFAULT_MAX_ROWS;
      const maxRows = Math.min(Math.max(1, requested), HARD_CAP_ROWS);
      const fetchCap = maxRows + 1;

      const result = await conn.execute(sql, binds || {}, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        maxRows: fetchCap,
      });

      const rawRows = (result.rows as Record<string, unknown>[] | undefined) || [];
      const truncated = rawRows.length > maxRows;
      const rows = truncated ? rawRows.slice(0, maxRows) : rawRows;

      const columns: DriverColumn[] = (result.metaData || []).map((m) => ({
        name: m.name,
        type: typeof m.dbTypeName === 'string' ? m.dbTypeName : undefined,
      }));

      return {
        rows, columns, rowCount: rows.length, truncated,
        outBinds: result.outBinds as Record<string, unknown> | undefined,
      };
    },
    async close() {
      await conn.close().catch(() => {});
    },
  };
}
