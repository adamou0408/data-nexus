// ============================================================
// Server-side DAG executor — DAG-PUBLISH-V01.
//
// Why this exists:
//   /api/dag/execute-node runs ONE node and trusts the client to walk
//   the graph. That is fine for admin authoring (browser drives), but
//   wrong for the published-DAG path: BI_USER never authored anything
//   and is gated at the published_dag resource, not at each upstream
//   fn. We need the server to walk the snapshotted DAG end-to-end.
//
// Fork-A choice (publish = bless):
//   The route /api/config-exec gates on `read on published_dag:<rid>`
//   ONCE before calling this executor. Inside this executor we do NOT
//   call authz_check(execute, function:<rid>) per node — the bless on
//   the published DAG is the only authz boundary, exactly mirroring
//   V044 BIZ-TERM blessed semantics. Column-level masks would still
//   apply on the leaf output (read-side) but are deferred to phase 2;
//   for phase 1 the bless covers the full pipeline output shape.
//
// Plan: .claude/plans/v3-phase-1/dag-publish-v01-plan.md §7
// ============================================================

import { pool as authzPool, getDataSourcePool } from '../db';
import { parseFunctionArgs, ParsedArg, classifyType } from './function-metadata';
import { runOperator, UpstreamFrame, OperatorColumn } from './dag-operators';

const MAX_ROWS = 1000;

// Identifier guard — matches the same shape used in routes/dag.ts.
function quoteIdent(s: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(`Invalid identifier: ${s}`);
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

// ── Snapshot shape (what `dag_snapshot` jsonb on authz_ui_page holds) ──
// At publish time we freeze the dag attributes plus an explicit
// `output_node_id` so downstream readers don't have to re-derive the
// single leaf.

export interface DagNode {
  id: string;
  type?: string;                                                // 'fn' (default) | 'literal' | 'filter' | 'cast' | 'aggregate' | 'sort' | 'limit' | 'projection' | 'sink'
  data: {
    resource_id?: string;                                       // 'function:<schema>.<name>' for fn nodes
    inputs?: Array<{ name: string; semantic_type?: string; kind?: string; pgType?: string; hasDefault?: boolean }>;
    outputs?: Array<{ name: string; semantic_type?: string }>;
    bound_params?: Record<string, unknown>;
    user_input_params?: string[];                               // names of bound_params exposed as form inputs
    expose_output?: boolean;                                    // DAG-PUBLISH-V01-FU: surface this node's frame as an extra output block on the published page (leaf is implicitly always exposed)
    op_kind?: 'literal' | 'filter' | 'cast' | 'aggregate' | 'sort' | 'limit' | 'projection';
    op_config?: Record<string, unknown>;
    arguments?: string;                                         // pg_get_function_arguments output, frozen at save time
  };
}

export interface DagEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface PublishedDagSnapshot {
  data_source_id: string;
  nodes: DagNode[];
  edges: DagEdge[];
  output_node_id: string;                                       // primary leaf — back-compat
  exposed_node_ids?: string[];                                  // DAG-PUBLISH-V01-FU: leaf + admin-flagged intermediate nodes (dedup, ordered: leaf first). Missing → fall back to [output_node_id] for V086 pages.
  // EXPLORER-MODE-V01: 'tabular' = single-leaf result table (V086 default,
  // assumed when missing); 'explorer' = multi-leaf navigable DAG. The field
  // is read by config-exec.ts to surface meta.display_mode to the front-end.
  display_mode?: 'tabular' | 'explorer';
}

// Per-node frame as surfaced to the published page. Same fields as the
// V086 single-leaf result, just keyed by node id so the front-end can
// render multi-output sections.
export interface DagExecOutput {
  columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
}

export interface DagExecResult {
  // V086 back-compat: primary leaf's columns/rows duplicated at top level
  // so existing readers (e.g. config-exec returning `data: result.rows`)
  // keep working without conditional unwrap.
  columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  lineage: Array<{ node_id: string; detail: string }>;
  output_node_id: string;                                       // primary (leaf) — V086 back-compat
  // DAG-PUBLISH-V01-FU: full multi-output map. Always populated; for
  // single-leaf pages it has exactly one key (= output_node_id).
  outputs: Record<string, DagExecOutput>;
  primary_output_node_id: string;
}

export class DagExecError extends Error {
  constructor(public node_id: string, message: string) {
    super(`Node ${node_id}: ${message}`);
    this.name = 'DagExecError';
  }
}

// ── Topological sort (Kahn). Throws on cycle so the executor refuses
// to run a structurally broken snapshot — publish time should already
// have caught this, but keep the check tight so a malformed DB row
// can't hang the API by infinite-looping.
function topoSort(nodes: DagNode[], edges: DagEdge[]): string[] {
  const indeg: Record<string, number> = Object.create(null);
  for (const n of nodes) indeg[n.id] = 0;
  for (const e of edges) {
    if (!(e.target in indeg)) continue;                          // ignore edges pointing at unknown nodes
    indeg[e.target] = (indeg[e.target] || 0) + 1;
  }
  const queue: string[] = [];
  for (const id of Object.keys(indeg)) if (indeg[id] === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const e of edges) {
      if (e.source !== id) continue;
      if (!(e.target in indeg)) continue;
      indeg[e.target] -= 1;
      if (indeg[e.target] === 0) queue.push(e.target);
    }
  }
  if (order.length !== nodes.length) {
    throw new Error('Cycle detected in DAG snapshot — refusing to execute');
  }
  return order;
}

