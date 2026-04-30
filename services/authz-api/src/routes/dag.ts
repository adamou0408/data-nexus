// ============================================================
// DAG CRUD + validation + per-node execution.
// Implements W4 (validator) and W5 (per-node exec w/ upstream piping)
// of the L3 composition roadmap, stored in authz_resource with
// resource_type='dag' so the unified node model + grant model apply.
// ============================================================
import { Router } from 'express';
import { pool as authzPool, getDataSourcePool } from '../db';
import { audit } from '../audit';
import { logAdminAction } from '../lib/admin-audit';
import { getUserId, getClientIp, handleApiError } from '../lib/request-helpers';
import { parseFunctionArgs } from '../lib/function-metadata';
import { validateDag, DagDoc } from '../lib/dag-validate';
import { runOperator, deriveOperatorResourceId, UpstreamFrame } from '../lib/dag-operators';
import { emitPageSnapshot, deriveSinkUpstreamFn, SinkValidationError } from '../lib/sink-runtime';
import { findSingleLeaf, deriveFormSchema, DagNode, DagEdge } from '../lib/dag-exec';
import { requireRole } from '../middleware/authz';

export const dagRouter = Router();

// L0 functional gates for write operations (FC-AUTHZ-01).
// Authoring a DAG = mutating authz_resource (resource_type='dag'); same blast
// radius as datasource/discover writes, so mirror their V083 role
// (DATA_STEWARD owns Catalog/Ingest data ops).
const requireDagAuthor = requireRole('DATA_STEWARD');
// save-as-page writes to authz_ui_page, the Tier A platform metadata table —
// gate it the same way config/snapshot is gated (AUTHZ_ADMIN per V083).
const requirePageAuthor = requireRole('AUTHZ_ADMIN');
// /publish opens a DAG to BI_USER as a live form-driven page. That's both a
// page-author act (writing to authz_ui_page) AND a bless act (granting
// BI_USER read on a new published_dag resource). DATA_STEWARD owns the
// blessing semantics elsewhere (V044 BIZ-TERM); same role here.
const requireDagPublisher = requireRole('DATA_STEWARD');

const MAX_ROWS = 1000;

function quoteIdent(s: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`Invalid identifier: ${s}`);
  return '"' + s.replace(/"/g, '""') + '"';
}

function slugify(name: string): string {
  const base = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  return base || `dag_${Date.now().toString(36)}`;
}

