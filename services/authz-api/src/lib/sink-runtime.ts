// ============================================================
// Composer sink runtime (sink-as-node-kind plan §3.3 +
// sink-as-authz_resource plan).
//
// MVP supports sink_kind='page' only. The page handler is a refactor of
// the inline body that used to live in dagRouter.post('/save-as-page'),
// extracted so:
//   1. /save-as-page (legacy alias) and /execute-sink (new node-driven
//      path) share one code path; behavior identical
//   2. Future sink_kind values (api / scheduled_job / alert) plug in as
//      additional handler modules without touching the page path
//
// V081 dual-write:
//   emitPageSnapshot now writes both authz_ui_page (Tier B snapshot
//   table) AND authz_resource(resource_type='page') in a single tx.
//   Why: bridges the two-tree gap so saved pages show up in
//   ModulesTab + inherit V070 cascade + V079 cascade_policy without a
//   separate primitive. parent_id derivation lives in
//   derivePageParentResource (mirrors dag's parent_id, falls back to
//   module:pg_tiptop_v1 when DAG is orphan).
//
// Deliberately *not* introduced here:
//   - Server-side upstream re-execution (snapshot is "what the Curator
//     just saw", not "what's fresh now"); the always-fresh contract is a
//     separate Refresh-sink feature, see plan §3.3 rationale.
// ============================================================
import { Pool, PoolClient } from 'pg';

// SSOT for sink_kind values consumed by routes/dag.ts (/save-as-page,
// /execute-sink) and lib/dag-validate.ts. Adding a new kind requires:
//   1. Append the literal here
//   2. Add the matching handler module (mirroring emitPageSnapshot below)
//   3. Wire the dispatch in routes/dag.ts
// MVP ships with 'page' only; 'api' / 'scheduled_job' / 'alert' are
// the planned next entries (see file header).
export const SINK_KINDS = ['page'] as const;
export type SinkKind = typeof SINK_KINDS[number];

export function isSinkKind(v: unknown): v is SinkKind {
  return typeof v === 'string' && (SINK_KINDS as readonly string[]).includes(v);
}

export const PAGE_ID_RE = /^[a-z][a-z0-9_]*$/;

const RENDER_BY_SEMANTIC: Record<string, string> = {
  status: 'status_badge',
  phase: 'phase_tag',
  gate: 'gate_badge',
};

const FALLBACK_PAGE_PARENT = 'module:pg_tiptop_v1';

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
  authz_resource_id: string;
  authz_parent_id: string;
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

// ── derivePageParentResource (V081) ──
// Returns the authz_resource.parent_id to attach to the new
// 'page:'+page_id row. Walk order:
//   1. dag_id → authz_resource(resource_type='dag').parent_id
//      (the page lives "under the same module as its DAG")
//   2. fallback FALLBACK_PAGE_PARENT
//
// Why dag.parent_id and not deriveSinkUpstreamFn → fn.parent_id:
//   The DAG itself is the authz boundary the user already navigated.
//   Inheriting from dag.parent_id keeps page-vs-dag siblings under the
//   same module. fn.parent_id may point at db_schema (deeper) which
//   would scatter saved pages across schemas instead of grouping them.
export async function derivePageParentResource(
  client: PoolClient | Pool,
  dag_id: string,
): Promise<string> {
  const r = await client.query(
    `SELECT parent_id FROM authz_resource
      WHERE resource_id = $1 AND resource_type = 'dag'`,
    [dag_id]
  );
  const parent = r.rows[0]?.parent_id;
  return (parent && typeof parent === 'string') ? parent : FALLBACK_PAGE_PARENT;
}

// ── Page snapshot handler ──
// Writes (or overwrites) one row in authz_ui_page AND mirrors it as a
// authz_resource(resource_type='page') row inside the same tx.
// Caller is responsible for L0 gating + authz inheritance check;
// this function only validates shape and performs the persistence.
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

  const authzResourceId = `page:${page_id}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (parent_page_id) {
      const pCheck = await client.query(
        `SELECT 1 FROM authz_ui_page WHERE page_id = $1`,
        [parent_page_id]
      );
      if (pCheck.rowCount === 0) {
        throw new SinkValidationError(`parent_page_id not found: ${parent_page_id}`);
      }
    }

    const exists = await client.query(
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

    const authzParentId = await derivePageParentResource(client, dag_id);
    const authzAttributes = {
      page_id,
      origin_kind: 'dag',
      dag_id,
      node_id,
    };

    let status: 'created' | 'overwritten';
    if (exists.rowCount && overwrite) {
      await client.query(
        `UPDATE authz_ui_page
            SET title = $2,
                parent_page_id = $3,
                description = $4,
                snapshot_data = $5::jsonb,
                is_active = TRUE
          WHERE page_id = $1`,
        [page_id, title, parent_page_id || null, description || null, JSON.stringify(snapshotData)]
      );
      status = 'overwritten';
    } else {
      await client.query(
        `INSERT INTO authz_ui_page
           (page_id, title, layout, parent_page_id, description, icon,
            snapshot_data, is_active)
         VALUES ($1, $2, 'table', $3, $4, 'database', $5::jsonb, TRUE)`,
        [page_id, title, parent_page_id || null, description || null, JSON.stringify(snapshotData)]
      );
      status = 'created';
    }

    // ── Mirror into authz_resource(resource_type='page') ──
    // Upsert so overwrite path also keeps mirror row in sync (parent_id
    // may move if the DAG was reparented since last save).
    //
    // TIER-B-PAGE-RENAME-V01-FU: respect manual_override flags. When a
    // curator has renamed or moved this page via PATCH /modules/pages/:id,
    // the corresponding attributes.manual_override.{display_name|parent_id}
    // flag is set. The sink must NOT silently revert those edits on the
    // next overwrite — otherwise every DAG re-save undoes the curator's
    // catalog work. We preserve the existing field when the flag is true,
    // and carry the manual_override sub-object forward into the new
    // attributes blob so the protection persists across upserts.
    await client.query(
      `INSERT INTO authz_resource
         (resource_id, resource_type, parent_id, display_name, attributes, is_active)
       VALUES ($1, 'page', $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (resource_id) DO UPDATE
         SET parent_id    = CASE
                              WHEN COALESCE((authz_resource.attributes->'manual_override'->>'parent_id')::boolean, FALSE)
                                THEN authz_resource.parent_id
                              ELSE EXCLUDED.parent_id
                            END,
             display_name = CASE
                              WHEN COALESCE((authz_resource.attributes->'manual_override'->>'display_name')::boolean, FALSE)
                                THEN authz_resource.display_name
                              ELSE EXCLUDED.display_name
                            END,
             attributes   = CASE
                              WHEN authz_resource.attributes ? 'manual_override'
                                THEN EXCLUDED.attributes ||
                                     jsonb_build_object('manual_override', authz_resource.attributes->'manual_override')
                              ELSE EXCLUDED.attributes
                            END,
             is_active    = TRUE`,
      [authzResourceId, authzParentId, title, JSON.stringify(authzAttributes)]
    );

    await client.query('COMMIT');

    // module_tree_stats refresh is best-effort outside tx — caller may
    // also trigger via /api/modules; failing here must not 500 the sink.
    pool.query('SELECT refresh_module_tree_stats()').catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[sink-runtime] refresh_module_tree_stats failed:', e?.message);
    });

    return {
      status,
      page_id,
      row_count: rows.length,
      column_count: columns.length,
      authz_resource_id: authzResourceId,
      authz_parent_id: authzParentId,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
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
