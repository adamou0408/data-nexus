import { Router, Request, Response } from 'express';
import { pool, getDataSourcePool, resolveDataSource } from '../db';
import { buildMaskedSelect, ColumnDef } from '../lib/masked-query';
import { handleApiError } from '../lib/request-helpers';
import { audit } from '../audit';
import { executeDagAsPublished, DagExecError, PublishedDagSnapshot } from '../lib/dag-exec';

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
      const snapshot = config.dag_snapshot as PublishedDagSnapshot;
      const formInputs = (params && typeof params === 'object') ? params : {};
      const hasInputs = Object.keys(formInputs).length > 0;

      if (!hasInputs) {
        // First-load: hand the form schema back, rows empty.
        audit({
          access_path: 'A',
          subject_id: user.user_id,
          action_id: 'read',
          resource_id: config.resource_id || `published_dag:${config.published_dag_id}`,
          decision: 'allow',
          context: { page_id, mode: 'published_dag', stage: 'form_load' },
        });
        return res.json({
          config: { ...config, columns: [] },
          data: [],
          meta: {
            published_dag: true,
            stage: 'form_load',
            form_schema: config.form_schema || [],
          },
        });
      }

      try {
        const result = await executeDagAsPublished({
          dagSnapshot: snapshot,
          userId: user.user_id,
          groups: user.groups,
          formInputs,
          publishedDagRid: config.resource_id || `published_dag:${config.published_dag_id}`,
        });
        audit({
          access_path: 'A',
          subject_id: user.user_id,
          action_id: 'read',
          resource_id: config.resource_id || `published_dag:${config.published_dag_id}`,
          decision: 'allow',
          context: {
            page_id, mode: 'published_dag', stage: 'exec',
            row_count: result.row_count,
            elapsed_ms: result.elapsed_ms,
            output_node_id: result.output_node_id,
          },
        });
        return res.json({
          config: { ...config, columns: result.columns },
          data: result.rows,
          meta: {
            published_dag: true,
            stage: 'exec',
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
            outputs: result.outputs,
            primary_output_node_id: result.primary_output_node_id,
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
