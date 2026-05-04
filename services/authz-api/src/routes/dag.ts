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
import { applyAutoCasts, AutoCastInsert } from '../lib/dag-auto-cast';
import { runOperator, deriveOperatorResourceId, UpstreamFrame } from '../lib/dag-operators';
import { emitPageSnapshot, deriveSinkUpstreamFn, SinkValidationError, SINK_KINDS, isSinkKind, type SinkKind } from '../lib/sink-runtime';
import { findSingleLeaf, deriveFormSchema, executeDagAsPublished, PublishedDagSnapshot, DagNode, DagEdge } from '../lib/dag-exec';
import { expandSubdags, SubdagExpansionError, EmbeddedSubdagRecord } from '../lib/dag-subdag-resolver';
import { requireRole } from '../middleware/authz';
import { runOracleDirect, OracleDirectError } from '../lib/oracle-direct';
import { pgTypeToLogical, LogicalType } from '../lib/db-driver';
import { canConnect, pgTypeStringToLogical } from '../lib/logical-type-compat';

// Best-effort Oracle → Postgres type mapping for downstream operators that
// branch on pgType strings (filter casts, sort comparators). Anything not
// listed falls back to text — operators key off column NAMES first, types
// second, so a fallback row still flows correctly through filter/projection.
// (logical_type is the new primary axis — pgType retained for legacy
// operator paths during L1 rollout.)
function oracleTypeToPgType(t?: string): string {
  if (!t) return 'text';
  const u = t.toUpperCase();
  if (u === 'NUMBER' || u === 'BINARY_FLOAT' || u === 'BINARY_DOUBLE' || u === 'FLOAT') return 'numeric';
  if (u === 'DATE' || u.startsWith('TIMESTAMP')) return 'timestamp';
  if (u === 'BLOB' || u === 'RAW' || u === 'LONG RAW') return 'bytea';
  // VARCHAR2, CHAR, NCHAR, NVARCHAR2, CLOB, NCLOB, ROWID, anything else → text
  return 'text';
}

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

// EXPLORER-MODE-V01: tolerant leaf-picker for explorer publish. Tabular still
// uses `findSingleLeaf` (rejects multi-leaf — single result table is the
// renderer contract). Explorer accepts any leaf because `output_node_id`
// becomes vestigial under the explorer renderer (it navigates via
// `exposed_node_ids`); we still need *some* leaf to populate the field for
// type back-compat with V086 consumers. Throws on zero leaves (cycle of
// sinks or empty graph) — that's still a publish-blocking invariant.
// Inlined here per plan §5.2 to avoid widening the dag-exec.ts surface area.
function pickFirstLeafOrThrow(nodes: DagNode[], edges: DagEdge[]): string {
  const hasOutgoing = new Set<string>();
  for (const e of edges) hasOutgoing.add(e.source);
  const leaves = nodes.filter((n) => !hasOutgoing.has(n.id) && n.type !== 'sink');
  if (leaves.length === 0) {
    throw new Error('DAG has no leaf node (every node has an outgoing edge or is a sink)');
  }
  return leaves[0].id;
}

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