// ─── List DAGs ───
dagRouter.get('/', async (req, res) => {
  const dsId = req.query.data_source_id as string | undefined;
  try {
    const params: unknown[] = [];
    let sql = `SELECT resource_id, display_name, attributes, updated_at, created_at
               FROM authz_resource
               WHERE resource_type = 'dag' AND is_active = TRUE`;
    if (dsId) {
      params.push(dsId);
      sql += ` AND attributes->>'data_source_id' = $${params.length}`;
    }
    sql += ` ORDER BY updated_at DESC NULLS LAST, resource_id`;
    const { rows } = await authzPool.query(sql, params);
    res.json(rows.map((r) => ({
      resource_id: r.resource_id,
      display_name: r.display_name,
      data_source_id: r.attributes?.data_source_id,
      node_count: (r.attributes?.nodes || []).length,
      edge_count: (r.attributes?.edges || []).length,
      updated_at: r.updated_at,
      created_at: r.created_at,
    })));
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Get one DAG ───
dagRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await authzPool.query(
      `SELECT resource_id, display_name, attributes
       FROM authz_resource
       WHERE resource_id = $1 AND resource_type = 'dag' AND is_active = TRUE`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'DAG not found' });
    const r = rows[0];
    res.json({
      resource_id: r.resource_id,
      display_name: r.display_name,
      ...r.attributes,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Save (create or update) ───
dagRouter.post('/save', requireDagAuthor, async (req, res) => {
  const { resource_id, display_name, data_source_id, nodes, edges, description } = req.body as {
    resource_id?: string;
    display_name: string;
    data_source_id: string;
    nodes: any[];
    edges: any[];
    description?: string;
  };
  const userId = getUserId(req);

  if (!display_name || !data_source_id || !Array.isArray(nodes) || !Array.isArray(edges)) {
    return res.status(400).json({ error: 'display_name, data_source_id, nodes[], edges[] required' });
  }

  // FC-VALIDATE-01: refuse to persist structurally invalid DAGs (cycle,
  // type_mismatch, missing_input, unknown_handle). Frontend already calls
  // /validate, but server is SSOT — never trust the client.
  const validation = validateDag({ nodes, edges });
  const errors = validation.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    return res.status(400).json({
      error: 'DAG validation failed',
      issues: errors,
    });
  }

  const rid = resource_id && resource_id.startsWith('dag:') ? resource_id : `dag:${slugify(display_name)}`;
  const attrs = {
    data_source_id,
    description: description || null,
    nodes,
    edges,
    version: 1,
    authored_by: userId,
    updated_at: new Date().toISOString(),
  };

  try {
    await authzPool.query(
      `INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
       VALUES ($1, 'dag', $2, $3::jsonb, TRUE)
       ON CONFLICT (resource_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         attributes = EXCLUDED.attributes,
         is_active = TRUE`,
      [rid, display_name, JSON.stringify(attrs)]
    );
    logAdminAction(authzPool, {
      userId,
      action: 'DAG_SAVE',
      resourceType: 'dag',
      resourceId: rid,
      details: { data_source_id, node_count: nodes.length, edge_count: edges.length },
      ip: getClientIp(req),
    });
    res.json({ status: 'ok', resource_id: rid, display_name, ...attrs });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Delete ───
dagRouter.delete('/:id', requireDagAuthor, async (req, res) => {
  const userId = getUserId(req);
  try {
    const result = await authzPool.query(
      `UPDATE authz_resource SET is_active = FALSE
       WHERE resource_id = $1 AND resource_type = 'dag'
       RETURNING resource_id`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'DAG not found' });
    logAdminAction(authzPool, {
      userId, action: 'DAG_DELETE',
      resourceType: 'dag', resourceId: req.params.id,
      details: {}, ip: getClientIp(req),
    });
    res.json({ status: 'ok', resource_id: req.params.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Validate (DV-01 type, DV-03 cycle, DV-04 orphan, required-input coverage) ───
dagRouter.post('/validate', (req, res) => {
  const doc = req.body as DagDoc;
  if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
    return res.status(400).json({ error: 'body must be { nodes:[], edges:[] }' });
  }
  const result = validateDag(doc);
  res.json(result);
});

// ─── Execute one function node, piping upstream outputs by semantic_type ───
// Client passes:
//   {
//     data_source_id,
//     node: { id, data: { resource_id, inputs[], bound_params } },
//     upstream: { <nodeId>: { columns:[{name, semantic_type}], row0:{...} } },
//     edges: [{source, target, sourceHandle, targetHandle}]
//   }
// Server reads the target node's input list, binds via (priority):
//   1. bound_params[name] — user-provided constant
//   2. upstream row0[sourceHandle] whose edge targets this input
//   3. first upstream column matching by semantic_type
dagRouter.post('/execute-node', async (req, res) => {
  const { data_source_id, node, upstream = {}, edges = [], upstream_resources = {} } = req.body as {
    data_source_id: string;
    node: {
      id: string;
      type?: string;                       // 'fn' (default) | 'literal' | 'filter' | 'cast'
      data: {
        resource_id?: string;              // fn nodes only — operator nodes derive from upstream
        inputs?: Array<{ name: string; semantic_type?: string; hasDefault?: boolean }>;
        bound_params?: Record<string, unknown>;
        op_kind?: 'literal' | 'filter' | 'cast' | 'aggregate';
        op_config?: Record<string, unknown>;
      };
    };
    upstream: Record<string, UpstreamFrame>;
    edges: Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
    upstream_resources?: Record<string, string>;   // upstream node_id → fn resource_id (for operator authz inheritance)
  };

  const userId = getUserId(req);
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);

  // ── Operator dispatch (composer-operator-and-sink plan §3.3) ──
  // Operators inherit AuthZ from the upstream fn whose rows they shape; they
  // do not introduce new data access surface. Audit still fires under the
  // upstream's resource_id for forensic continuity.
  if (node.type && node.type !== 'fn') {
    const opKind = node.data.op_kind || (node.type as 'literal' | 'filter' | 'cast' | 'aggregate');
    const inbound = edges.filter((e) => e.target === node.id);
    const inheritedRid = deriveOperatorResourceId({
      op_kind: opKind,
      inbound,
      upstreamResourceIds: upstream_resources,
    });

    // For non-literal operators, gate against the upstream resource the same
    // way fn execute-node does — if curator can't execute upstream, they
    // can't shape its rows either.
    if (opKind !== 'literal' && inheritedRid.startsWith('function:')) {
      const chk = await authzPool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [userId, groups, 'execute', inheritedRid]
      );
      if (!chk.rows[0].allowed) {
        audit({
          access_path: 'B', subject_id: userId,
          action_id: `dag_op_${opKind}`, resource_id: inheritedRid,
          decision: 'deny', context: { node_id: node.id, op_kind: opKind },
        });
        return res.status(403).json({
          error: 'Forbidden',
          detail: `${userId} lacks execute on upstream ${inheritedRid}`,
        });
      }
    }

    try {
      const result = runOperator({
        op_kind: opKind,
        op_config: node.data.op_config || {},
        inbound,
        upstream,
        node_id: node.id,
      });
      audit({
        access_path: 'B', subject_id: userId,
        action_id: `dag_op_${opKind}`, resource_id: inheritedRid,
        decision: 'allow',
        context: {
          data_source_id, node_id: node.id, op_kind: opKind,
          row_count: result.row_count, elapsed_ms: result.elapsed_ms,
        },
      });
      return res.json({
        status: 'ok',
        node_id: node.id,
        resource_id: inheritedRid,
        columns: result.columns,
        rows: result.rows,
        row_count: result.row_count,
        truncated: false,
        elapsed_ms: result.elapsed_ms,
        lineage: result.lineage,
      });
    } catch (err: any) {
      return res.status(400).json({ error: 'Operator execution failed', detail: err.message });
    }
  }

  if (!data_source_id || !node?.data?.resource_id) {
    return res.status(400).json({ error: 'data_source_id and node.data.resource_id required' });
  }

  try {
    // Fetch function metadata
    const metaResult = await authzPool.query(
      `SELECT resource_id, attributes FROM authz_resource
       WHERE resource_id = $1 AND resource_type = 'function' AND is_active = TRUE
         AND attributes->>'data_source_id' = $2`,
      [node.data.resource_id, data_source_id]
    );
    if (metaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Function not found', detail: node.data.resource_id });
    }

    // AuthZ check
    const chk = await authzPool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [userId, groups, 'execute', node.data.resource_id]
    );
    if (!chk.rows[0].allowed) {
      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'dag_node_exec', resource_id: node.data.resource_id,
        decision: 'deny', context: { data_source_id },
      });
      return res.status(403).json({ error: 'Forbidden', detail: `${userId} lacks execute on ${node.data.resource_id}` });
    }

    const fnAttrs = metaResult.rows[0].attributes || {};
    const parsedArgs = parseFunctionArgs(fnAttrs.arguments || '');
    const lineage: Array<{ input: string; source: string }> = [];
    const bound = node.data.bound_params || {};

    // Build edge lookup for this node's inbound edges
    const inbound = edges.filter((e) => e.target === node.id);

    // Named notation (p_x := $n) lets us skip defaulted params cleanly —
    // literal DEFAULT is rejected by PG/Greenplum in SELECT expression context.
    const values: unknown[] = [];
    const bindList: string[] = [];

    const pushBind = (arg: { name: string }, v: unknown, source: string) => {
      values.push(v);
      bindList.push(`${quoteIdent(arg.name)} := $${values.length}`);
      lineage.push({ input: arg.name, source });
    };

    for (const arg of parsedArgs) {
      // 1. Explicit user binding wins
      if (Object.prototype.hasOwnProperty.call(bound, arg.name)) {
        pushBind(arg, bound[arg.name], 'bound_param');
        continue;
      }

      // 2. Upstream edge targets this input
      const matchingEdge = inbound.find((e) => e.targetHandle === arg.name);
      if (matchingEdge) {
        const up = upstream[matchingEdge.source];
        if (up?.row0 && matchingEdge.sourceHandle && matchingEdge.sourceHandle in up.row0) {
          pushBind(arg, up.row0[matchingEdge.sourceHandle], `${matchingEdge.source}.${matchingEdge.sourceHandle}`);
          continue;
        }
      }

      // 3. Semantic-type match across any upstream row0
      const argInput = (fnAttrs.inputs || []).find((i: any) => i.name === arg.name);
      const wantType = argInput?.semantic_type;
      if (wantType && wantType !== 'unknown') {
        let matched = false;
        for (const [upId, up] of Object.entries(upstream)) {
          const col = (up.columns || []).find((c) => c.semantic_type === wantType);
          if (col && up.row0 && col.name in up.row0) {
            pushBind(arg, up.row0[col.name], `${upId}.${col.name} (semantic:${wantType})`);
            matched = true;
            break;
          }
        }
        if (matched) continue;
      }

      // 4. Fallback: skip (DEFAULT) or error
      if (arg.hasDefault) {
        lineage.push({ input: arg.name, source: 'default' });
        continue;
      }
      return res.status(400).json({
        error: 'Unbound required input',
        detail: `${arg.name} has no upstream edge, no bound value, and no default`,
        node_id: node.id,
      });
    }

    const schemaAndName = node.data.resource_id.slice('function:'.length);
    const [schema, fnName] = schemaAndName.split('.');
    const sql = `SELECT * FROM (SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(fnName)}(${bindList.join(', ')})) _inner LIMIT ${MAX_ROWS + 1}`;

    const dsPool = await getDataSourcePool(data_source_id);
    const t0 = Date.now();
    const qres = await dsPool.query(sql, values);
    const elapsedMs = Date.now() - t0;

    const truncated = (qres.rowCount || 0) > MAX_ROWS;
    const rows = truncated ? qres.rows.slice(0, MAX_ROWS) : qres.rows;
    const columns = qres.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));

    // Decorate columns with semantic_type from function metadata
    const outputs = fnAttrs.outputs || [];
    const semanticByName = new Map<string, string>();
    for (const o of outputs) if (o.semantic_type) semanticByName.set(o.name, o.semantic_type);
    const enrichedColumns = columns.map((c) => ({ ...c, semantic_type: semanticByName.get(c.name) }));

    audit({
      access_path: 'B', subject_id: userId,
      action_id: 'dag_node_exec', resource_id: node.data.resource_id,
      decision: 'allow',
      context: { data_source_id, node_id: node.id, row_count: rows.length, elapsed_ms: elapsedMs },
    });

    res.json({
      status: 'ok',
      node_id: node.id,
      resource_id: node.data.resource_id,
      columns: enrichedColumns,
      rows,
      row_count: rows.length,
      truncated,
      elapsed_ms: elapsedMs,
      lineage,
    });
  } catch (err: any) {
    return res.status(400).json({ error: 'Node execution failed', detail: err.message });
  }
});

// ─── Save a node's last_result as a Tier B snapshot page ───
// Path A from .claude/plans/v3-phase-1/two-tier-platform-model.md §Q4.
// Cheapest end-to-end Curator loop: run DAG → click button → page exists.
// Live re-execution (Path B) requires config-exec dispatch on dag: prefix
// and is intentionally deferred.
//
// Body:
//   {
//     page_id:        'mat_360_n3_snapshot',     // ^[a-z][a-z0-9_]*$
//     title:          'Material 360 — Full trace',
//     parent_page_id: 'modules_home',            // optional, must exist
//     description?:   string,
//     dag_id:         'dag:material_360_trace',
//     node_id:        'n3',
//     bound_params:   { p_material_no: 'M001' },
//     columns: [{ name, semantic_type?, dataTypeID? }],
//     rows:    [{ ... }, ...],
//     overwrite?:     boolean
//   }
// Legacy alias (sink-as-node-kind plan §3.3, AC-6): kept fully intact so
// existing button-driven Save-as-page UI + e2e are unaffected. New
// node-driven path is /execute-sink. The two share emitPageSnapshot().
dagRouter.post('/save-as-page', requirePageAuthor, async (req, res) => {
  const {
    page_id, title, parent_page_id, description,
    dag_id, node_id, bound_params,
    columns, rows, overwrite,
  } = req.body as {
    page_id: string;
    title: string;
    parent_page_id?: string;
    description?: string;
    dag_id: string;
    node_id: string;
    bound_params?: Record<string, unknown>;
    columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
    rows: Record<string, unknown>[];
    overwrite?: boolean;
  };
  const userId = getUserId(req);

  try {
    const result = await emitPageSnapshot(authzPool, {
      page_id, title, parent_page_id, description,
      dag_id, node_id, bound_params,
      columns, rows, overwrite,
      captured_by: userId,
    });

    logAdminAction(authzPool, {
      userId,
      action: result.status === 'overwritten' ? 'DAG_SAVE_AS_PAGE_OVERWRITE' : 'DAG_SAVE_AS_PAGE',
      resourceType: 'ui_page',
      resourceId: page_id,
      details: { dag_id, node_id, row_count: result.row_count, column_count: result.column_count },
      ip: getClientIp(req),
    });

    res.status(result.status === 'overwritten' ? 200 : 201).json({
      status: result.status,
      page_id: result.page_id,
      row_count: result.row_count,
      column_count: result.column_count,
    });
  } catch (err) {
    if (err instanceof SinkValidationError) {
      return res.status(err.status).json({ error: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    }
    handleApiError(res, err);
  }
});

// ── New: composer-native sink dispatch (sink-as-node-kind plan §3.3) ──
// Body:
//   {
//     dag_id:       'dag:foo',
//     sink_node_id: 's1',                  // node.type='sink' inside the DAG
//     sink_kind:    'page',                // future: 'api' | 'scheduled_job'
//     sink_config:  { page_id, title, parent_page_id?, description?, overwrite? },
//     bound_params?: { ... },
//     columns:      [{ name, semantic_type? }],   // client-supplied snapshot
//     rows:         [{...}, ...]                  //  (same contract as save-as-page;
//                                                  //   server does NOT re-execute upstream)
//   }
//
// AuthZ: walks DAG to find upstream fn ancestor; authz_check(execute,
// fn:resource_id) gates the write. Maintains parity with operator
// dispatch (composer-operator-and-sink §3.2). The L0 page-author role
// is also required (writing to authz_ui_page is platform-side).
dagRouter.post('/execute-sink', requirePageAuthor, async (req, res) => {
  const {
    dag_id, sink_node_id, sink_kind, sink_config,
    bound_params, columns, rows,
  } = req.body as {
    dag_id: string;
    sink_node_id: string;
    sink_kind: 'page';
    sink_config: {
      page_id: string;
      title: string;
      parent_page_id?: string;
      description?: string;
      overwrite?: boolean;
    };
    bound_params?: Record<string, unknown>;
    columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
    rows: Record<string, unknown>[];
  };
  const userId = getUserId(req);
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);

  if (!dag_id || !sink_node_id || !sink_kind || !sink_config) {
    return res.status(400).json({ error: 'dag_id, sink_node_id, sink_kind, sink_config required' });
  }
  if (sink_kind !== 'page') {
    return res.status(400).json({ error: `unsupported sink_kind '${sink_kind}' (MVP supports only 'page')` });
  }

  try {
    // Walk DAG to find upstream fn ancestor for authz inheritance.
    const dagRow = await authzPool.query(
      `SELECT attributes FROM authz_resource
        WHERE resource_id = $1 AND resource_type = 'dag' AND is_active = TRUE`,
      [dag_id]
    );
    if (dagRow.rowCount === 0) {
      return res.status(404).json({ error: `DAG not found: ${dag_id}` });
    }
    const attrs = dagRow.rows[0].attributes || {};
    const dagNodes: Array<{ id: string; type?: string; data?: { resource_id?: string } }> = attrs.nodes || [];
    const dagEdges: Array<{ source: string; target: string }> = attrs.edges || [];

    const sinkNode = dagNodes.find((n) => n.id === sink_node_id);
    if (!sinkNode) {
      return res.status(400).json({ error: `sink_node_id '${sink_node_id}' not found in ${dag_id}` });
    }
    if (sinkNode.type !== 'sink') {
      return res.status(400).json({ error: `node '${sink_node_id}' is not a sink (type=${sinkNode.type ?? 'fn'})` });
    }

    const upstreamFnRid = deriveSinkUpstreamFn(dagNodes, dagEdges, sink_node_id);
    const auditResourceId = upstreamFnRid || `sink:${sink_kind}:no_upstream`;

    if (upstreamFnRid && upstreamFnRid.startsWith('function:')) {
      const chk = await authzPool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [userId, groups, 'execute', upstreamFnRid]
      );
      if (!chk.rows[0].allowed) {
        audit({
          access_path: 'B', subject_id: userId,
          action_id: `dag_sink_${sink_kind}`, resource_id: auditResourceId,
          decision: 'deny',
          context: { dag_id, sink_node_id, sink_kind, reason: 'upstream_fn_denied' },
        });
        return res.status(403).json({
          error: 'Forbidden',
          detail: `${userId} lacks execute on upstream ${upstreamFnRid}`,
        });
      }
    }

    const result = await emitPageSnapshot(authzPool, {
      page_id: sink_config.page_id,
      title: sink_config.title,
      parent_page_id: sink_config.parent_page_id,
      description: sink_config.description,
      dag_id,
      node_id: sink_node_id,
      bound_params,
      columns,
      rows,
      overwrite: sink_config.overwrite,
      captured_by: userId,
    });

    audit({
      access_path: 'B', subject_id: userId,
      action_id: `dag_sink_${sink_kind}`, resource_id: auditResourceId,
      decision: 'allow',
      context: {
        dag_id, sink_node_id, sink_kind,
        page_id: result.page_id,
        row_count: result.row_count,
        snapshot_status: result.status,
      },
    });
    logAdminAction(authzPool, {
      userId,
      action: result.status === 'overwritten' ? 'DAG_SINK_PAGE_OVERWRITE' : 'DAG_SINK_PAGE',
      resourceType: 'ui_page',
      resourceId: result.page_id,
      details: { dag_id, sink_node_id, row_count: result.row_count, column_count: result.column_count },
      ip: getClientIp(req),
    });

    res.status(result.status === 'overwritten' ? 200 : 201).json({
      status: result.status,
      sink_kind,
      artifact_id: result.page_id,
      page_id: result.page_id,
      row_count: result.row_count,
      column_count: result.column_count,
    });
  } catch (err) {
    if (err instanceof SinkValidationError) {
      return res.status(err.status).json({ error: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    }
    handleApiError(res, err);
  }
});

// ─── POST /:id/publish — DAG-PUBLISH-V01 (live form-driven page) ───
// Body:
//   {
//     page_id:        'tiptop_material_search',   // ^[a-z][a-z0-9_]*$
//     title:          '物料 360 查詢',
//     parent_page_id: 'modules_home',             // optional, must exist
//     description?:   string,
//     overwrite?:     boolean,                    // default false; required for re-publish
//     grant_read_to_roles?: string[],             // default ['BI_USER']
//   }
//
// What it does (one tx):
//   1. Validates: DAG exists, single leaf, no cycle.
//   2. Freezes dag_snapshot (nodes/edges/data_source_id/output_node_id).
//   3. Derives form_schema from each fn node's user_input_params + parsed args.
//   4. Upserts authz_ui_page row with published_dag_id + dag_snapshot + form_schema.
//   5. Mirrors page resource into authz_resource(resource_type='page')
//      (parent inherited from dag.parent_id, or module:pg_tiptop_v1).
//   6. Registers authz_resource(resource_type='published_dag', resource_id='published_dag:'+dag_id).
//   7. Grants `read` on the published_dag resource to BI_USER (or caller-specified roles).
//
// Authz model (Fork A — publish=bless): the published_dag resource is the
// gate BI_USER passes through; per-fn execute permissions are NOT widened
// for BI_USER. See plan §4 Fork A.
dagRouter.post('/:id/publish', requireDagPublisher, async (req, res) => {
  const dagId = req.params.id;
  const {
    page_id, title, parent_page_id, description,
    overwrite, grant_read_to_roles,
  } = req.body as {
    page_id?: string;
    title?: string;
    parent_page_id?: string;
    description?: string;
    overwrite?: boolean;
    grant_read_to_roles?: string[];
  };
  const userId = getUserId(req);

  if (!dagId.startsWith('dag:')) {
    return res.status(400).json({ error: 'dag_id must start with "dag:"' });
  }
  if (!page_id || !/^[a-z][a-z0-9_]*$/.test(page_id)) {
    return res.status(400).json({ error: 'page_id must match ^[a-z][a-z0-9_]*$' });
  }
  if (!title || title.trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }

  const grantRoles = Array.isArray(grant_read_to_roles) && grant_read_to_roles.length > 0
    ? grant_read_to_roles
    : ['BI_USER'];

  const client = await authzPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Load DAG attributes.
    const dagRow = await client.query(
      `SELECT attributes, parent_id FROM authz_resource
        WHERE resource_id = $1 AND resource_type = 'dag' AND is_active = TRUE`,
      [dagId]
    );
    if (dagRow.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `DAG not found: ${dagId}` });
    }
    const attrs = dagRow.rows[0].attributes || {};
    const dagParent = dagRow.rows[0].parent_id as string | null;
    const nodes: DagNode[] = attrs.nodes || [];
    const edges: DagEdge[] = attrs.edges || [];
    const dataSourceId = attrs.data_source_id as string;
    if (!dataSourceId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'DAG has no data_source_id — cannot publish' });
    }

    // 2. Single-leaf invariant + structural validation (refuses cycle).
    let outputNodeId: string;
    try {
      outputNodeId = findSingleLeaf(nodes, edges);
    } catch (err) {
      await client.query('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: `DAG not publishable: ${msg}` });
    }
    // Cast: dag-exec.DagEdge omits the optional `id` field that dag-validate's
    // DagEdge requires for issue-reporting; the persisted attributes always
    // carry it (the /save handler stores client edges verbatim).
    const validation = validateDag({ nodes, edges } as unknown as DagDoc);
    const errs = validation.issues.filter((i) => i.severity === 'error');
    if (errs.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'DAG validation failed', issues: errs });
    }

    // 3. Derive form_schema. Refuse publish if no user_input_params anywhere
    // (a published page with zero inputs would be redundant — that's a snapshot).
    const formSchema = deriveFormSchema(nodes);
    if (formSchema.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'DAG has no user_input_params — nothing to render as a form. Mark at least one bound_param as form input in Composer, or use Save as Page (snapshot) instead.',
      });
    }

    // 4. Build dag_snapshot (frozen).
    const dagSnapshot = {
      data_source_id: dataSourceId,
      nodes,
      edges,
      output_node_id: outputNodeId,
    };

    // 5. parent_page_id existence check (if provided).
    if (parent_page_id) {
      const pCheck = await client.query(`SELECT 1 FROM authz_ui_page WHERE page_id = $1`, [parent_page_id]);
      if (pCheck.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `parent_page_id not found: ${parent_page_id}` });
      }
    }

    // 6. FK-safe ordering: insert authz_resource rows BEFORE the
    // authz_ui_page row that references them via resource_id +
    // published_dag_id. The publish-mode mutex constraint
    // (authz_ui_page_publish_mode_check) lives on the page row and
    // enforces snapshot/published exclusivity.
    const publishedDagRid = `published_dag:${dagId}`;
    const pageRid = `page:${page_id}`;
    const pageParent = dagParent || 'module:pg_tiptop_v1';

    const exists = await client.query(`SELECT 1 FROM authz_ui_page WHERE page_id = $1`, [page_id]);
    let pageStatus: 'created' | 'overwritten';
    if (exists.rowCount && !overwrite) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'page_id already exists',
        hint: 'Pass overwrite:true to replace the existing page (snapshot will be cleared).',
      });
    }

    // 6a. Bless gate: published_dag:<rid> resource — must exist before
    // authz_ui_page.resource_id can FK to it.
    const blessAttrs = {
      dag_id: dagId,
      page_id,
      output_node_id: outputNodeId,
      blessed_by: userId,
      blessed_at: new Date().toISOString(),
    };
    await client.query(
      `INSERT INTO authz_resource
         (resource_id, resource_type, parent_id, display_name, attributes, is_active)
       VALUES ($1, 'published_dag', $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (resource_id) DO UPDATE
         SET parent_id    = EXCLUDED.parent_id,
             display_name = EXCLUDED.display_name,
             attributes   = EXCLUDED.attributes,
             is_active    = TRUE`,
      [publishedDagRid, pageParent, `Published: ${title}`, JSON.stringify(blessAttrs)]
    );

    // 6b. Page mirror in authz_resource (V081 dual-write parity), so
    // ModulesTab finds the page in cascade.
    const pageMirrorAttrs = {
      page_id,
      origin_kind: 'published_dag',
      dag_id: dagId,
      output_node_id: outputNodeId,
    };
    await client.query(
      `INSERT INTO authz_resource
         (resource_id, resource_type, parent_id, display_name, attributes, is_active)
       VALUES ($1, 'page', $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (resource_id) DO UPDATE
         SET parent_id    = EXCLUDED.parent_id,
             display_name = EXCLUDED.display_name,
             attributes   = EXCLUDED.attributes,
             is_active    = TRUE`,
      [pageRid, pageParent, title, JSON.stringify(pageMirrorAttrs)]
    );

    // 6c. Upsert authz_ui_page. resource_id points at the bless gate so
    // step 2 of /api/config-exec (authz_check 'read' on resource_id)
    // already gates BI_USER without any new code there.
    if (exists.rowCount && overwrite) {
      await client.query(
        `UPDATE authz_ui_page
            SET title = $2,
                parent_page_id = $3,
                description = $4,
                snapshot_data = NULL,
                resource_id = $5,
                published_dag_id = $6,
                dag_snapshot = $7::jsonb,
                form_schema = $8::jsonb,
                is_active = TRUE
          WHERE page_id = $1`,
        [
          page_id, title, parent_page_id || null, description || null,
          publishedDagRid, dagId, JSON.stringify(dagSnapshot), JSON.stringify(formSchema),
        ]
      );
      pageStatus = 'overwritten';
    } else {
      await client.query(
        `INSERT INTO authz_ui_page
           (page_id, title, layout, parent_page_id, description, icon,
            resource_id, published_dag_id, dag_snapshot, form_schema, is_active)
         VALUES ($1, $2, 'table', $3, $4, 'workflow', $5, $6, $7::jsonb, $8::jsonb, TRUE)`,
        [
          page_id, title, parent_page_id || null, description || null,
          publishedDagRid, dagId, JSON.stringify(dagSnapshot), JSON.stringify(formSchema),
        ]
      );
      pageStatus = 'created';
    }

    // 7. Grant `read` on the bless gate to each requested role.
    // ON CONFLICT keeps re-publish idempotent (unique on role/action/rid).
    for (const roleId of grantRoles) {
      await client.query(
        `INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect, is_active)
         VALUES ($1, 'read', $2, 'allow', TRUE)
         ON CONFLICT (role_id, action_id, resource_id) DO UPDATE SET is_active = TRUE`,
        [roleId, publishedDagRid]
      );
    }

    await client.query('COMMIT');

    audit({
      access_path: 'A', subject_id: userId,
      action_id: 'dag_publish', resource_id: publishedDagRid,
      decision: 'allow',
      context: {
        dag_id: dagId, page_id, output_node_id: outputNodeId,
        form_field_count: formSchema.length, granted_roles: grantRoles,
        page_status: pageStatus,
      },
    });
    void logAdminAction(authzPool, {
      userId,
      action: pageStatus === 'overwritten' ? 'DAG_PUBLISH_OVERWRITE' : 'DAG_PUBLISH',
      resourceType: 'published_dag',
      resourceId: publishedDagRid,
      details: {
        dag_id: dagId, page_id, output_node_id: outputNodeId,
        form_field_count: formSchema.length, granted_roles: grantRoles,
      },
      ip: getClientIp(req),
    });

    res.status(pageStatus === 'overwritten' ? 200 : 201).json({
      status: pageStatus,
      page_id,
      published_dag_id: dagId,
      published_dag_rid: publishedDagRid,
      output_node_id: outputNodeId,
      form_schema: formSchema,
      granted_read_to: grantRoles,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    handleApiError(res, err);
  } finally {
    client.release();
  }
});
