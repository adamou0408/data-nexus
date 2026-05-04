import { Router } from 'express';
import oracledb from 'oracledb';
import { pool as authzPool, getDataSourcePool, getDataSourceClient } from '../db';
import { audit } from '../audit';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';
import {
  parseFunctionArgs,
  parseReturnType,
  classifySubtype,
  extractFunctionMetadata,
  classifyType,
} from '../lib/function-metadata';
import { lintFunction } from '../lib/fn-quality-lint';
import { getOracleReadOnlyDriver } from '../lib/db-driver';

export const dataQueryRouter = Router();

const MAX_ROWS = 1000;

const ORACLE_IDENT_RE = /^[A-Z][A-Z0-9_$#]*$/;
const BIND_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteOracleIdent(s: string): string {
  if (!ORACLE_IDENT_RE.test(s)) {
    throw new Error(`Invalid Oracle identifier: ${s}`);
  }
  // Oracle quoted identifiers preserve case and disallow embedded ".
  // Whitelist already excludes ", so direct interpolation is safe.
  return '"' + s + '"';
}

function quoteIdent(s: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(`Invalid identifier: ${s}`);
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

// ─── List tables in a data source, with output columns (unified node model) ───
dataQueryRouter.get('/tables', async (req, res) => {
  const dsId = req.query.data_source_id as string;
  if (!dsId) return res.status(400).json({ error: 'data_source_id is required' });
  try {
    const result = await authzPool.query(
      `SELECT resource_id, resource_type, display_name, attributes
       FROM authz_resource
       WHERE resource_type IN ('table', 'view') AND is_active = TRUE
         AND attributes->>'data_source_id' = $1
       ORDER BY resource_id`,
      [dsId]
    );
    const tables = result.rows.map(r => {
      const rid = r.resource_id as string;
      const baseName = rid.replace(/^(table|view):/, '');
      const attrs = r.attributes || {};
      return {
        resource_id: rid,
        resource_type: r.resource_type,
        table_schema: attrs.table_schema,
        table_name: baseName,
        display_name: r.display_name,
        table_comment: attrs.table_comment || null,
        outputs: attrs.outputs || [],
        output_count: (attrs.outputs || []).length,
      };
    });
    res.json(tables);
  } catch (err) {
    handleApiError(res, err);
  }
});

dataQueryRouter.get('/functions', async (req, res) => {
  const dsId = req.query.data_source_id as string;
  if (!dsId) return res.status(400).json({ error: 'data_source_id is required' });
  try {
    const result = await authzPool.query(
      `SELECT resource_id, display_name, attributes
       FROM authz_resource
       WHERE resource_type = 'function' AND is_active = TRUE
         AND attributes->>'data_source_id' = $1
       ORDER BY resource_id`,
      [dsId]
    );
    const functions = result.rows.map(r => {
      const rid = r.resource_id as string;
      const schemaAndName = rid.startsWith('function:') ? rid.slice('function:'.length) : rid;
      const [schema, name] = schemaAndName.split('.');
      const attrs = r.attributes || {};
      const argsStr = attrs.arguments || '';
      const retStr = attrs.return_type || '';
      const volatility = (attrs.volatility || 'VOLATILE') as 'IMMUTABLE' | 'STABLE' | 'VOLATILE';

      // Prefer cached parsed metadata; fall back to on-the-fly parsing for legacy rows.
      const parsed_args = attrs.parsed_args || parseFunctionArgs(argsStr);
      const return_shape = attrs.return_shape || parseReturnType(retStr);
      const subtype = attrs.subtype || classifySubtype({ name, volatility, returnShape: return_shape });

      return {
        resource_id: rid,
        schema,
        function_name: name,
        display_name: r.display_name,
        arguments: argsStr,
        parsed_args,
        return_type: retStr,
        return_shape,
        volatility,
        subtype,
        idempotent: attrs.idempotent ?? (volatility !== 'VOLATILE'),
        side_effects: attrs.side_effects ?? (subtype === 'action'),
      };
    });
    res.json(functions);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Compatible functions: given a set of semantic output types, list fns whose
// required inputs are all coverable by them. Used by DAG canvas "next step" hint.
dataQueryRouter.post('/functions/compatible', async (req, res) => {
  const { data_source_id, available_semantic_types = [] } = req.body as {
    data_source_id: string;
    available_semantic_types: string[];
  };
  if (!data_source_id) return res.status(400).json({ error: 'data_source_id is required' });
  const available = new Set((available_semantic_types || []).filter(Boolean));

  try {
    const result = await authzPool.query(
      `SELECT resource_id, display_name, attributes
       FROM authz_resource
       WHERE resource_type = 'function' AND is_active = TRUE
         AND attributes->>'data_source_id' = $1
       ORDER BY resource_id`,
      [data_source_id]
    );

    const candidates = result.rows.map((r) => {
      const attrs = r.attributes || {};
      const inputs: Array<{ name: string; semantic_type?: string; hasDefault?: boolean; kind?: string }> =
        attrs.inputs || attrs.parsed_args || [];
      const outputs: Array<{ name: string; semantic_type?: string; kind?: string }> =
        attrs.outputs || [];

      const required = inputs.filter((i) => !i.hasDefault);
      const requiredSemTypes = required
        .map((i) => i.semantic_type)
        .filter((t): t is string => !!t && t !== 'unknown');
      const missing = requiredSemTypes.filter((t) => !available.has(t));
      const covered = requiredSemTypes.filter((t) => available.has(t));
      const allCovered = required.length === 0 || missing.length === 0;
      // A function is compatible only if at least one required input matches an
      // available upstream type. Otherwise it's usable standalone, not downstream.
      const bindable = covered.length > 0;

      return {
        resource_id: r.resource_id,
        display_name: r.display_name,
        subtype: attrs.subtype,
        required_inputs: required.map((i) => ({ name: i.name, semantic_type: i.semantic_type })),
        optional_inputs: inputs.filter((i) => i.hasDefault).map((i) => ({ name: i.name, semantic_type: i.semantic_type })),
        outputs: outputs.map((o) => ({ name: o.name, semantic_type: o.semantic_type })),
        covered_inputs: covered,
        missing_inputs: missing,
        all_required_covered: allCovered,
        bindable,
      };
    });

    const compatible = candidates.filter((c) => c.bindable && c.all_required_covered);
    const partial = candidates.filter((c) => c.bindable && !c.all_required_covered);

    res.json({ compatible, partial, total_scanned: candidates.length });
  } catch (err) {
    handleApiError(res, err);
  }
});

dataQueryRouter.post('/functions/exec', async (req, res) => {
  const { data_source_id, resource_id, params = {} } = req.body as {
    data_source_id: string;
    resource_id: string;
    params: Record<string, unknown>;
  };
  const userId = getUserId(req);
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);

  if (!data_source_id || !resource_id) {
    return res.status(400).json({ error: 'data_source_id and resource_id are required' });
  }

  try {
    const dsResult = await authzPool.query(
      `SELECT source_id, db_type FROM authz_data_source
       WHERE source_id = $1 AND is_active = TRUE`,
      [data_source_id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Data source not found or inactive' });
    }
    const ds = dsResult.rows[0];
    if (ds.db_type === 'oracle') {
      return res.status(400).json({ error: 'Oracle data sources use /api/oracle-exec' });
    }

    const whitelistResult = await authzPool.query(
      `SELECT resource_id, attributes FROM authz_resource
       WHERE resource_id = $1 AND resource_type = 'function' AND is_active = TRUE
         AND attributes->>'data_source_id' = $2`,
      [resource_id, data_source_id]
    );
    if (whitelistResult.rows.length === 0) {
      return res.status(400).json({
        error: 'Function not in whitelist',
        detail: `${resource_id} not registered for ${data_source_id}. Run discovery first.`,
      });
    }
    const fnRow = whitelistResult.rows[0];
    const parsedArgs = parseFunctionArgs(fnRow.attributes?.arguments || '');

    const checkResult = await authzPool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [userId, groups, 'execute', resource_id]
    );
    if (!checkResult.rows[0].allowed) {
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'data_function_call', resource_id,
        decision: 'deny', context: { data_source_id },
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: `${userId} lacks execute access to ${resource_id}`,
      });
    }

    const schemaAndName = resource_id.slice('function:'.length);
    const [schema, fnName] = schemaAndName.split('.');
    const qSchema = quoteIdent(schema);
    const qFn = quoteIdent(fnName);

    // Use named notation (p_x := $n) so we can skip defaulted params without
    // emitting literal DEFAULT — Greenplum/PG reject DEFAULT in SELECT context.
    const values: unknown[] = [];
    const bindList: string[] = [];
    for (const arg of parsedArgs) {
      const supplied = Object.prototype.hasOwnProperty.call(params, arg.name);
      if (!supplied && !arg.hasDefault) {
        return res.status(400).json({ error: `Missing required parameter: ${arg.name}` });
      }
      if (!supplied) continue; // let PG apply the DEFAULT
      values.push(params[arg.name]);
      bindList.push(`${quoteIdent(arg.name)} := $${values.length}`);
    }

    const sql = `SELECT * FROM (SELECT * FROM ${qSchema}.${qFn}(${bindList.join(', ')})) _inner LIMIT ${MAX_ROWS + 1}`;

    const dsPool = await getDataSourcePool(data_source_id);
    const t0 = Date.now();
    let queryResult;
    try {
      queryResult = await dsPool.query(sql, values);
    } catch (err: any) {
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'data_function_call', resource_id,
        decision: 'deny', context: { data_source_id, error: err.message },
      });
      return res.status(500).json({ error: 'Execution failed', detail: err.message });
    }
    const elapsedMs = Date.now() - t0;

    const truncated = queryResult.rowCount ? queryResult.rowCount > MAX_ROWS : false;
    const rows = truncated ? queryResult.rows.slice(0, MAX_ROWS) : queryResult.rows;
    const columns = queryResult.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID }));

    audit({
      access_path: 'B', subject_id: userId,
      action_id: 'data_function_call', resource_id,
      decision: 'allow',
      context: { data_source_id, param_count: parsedArgs.length, row_count: rows.length, elapsed_ms: elapsedMs },
    });
    logAdminAction(authzPool, {
      userId, action: 'DATA_FUNCTION_CALL',
      resourceType: 'function', resourceId: resource_id,
      details: { data_source_id, param_count: parsedArgs.length, row_count: rows.length, elapsed_ms: elapsedMs },
      ip: getClientIp(req),
    });

    res.json({
      status: 'ok',
      resource_id,
      columns,
      rows,
      row_count: rows.length,
      truncated,
      max_rows: MAX_ROWS,
      elapsed_ms: elapsedMs,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Oracle direct query (read-only) ───
// Spike: query an Oracle view / scalar function / pipelined function
// without going through the CDC replica. Resource must carry
//   attributes.available_targets ∋ "oracle_direct"
//   attributes.oracle_owner   (uppercase Oracle schema)
//   attributes.oracle_object  (uppercase object name)
//   attributes.oracle_kind    ∈ {view, table, function_scalar, function_table}
//
// Read-only is enforced at three layers:
//   1. Resource whitelist — only seeded objects are reachable.
//   2. Identifier regex — ^[A-Z][A-Z0-9_$#]*$ on owner + object.
//   3. SET TRANSACTION READ ONLY — Oracle rejects DML on this conn
//      regardless of what the SQL string says.
//
// We never accept user-supplied SQL strings here. Bind values are
// passed through oracledb named binds.
dataQueryRouter.post('/oracle-direct', async (req, res) => {
  const { data_source_id, resource_id, params = {}, limit } = req.body as {
    data_source_id?: string;
    resource_id?: string;
    params?: Record<string, unknown>;
    limit?: number;
  };
  const userId = getUserId(req);
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);

  if (!data_source_id || !resource_id) {
    return res.status(400).json({ error: 'data_source_id and resource_id are required' });
  }

  try {
    // 1. DS must be Oracle + active
    const dsResult = await authzPool.query(
      `SELECT source_id, db_type FROM authz_data_source
       WHERE source_id = $1 AND is_active = TRUE AND db_type = 'oracle'`,
      [data_source_id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Oracle data source not found or inactive' });
    }

    // 2. Resource must be registered, scoped to this DS, and tagged oracle_direct
    const resResult = await authzPool.query(
      `SELECT resource_id, resource_type, attributes FROM authz_resource
       WHERE resource_id = $1 AND is_active = TRUE
         AND attributes->>'data_source_id' = $2`,
      [resource_id, data_source_id]
    );
    if (resResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Resource not found',
        detail: `${resource_id} not registered for ${data_source_id}`,
      });
    }
    const resRow = resResult.rows[0];
    const attrs = resRow.attributes || {};
    const targets: string[] = Array.isArray(attrs.available_targets) ? attrs.available_targets : [];
    if (!targets.includes('oracle_direct')) {
      return res.status(400).json({
        error: 'Resource not available for oracle_direct',
        detail: `attributes.available_targets must include "oracle_direct" (got ${JSON.stringify(targets)})`,
      });
    }

    const oracleOwner = String(attrs.oracle_owner || '').toUpperCase();
    const oracleObject = String(attrs.oracle_object || '').toUpperCase();
    const oracleKind = String(attrs.oracle_kind || '');
    if (!oracleOwner || !oracleObject || !oracleKind) {
      return res.status(400).json({
        error: 'Resource missing Oracle metadata',
        detail: 'attributes must include oracle_owner, oracle_object, oracle_kind',
      });
    }
    if (!ORACLE_IDENT_RE.test(oracleOwner) || !ORACLE_IDENT_RE.test(oracleObject)) {
      return res.status(400).json({
        error: 'Oracle identifier rejected',
        detail: `owner=${oracleOwner}, object=${oracleObject} must match ${ORACLE_IDENT_RE}`,
      });
    }

    // 3. Permission gate — view/table = select, function = execute
    const isFunctionKind = oracleKind === 'function_scalar' || oracleKind === 'function_table';
    const action = isFunctionKind ? 'execute' : 'select';
    const checkResult = await authzPool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [userId, groups, action, resource_id]
    );
    if (!checkResult.rows[0].allowed) {
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'oracle_direct_query', resource_id,
        decision: 'deny', context: { data_source_id, oracle_kind: oracleKind, action },
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: `${userId} lacks ${action} access to ${resource_id}`,
      });
    }

    // 4. Build SQL + binds. Identifiers are whitelisted; values pass through binds.
    const requestedLimit = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 100;
    const effectiveLimit = Math.min(Math.max(1, requestedLimit), MAX_ROWS);

    const qOwner = quoteOracleIdent(oracleOwner);
    const qObject = quoteOracleIdent(oracleObject);

    // Validate bind names — only alnum + underscore, can't begin with digit.
    const binds: Record<string, oracledb.BindParameter> = {};
    const paramNames: string[] = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (!BIND_NAME_RE.test(k)) {
        return res.status(400).json({ error: `Invalid bind name: ${k}` });
      }
      paramNames.push(k);
      binds[k] = { val: v as number | string | Date | null, dir: oracledb.BIND_IN };
    }

    let sql: string;
    let isPlsql = false;
    if (oracleKind === 'view' || oracleKind === 'table') {
      // FETCH FIRST is supported on Oracle 12c+; tiptop_oracle is 19c.
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
      return res.status(400).json({
        error: 'Unsupported oracle_kind',
        detail: `${oracleKind} not in {view, table, function_scalar, function_table}`,
      });
    }

    // 5. Execute through the read-only driver. SELECT and PL/SQL share one
    //    connection (driver sets TRANSACTION READ ONLY once on open).
    const driver = await getOracleReadOnlyDriver(data_source_id);
    const t0 = Date.now();
    try {
      const result = await driver.execute(sql, binds, { maxRows: effectiveLimit });
      const elapsedMs = Date.now() - t0;

      const auditCtx = isPlsql
        ? { data_source_id, oracle_kind: oracleKind, elapsed_ms: elapsedMs }
        : {
            data_source_id, oracle_kind: oracleKind,
            row_count: result.rowCount, truncated: result.truncated, elapsed_ms: elapsedMs,
          };
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'oracle_direct_query', resource_id,
        decision: 'allow', context: auditCtx,
      });
      logAdminAction(authzPool, {
        userId, action: 'ORACLE_DIRECT_QUERY',
        resourceType: resRow.resource_type, resourceId: resource_id,
        details: auditCtx,
        ip: getClientIp(req),
      });

      if (isPlsql) {
        const out = (result.outBinds as { __result__?: unknown } | undefined)?.__result__ ?? null;
        return res.json({
          status: 'ok',
          resource_id,
          target: 'oracle_direct',
          oracle_kind: oracleKind,
          scalar_result: out,
          elapsed_ms: elapsedMs,
        });
      }
      return res.json({
        status: 'ok',
        resource_id,
        target: 'oracle_direct',
        oracle_kind: oracleKind,
        columns: result.columns,
        rows: result.rows,
        row_count: result.rowCount,
        truncated: result.truncated,
        max_rows: effectiveLimit,
        elapsed_ms: elapsedMs,
      });
    } finally {
      await driver.close();
    }
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Fetch live DDL for a deployed function ───
// Lets curators load a deployed fn back into AuthorPanel for Edit / Duplicate.
// Closes the "AI Refine needs current_sql" loop — admin can pull the on-disk
// body, hand it to AI Refine, deploy a revised version.
//
// Permissioning is stricter than exec: in addition to authz_check(execute),
// the caller must hold DATA_STEWARD (SYSADMIN bypasses). DDL exposes business
// rules embedded in the body (joins, filtering predicates) — exec only
// exposes output rows that already pass column-mask. Stricter gate justified.
//
// Errors:
//   404 'resource not found / inactive'           — no row in authz_resource
//   404 { error: 'orphaned' }                     — pg_proc row dropped on remote
//   422 { error: 'cannot_serialize_function' }    — pg_get_functiondef raises 42704
//   403                                           — non-steward, or no execute permission
dataQueryRouter.get('/functions/:resource_id/ddl', async (req, res) => {
  const resource_id = req.params.resource_id;
  const dsId = req.query.data_source_id as string;
  const userId = getUserId(req);
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);

  if (!dsId) return res.status(400).json({ error: 'data_source_id is required' });

  try {
    // Resource lookup — same shape as /functions/exec
    const resRow = await authzPool.query(
      `SELECT resource_id, attributes
         FROM authz_resource
        WHERE resource_id = $1
          AND resource_type = 'function'
          AND is_active = TRUE
          AND attributes->>'data_source_id' = $2`,
      [resource_id, dsId]
    );
    if (resRow.rows.length === 0) {
      return res.status(404).json({ error: 'Function not found or inactive' });
    }

    // execute permission gate (mirrors /functions/exec line ~210)
    const checkResult = await authzPool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [userId, groups, 'execute', resource_id]
    );
    if (!checkResult.rows[0].allowed) {
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'data_function_ddl', resource_id,
        decision: 'deny', context: { data_source_id: dsId, reason: 'no_execute_permission' },
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: `${userId} lacks execute access to ${resource_id}`,
      });
    }

    // Steward role gate (DDL > exec sensitivity). SYSADMIN bypasses (mirrors requireRole).
    const rolesRes = await authzPool.query(
      'SELECT _authz_resolve_roles($1, $2) AS roles',
      [userId, groups]
    );
    const userRoles: string[] = rolesRes.rows[0]?.roles || [];
    const isSysadmin = userRoles.includes('SYSADMIN');
    const isSteward = userRoles.includes('DATA_STEWARD');
    if (!isSysadmin && !isSteward) {
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'data_function_ddl', resource_id,
        decision: 'deny', context: { data_source_id: dsId, reason: 'role_check_failed', user_roles: userRoles },
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'Requires role: DATA_STEWARD',
      });
    }

    // Parse (schema, function_name) from resource_id (function:schema.name)
    const fq = resource_id.startsWith('function:') ? resource_id.slice('function:'.length) : resource_id;
    const dot = fq.indexOf('.');
    const schema = dot > 0 ? fq.slice(0, dot) : 'public';
    const function_name = dot > 0 ? fq.slice(dot + 1) : fq;

    // Connect to remote DS, fetch pg_get_functiondef
    const dsPool = await getDataSourcePool(dsId);
    let defRow;
    try {
      defRow = await dsPool.query(
        `SELECT pg_get_functiondef(p.oid) AS def
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = $2`,
        [schema, function_name]
      );
    } catch (err: any) {
      if (err && err.code === '42704') {
        return res.status(422).json({
          error: 'cannot_serialize_function',
          detail: 'pg_get_functiondef rejected this function (likely an extension type it cannot serialize). Fetch the DDL manually from the remote DB.',
        });
      }
      throw err;
    }

    if (defRow.rows.length === 0) {
      // Resource is registered but pg_proc row gone — orphaned registry entry.
      return res.status(404).json({
        error: 'orphaned',
        detail: `${schema}.${function_name} is registered in authz_resource but no longer exists in pg_proc. Re-run discovery or delete the registry entry.`,
      });
    }

    audit({
      access_path: 'B', subject_id: userId,
      action_id: 'data_function_ddl', resource_id,
      decision: 'allow', context: { data_source_id: dsId },
    });

    res.json({
      resource_id,
      schema,
      function_name,
      ddl: defRow.rows[0].def as string,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Validate-only: parse SQL + run through target DB without committing ───
const CREATE_FN_RE = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i;

function stripLeadingSqlComments(sql: string): string {
  let out = sql;
  while (true) {
    const trimmed = out.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      out = nl === -1 ? '' : trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      out = end === -1 ? '' : trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

function parseCreateFunctionHeader(sql: string): { schema: string; function_name: string } | null {
  const stripped = stripLeadingSqlComments(sql);
  const m = stripped.match(CREATE_FN_RE);
  if (!m) return null;
  return { schema: m[1] || 'public', function_name: m[2] };
}

// ─── Lint-all: per-fn quality summary for the deployed catalog ───
// Single batch query against the data source's pg_proc → pg_get_functiondef
// for every registered fn, then runs the same lint rules used by /lint.
//
// One round-trip per data source is enough (N rows back, not N queries),
// so even a few hundred fns stays well under a second. Results are returned
// as a map keyed by resource_id so the frontend can index without a second
// pass.
//
// Inactive fns and fns whose pg_proc row was dropped (orphaned authz_resource
// entry) are simply omitted from the response — the frontend treats "no entry"
// as "no badge", which matches "we don't know yet" rather than "clean".
dataQueryRouter.get('/functions/lint-all', async (req, res) => {
  const dsId = req.query.data_source_id as string;
  if (!dsId) return res.status(400).json({ error: 'data_source_id is required' });

  try {
    const reg = await authzPool.query(
      `SELECT resource_id, attributes
         FROM authz_resource
        WHERE resource_type = 'function' AND is_active = TRUE
          AND attributes->>'data_source_id' = $1`,
      [dsId]
    );
    if (reg.rows.length === 0) return res.json({ functions: {} });

    type Reg = { resource_id: string; schema: string; function_name: string; volatility: 'IMMUTABLE'|'STABLE'|'VOLATILE'; arg_names: string[] };
    const registry: Reg[] = reg.rows.map((r) => {
      const rid = r.resource_id as string;
      const fq = rid.startsWith('function:') ? rid.slice('function:'.length) : rid;
      const dot = fq.indexOf('.');
      const schema = dot > 0 ? fq.slice(0, dot) : 'public';
      const function_name = dot > 0 ? fq.slice(dot + 1) : fq;
      const attrs = r.attributes || {};
      const volatility = (attrs.volatility || 'VOLATILE') as 'IMMUTABLE'|'STABLE'|'VOLATILE';
      const parsed = attrs.parsed_args || parseFunctionArgs(attrs.arguments || '');
      const arg_names = (parsed as Array<{name: string}>).map((a) => a.name);
      return { resource_id: rid, schema, function_name, volatility, arg_names };
    });

    // Pull source text for every (schema, name) pair in one query. Using two
    // parallel arrays + unnest avoids the N-parameter awkwardness of an
    // IN ((s1,f1),(s2,f2),...) tuple list.
    const dsPool = await getDataSourcePool(dsId);
    const schemas = registry.map((r) => r.schema);
    const names = registry.map((r) => r.function_name);
    const defs = await dsPool.query(
      `SELECT n.nspname AS schema, p.proname AS function_name,
              pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN unnest($1::text[], $2::text[]) AS w(s, f)
           ON w.s = n.nspname AND w.f = p.proname`,
      [schemas, names]
    );

    const defByKey = new Map<string, string>();
    for (const row of defs.rows) {
      defByKey.set(`${row.schema}.${row.function_name}`, row.def);
    }

    // FN-QUALITY-LINT-V02-FU: payload now includes full issues[] alongside
    // the count/code summary. List-row dots only need counts; the fn detail
    // panel renders the full issue body (message + hint). Returning both in
    // one trip avoids a second round-trip when the user expands a function.
    const out: Record<string, { warn_count: number; info_count: number; codes: string[]; issues: ReturnType<typeof lintFunction> }> = {};
    for (const r of registry) {
      const def = defByKey.get(`${r.schema}.${r.function_name}`);
      if (!def) continue;   // orphaned registry entry — skip silently
      const issues = lintFunction({
        sql: def,
        function_name: r.function_name,
        arg_names: r.arg_names,
        volatility: r.volatility,
      });
      out[r.resource_id] = {
        warn_count: issues.filter((i) => i.severity === 'warn').length,
        info_count: issues.filter((i) => i.severity === 'info').length,
        codes: issues.map((i) => i.code),
        issues,
      };
    }
    res.json({ functions: out });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Lint: pure-text quality advisory for SQL fn DDL ───
// Stateless — no DB round trip, no data_source_id required. Curators get
// instant feedback while typing. Volatility is inferred from the DDL keyword
// (STABLE / IMMUTABLE / VOLATILE) if explicit; defaults to VOLATILE (PG's
// own default), which is what the planner sees too if the keyword is absent.
//
// FQL-01 (volatility) therefore fires accurately on the same signal PG uses.
// FQL-02..04 are pure-text rules (SELECT *, p_ prefix, name pattern).
dataQueryRouter.post('/functions/lint', (req, res) => {
  const { sql } = req.body as { sql?: string };
  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'sql (string) required' });
  }
  const header = parseCreateFunctionHeader(sql);
  if (!header) {
    return res.status(400).json({
      error: 'Invalid SQL',
      detail: 'Must start with CREATE [OR REPLACE] FUNCTION schema.function_name(...)',
    });
  }

  // Best-effort arg name extraction — same parser the deploy path uses.
  // We only need names for FQL-03; types/defaults are irrelevant here.
  const headerEnd = sql.indexOf('(', sql.toUpperCase().indexOf('FUNCTION'));
  let argText = '';
  if (headerEnd !== -1) {
    let depth = 0;
    for (let i = headerEnd; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { argText = sql.slice(headerEnd + 1, i); break; }
      }
    }
  }
  const arg_names = parseFunctionArgs(argText).map((a) => a.name);

  // Infer volatility from explicit keyword in the DDL. PG's default is VOLATILE
  // when the keyword is omitted, and that's the lint signal that matters.
  const volMatch = /\b(IMMUTABLE|STABLE|VOLATILE)\b/i.exec(sql.replace(/--[^\n]*/g, ''));
  const volatility =
    (volMatch?.[1].toUpperCase() as 'IMMUTABLE' | 'STABLE' | 'VOLATILE' | undefined) || 'VOLATILE';

  const issues = lintFunction({
    sql,
    function_name: header.function_name,
    arg_names,
    volatility,
  });
  res.json({
    status: 'ok',
    schema: header.schema,
    function_name: header.function_name,
    volatility,
    issues,
  });
});

dataQueryRouter.post('/functions/validate', async (req, res) => {
  const { data_source_id, sql } = req.body as { data_source_id: string; sql: string };
  if (!data_source_id || !sql) return res.status(400).json({ error: 'data_source_id and sql are required' });

  const header = parseCreateFunctionHeader(sql);
  if (!header) {
    return res.status(400).json({
      error: 'Invalid SQL',
      detail: 'Must start with CREATE [OR REPLACE] FUNCTION schema.function_name(...)',
    });
  }

  let client;
  try {
    client = await getDataSourceClient(data_source_id);
    await client.query('BEGIN');
    await client.query(sql);
    // Verify it shows up in pg_proc
    const check = await client.query(
      `SELECT pg_get_function_arguments(p.oid) AS arguments,
              pg_get_function_result(p.oid) AS return_type,
              CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname=$1 AND p.proname=$2`,
      [header.schema, header.function_name]
    );
    await client.query('ROLLBACK');
    if (check.rows.length === 0) {
      return res.status(400).json({ error: 'Function not found after CREATE (rolled back)' });
    }
    const row = check.rows[0];
    const meta = extractFunctionMetadata({
      name: header.function_name,
      arguments: row.arguments,
      return_type: row.return_type,
      volatility: row.volatility,
    });
    res.json({
      status: 'ok',
      schema: header.schema,
      function_name: header.function_name,
      arguments: row.arguments,
      return_type: row.return_type,
      volatility: row.volatility,
      parsed_args: meta.parsed_args,
      return_shape: meta.return_shape,
      subtype: meta.subtype,
    });
  } catch (err: any) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: 'SQL error', detail: err.message });
  } finally {
    if (client) await client.end().catch(() => {});
  }
});