// GET /published-list?data_source_id=<id>
// Lists published_dag rids the caller can read, filtered to one ds (subdag
// requires same-ds). Used by DagTab Inspector dropdown.
//
// MUST be registered before `/:id` — Express matches in order, and `/:id`
// would otherwise capture `/published-list` with id='published-list' and 404.
dagRouter.get('/published-list', async (req, res) => {
  const userId = getUserId(req);
  const dsId = req.query.data_source_id as string | undefined;
  try {
    const grpRes = await authzPool.query('SELECT authz_resolve_user_groups($1) AS groups', [userId]);
    const groupsRaw: string[] = grpRes.rows[0]?.groups || [];
    const groups = groupsRaw.map((g) => (g.startsWith('group:') ? g.slice('group:'.length) : g));

    const params: unknown[] = [];
    let sql = `SELECT page.resource_id AS rid,
                      page.published_dag_id,
                      page.title,
                      page.dag_snapshot->>'data_source_id' AS data_source_id,
                      page.dag_snapshot->>'output_node_id' AS output_node_id,
                      page.dag_snapshot->'exposed_node_ids' AS exposed_node_ids
                 FROM authz_ui_page page
                WHERE page.is_active = TRUE
                  AND page.published_dag_id IS NOT NULL`;
    if (dsId) {
      params.push(dsId);
      sql += ` AND page.dag_snapshot->>'data_source_id' = $${params.length}`;
    }
    sql += ` ORDER BY page.title`;
    const { rows } = await authzPool.query(sql, params);

    // App-level authz filter — typical published_dag count is dozens, so
    // N round-trips is fine; revisit if the catalog grows.
    const allowed: typeof rows = [];
    for (const row of rows) {
      const chk = await authzPool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [userId, groups, 'read', row.rid]
      );
      if (chk.rows[0]?.allowed) allowed.push(row);
    }
    res.json({ published_dags: allowed });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Get one DAG ───
dagRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await authzPool.query(
      `SELECT resource_id, display_name, parent_id, attributes
       FROM authz_resource
       WHERE resource_id = $1 AND resource_type = 'dag' AND is_active = TRUE`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'DAG not found' });
    const r = rows[0];
    res.json({
      resource_id: r.resource_id,
      display_name: r.display_name,
      parent_id: r.parent_id,
      ...r.attributes,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Save (create or update) ───
dagRouter.post('/save', requireDagAuthor, async (req, res) => {
  const { resource_id, display_name, data_source_id, nodes, edges, description, auto_cast } = req.body as {
    resource_id?: string;
    display_name: string;
    data_source_id: string;
    nodes: any[];
    edges: any[];
    description?: string;
    /** DAG-AUTOCAST-V01: when true, server inserts visible cast nodes for
     *  whitelist-safe DV-01 mismatches before validation. Default false
     *  (back-compat). Response carries auto_inserted_casts[] when triggered. */
    auto_cast?: boolean;
  };
  const userId = getUserId(req);

  if (!display_name || !data_source_id || !Array.isArray(nodes) || !Array.isArray(edges)) {
    return res.status(400).json({ error: 'display_name, data_source_id, nodes[], edges[] required' });
  }

  // DAG-AUTOCAST-V01: opt-in auto-fix pass before validation.
  // Mismatches outside the safe whitelist (text→number, narrowing, etc.)
  // remain — validation below still rejects them with the original hint.
  let workingNodes = nodes;
  let workingEdges = edges;
  let autoInsertedCasts: AutoCastInsert[] = [];
  if (auto_cast) {
    const fixed = applyAutoCasts({ nodes, edges });
    workingNodes = fixed.doc.nodes;
    workingEdges = fixed.doc.edges;
    autoInsertedCasts = fixed.inserted;
  }

  // FC-VALIDATE-01: refuse to persist structurally invalid DAGs (cycle,
  // type_mismatch, missing_input, unknown_handle). Frontend already calls
  // /validate, but server is SSOT — never trust the client.
  const validation = validateDag({ nodes: workingNodes, edges: workingEdges });
  const errors = validation.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    return res.status(400).json({
      error: 'DAG validation failed',
      issues: errors,
      auto_inserted_casts: autoInsertedCasts,
    });
  }

  const rid = resource_id && resource_id.startsWith('dag:') ? resource_id : `dag:${slugify(display_name)}`;
  const attrs = {
    data_source_id,
    description: description || null,
    nodes: workingNodes,
    edges: workingEdges,
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
      details: {
        data_source_id,
        node_count: workingNodes.length,
        edge_count: workingEdges.length,
        auto_cast_count: autoInsertedCasts.length,
      },
      ip: getClientIp(req),
    });
    res.json({
      status: 'ok',
      resource_id: rid,
      display_name,
      ...attrs,
      auto_inserted_casts: autoInsertedCasts,
    });
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
    data_source_id: string;                          // dag-level default DS (legacy fallback / inspector prefill)
    node: {
      id: string;
      type?: string;                       // 'fn' (default) | 'literal' | 'filter' | 'cast'
      data: {
        resource_id?: string;              // fn nodes only — operator nodes derive from upstream
        // XDB-TIER-B-L2: per-node DS binding. Source-emitting nodes carry
        // their own DS so a single DAG can fan out to multiple databases.
        // Missing → fall back to the top-level data_source_id (legacy).
        data_source_id?: string;
        inputs?: Array<{ name: string; semantic_type?: string; hasDefault?: boolean }>;
        bound_params?: Record<string, unknown>;
        op_kind?: 'literal' | 'filter' | 'cast' | 'aggregate' | 'sort' | 'limit' | 'projection';
        op_config?: Record<string, unknown>;
      };
    };
    upstream: Record<string, UpstreamFrame>;
    edges: Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
    upstream_resources?: Record<string, string>;   // upstream node_id → fn resource_id (for operator authz inheritance)
  };

  const userId = getUserId(req);
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);

  // ── Sub-DAG dispatch (SUBDAG-HANDLE-V01) ──
  // Composer pre-publish preview: load the child published_dag's snapshot and
  // run it via the same executor BI users hit at runtime. Returns the chosen
  // exposed output's frame so the parent's downstream nodes can chain on row0.
  // Authz: caller must have `read` on the child rid (transitive — same gate
  // expandSubdags applies at publish time).
  if (node.type === 'subdag') {
    const subData = node.data as DagNode['data'] & {
      subdag_source_output_node_id?: string;
      bound_subdag_params?: Record<string, unknown>;
    };
    const childRid = subData.resource_id || '';
    if (!childRid.startsWith('published_dag:')) {
      return res.status(400).json({
        error: 'subdag misconfigured',
        detail: `data.resource_id must start with 'published_dag:' (got: ${childRid || 'empty'}). Pick a published_dag in the Inspector.`,
        node_id: node.id,
      });
    }

    try {
      const chk = await authzPool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [userId, groups, 'read', childRid]
      );
      if (!chk.rows[0]?.allowed) {
        audit({
          access_path: 'B', subject_id: userId,
          action_id: 'dag_subdag_exec', resource_id: childRid,
          decision: 'deny', context: { node_id: node.id },
        });
        return res.status(403).json({ error: 'Forbidden', detail: `${userId} lacks read on ${childRid}` });
      }

      const snapRes = await authzPool.query(
        `SELECT dag_snapshot FROM authz_ui_page WHERE resource_id = $1 AND is_active = TRUE`,
        [childRid]
      );
      if (snapRes.rowCount === 0) {
        return res.status(404).json({ error: 'published_dag not found', detail: childRid });
      }
      const childSnap = snapRes.rows[0].dag_snapshot as PublishedDagSnapshot;

      // Same-datasource invariant — mirrors expandSubdags at publish. Different
      // ds in composer test would mean we're querying the wrong PG cluster.
      if (childSnap.data_source_id !== data_source_id) {
        return res.status(400).json({
          error: 'subdag cross-datasource',
          detail: `child ds='${childSnap.data_source_id}' != parent ds='${data_source_id}'`,
          node_id: node.id,
        });
      }

      // Surface bound_subdag_params as formInputs — these override child fn
      // user_input_param defaults exactly the way expandSubdags will demote
      // non-surfaced inputs at publish. Surfaced inputs without a value here
      // fall back to the child fn's own bound default (preview-only behaviour).
      const formInputs: Record<string, unknown> = { ...(subData.bound_subdag_params || {}) };

      const result = await executeDagAsPublished({
        dagSnapshot: childSnap,
        userId, groups,
        formInputs,
        publishedDagRid: childRid,
      });

      // Pick the chosen exposed output (defaults to leaf). Fall back to leaf
      // if curator hasn't picked yet or the picked id was dropped from
      // exposed_node_ids on a re-publish.
      const chosenId = subData.subdag_source_output_node_id || childSnap.output_node_id;
      const out = result.outputs[chosenId] || result.outputs[childSnap.output_node_id];
      if (!out) {
        return res.status(500).json({
          error: 'subdag output missing',
          detail: `no frame for exposed_node_id='${chosenId}' (child leaf='${childSnap.output_node_id}')`,
          node_id: node.id,
        });
      }

      audit({
        access_path: 'B', subject_id: userId,
        action_id: 'dag_subdag_exec', resource_id: childRid,
        decision: 'allow',
        context: {
          data_source_id, node_id: node.id,
          chosen_output: chosenId,
          row_count: out.row_count, elapsed_ms: result.elapsed_ms,
        },
      });

      return res.json({
        status: 'ok',
        node_id: node.id,
        resource_id: childRid,
        columns: out.columns,
        rows: out.rows,
        row_count: out.row_count,
        truncated: out.truncated,
        elapsed_ms: result.elapsed_ms,
        lineage: result.lineage,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: 'Subdag execution failed', detail: msg, node_id: node.id });
    }
  }

  // ── Oracle source dispatch ──
  // Same role as a `fn` source: outputs a frame, no inbound edges. AuthZ +
  // SQL building + READ ONLY enforcement are centralised in runOracleDirect
  // (lib/oracle-direct.ts). Function-scalar kind is rejected here — it
  // returns a single value, not a frame, so it can't feed downstream
  // operators. Use POST /api/data-query/oracle-direct for scalar reads.
  if (node.type === 'oracle-source') {
    const rid = node.data.resource_id || '';
    if (!rid) {
      return res.status(400).json({ error: 'oracle-source requires node.data.resource_id', node_id: node.id });
    }
    // XDB-TIER-B-L2: read-time fan-out for oracle-source — node carries its
    // own ds when present (multi-DS DAG), otherwise the dag-level default.
    const oracleDsId = node.data.data_source_id || data_source_id;
    try {
      const result = await runOracleDirect({
        sourceId: oracleDsId,
        resourceId: rid,
        params: (node.data.bound_params || {}) as Record<string, unknown>,
        limit: MAX_ROWS,
        userId, groups,
        caller: `dag/execute-node:${node.id}`,
      });
      if (result.kind !== 'rowset') {
        return res.status(400).json({
          error: 'oracle-source kind unsupported',
          detail: `function_scalar produces a single value, not a frame. Use a function_table or view resource.`,
          node_id: node.id,
        });
      }
      const enrichedColumns = result.columns.map((c) => ({
        name: c.name,
        logical_type: c.logical_type,
        pgType: oracleTypeToPgType(c.type),
        oracleType: c.type,
      }));
      return res.json({
        status: 'ok',
        node_id: node.id,
        resource_id: result.resourceId,
        target: 'oracle_direct',
        oracle_kind: result.oracleKind,
        columns: enrichedColumns,
        rows: result.rows,
        row_count: result.rowCount,
        truncated: result.truncated,
        elapsed_ms: result.elapsedMs,
        lineage: [{ input: '*', source: `${result.resourceId} (oracle_direct)` }],
      });
    } catch (err) {
      if (err instanceof OracleDirectError) {
        return res.status(err.status).json({
          error: err.message,
          ...(err.detail ? { detail: err.detail } : {}),
          node_id: node.id,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: 'Oracle source execution failed', detail: msg, node_id: node.id });
    }
  }

  // ── Operator dispatch (composer-operator-and-sink plan §3.3) ──
  // Operators inherit AuthZ from the upstream fn whose rows they shape; they
  // do not introduce new data access surface. Audit still fires under the
  // upstream's resource_id for forensic continuity.
  if (node.type && node.type !== 'fn') {
    const opKind = node.data.op_kind || (node.type as 'literal' | 'filter' | 'cast' | 'aggregate' | 'sort' | 'limit' | 'projection');
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

  // XDB-TIER-B-L2: per-node DS resolution (read-time fan-out).
  //   * fn nodes carrying node.data.data_source_id execute against that DS
  //     and have their metadata looked up there.
  //   * Legacy fn nodes (pre-L2) fall back to the dag-level default.
  // The dag-level data_source_id remains required so legacy DAGs without
  // any per-node ds fields still resolve to a single pool.
  const nodeDsId = node.data.data_source_id || data_source_id;

  try {
    // Fetch function metadata — scoped to the node's resolved ds (so a fn
    // existing in DS A but not DS B 404s correctly when the node binds to B).
    const metaResult = await authzPool.query(
      `SELECT resource_id, attributes FROM authz_resource
       WHERE resource_id = $1 AND resource_type = 'function' AND is_active = TRUE
         AND attributes->>'data_source_id' = $2`,
      [node.data.resource_id, nodeDsId]
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
        decision: 'deny', context: { data_source_id: nodeDsId, dag_data_source_id: data_source_id },
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
          // XDB-TIER-B-L3: cross-DB edge boundary check. Reject when both
          // sides have a known logical_type and they're incompatible —
          // surface suggested cast targets so the curator can resolve via
          // an explicit cast operator rather than a silent auto-coerce.
          const upCol = (up.columns || []).find((c) => c.name === matchingEdge.sourceHandle);
          const argInputForLT: any = (fnAttrs.inputs || []).find((i: any) => i.name === arg.name);
          const upLT: LogicalType | undefined =
            upCol?.logical_type || pgTypeStringToLogical(upCol?.pgType);
          const argLT: LogicalType | undefined =
            argInputForLT?.logical_type || pgTypeStringToLogical(argInputForLT?.pgType);
          if (upLT && argLT && upLT !== 'unknown' && argLT !== 'unknown') {
            const verdict = canConnect(upLT, argLT);
            if (!verdict.ok) {
              return res.status(422).json({
                error: 'type-mismatch',
                from: upLT,
                to: argLT,
                suggestedCast: verdict.needCast || ['string'],
                hint: `Insert a cast operator with target_logical_type=${(verdict.needCast || ['string'])[0]}`,
                node_id: node.id,
                input: arg.name,
                source: `${matchingEdge.source}.${matchingEdge.sourceHandle}`,
              });
            }
          }
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

    const dsPool = await getDataSourcePool(nodeDsId);
    const t0 = Date.now();
    const qres = await dsPool.query(sql, values);
    const elapsedMs = Date.now() - t0;

    const truncated = (qres.rowCount || 0) > MAX_ROWS;
    const rows = truncated ? qres.rows.slice(0, MAX_ROWS) : qres.rows;
    const columns = qres.fields.map((f) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
      logical_type: pgTypeToLogical(f.dataTypeID),
    }));

    // Decorate columns with semantic_type from function metadata
    const outputs = fnAttrs.outputs || [];
    const semanticByName = new Map<string, string>();
    for (const o of outputs) if (o.semantic_type) semanticByName.set(o.name, o.semantic_type);
    const enrichedColumns = columns.map((c) => ({ ...c, semantic_type: semanticByName.get(c.name) }));

    audit({
      access_path: 'B', subject_id: userId,
      action_id: 'dag_node_exec', resource_id: node.data.resource_id,
      decision: 'allow',
      // XDB-TIER-B-L2: log both resolved (node) and dag-level ds so cross-DS
      // forensics can tell which actual cluster served the row.
      context: { data_source_id: nodeDsId, dag_data_source_id: data_source_id, node_id: node.id, row_count: rows.length, elapsed_ms: elapsedMs },
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
    sink_kind: SinkKind;
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
  if (!isSinkKind(sink_kind)) {
    return res.status(400).json({
      error: `unsupported sink_kind '${sink_kind}' (supported: ${SINK_KINDS.join(', ')})`,
    });
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
    page_id, title, parent_page_id, parent_module_id, description,
    overwrite, grant_read_to_roles, display_mode,
  } = req.body as {
    page_id?: string;
    title?: string;
    parent_page_id?: string;
    // PUB-PAGES-ADMIN-V01 Part A: catalog-tree parent for the page mirror
    // (`authz_resource.parent_id`). Distinct from `parent_page_id` which is
    // the legacy renderer drilldown (`authz_ui_page.parent_page_id`). When
    // omitted, falls back to the DAG's own parent (existing behavior).
    parent_module_id?: string;
    description?: string;
    overwrite?: boolean;
    grant_read_to_roles?: string[];
    // EXPLORER-MODE-V01: 'tabular' (default, V086 single-leaf table) or
    // 'explorer' (multi-leaf navigable DAG). Validated as enum below; the
    // value is persisted in dag_snapshot for config-exec to surface back.
    display_mode?: 'tabular' | 'explorer';
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
  // EXPLORER-MODE-V01: enum validation. Default 'tabular' keeps V086 publish
  // semantics (single-leaf table) — explorer is opt-in only.
  const displayMode: 'tabular' | 'explorer' = display_mode ?? 'tabular';
  if (displayMode !== 'tabular' && displayMode !== 'explorer') {
    return res.status(400).json({ error: `display_mode must be 'tabular' or 'explorer'` });
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
    const authoredNodes: DagNode[] = attrs.nodes || [];
    const authoredEdges: DagEdge[] = attrs.edges || [];
    const dataSourceId = attrs.data_source_id as string;
    if (!dataSourceId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'DAG has no data_source_id — cannot publish' });
    }

    // 1b. SUBDAG-EMBED-V01: inline-expand any subdag-typed nodes into a flat
    // (nodes, edges) the rest of publish (validator, single-leaf, dag-exec)
    // operates on without modification.
    let nodes: DagNode[];
    let edges: DagEdge[];
    let embeddedSubdags: EmbeddedSubdagRecord[];
    try {
      const expanded = await expandSubdags({
        parentNodes: authoredNodes,
        parentEdges: authoredEdges,
        parentDataSourceId: dataSourceId,
        blessedBy: userId,
        client,
      });
      nodes = expanded.nodes;
      edges = expanded.edges;
      embeddedSubdags = expanded.embedded_subdags;
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof SubdagExpansionError) {
        const status = err.reason === 'authz_denied' ? 403
          : err.reason === 'not_found' ? 404
          : 400;
        return res.status(status).json({
          error: err.message,
          subdag_node_id: err.subdag_node_id,
          reason: err.reason,
        });
      }
      throw err;
    }

    // 2. Output-leaf resolution + structural validation (refuses cycle).
    // EXPLORER-MODE-V01: tabular keeps the V086 single-leaf invariant (so the
    // existing table renderer always has one definitive output). Explorer
    // tolerates multiple leaves — we only need *some* leaf to populate the
    // legacy `output_node_id` slot (vestigial for explorer; the renderer
    // navigates via `exposed_node_ids` instead). Both modes still reject
    // a leafless graph (which means a cycle of sinks or empty DAG).
    let outputNodeId: string;
    try {
      if (displayMode === 'tabular') {
        outputNodeId = findSingleLeaf(nodes, edges);
      } else {
        outputNodeId = pickFirstLeafOrThrow(nodes, edges);
      }
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
    // Tabular (DAG-PUBLISH-V01-FU): opt-in — leaf + admin-flagged intermediate
    // nodes (`expose_output: true`).
    // Explorer (EXPLORER-MODE-V01): opt-out — every non-sink node is exposed
    // unless explicitly hidden via `expose_output === false`. The two modes
    // share the same `exposed_node_ids` field shape but have inverted defaults
    // because explorer's UX is "navigate any node" while tabular is "view a
    // single result table with optional drill-ins".
    // Filter to present node ids to defend against ghost flags from a stale
    // client payload, and skip sinks (publish-time artifacts, not runtime
    // outputs) in both modes.
    const presentNodeIds = new Set(nodes.map((n) => n.id));
    const exposedNodeIds: string[] = [outputNodeId];
    if (displayMode === 'tabular') {
      for (const n of nodes) {
        if (n.id === outputNodeId) continue;
        if (n.type === 'sink') continue;
        if (!n.data?.expose_output) continue;
        if (!presentNodeIds.has(n.id)) continue;
        exposedNodeIds.push(n.id);
      }
    } else {
      for (const n of nodes) {
        if (n.id === outputNodeId) continue;
        if (n.type === 'sink') continue;
        // Opt-out: only `expose_output === false` hides the node. `undefined`
        // and `true` both expose, matching explorer's "show everything by
        // default" intent.
        if (n.data?.expose_output === false) continue;
        if (!presentNodeIds.has(n.id)) continue;
        exposedNodeIds.push(n.id);
      }
    }
    const dagSnapshot = {
      data_source_id: dataSourceId,
      nodes,
      edges,
      output_node_id: outputNodeId,
      exposed_node_ids: exposedNodeIds,
      // EXPLORER-MODE-V01: persist the mode so config-exec can surface
      // `meta.display_mode` to the front-end without re-deriving from edges.
      display_mode: displayMode,
      // SUBDAG-EMBED-V01: current-state index for inverse lookup
      // (`/api/dag/published/:rid/embedders`). Populated only when this
      // parent embeds at least one child; absent for plain DAGs.
      ...(embeddedSubdags.length > 0 ? { embedded_subdags: embeddedSubdags } : {}),
    };

    // 5. parent_page_id existence check (if provided).
    if (parent_page_id) {
      const pCheck = await client.query(`SELECT 1 FROM authz_ui_page WHERE page_id = $1`, [parent_page_id]);
      if (pCheck.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `parent_page_id not found: ${parent_page_id}` });
      }
    }

    // 5b. PUB-PAGES-ADMIN-V01 Part A: parent_module_id (catalog-tree parent
    // for the page mirror). Validate it points at a real active module.
    if (parent_module_id) {
      const mCheck = await client.query(
        `SELECT 1 FROM authz_resource
          WHERE resource_id = $1 AND resource_type = 'module' AND is_active = TRUE`,
        [parent_module_id]
      );
      if (mCheck.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `parent_module_id not found or inactive: ${parent_module_id}` });
      }
    }

    // 6. FK-safe ordering: insert authz_resource rows BEFORE the
    // authz_ui_page row that references them via resource_id +
    // published_dag_id. The publish-mode mutex constraint
    // (authz_ui_page_publish_mode_check) lives on the page row and
    // enforces snapshot/published exclusivity.
    const publishedDagRid = `published_dag:${dagId}`;
    const pageRid = `page:${page_id}`;
    // Curator-chosen catalog parent wins; falls back to DAG's own parent;
    // last-resort default keeps demo seed flow unchanged.
    const pageParent = parent_module_id || dagParent || 'module:pg_tiptop_v1';

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
        exposed_node_ids: exposedNodeIds,
        // EXPLORER-MODE-V01: capture mode for forensics — same publish
        // primitive can now produce two renderer-distinct artifacts.
        display_mode: displayMode,
        embedded_subdag_rids: embeddedSubdags.map((e) => ({ subdag_node_id: e.subdag_node_id, rid: e.child_rid })),
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
        exposed_node_ids: exposedNodeIds,
        // EXPLORER-MODE-V01: parallels the audit() context above. Mirrored
        // into the admin-action ledger so audit dashboards can filter on it.
        display_mode: displayMode,
        embedded_subdag_rids: embeddedSubdags.map((e) => ({ subdag_node_id: e.subdag_node_id, rid: e.child_rid })),
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
      exposed_node_ids: exposedNodeIds,
      embedded_subdags: embeddedSubdags,
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

