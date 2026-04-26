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

export const dagRouter = Router();

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
dagRouter.post('/save', async (req, res) => {
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
dagRouter.delete('/:id', async (req, res) => {
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
  const { data_source_id, node, upstream = {}, edges = [] } = req.body as {
    data_source_id: string;
    node: {
      id: string;
      data: {
        resource_id: string;
        inputs?: Array<{ name: string; semantic_type?: string; hasDefault?: boolean }>;
        bound_params?: Record<string, unknown>;
      };
    };
    upstream: Record<string, { columns: Array<{ name: string; semantic_type?: string }>; row0?: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
  };

  const userId = getUserId(req);
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);

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
const PAGE_ID_RE = /^[a-z][a-z0-9_]*$/;
const RENDER_BY_SEMANTIC: Record<string, string> = {
  status: 'status_badge',
  phase: 'phase_tag',
  gate: 'gate_badge',
};

dagRouter.post('/save-as-page', async (req, res) => {
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

  if (!page_id || !PAGE_ID_RE.test(page_id)) {
    return res.status(400).json({ error: 'page_id must match ^[a-z][a-z0-9_]*$' });
  }
  if (!title || !dag_id || !node_id || !Array.isArray(columns) || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'title, dag_id, node_id, columns[], rows[] required' });
  }
  if (!dag_id.startsWith('dag:')) {
    return res.status(400).json({ error: 'dag_id must start with "dag:"' });
  }

  try {
    if (parent_page_id) {
      const pCheck = await authzPool.query(
        `SELECT 1 FROM authz_ui_page WHERE page_id = $1`,
        [parent_page_id]
      );
      if (pCheck.rowCount === 0) {
        return res.status(400).json({ error: `parent_page_id not found: ${parent_page_id}` });
      }
    }

    const exists = await authzPool.query(
      `SELECT 1 FROM authz_ui_page WHERE page_id = $1`,
      [page_id]
    );
    if (exists.rowCount && !overwrite) {
      return res.status(409).json({
        error: 'page_id already exists',
        hint: 'Pass overwrite:true to replace the existing snapshot.',
      });
    }

    // Normalize columns to ColumnDef shape (key/label/data_type/render).
    // Default render is picked by semantic_type when we have a known mapping.
    const normalizedColumns = columns.map((c) => ({
      key: c.name,
      label: c.name,
      data_type: 'text',
      render: c.semantic_type ? RENDER_BY_SEMANTIC[c.semantic_type] : undefined,
      semantic_type: c.semantic_type,
    }));

    const snapshotData = {
      columns: normalizedColumns,
      rows,
      origin: {
        kind: 'dag',
        dag_id,
        node_id,
        bound_params: bound_params || {},
        captured_by: userId,
        captured_at: new Date().toISOString(),
      },
    };

    if (exists.rowCount && overwrite) {
      await authzPool.query(
        `UPDATE authz_ui_page
            SET title = $2,
                parent_page_id = $3,
                description = $4,
                snapshot_data = $5::jsonb,
                is_active = TRUE
          WHERE page_id = $1`,
        [page_id, title, parent_page_id || null, description || null, JSON.stringify(snapshotData)]
      );
    } else {
      await authzPool.query(
        `INSERT INTO authz_ui_page
           (page_id, title, layout, parent_page_id, description, icon,
            snapshot_data, is_active)
         VALUES ($1, $2, 'table', $3, $4, 'database', $5::jsonb, TRUE)`,
        [page_id, title, parent_page_id || null, description || null, JSON.stringify(snapshotData)]
      );
    }

    logAdminAction(authzPool, {
      userId,
      action: overwrite && exists.rowCount ? 'DAG_SAVE_AS_PAGE_OVERWRITE' : 'DAG_SAVE_AS_PAGE',
      resourceType: 'ui_page',
      resourceId: page_id,
      details: { dag_id, node_id, row_count: rows.length, column_count: columns.length },
      ip: getClientIp(req),
    });

    res.status(exists.rowCount ? 200 : 201).json({
      status: 'ok',
      page_id,
      row_count: rows.length,
      column_count: columns.length,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});
