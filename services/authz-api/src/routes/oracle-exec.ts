import { Router } from 'express';
import oracledb from 'oracledb';
import { pool as authzPool, getOracleConnection } from '../db';
import { audit } from '../audit';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';

export const oracleExecRouter = Router();

/**
 * POST /api/oracle-exec
 *
 * Execute a whitelisted Oracle function via authz_check gate.
 * Only functions registered in authz_resource with attributes.oracle = true
 * can be called. This prevents arbitrary SQL execution on Oracle.
 *
 * Body: {
 *   data_source_id: string,     // must be db_type='oracle', is_active=TRUE
 *   function_name: string,      // must exist in authz_resource whitelist
 *   params: Record<string, any> // bind parameters for the function
 * }
 */
oracleExecRouter.post('/', async (req, res) => {
  const { data_source_id, function_name, params = {} } = req.body;
  const userId = getUserId(req);
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);

  if (!data_source_id || !function_name) {
    return res.status(400).json({ error: 'data_source_id and function_name are required' });
  }

  try {
    // Step 1: Verify data source is Oracle and active
    const dsResult = await authzPool.query(
      `SELECT source_id, db_type, cdc_target_schema, oracle_connection
       FROM authz_data_source
       WHERE source_id = $1 AND is_active = TRUE AND db_type = 'oracle'`,
      [data_source_id]
    );
    if (dsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Oracle data source not found or inactive' });
    }
    const ds = dsResult.rows[0];

    // Step 2: Build resource_id and check authz_check permission gate
    const resourceId = `function:${ds.cdc_target_schema}.${function_name.toLowerCase()}`;
    const checkResult = await authzPool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [userId, groups, 'execute', resourceId]
    );
    if (!checkResult.rows[0].allowed) {
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'oracle_function_call', resource_id: resourceId,
        decision: 'deny', context: { data_source_id, function_name },
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: `${userId} lacks execute access to ${resourceId}`,
      });
    }

    // Step 3: Whitelist validation — function must be registered with oracle=true
    const whitelistResult = await authzPool.query(
      `SELECT resource_id, attributes
       FROM authz_resource
       WHERE resource_id = $1 AND resource_type = 'function'
         AND (attributes->>'oracle')::boolean = true`,
      [resourceId]
    );
    if (whitelistResult.rows.length === 0) {
      return res.status(400).json({
        error: 'Function not in whitelist',
        detail: `${function_name} is not a registered Oracle function. Run discovery first.`,
      });
    }

    // Step 4: Execute on Oracle
    let conn: oracledb.Connection | null = null;
    try {
      conn = await getOracleConnection(data_source_id);

      // Build bind parameters — all as IN binds
      const bindParams: Record<string, oracledb.BindParameter> = {};
      const paramNames: string[] = [];
      for (const [key, value] of Object.entries(params)) {
        // Sanitize param names: only allow alphanumeric + underscore
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          return res.status(400).json({ error: `Invalid parameter name: ${key}` });
        }
        paramNames.push(key);
        bindParams[key] = { val: value, dir: oracledb.BIND_IN };
      }

      // Add output bind for function return value
      bindParams['result'] = { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 };

      // Build PL/SQL block: BEGIN :result := schema.function(:p1, :p2, ...); END;
      const oracleSchema = ds.oracle_connection.user.toUpperCase();
      const fnNameUpper = function_name.toUpperCase();
      const paramList = paramNames.map(p => `:${p}`).join(', ');
      const plsql = `BEGIN :result := ${oracleSchema}.${fnNameUpper}(${paramList}); END;`;

      const execResult = await conn.execute(plsql, bindParams);

      // Step 5: Audit success
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'oracle_function_call', resource_id: resourceId,
        decision: 'allow', context: { data_source_id, function_name, param_count: paramNames.length },
      });
      logAdminAction(authzPool, {
        userId, action: 'ORACLE_FUNCTION_CALL',
        resourceType: 'function', resourceId,
        details: { data_source_id, function_name, param_count: paramNames.length },
        ip: getClientIp(req),
      });

      res.json({
        status: 'ok',
        function_name,
        result: execResult.outBinds ? (execResult.outBinds as any).result : null,
      });
    } finally {
      if (conn) await conn.close().catch(() => {});
    }
  } catch (err) {
    handleApiError(res, err);
  }
});
