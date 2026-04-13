import { Router, Request, Response } from 'express';
import { pool, getDataSourcePool, resolveDataSource } from '../db';
import { buildMaskedSelect, ColumnDef } from '../lib/masked-query';

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
    res.status(500).json({ error: String(err) });
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

  // Validate page_id format to prevent injection
  if (!/^[a-z][a-z0-9_]*$/.test(page_id)) {
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
        return res.status(403).json({
          error: 'Forbidden',
          detail: `${user.user_id} lacks read access to ${config.resource_id}`,
        });
      }
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

    // Step 4: Resolve data source pool (SSOT from authz_data_source)
    const sourceId = await resolveDataSource(table);
    const dataPool = sourceId ? await getDataSourcePool(sourceId) : pool;

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
    res.status(500).json({ error: String(err) });
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
  filtersConfig: { field: string; type: string; default?: string }[],
  validColumns: Set<string>,  // SSOT from information_schema via buildMaskedSelect
): Promise<{ field: string; type: string; options: string[]; default: string }[]> {
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
    });
  }

  return results;
}
