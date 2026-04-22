import { Router } from 'express';
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

export const dataQueryRouter = Router();

const MAX_ROWS = 1000;

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

    // Auto-grant ADMIN execute
    await authzPool.query(
      `INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect)
       VALUES ('ADMIN', 'execute', $1, 'allow')
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