// ─── DAG-SUBDAG-EMBED-V01: discovery endpoints for the Composer subdag picker ───
// (See `/published-list` above — registered before `/:id` to avoid shadowing.)
// The two routes below are safe here: their `/published/:rid/...` shape has a
// trailing segment, so `/:id` cannot match.

// GET /published/:rid/snapshot-meta
// Returns metadata the Composer needs to wire a subdag node: data source,
// exposed outputs, and form schema (so parent admin can pick which child
// inputs to surface). Caller must have `read` on the rid.
dagRouter.get('/published/:rid/snapshot-meta', async (req, res) => {
  const rid = req.params.rid;
  const userId = getUserId(req);
  try {
    const grpRes = await authzPool.query('SELECT authz_resolve_user_groups($1) AS groups', [userId]);
    const groupsRaw: string[] = grpRes.rows[0]?.groups || [];
    const groups = groupsRaw.map((g) => (g.startsWith('group:') ? g.slice('group:'.length) : g));

    const chk = await authzPool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [userId, groups, 'read', rid]
    );
    if (!chk.rows[0]?.allowed) {
      return res.status(403).json({ error: `Forbidden: ${userId} lacks read on ${rid}` });
    }

    const { rows } = await authzPool.query(
      `SELECT page_id, title, published_dag_id,
              dag_snapshot->>'data_source_id' AS data_source_id,
              dag_snapshot->>'output_node_id' AS output_node_id,
              dag_snapshot->'exposed_node_ids' AS exposed_node_ids,
              dag_snapshot AS dag_snapshot,
              form_schema
         FROM authz_ui_page
        WHERE resource_id = $1 AND is_active = TRUE`,
      [rid]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: `published_dag not found: ${rid}` });
    }
    const row = rows[0];
    // SUBDAG-HANDLE-V01: surface column-shaped outputs for each exposed node so
    // the parent Composer can render per-column source handles on the subdag node
    // (instead of the legacy single-`__downstream` placeholder). The parent
    // curator wires column→fn-input edges; expandSubdags rewrites only `source`
    // at publish time, leaving curator-supplied sourceHandle column names intact.
    const snap = row.dag_snapshot || {};
    const exposedIds: string[] = Array.isArray(snap.exposed_node_ids) && snap.exposed_node_ids.length > 0
      ? snap.exposed_node_ids
      : (snap.output_node_id ? [snap.output_node_id] : []);
    const exposed_outputs: Record<string, Array<{ name: string; semantic_type?: string; pgType?: string }>> = {};
    for (const id of exposedIds) {
      const node = (snap.nodes || []).find((n: { id: string }) => n.id === id);
      const outs = node?.data?.outputs || [];
      exposed_outputs[id] = outs.map((o: { name: string; semantic_type?: string; pgType?: string }) => ({
        name: o.name,
        semantic_type: o.semantic_type,
        pgType: o.pgType,
      }));
    }
    // Strip dag_snapshot from response — it's an internal helper, not part of the
    // external contract; clients should never read child internals directly.
    const { dag_snapshot: _omit, ...rest } = row;
    res.json({ ...rest, exposed_outputs });
  } catch (err) {
    handleApiError(res, err);
  }
});

