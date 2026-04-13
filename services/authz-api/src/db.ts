import { Pool } from 'pg';
import { decrypt } from './lib/crypto';

// ============================================================
// AuthZ policy store — always exactly one
// ============================================================

export const authzPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
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
    'SELECT * FROM authz_data_source WHERE source_id = $1 AND is_active = TRUE',
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
    password: decrypt(ds.connector_password), // SEC-04: decrypt from DB ciphertext
    max: 5,
  });

  dataSourcePools.set(sourceId, dsPool);
  return dsPool;
}

// Resolve which data source a table belongs to (via authz_resource.attributes)
export async function resolveDataSource(table: string): Promise<string | null> {
  const result = await authzPool.query(
    `SELECT attributes->>'data_source_id' AS ds_id
     FROM authz_resource
     WHERE resource_id = $1 AND attributes ? 'data_source_id'`,
    [`table:${table}`]
  );
  if (result.rows.length > 0 && result.rows[0].ds_id) {
    return result.rows[0].ds_id;
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