// ── Single-leaf finder (used at publish time, exported for routes/dag.ts).
// "Leaf" = node with outdegree 0, ignoring sink nodes (those are publish-
// time artifacts, not exec-time outputs). Multi-leaf publishes are
// rejected up front; this is Fork B, the single-leaf default.
export function findSingleLeaf(nodes: DagNode[], edges: DagEdge[]): string {
  const sources = new Set(edges.map((e) => e.source));
  const leaves = nodes
    .filter((n) => n.type !== 'sink')
    .filter((n) => !sources.has(n.id))
    .map((n) => n.id);
  if (leaves.length === 0) throw new Error('No leaf found in DAG');
  if (leaves.length > 1) {
    throw new Error(`Multiple leaf nodes: ${leaves.join(', ')}. Publish requires a single output node — converge upstream or remove disconnected leaves in Composer.`);
  }
  return leaves[0];
}

// ── Form-schema derivation. Walks each fn node's user_input_params and
// pulls type / default / required from the parsed args (or inputs, as
// a backstop). Stable order: depth-first by node_id, dedup on name.
export interface FormField {
  name: string;
  type: string;                  // ParamKind from function-metadata
  pg_type?: string;              // raw PG type for client-side coercion
  required: boolean;
  default: unknown;
  help_text?: string;
  source_node_id: string;
}

export function deriveFormSchema(nodes: DagNode[]): FormField[] {
  const schema: FormField[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.type && node.type !== 'fn') continue;
    const userInputs = node.data?.user_input_params || [];
    if (userInputs.length === 0) continue;
    const parsed = parseFunctionArgs(node.data?.arguments || '');
    const parsedByName = new Map<string, ParsedArg>(parsed.map((p) => [p.name, p]));
    const inputs = node.data?.inputs || [];
    const bound = node.data?.bound_params || {};
    for (const name of userInputs) {
      if (seen.has(name)) continue;
      seen.add(name);
      const arg = parsedByName.get(name);
      const inputDef = inputs.find((i) => i.name === name);
      // pgType precedence: parsed args (authoritative, frozen at save) > node.inputs.pgType
      // (which DagTab populates from the same parse). type/kind derives from the same pgType
      // when parsed args are absent (older DAGs that weren't re-saved post-arguments-snapshot).
      const pgType = arg?.pgType || inputDef?.pgType;
      schema.push({
        name,
        type: arg?.kind || (inputDef?.kind as string | undefined) || (pgType ? classifyType(pgType) : 'text'),
        pg_type: pgType,
        required: !(arg?.hasDefault ?? (inputDef?.hasDefault ?? false)),
        default: bound[name] ?? null,
        help_text: inputDef?.semantic_type ? `semantic: ${inputDef.semantic_type}` : undefined,
        source_node_id: node.id,
      });
    }
  }
  return schema;
}

