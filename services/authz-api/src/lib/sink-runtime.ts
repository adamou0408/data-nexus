// ============================================================
// Composer sink runtime (sink-as-node-kind plan §3.3).
//
// MVP supports sink_kind='page' only. The page handler is a refactor of
// the inline body that used to live in dagRouter.post('/save-as-page'),
// extracted so:
//   1. /save-as-page (legacy alias) and /execute-sink (new node-driven
//      path) share one code path; behavior identical
//   2. Future sink_kind values (api / scheduled_job / alert) plug in as
//      additional handler modules without touching the page path
//
// Deliberately *not* introduced here:
//   - Server-side upstream re-execution (snapshot is "what the Curator
//     just saw", not "what's fresh now"); the always-fresh contract is a
//     separate Refresh-sink feature, see plan §3.3 rationale.
//   - sink-as-authz_resource (deferred to saved_view sub-plan, Q4 2026).
// ============================================================
import { Pool } from 'pg';

export const PAGE_ID_RE = /^[a-z][a-z0-9_]*$/;

const RENDER_BY_SEMANTIC: Record<string, string> = {
  status: 'status_badge',
  phase: 'phase_tag',
  gate: 'gate_badge',
};

export interface PageSinkInput {
  page_id: string;
  title: string;
  parent_page_id?: string | null;
  description?: string | null;
  dag_id: string;
  node_id: string;
  bound_params?: Record<string, unknown>;
  columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
  rows: Record<string, unknown>[];
  overwrite?: boolean;
  captured_by: string;
}

export interface PageSinkResult {
  status: 'created' | 'overwritten';
  page_id: string;
  row_count: number;
  column_count: number;
}

export class SinkValidationError extends Error {
  status: number;
  hint?: string;
  constructor(message: string, status = 400, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

// ── Page snapshot handler ──
// Writes (or overwrites) one row in authz_ui_page. Caller is responsible
// for L0 gating + authz inheritance check; this function only validates
// shape and performs the persistence.
export async function emitPageSnapshot(
  pool: Pool,
  input: PageSinkInput,
): Promise<PageSinkResult> {
  const {
    page_id, title, parent_page_id, description,
    dag_id, node_id, bound_params,
    columns, rows, overwrite, captured_by,
  } = input;

  if (!page_id || !PAGE_ID_RE.test(page_id)) {
    throw new SinkValidationError('page_id must match ^[a-z][a-z0-9_]*$');
  }
  if (!title || !dag_id || !node_id || !Array.isArray(columns) || !Array.isArray(rows)) {
    throw new SinkValidationError('title, dag_id, node_id, columns[], rows[] required');
  }
  if (!dag_id.startsWith('dag:')) {
    throw new SinkValidationError('dag_id must start with "dag:"');
  }

  if (parent_page_id) {
    const pCheck = await pool.query(
      `SELECT 1 FROM authz_ui_page WHERE page_id = $1`,
      [parent_page_id]
    );
    if (pCheck.rowCount === 0) {
      throw new SinkValidationError(`parent_page_id not found: ${parent_page_id}`);
    }
  }

  const exists = await pool.query(
    `SELECT 1 FROM authz_ui_page WHERE page_id = $1`,
    [page_id]
  );
  if (exists.rowCount && !overwrite) {
    throw new SinkValidationError(
      'page_id already exists',
      409,
      'Pass overwrite:true to replace the existing snapshot.',
    );
  }

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
      captured_by,
      captured_at: new Date().toISOString(),
    },
  };

  if (exists.rowCount && overwrite) {
    await pool.query(
      `UPDATE authz_ui_page
          SET title = $2,
              parent_page_id = $3,
              description = $4,
              snapshot_data = $5::jsonb,
              is_active = TRUE
        WHERE page_id = $1`,
      [page_id, title, parent_page_id || null, description || null, JSON.stringify(snapshotData)]
    );
    return { status: 'overwritten', page_id, row_count: rows.length, column_count: columns.length };
  }

  await pool.query(
    `INSERT INTO authz_ui_page
       (page_id, title, layout, parent_page_id, description, icon,
        snapshot_data, is_active)
     VALUES ($1, $2, 'table', $3, $4, 'database', $5::jsonb, TRUE)`,
    [page_id, title, parent_page_id || null, description || null, JSON.stringify(snapshotData)]
  );
  return { status: 'created', page_id, row_count: rows.length, column_count: columns.length };
}

// ── Authz derivation: sink inherits upstream fn ancestor's resource_id ──
// Walks the DAG nodes/edges starting from sink_node_id until it hits a node
// whose type is 'fn' (or undefined, treated as fn for legacy DAGs). Returns
// null if no fn ancestor exists (e.g. a sink connected only to a literal
// chain — caller decides policy for that edge case).
export function deriveSinkUpstreamFn(
  nodes: Array<{ id: string; type?: string; data?: { resource_id?: string } }>,
  edges: Array<{ source: string; target: string }>,
  sink_node_id: string,
): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const stack = [sink_node_id];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);

    const node = byId.get(cur);
    if (!node) continue;

    // First fn ancestor wins. node.type undefined in legacy DAGs = fn.
    if (cur !== sink_node_id && (!node.type || node.type === 'fn')) {
      const rid = node.data?.resource_id;
      if (rid) return rid;
    }

    // Push all incoming sources (walk upstream)
    for (const e of edges) {
      if (e.target === cur && !visited.has(e.source)) stack.push(e.source);
    }
  }
  return null;
}