// GET /published/:rid/embedders
// Inverse query: which parent published_dags currently embed this child?
// Backend SSOT for family-tree v01 — UI (cascade impact, re-publish notify)
// will read from this endpoint. Caller must have `read` on the child rid.
dagRouter.get('/published/:rid/embedders', async (req, res) => {
  const rid = req.params.rid;
  const userId = getUserId(req);
  try {
    const grpRes = await authzPool.query('SELECT authz_resolve_user_groups($1) AS groups', [userId]);
    const groupsRaw: string[] = grpRes.rows[0]?.groups || [];
    const groups = groupsRaw.map((g) => (g.startsWith('group:') ? g.slice('group:'.length) : g));

    const chk = await authzPool.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [userId, groups, 'read', rid]
    );
    if (!chk.rows[0]?.allowed) {
      return res.status(403).json({ error: `Forbidden: ${userId} lacks read on ${rid}` });
    }

    // JSONB containment: any parent whose embedded_subdags array contains
    // an element with child_rid matching the queried rid.
    const filter = JSON.stringify([{ child_rid: rid }]);
    const { rows } = await authzPool.query(
      `SELECT page.page_id            AS parent_page_id,
              page.resource_id        AS parent_published_dag_rid,
              page.published_dag_id   AS parent_published_dag_id,
              page.title              AS parent_title,
              embed.value->>'subdag_node_id' AS embedded_at_node_id,
              embed.value->>'child_output_node_id' AS child_output_node_id,
              embed.value->'child_user_inputs_surfaced' AS child_user_inputs_surfaced
         FROM authz_ui_page page,
              LATERAL jsonb_array_elements(page.dag_snapshot->'embedded_subdags') AS embed(value)
        WHERE page.is_active = TRUE
          AND page.dag_snapshot->'embedded_subdags' @> $1::jsonb
          AND embed.value->>'child_rid' = $2
        ORDER BY page.title`,
      [filter, rid]
    );
    res.json({ child_rid: rid, parents: rows });
  } catch (err) {
    handleApiError(res, err);
  }
});