// ── fn-node binding builder. Lifted from routes/dag.ts /execute-node so
// the same precedence (bound > edge > semantic-type > default) applies
// in published-run context. Throws DagExecError on unbound required
// inputs so the caller can map node_id → 4xx response.
function buildFnBinding(
  node: DagNode,
  inbound: DagEdge[],
  frames: Record<string, UpstreamFrame>,
  formInputs: Record<string, unknown>,
  parsed: ParsedArg[],
): { bindList: string[]; values: unknown[]; lineage: Array<{ node_id: string; detail: string }> } {
  const userInputs = new Set(node.data?.user_input_params || []);
  const bound: Record<string, unknown> = { ...(node.data?.bound_params || {}) };
  for (const k of userInputs) {
    if (Object.prototype.hasOwnProperty.call(formInputs, k)) {
      bound[k] = formInputs[k];
    }
  }
  const inputs = node.data?.inputs || [];
  const lineage: Array<{ node_id: string; detail: string }> = [];
  const bindList: string[] = [];
  const values: unknown[] = [];

  for (const arg of parsed) {
    // 1. Explicit bind (constant or form-substituted) wins.
    if (Object.prototype.hasOwnProperty.call(bound, arg.name)) {
      values.push(bound[arg.name]);
      bindList.push(`${quoteIdent(arg.name)} := $${values.length}`);
      lineage.push({ node_id: node.id, detail: `${arg.name}=${userInputs.has(arg.name) ? 'form_input' : 'bound_param'}` });
      continue;
    }
    // 2. Upstream edge whose target handle matches.
    const edge = inbound.find((e) => e.targetHandle === arg.name);
    if (edge) {
      const up = frames[edge.source];
      if (up?.row0 && edge.sourceHandle && edge.sourceHandle in up.row0) {
        values.push(up.row0[edge.sourceHandle]);
        bindList.push(`${quoteIdent(arg.name)} := $${values.length}`);
        lineage.push({ node_id: node.id, detail: `${arg.name}=${edge.source}.${edge.sourceHandle}` });
        continue;
      }
    }
    // 3. Semantic-type match across any upstream frame.
    const wantType = inputs.find((i) => i.name === arg.name)?.semantic_type;
    if (wantType && wantType !== 'unknown') {
      let matched = false;
      for (const [upId, up] of Object.entries(frames)) {
        const col = (up.columns || []).find((c: OperatorColumn) => c.semantic_type === wantType);
        if (col && up.row0 && col.name in up.row0) {
          values.push(up.row0[col.name]);
          bindList.push(`${quoteIdent(arg.name)} := $${values.length}`);
          lineage.push({ node_id: node.id, detail: `${arg.name}=${upId}.${col.name} (semantic:${wantType})` });
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    // 4. PG DEFAULT (skip the bind — named notation lets us omit the param).
    if (arg.hasDefault) {
      lineage.push({ node_id: node.id, detail: `${arg.name}=DEFAULT` });
      continue;
    }
    throw new DagExecError(node.id, `unbound required input '${arg.name}'`);
  }
  return { bindList, values, lineage };
}

// ── Main entry. Topo-walk the snapshot, producing a frame per node.
// Returns the leaf frame as { columns, rows, ... }. The route layer
// is responsible for both the published_dag authz gate AND the audit
// row — this function just runs the pipeline.
export async function executeDagAsPublished(opts: {
  dagSnapshot: PublishedDagSnapshot;
  userId: string;
  groups: string[];
  formInputs: Record<string, unknown>;
  publishedDagRid: string;
}): Promise<DagExecResult> {
  const t0 = Date.now();
  const { dagSnapshot, formInputs } = opts;
  const dsPool = await getDataSourcePool(dagSnapshot.data_source_id);
  const order = topoSort(dagSnapshot.nodes, dagSnapshot.edges);
  const frames: Record<string, UpstreamFrame> = {};
  const lineage: Array<{ node_id: string; detail: string }> = [];

  for (const nodeId of order) {
    const node = dagSnapshot.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    if (node.type === 'sink') continue;                          // sinks are publish-time artifacts

    const inbound = dagSnapshot.edges.filter((e) => e.target === node.id);

    // ─ Operator branch (literal / filter / cast / aggregate) ─
    if (node.type && node.type !== 'fn') {
      const opKind = node.data?.op_kind || (node.type as 'literal' | 'filter' | 'cast' | 'aggregate' | 'sort' | 'limit' | 'projection');
      try {
        const result = runOperator({
          op_kind: opKind,
          op_config: node.data?.op_config || {},
          inbound,
          upstream: frames,
          node_id: node.id,
        });
        frames[node.id] = { columns: result.columns, rows: result.rows, row0: result.rows[0] };
        lineage.push({ node_id: node.id, detail: `op:${opKind} rows=${result.row_count}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DagExecError(node.id, `operator '${opKind}' failed: ${msg}`);
      }
      continue;
    }

    // ─ fn branch ─
    if (!node.data?.resource_id || !node.data.resource_id.startsWith('function:')) {
      throw new DagExecError(node.id, `fn node missing or malformed resource_id: ${node.data?.resource_id}`);
    }

    // Parse args from the snapshot (preferred — frozen at publish time).
    // Fall back to a live read of authz_resource only if the snapshot was
    // saved before we started serializing arguments inline.
    let parsed = parseFunctionArgs(node.data.arguments || '');
    if (parsed.length === 0) {
      const r = await authzPool.query(
        `SELECT attributes->>'arguments' AS args
           FROM authz_resource
          WHERE resource_id = $1 AND resource_type = 'function' AND is_active = TRUE`,
        [node.data.resource_id],
      );
      parsed = parseFunctionArgs(r.rows[0]?.args || '');
    }

    const { bindList, values, lineage: bindLineage } = buildFnBinding(node, inbound, frames, formInputs, parsed);
    lineage.push(...bindLineage);

    const fqName = node.data.resource_id.slice('function:'.length);
    const dotIdx = fqName.indexOf('.');
    if (dotIdx <= 0) throw new DagExecError(node.id, `resource_id '${node.data.resource_id}' missing schema.name`);
    const schema = fqName.slice(0, dotIdx);
    const fnName = fqName.slice(dotIdx + 1);
    const sql = `SELECT * FROM (SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(fnName)}(${bindList.join(', ')})) _x LIMIT ${MAX_ROWS + 1}`;

    let qres;
    try {
      qres = await dsPool.query(sql, values);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DagExecError(node.id, `PG error: ${msg}`);
    }

    const truncated = (qres.rowCount || 0) > MAX_ROWS;
    const rows = truncated ? qres.rows.slice(0, MAX_ROWS) : qres.rows;
    const outputs = node.data.outputs || [];
    const semByName = new Map<string, string>();
    for (const o of outputs) if (o.semantic_type) semByName.set(o.name, o.semantic_type);
    const columns = qres.fields.map((f) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
      semantic_type: semByName.get(f.name),
    }));
    frames[node.id] = { columns, rows, row0: rows[0] };
  }

  const outId = dagSnapshot.output_node_id;
  const out = frames[outId];
  if (!out) {
    throw new DagExecError(outId, 'output node produced no frame (sink-only DAG, or topo skipped it?)');
  }
  const outRows = out.rows || (out.row0 ? [out.row0] : []);

  // Multi-output map (DAG-PUBLISH-V01-FU). Build from exposed_node_ids if
  // present; otherwise emit just the leaf to mirror V086. Filter to ids
  // that actually produced a frame — sinks were skipped, ghost ids would
  // throw — and always force-include the leaf so the primary stays
  // canonical even if a stale snapshot omitted it.
  const exposedIds = Array.isArray(dagSnapshot.exposed_node_ids) && dagSnapshot.exposed_node_ids.length > 0
    ? dagSnapshot.exposed_node_ids
    : [outId];
  const seenOutIds = new Set<string>();
  const orderedExposed: string[] = [];
  // Leaf first so iteration order is stable; admin-flagged intermediates follow.
  for (const id of [outId, ...exposedIds]) {
    if (seenOutIds.has(id)) continue;
    if (!frames[id]) continue;                                  // ghost or sink — skip
    seenOutIds.add(id);
    orderedExposed.push(id);
  }
  const outputs: Record<string, DagExecOutput> = {};
  for (const id of orderedExposed) {
    const frame = frames[id];
    const rows = frame.rows || (frame.row0 ? [frame.row0] : []);
    outputs[id] = {
      columns: (frame.columns || []) as Array<{ name: string; semantic_type?: string; dataTypeID?: number }>,
      rows,
      row_count: rows.length,
      truncated: rows.length >= MAX_ROWS,
    };
  }

  return {
    columns: (out.columns || []) as Array<{ name: string; semantic_type?: string; dataTypeID?: number }>,
    rows: outRows,
    row_count: outRows.length,
    truncated: outRows.length >= MAX_ROWS,
    elapsed_ms: Date.now() - t0,
    lineage,
    output_node_id: outId,
    outputs,
    primary_output_node_id: outId,
  };
}
