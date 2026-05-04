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

// ── Logical type layer (cross-db-tier-b-integration §L1).
// 9 DB-agnostic types + `unknown` fallback. Source-of-truth for
// type compatibility checks at DAG edges. PG OIDs and Oracle type
// strings both map into this enum so frame interchange is uniform.
export type LogicalType =
  | 'string' | 'int64' | 'decimal' | 'float64'
  | 'bool' | 'date' | 'timestamp' | 'bytes' | 'json' | 'unknown';

// PG type OIDs from `pg_type.oid`. Covers the common cases the
// composer encounters; unknown OIDs surface as 'unknown' so edges
// reject explicitly rather than silently mistype.
const PG_OID_TO_LOGICAL: Record<number, LogicalType> = {
  16: 'bool',
  17: 'bytes',
  20: 'int64',  // int8
  21: 'int64',  // int2
  23: 'int64',  // int4
  25: 'string', // text
  114: 'json',
  700: 'float64', // float4
  701: 'float64', // float8
  1042: 'string', // bpchar
  1043: 'string', // varchar
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamp', // timestamptz
  1700: 'decimal',   // numeric
  3802: 'json',      // jsonb
};

export function pgTypeToLogical(oid: number): LogicalType {
  return PG_OID_TO_LOGICAL[oid] ?? 'unknown';
}

// Oracle type strings come from `dbTypeName`. NUMBER without
// scale could be int or decimal — we conservatively return
// 'decimal' (no precision loss). Curators who know it's an int
// can cast via the cast operator.
export function oracleTypeToLogical(t: string | undefined): LogicalType {
  if (!t) return 'unknown';
  const u = t.toUpperCase();
  if (u === 'VARCHAR2' || u === 'CHAR' || u === 'NVARCHAR2' || u === 'NCHAR' ||
      u === 'CLOB' || u === 'NCLOB' || u === 'LONG' || u === 'ROWID') return 'string';
  if (u.startsWith('VARCHAR') || u.startsWith('CHAR')) return 'string';
  if (u === 'NUMBER' || u.startsWith('NUMBER')) return 'decimal';
  if (u === 'BINARY_FLOAT' || u === 'BINARY_DOUBLE' || u === 'FLOAT') return 'float64';
  if (u === 'DATE') return 'date';
  if (u.startsWith('TIMESTAMP')) return 'timestamp';
  if (u === 'BLOB' || u === 'RAW' || u === 'LONG RAW') return 'bytes';
  // INTERVAL, JSON-as-CLOB, etc. — conservative fallback to string
  if (u.startsWith('INTERVAL')) return 'string';
  return 'unknown';
}

export interface DriverColumn {
  name: string;
  /** Native column type as the driver reports it (e.g. PG "text", Oracle "VARCHAR2"). Kept for inspector display. */
  type?: string;
  /** DB-agnostic logical type for cross-DB frame interchange. Always populated. */
  logical_type: LogicalType;
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

      const columns: DriverColumn[] = (result.metaData || []).map((m) => {
        const oracleType = typeof m.dbTypeName === 'string' ? m.dbTypeName : undefined;
        return {
          name: m.name,
          type: oracleType,
          logical_type: oracleTypeToLogical(oracleType),
        };
      });

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
