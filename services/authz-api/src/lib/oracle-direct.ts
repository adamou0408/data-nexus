// ============================================================
// Shared core for "oracle-direct" reads. Used by:
//   - POST /api/data-query/oracle-direct (ad-hoc query tab)
//   - POST /api/dag/execute-node when node.type === 'oracle-source'
//
// All callers MUST come through here so DS validation, resource
// whitelisting, identifier escaping, authz_check, audit, and
// READ ONLY enforcement live in one place.
// ============================================================
import oracledb from 'oracledb';
import { pool as authzPool } from '../db';
import { audit } from '../audit';
import { getOracleReadOnlyDriver } from './db-driver';
import type { DriverColumn } from './db-driver';

const MAX_ROWS = 1000;
const ORACLE_IDENT_RE = /^[A-Z][A-Z0-9_$#]*$/;
const BIND_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteOracleIdent(s: string): string {
  if (!ORACLE_IDENT_RE.test(s)) throw new OracleDirectError(400, `Invalid Oracle identifier: ${s}`);
  return '"' + s + '"';
}

export class OracleDirectError extends Error {
  constructor(public status: number, message: string, public detail?: string) {
    super(message);
  }
}

export type OracleKind = 'view' | 'table' | 'function_scalar' | 'function_table';

export interface OracleDirectInput {
  sourceId: string;
  resourceId: string;
  params?: Record<string, unknown>;
  limit?: number;
  userId: string;
  groups: string[];
  /** Optional caller tag, surfaced in audit context for forensic trail. */
  caller?: string;
}

export interface OracleDirectRowsetResult {
  kind: 'rowset';
  resourceId: string;
  resourceType: string;
  oracleKind: OracleKind;
  columns: DriverColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  maxRows: number;
  elapsedMs: number;
}

export interface OracleDirectScalarResult {
  kind: 'scalar';
  resourceId: string;
  resourceType: string;
  oracleKind: 'function_scalar';
  scalarResult: unknown;
  elapsedMs: number;
}

export type OracleDirectResult = OracleDirectRowsetResult | OracleDirectScalarResult;

/**
 * Runs an oracle-direct read against a registered resource.
 *
 * Throws OracleDirectError(status, message) for any validation/authz
 * failure — caller maps to HTTP. Anything else (driver / SQL errors)
 * surfaces as the underlying Error and should map to 500.
 */
export async function runOracleDirect(input: OracleDirectInput): Promise<OracleDirectResult> {
  const { sourceId, resourceId, params = {}, limit, userId, groups, caller } = input;

  if (!sourceId || !resourceId) {
    throw new OracleDirectError(400, 'data_source_id and resource_id are required');
  }

  // 1. DS must be Oracle + active
  const dsResult = await authzPool.query(
    `SELECT source_id FROM authz_data_source
     WHERE source_id = $1 AND is_active = TRUE AND db_type = 'oracle'`,
    [sourceId],
  );
  if (dsResult.rows.length === 0) {
    throw new OracleDirectError(404, 'Oracle data source not found or inactive');
  }

  // 2. Resource must be registered, scoped to this DS, tagged oracle_direct
  const resResult = await authzPool.query(
    `SELECT resource_id, resource_type, attributes FROM authz_resource
     WHERE resource_id = $1 AND is_active = TRUE
       AND attributes->>'data_source_id' = $2`,
    [resourceId, sourceId],
  );
  if (resResult.rows.length === 0) {
    throw new OracleDirectError(404, 'Resource not found', `${resourceId} not registered for ${sourceId}`);
  }
  const resRow = resResult.rows[0];
  const attrs = resRow.attributes || {};
  const targets: string[] = Array.isArray(attrs.available_targets) ? attrs.available_targets : [];
  if (!targets.includes('oracle_direct')) {
    throw new OracleDirectError(
      400,
      'Resource not available for oracle_direct',
      `attributes.available_targets must include "oracle_direct" (got ${JSON.stringify(targets)})`,
    );
  }

  const oracleOwner = String(attrs.oracle_owner || '').toUpperCase();
  const oracleObject = String(attrs.oracle_object || '').toUpperCase();
  const oracleKind = String(attrs.oracle_kind || '') as OracleKind;
  if (!oracleOwner || !oracleObject || !oracleKind) {
    throw new OracleDirectError(
      400,
      'Resource missing Oracle metadata',
      'attributes must include oracle_owner, oracle_object, oracle_kind',
    );
  }
  if (!ORACLE_IDENT_RE.test(oracleOwner) || !ORACLE_IDENT_RE.test(oracleObject)) {
    throw new OracleDirectError(
      400,
      'Oracle identifier rejected',
      `owner=${oracleOwner}, object=${oracleObject} must match ${ORACLE_IDENT_RE}`,
    );
  }

  // 3. Permission gate — view/table = read, function = execute
  const isFunctionKind = oracleKind === 'function_scalar' || oracleKind === 'function_table';
  const action = isFunctionKind ? 'execute' : 'read';
  const checkResult = await authzPool.query(
    'SELECT authz_check($1, $2, $3, $4) AS allowed',
    [userId, groups, action, resourceId],
  );
  if (!checkResult.rows[0].allowed) {
    audit({
      access_path: 'B', subject_id: userId,
      action_id: 'oracle_direct_query', resource_id: resourceId,
      decision: 'deny',
      context: { data_source_id: sourceId, oracle_kind: oracleKind, action, caller },
    });
    throw new OracleDirectError(403, 'Forbidden', `${userId} lacks ${action} access to ${resourceId}`);
  }

  // 4. Build SQL + binds
  const requestedLimit = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 100;
  const effectiveLimit = Math.min(Math.max(1, requestedLimit), MAX_ROWS);
  const qOwner = quoteOracleIdent(oracleOwner);
  const qObject = quoteOracleIdent(oracleObject);

  const binds: Record<string, oracledb.BindParameter> = {};
  const paramNames: string[] = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (!BIND_NAME_RE.test(k)) {
      throw new OracleDirectError(400, `Invalid bind name: ${k}`);
    }
    paramNames.push(k);
    binds[k] = { val: v as number | string | Date | null, dir: oracledb.BIND_IN };
  }

  let sql: string;
  let isPlsql = false;
  if (oracleKind === 'view' || oracleKind === 'table') {
    sql = `SELECT * FROM ${qOwner}.${qObject} FETCH FIRST ${effectiveLimit} ROWS ONLY`;
  } else if (oracleKind === 'function_table') {
    const argList = paramNames.map((p) => `:${p}`).join(', ');
    sql = `SELECT * FROM TABLE(${qOwner}.${qObject}(${argList})) FETCH FIRST ${effectiveLimit} ROWS ONLY`;
  } else if (oracleKind === 'function_scalar') {
    const argList = paramNames.map((p) => `:${p}`).join(', ');
    binds['__result__'] = { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 };
    sql = `BEGIN :__result__ := ${qOwner}.${qObject}(${argList}); END;`;
    isPlsql = true;
  } else {
    throw new OracleDirectError(
      400,
      'Unsupported oracle_kind',
      `${oracleKind} not in {view, table, function_scalar, function_table}`,
    );
  }

  // 5. Execute through the read-only driver
  const driver = await getOracleReadOnlyDriver(sourceId);
  const t0 = Date.now();
  try {
    const result = await driver.execute(sql, binds, { maxRows: effectiveLimit });
    const elapsedMs = Date.now() - t0;

    const auditCtx = isPlsql
      ? { data_source_id: sourceId, oracle_kind: oracleKind, elapsed_ms: elapsedMs, caller }
      : {
          data_source_id: sourceId, oracle_kind: oracleKind,
          row_count: result.rowCount, truncated: result.truncated, elapsed_ms: elapsedMs, caller,
        };
    audit({
      access_path: 'B', subject_id: userId,
      action_id: 'oracle_direct_query', resource_id: resourceId,
      decision: 'allow', context: auditCtx,
    });

    if (isPlsql) {
      const out = (result.outBinds as { __result__?: unknown } | undefined)?.__result__ ?? null;
      return {
        kind: 'scalar',
        resourceId,
        resourceType: resRow.resource_type,
        oracleKind: 'function_scalar',
        scalarResult: out,
        elapsedMs,
      };
    }
    return {
      kind: 'rowset',
      resourceId,
      resourceType: resRow.resource_type,
      oracleKind: oracleKind as Exclude<OracleKind, 'function_scalar'>,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      maxRows: effectiveLimit,
      elapsedMs,
    };
  } finally {
    await driver.close();
  }
}
