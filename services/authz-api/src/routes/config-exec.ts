import { Router, Request, Response } from 'express';
import { pool, getDataSourcePool, resolveDataSource } from '../db';
import { buildMaskedSelect, ColumnDef } from '../lib/masked-query';
import { handleApiError } from '../lib/request-helpers';
import { audit } from '../audit';
import { executeDagAsPublished, DagExecError, PublishedDagSnapshot, DagExecOutput } from '../lib/dag-exec';
import { applyColumnRenamesToFrame } from '../lib/dag-publish';

export const configExecRouter = Router();

// ============================================================
// POST /root — Card grid landing page (dynamic from authz_ui_page)
// ============================================================
configExecRouter.post('/root', async (req: Request, res: Response) => {
  const user = (req as any).authzUser;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const result = await pool.query(
      'SELECT fn_ui_root($1, $2) AS payload',
      [user.user_id, user.groups]
    );

    const payload = result.rows[0]?.payload;
    if (!payload) {
      return res.status(404).json({ error: 'No root config found' });
    }

    res.json(payload);
  } catch (err) {
    handleApiError(res, err);
  }
});

// ============================================================
// POST / — Execute a page by page_id
// Orchestrates: config from authz_ui_page → permission check →
//   columns from information_schema → masks from authz_resolve() →
//   filters from DISTINCT → data from nexus_data
// ============================================================
configExecRouter.post('/', async (req: Request, res: Response) => {
  const user = (req as any).authzUser;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { page_id, params } = req.body;
  if (!page_id || typeof page_id !== 'string') {
    return res.status(400).json({ error: 'page_id is required' });
  }

  // Validate page_id format. Two accepted shapes:
  //   1. Hand-seeded: `^[a-z][a-z0-9_]*$` — original convention (e.g. modules_home).
  //   2. BU-08 auto-generated: `auto:<source_id>:<schema>.<table>` — namespace
  //      isolated from hand-seeded pages, source_id may contain `-` (slug shape).
  // Both go through parameterized SQL (`fn_ui_page($1)`); regex is defense-in-depth.
  const validHandSeeded = /^[a-z][a-z0-9_]*$/.test(page_id);
  const validAuto = /^auto:[a-zA-Z0-9_-]+:[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(page_id);
  if (!validHandSeeded && !validAuto) {
    return res.status(400).json({ error: 'Invalid page_id format' });
  }

  try {
    // Step 1: Get page config from authz_ui_page via fn_ui_page()
    const configResult = await pool.query(
      'SELECT fn_ui_page($1) AS payload',
      [page_id]
    );

    const payload = configResult.rows[0]?.payload;
    if (!payload || !payload.config) {
      return res.status(404).json({ error: `Page not found: ${page_id}` });
    }

    const config = payload.config;

    // Step 2: Permission check via authz_check() (SSOT from authz_role_permission)
    if (config.resource_id) {
      const checkResult = await pool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [user.user_id, user.groups, 'read', config.resource_id]
      );
      if (!checkResult.rows[0].allowed) {
        audit({
          access_path: 'A',
          subject_id: user.user_id,
          action_id: 'read',
          resource_id: config.resource_id,
          decision: 'deny',
          context: { page_id, reason: 'authz_check_failed' },
        });
        return res.status(403).json({
          error: 'Forbidden',
          detail: `${user.user_id} lacks read access to ${config.resource_id}`,
        });
      }
    }

    // Step 3a-pre: Published-DAG live pages (DAG-PUBLISH-V01).
    // Mutually exclusive with snapshot_data via authz_ui_page_publish_mode_check.
    // First call (no params, or empty params) returns the form_schema so the
    // client can render the form before the user submits. Subsequent calls
    // with a non-empty `params` object execute the snapshotted DAG live, with
    // BI_USER's identity scoping the per-row mask layer (phase 2).
    //
    // Authz: step 2 above already gated `read` on config.resource_id, which
    // for published pages points at `published_dag:<dag_id>`. No additional
    // check here — the bless gate is the boundary.
    if (config.published_dag_id && config.dag_snapshot) {
      const snapshot = config.dag_snapshot as PublishedDagSnapshot & {
        cached_outputs?: {
          outputs: Record<string, DagExecOutput>;
          primary_output_node_id: string;
          frozen_form_inputs?: Record<string, unknown>;
          row_count: number;
          truncated: boolean;
        };
        cached_at?: string;
        cached_columns?: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
      };
      const formInputs = (params && typeof params === 'object') ? params : {};
      const hasInputs = Object.keys(formInputs).length > 0;

      // XDB-TIER-B-L4: render_mode + column_renames live as page-level columns
      // (V092). fn_ui_page surfaces them on the config payload; default
      // 'snapshot' for legacy rows that pre-date V092. Empty {} means no
      // renames need to be applied.
      const renderMode: 'snapshot' | 'live' = (config.render_mode === 'live' ? 'live' : 'snapshot');
      const columnRenames: Record<string, string> = (config.column_renames && typeof config.column_renames === 'object')
        ? (config.column_renames as Record<string, string>)
        : {};
      // Legacy fallback: rows published before V092 have no `cached_outputs`,
      // so even if their (defaulted) render_mode is 'snapshot' we behave like
      // live mode — re-execute on every render. The migration comment notes
      // this explicitly.
      const hasCachedOutputs = renderMode === 'snapshot'
        && snapshot.cached_outputs
        && typeof snapshot.cached_outputs === 'object'
        && snapshot.cached_outputs.outputs;

      // EXPLORER-MODE-V01 Phase B: explorer renderer needs the edge list and
      // exposed-node set client-side to compute drill candidates per cell.
      // We surface them only when display_mode === 'explorer' so V086
      // tabular pages stay byte-cheap. snapshot.edges is already the
      // frozen, sanitised shape we want to pass through verbatim.
      const isExplorer = snapshot.display_mode === 'explorer';
      const explorerMeta = isExplorer
        ? {
            edges: (snapshot.edges || []).map((e) => ({
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle ?? null,
              targetHandle: e.targetHandle ?? null,
            })),
            exposed_node_ids: snapshot.exposed_node_ids || [snapshot.output_node_id],
          }
        : {};

      // XDB-TIER-B-L4.3: helper — apply column_renames map to a multi-output
      // bundle (used by both snapshot and live branches so the consumer-side
      // flat namespace is always renamed-per-publish-time-choice).
      const applyRenames = (outputs: Record<string, DagExecOutput>): Record<string, DagExecOutput> => {
        if (!columnRenames || Object.keys(columnRenames).length === 0) return outputs;
        const renamed: Record<string, DagExecOutput> = {};
        for (const [nodeId, frame] of Object.entries(outputs)) {
          const r = applyColumnRenamesToFrame(nodeId, frame.columns, frame.rows, columnRenames);
          renamed[nodeId] = {
            columns: r.columns,
            rows: r.rows,
            row_count: r.rows.length,
            truncated: frame.truncated,
          };
        }
        return renamed;
      };

      // XDB-TIER-B-L4.1: SNAPSHOT mode fast-path. When the page was published
      // with `render_mode='snapshot'` AND has frozen `cached_outputs`, return
      // those rows directly — no DAG re-execute, no per-render authz_check
      // beyond the bless-gate above. The frozen form inputs are surfaced in
      // meta so the front-end can show "rendered with these values at
      // <cached_at>". A page with form_schema=[] (parameterless snapshot)
      // simply lands straight on the data view.
      if (hasCachedOutputs) {
        const cached = snapshot.cached_outputs!;
        const renamedOutputs = applyRenames(cached.outputs);
        const primaryId = cached.primary_output_node_id || snapshot.output_node_id;
        const primaryFrame = renamedOutputs[primaryId];
        audit({
          access_path: 'A',
          subject_id: user.user_id,
          action_id: 'read',
          resource_id: config.resource_id || `published_dag:${config.published_dag_id}`,
          decision: 'allow',
          context: {
            page_id, mode: 'published_dag', stage: 'snapshot_render',
            row_count: primaryFrame?.row_count ?? 0,
            cached_at: snapshot.cached_at,
          },
        });
        return res.json({
          config: { ...config, columns: primaryFrame?.columns || snapshot.cached_columns || [] },
          data: primaryFrame?.rows || [],
          meta: {
            published_dag: true,
            stage: 'snapshot_render',
            render_mode: 'snapshot',
            cached_at: snapshot.cached_at,
            form_schema: config.form_schema || [],
            frozen_form_inputs: cached.frozen_form_inputs,
            output_node_id: primaryId,
            row_count: primaryFrame?.row_count ?? 0,
            truncated: primaryFrame?.truncated ?? false,
            outputs: renamedOutputs,
            primary_output_node_id: primaryId,
            display_mode: snapshot.display_mode || 'tabular',
            column_renames: columnRenames,
            ...explorerMeta,
          },
        });
      }

      if (!hasInputs) {
        // First-load: hand the form schema back, rows empty.
        audit({
          access_path: 'A',
          subject_id: user.user_id,
          action_id: 'read',
          resource_id: config.resource_id || `published_dag:${config.published_dag_id}`,
          decision: 'allow',
          context: { page_id, mode: 'published_dag', stage: 'form_load', render_mode: renderMode },
        });
        return res.json({
          config: { ...config, columns: [] },
          data: [],
          meta: {
            published_dag: true,
            stage: 'form_load',
            render_mode: renderMode,
            form_schema: config.form_schema || [],
            // EXPLORER-MODE-V01: surface mode at form_load so the front-end
            // can choose its renderer before the user submits. V086 snapshots
            // lack the field — default to 'tabular' (the historical behavior).
            display_mode: snapshot.display_mode || 'tabular',
            column_renames: columnRenames,
            ...explorerMeta,
          },
        });
      }

      try {
        // XDB-TIER-B-L4.1: LIVE mode (and legacy snapshot fallback when
        // cached_outputs is absent) — re-execute under caller's identity.
        // dag-exec already pulls per-node DS pools (L2), so cross-DS DAGs
        // run each fn against the right pool. authz is the bless-gate above
        // (Fork A); per-node authz_check is intentionally not added — the
        // bless covers the full pipeline shape.
        const result = await executeDagAsPublished({
          dagSnapshot: snapshot,
          userId: user.user_id,
          groups: user.groups,
          formInputs,
          publishedDagRid: config.resource_id || `published_dag:${config.published_dag_id}`,
        });
        // XDB-TIER-B-L4.3: apply column_renames to multi-output map AND to
        // the V086-flat result (back-compat: top-level columns/rows still
        // mirror the primary frame).
        const renamedOutputs = applyRenames(result.outputs);
        const primaryFrame = renamedOutputs[result.primary_output_node_id];
        audit({
          access_path: 'A',
          subject_id: user.user_id,
          action_id: 'read',
          resource_id: config.resource_id || `published_dag:${config.published_dag_id}`,
          decision: 'allow',
          context: {
            page_id, mode: 'published_dag', stage: 'exec',
            render_mode: renderMode,
            row_count: result.row_count,
            elapsed_ms: result.elapsed_ms,
            output_node_id: result.output_node_id,
          },
        });
        return res.json({
          config: { ...config, columns: primaryFrame?.columns || result.columns },
          data: primaryFrame?.rows || result.rows,
          meta: {
            published_dag: true,
            stage: 'exec',
            render_mode: renderMode,
            form_schema: config.form_schema || [],
            output_node_id: result.output_node_id,
            row_count: result.row_count,
            truncated: result.truncated,
            elapsed_ms: result.elapsed_ms,
            lineage: result.lineage,
            // DAG-PUBLISH-V01-FU: multi-output map. The front-end's
            // PublishedDagPage renders one section per key; falls back to
            // single-table mode if `outputs` is absent (shouldn't happen
            // post-FU, but kept for resilience).
            outputs: renamedOutputs,
            primary_output_node_id: result.primary_output_node_id,
            // EXPLORER-MODE-V01: same default-to-'tabular' rule as form_load
            // so the front-end's exec-stage renderer matches the form-stage
            // choice without a second source of truth.
            display_mode: snapshot.display_mode || 'tabular',
            column_renames: columnRenames,
            // Phase B: surface edges + exposed_node_ids only for explorer
            // pages — tabular renderer doesn't read them.
            ...explorerMeta,
          },
        });
      } catch (err) {
        if (err instanceof DagExecError) {
          audit({
            access_path: 'A',
            subject_id: user.user_id,
            action_id: 'read',
            resource_id: config.resource_id || `published_dag:${config.published_dag_id}`,
            decision: 'deny',
            context: { page_id, mode: 'published_dag', stage: 'exec_error', node_id: err.node_id, detail: err.message },
          });
          return res.status(400).json({
            error: 'Published DAG execution failed',
            node_id: err.node_id,
            detail: err.message,
          });
        }
        return handleApiError(res, err);
      }
    }

    // Step 3a: Snapshot pages (DAG-SAVE-PAGE-01).
    // When `snapshot_data` is set, the page renders cached rows from a prior
    // DAG node run. No data_table dispatch, no information_schema scan, no
    // mask resolution — the snapshot was captured under the saver's identity
    // at save time; future Path B work will re-execute the DAG live and
    // re-apply masks per viewer.
    if (config.snapshot_data) {
      const snap = config.snapshot_data;
      audit({
        access_path: 'A',
        subject_id: user.user_id,
        action_id: 'read',
        resource_id: config.resource_id || `page:${page_id}`,
        decision: 'allow',
        context: { page_id, source: 'snapshot', row_count: (snap.rows || []).length },
      });
      return res.json({
        config: { ...config, columns: snap.columns || [] },
        data: snap.rows || [],
        meta: {
          totalCount: (snap.rows || []).length,
          filteredCount: (snap.rows || []).length,
          snapshot: true,
          origin: snap.origin,
        },
      });
    }

    // Step 3: If no data_table, return config only (e.g., card_grid sub-pages)
    if (!config.data_table) {
      // For card_grid pages, populate components from child pages
      if (config.layout === 'card_grid') {
        const childResult = await pool.query(`
          SELECT page_id, title, description, icon, display_order
          FROM authz_ui_page
          WHERE parent_page_id = $1 AND is_active
            AND (resource_id IS NULL OR authz_check($2, $3, 'read', resource_id))
          ORDER BY display_order
        `, [page_id, user.user_id, user.groups]);
        config.components = childResult.rows.map((r: any) => ({
          type: 'metric_card',
          page_id: r.page_id,
          label: r.title,
          description: r.description,
          icon: r.icon,
          display_order: r.display_order,
          drilldown: { page_id: r.page_id },
        }));
      }
      return res.json({ config, data: [], meta: {} });
    }

    const table = config.data_table;

    // Step 4: Resolve data source pool (SSOT from authz_data_source).
    // ARCH-02 (2026-05-04): the authz_resource MUST carry
    // attributes->>'data_source_id'. The historical fallback to the
    // internal nexus_data pool was removed — Path A pages that don't
    // bind to a data_source_id now return HTTP 400 instead of silently
    // running against an internal infra DB.
    const sourceId = await resolveDataSource(table);
    if (!sourceId) {
      return res.status(400).json({
        error: 'data_source_id missing on authz_resource',
        hint: `Set authz_resource.attributes->>'data_source_id' for table:${table} (e.g. "ds:pg_k8"). Fallback removed in ARCH-02.`,
      });
    }
    const dataPool = await getDataSourcePool(sourceId);

    // Step 5: Build extra WHERE from drill-down params
    const extraWhere = buildExtraWhere(params, table, dataPool);

    // Step 6: Execute masked query (columns from information_schema, masks from authz_resolve)
    const queryResult = await buildMaskedSelect({
      authzPool: pool,
      dataPool,
      table,
      userId: user.user_id,
      groups: user.groups,
      extraWhere: await extraWhere,
      orderBy: config.order_by || 'created_at DESC',
      limit: config.row_limit || 1000,
      columnsOverride: config.columns_override || {},
    });

    // Step 7: Get dynamic filter options (SSOT: validColumns from buildMaskedSelect)
    const filtersConfig = config.filters_config || [];
    const filtersWithOptions = await resolveFilterOptions(dataPool, table, filtersConfig, queryResult.validColumns);

    // Step 8: Merge into config and return
    config.columns = queryResult.columns;
    config.filters = filtersWithOptions;

    audit({
      access_path: 'A',
      subject_id: user.user_id,
      action_id: 'read',
      resource_id: config.resource_id || `table:${table}`,
      decision: 'allow',
      context: {
        page_id,
        table,
        source_id: sourceId,
        row_count: queryResult.rows.length,
        filtered_count: queryResult.filteredCount,
        total_count: queryResult.totalCount,
      },
    });

    res.json({
      config,
      data: queryResult.rows,
      meta: {
        filteredCount: queryResult.filteredCount,
        totalCount: queryResult.totalCount,
        columnMasks: queryResult.columnMasks,
        resolvedRoles: queryResult.resolvedRoles,
        filterClause: queryResult.filterClause,
      },
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ============================================================
// Helper: Build WHERE clause from drill-down params
// Only allows columns that actually exist in the table (SQL injection safe)
// ============================================================
async function buildExtraWhere(
  params: Record<string, string> | undefined,
  table: string,
  dataPool: any,
): Promise<string | undefined> {
  if (!params || Object.keys(params).length === 0) return undefined;

  // Get actual column names to validate params
  const colResult = await dataPool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
  `, [table]);

  const validColumns = new Set(colResult.rows.map((r: { column_name: string }) => r.column_name));
  const conditions: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (validColumns.has(key) && value !== undefined && value !== '') {
      // Use parameterized-style escaping (single quotes escaped)
      const escaped = String(value).replace(/'/g, "''");
      conditions.push(`${key} = '${escaped}'`);
    }
  }

  return conditions.length > 0 ? conditions.join(' AND ') : undefined;
}

// ============================================================
// Helper: Resolve filter options via SELECT DISTINCT (SSOT from data)
// ============================================================
async function resolveFilterOptions(
  dataPool: any,
  table: string,
  filtersConfig: { field: string; type: string; default?: string; help_text?: string }[],
  validColumns: Set<string>,  // SSOT from information_schema via buildMaskedSelect
): Promise<{ field: string; type: string; options: string[]; default: string; help_text?: string }[]> {
  const results = [];

  for (const filter of filtersConfig) {
    // SEC-03: validate filter.field against SSOT column list
    if (!validColumns.has(filter.field)) continue;

    let options: string[] = ['All'];
    try {
      const distinctResult = await dataPool.query(
        `SELECT DISTINCT ${filter.field}::text AS val FROM ${table} WHERE ${filter.field} IS NOT NULL ORDER BY val`
      );
      options = ['All', ...distinctResult.rows.map((r: { val: string }) => r.val)];
    } catch {
      // query error — skip this filter
    }
    results.push({
      field: filter.field,
      type: filter.type,
      options,
      default: filter.default || 'All',
      ...(filter.help_text ? { help_text: filter.help_text } : {}),
    });
  }

  return results;
}
