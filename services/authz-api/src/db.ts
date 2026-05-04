import { Pool, Client } from 'pg';
import oracledb from 'oracledb';
import { decrypt } from './lib/crypto';

// ============================================================
// AuthZ policy store — always exactly one
// ============================================================

export const authzPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '15432'),
  database: process.env.DB_NAME || 'nexus_authz',
  user: process.env.DB_USER || 'nexus_admin',
  password: process.env.DB_PASSWORD || 'nexus_dev_password',
  max: 10,
});

// Backward compatibility — existing routes import { pool }
export const pool = authzPool;

// ============================================================
// Dynamic data source pools — created on demand, cached
// ============================================================

const dataSourcePools = new Map<string, Pool>();

export async function getDataSourcePool(sourceId: string): Promise<Pool> {
  const existing = dataSourcePools.get(sourceId);
  if (existing) return existing;

  const result = await authzPool.query(
    'SELECT host, port, database_name, connector_user, connector_password FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
    [sourceId]
  );
  if (result.rows.length === 0) {
    throw new Error(`Data source not found or inactive: ${sourceId}`);
  }

  const ds = result.rows[0];
  const dsPool = new Pool({
    host: ds.host,
    port: ds.port,
    database: ds.database_name,
    user: ds.connector_user,
    ...(ds.connector_password ? { password: decrypt(ds.connector_password) } : {}),
    max: 5,
  });

  dataSourcePools.set(sourceId, dsPool);
  return dsPool;
}

// Single client connection for DDL operations (caller must call client.end())
export async function getDataSourceClient(sourceId: string): Promise<Client> {
  const result = await authzPool.query(
    'SELECT host, port, database_name, connector_user, connector_password FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
    [sourceId]
  );
  if (result.rows.length === 0) {
    throw new Error(`Data source not found or inactive: ${sourceId}`);
  }
  const ds = result.rows[0];
  const client = new Client({
    host: ds.host,
    port: ds.port,
    database: ds.database_name,
    user: ds.connector_user,
    ...(ds.connector_password ? { password: decrypt(ds.connector_password) } : {}),
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  await client.query('SET statement_timeout = \'30s\'');
  return client;
}

// Resolve which remote data source a table/view belongs to via
// authz_resource.attributes->>'data_source_id'. Returns null when the
// resource is not registered against any remote source.
//
// Post-ARCH-02 (2026-05-04): query-path callers (browse-read,
// config-exec, rls-simulate) MUST treat null as a 400-level error and
// require an explicit data_source_id from the client. The previous
// "fall back to nexus_data" behaviour was removed because it tied
// query routing to an internal DB that holds CDC sinks rather than
// authoritative business data.
//
// Historical "first active datasource" fallback was removed earlier:
// it made behaviour depend on registration order and would silently
// route an unmapped table to an unrelated remote DB.
export async function resolveDataSource(table: string): Promise<string | null> {
  for (const prefix of ['table', 'view']) {
    const result = await authzPool.query(
      `SELECT attributes->>'data_source_id' AS ds_id
       FROM authz_resource
       WHERE resource_id = $1 AND attributes ? 'data_source_id'`,
      [`${prefix}:${table}`]
    );
    if (result.rows.length > 0 && result.rows[0].ds_id) {
      return result.rows[0].ds_id;
    }
  }
  return null;
}

// Close a cached data source pool (e.g., when DS is updated or deactivated)
export function evictDataSourcePool(sourceId: string): void {
  const existing = dataSourcePools.get(sourceId);
  if (existing) {
    existing.end();
    dataSourcePools.delete(sourceId);
  }
}

// ============================================================
// Internal nexus_data pool — INFRASTRUCTURE ONLY
//
// Strictly for operations on the internal nexus_data DB (separate
// from nexus_authz):
//   - Oracle CDC schema setup (CREATE SCHEMA _cdc_*, GRANT on CDC schemas)
//   - DAG sink table provisioning
//   - Path C native role infra (PG-side roles for RLS demos)
//
// MUST NOT be used by query-path routes (browse-read, config-exec,
// rls-simulate, data-explorer). Those routes route via
// getDataSourcePool(data_source_id) and reject requests with no
// data_source_id (HTTP 400). Removed 2026-05-04 (ARCH-02): the
// "免註冊 fallback" that silently used this pool when no DS was
// supplied — it was load-bearing in routes that should never have
// touched the internal DB.
//
// Renamed 2026-05-04 from getLocalDataPool / getLocalDataClient
// to make the "internal infra DB" intent explicit at the call site.
// ============================================================

let _internalDataPool: Pool | null = null;

export function getInternalDataPool(): Pool {
  if (_internalDataPool) return _internalDataPool;
  _internalDataPool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '15432'),
    database: process.env.DATA_DB_NAME || 'nexus_data',
    user: process.env.DB_USER || 'nexus_admin',
    password: process.env.DB_PASSWORD || 'nexus_dev_password',
    max: 5,
  });
  return _internalDataPool;
}

export async function getInternalDataClient(): Promise<Client> {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '15432'),
    database: process.env.DATA_DB_NAME || 'nexus_data',
    user: process.env.DB_USER || 'nexus_admin',
    password: process.env.DB_PASSWORD || 'nexus_dev_password',
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  await client.query("SET statement_timeout = '30s'");
  return client;
}

// ============================================================
// Oracle connection — thin client (pure JS, no Oracle Client)
// Used exclusively for function call proxy (/api/oracle-exec)
// and Oracle function discovery during schema scan.
// ============================================================

interface OracleConnectionInfo {
  host: string;
  port: number;
  service_name: string;
  user: string;
  password_enc: string;
}

export async function getOracleConnection(sourceId: string): Promise<oracledb.Connection> {
  const result = await authzPool.query(
    'SELECT oracle_connection FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE AND db_type = $2',
    [sourceId, 'oracle']
  );
  if (result.rows.length === 0) {
    throw new Error(`Oracle data source not found or inactive: ${sourceId}`);
  }
  const info: OracleConnectionInfo = result.rows[0].oracle_connection;
  if (!info || !info.host || !info.service_name) {
    throw new Error(`Oracle connection info missing for data source: ${sourceId}`);
  }

  const password = decrypt(info.password_enc);
  const connection = await oracledb.getConnection({
    user: info.user,
    password,
    connectString: `${info.host}:${info.port}/${info.service_name}`,
  });
  return connection;
}