// ─── Deploy: execute CREATE FUNCTION on target DS, register, grant ADMIN execute ───
dataQueryRouter.post('/functions/deploy', async (req, res) => {
  const { data_source_id, sql } = req.body as { data_source_id: string; sql: string };
  const userId = getUserId(req);
  if (!data_source_id || !sql) return res.status(400).json({ error: 'data_source_id and sql are required' });

  const header = parseCreateFunctionHeader(sql);
  if (!header) {
    return res.status(400).json({
      error: 'Invalid SQL',
      detail: 'Must start with CREATE [OR REPLACE] FUNCTION schema.function_name(...)',
    });
  }

  const dsCheck = await authzPool.query(
    `SELECT source_id, db_type FROM authz_data_source WHERE source_id=$1 AND is_active=TRUE`,
    [data_source_id]
  );
  if (dsCheck.rows.length === 0) return res.status(404).json({ error: 'Data source not found or inactive' });
  if (dsCheck.rows[0].db_type === 'oracle') return res.status(400).json({ error: 'Oracle deploy not supported via this endpoint' });

  let client;
  try {
    client = await getDataSourceClient(data_source_id);
    await client.query(sql);

    // Fetch metadata of the newly created/replaced function
    const check = await client.query(
      `SELECT pg_get_function_arguments(p.oid) AS arguments,
              pg_get_function_result(p.oid) AS return_type,
              CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname=$1 AND p.proname=$2`,
      [header.schema, header.function_name]
    );
    if (check.rows.length === 0) return res.status(500).json({ error: 'Function missing from pg_proc after CREATE' });

    const row = check.rows[0];
    const meta = extractFunctionMetadata({
      name: header.function_name,
      arguments: row.arguments,
      return_type: row.return_type,
      volatility: row.volatility,
    });

    const resource_id = `function:${header.schema}.${header.function_name}`;
    const display_name = `${header.schema}.${header.function_name}(${row.arguments})`;
    const attrs = {
      data_source_id,
      arguments: meta.arguments,
      return_type: meta.return_type,
      volatility: meta.volatility,
      parsed_args: meta.parsed_args,
      return_shape: meta.return_shape,
      subtype: meta.subtype,
      idempotent: meta.idempotent,
      side_effects: meta.side_effects,
      authored_by: userId,
      authored_at: new Date().toISOString(),
    };

    // Upsert into authz_resource
    await authzPool.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'function', $2, $3::jsonb, TRUE)
       ON CONFLICT (resource_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         attributes = EXCLUDED.attributes,
         is_active = TRUE`,
      [resource_id, display_name, JSON.stringify(attrs)]
    );

    // Auto-grant DATA_STEWARD execute (V083: data-function deploy = data ops).
    // ADMIN/DBA grants would FK-fail since V083 dropped those roles.
    await authzPool.query(
      `INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect)
       VALUES ('DATA_STEWARD', 'execute', $1, 'allow')
       ON CONFLICT (role_id, action_id, resource_id) DO UPDATE SET effect='allow', is_active=TRUE`,
      [resource_id]
    );

    audit({
      access_path: 'B', subject_id: userId,
      action_id: 'data_function_deploy', resource_id,
      decision: 'allow',
      context: { data_source_id, subtype: meta.subtype },
    });
    logAdminAction(authzPool, {
      userId, action: 'DATA_FUNCTION_DEPLOY',
      resourceType: 'function', resourceId: resource_id,
      details: { data_source_id, schema: header.schema, function_name: header.function_name, subtype: meta.subtype },
      ip: getClientIp(req),
    });

    res.json({
      status: 'ok',
      resource_id,
      schema: header.schema,
      function_name: header.function_name,
      display_name,
      arguments: row.arguments,
      return_type: row.return_type,
      volatility: row.volatility,
      subtype: meta.subtype,
      parsed_args: meta.parsed_args,
      return_shape: meta.return_shape,
    });
  } catch (err: any) {
    return res.status(400).json({ error: 'Deploy failed', detail: err.message });
  } finally {
    if (client) await client.end().catch(() => {});
  }
});
