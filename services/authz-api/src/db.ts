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

// Resolve which data source a table/view belongs to (via authz_resource.attributes)
export async function resolveDataSource(table: string): Promise<string | null> {
  // Try both table: and view: prefixes
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
  // Fallback: check if there's only one active data source
  const fallback = await authzPool.query(
    'SELECT source_id FROM authz_data_source WHERE is_active = TRUE LIMIT 1'
  );
  return fallback.rows.length > 0 ? fallback.rows[0].source_id : null;
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
// Local nexus_data pool — for CDC schema operations
// (CREATE SCHEMA, GRANT on CDC schemas, discovery queries)
// Separate from authzPool which points to nexus_authz.
// ============================================================

let _localDataPool: Pool | null = null;

export function getLocalDataPool(): Pool {
  if (_localDataPool) return _localDataPool;
  _localDataPool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '15432'),
    database: process.env.DATA_DB_NAME || 'nexus_data',
    user: process.env.DB_USER || 'nexus_admin',
    password: process.env.DB_PASSWORD || 'nexus_dev_password',
    max: 5,
  });
  return _localDataPool;
}

export async function getLocalDataClient(): Promise<Client> {
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
