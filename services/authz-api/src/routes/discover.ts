import { Router } from 'express';
import { pool as authzPool } from '../db';
import { handleApiError } from '../lib/request-helpers';

export const discoverRouter = Router();

// ─── Cross-source resource discovery ───
// Lists tables/views/functions across all data sources from the local catalog
// (authz_resource). Already-discovered resources only — does NOT re-introspect
// remote DBs. Use POST /api/datasources/:id/discover to refresh a specific DS.
discoverRouter.get('/', async (req, res) => {
  try {
    const type = String(req.query.type || 'all'); // 'table' | 'view' | 'function' | 'all'
    const unmappedOnly = String(req.query.unmapped_only || 'false') === 'true';
    const q = String(req.query.q || '').trim();
    const dataSourceId = String(req.query.data_source_id || '').trim();

    const validTypes = ['table', 'view', 'function'];
    const typeFilter = validTypes.includes(type) ? type : null;

    const params: unknown[] = [typeFilter, unmappedOnly, q || null, dataSourceId || null];

    const sql = `
      SELECT
        ar.resource_id,
        ar.resource_type,
        ar.display_name,
        ar.attributes->>'data_source_id'   AS data_source_id,
        ds.display_name                    AS ds_display_name,
        ds.db_type                         AS ds_db_type,
        ar.attributes->>'table_schema'     AS schema,
        ar.parent_id,
        parent.display_name                AS parent_display_name,
        parent.resource_type               AS parent_resource_type,
        ar.created_at
      FROM authz_resource ar
      LEFT JOIN authz_data_source ds
             ON ds.source_id = ar.attributes->>'data_source_id'
      LEFT JOIN authz_resource parent
             ON parent.resource_id = ar.parent_id
      WHERE ar.is_active = TRUE
        AND ar.resource_type IN ('table', 'view', 'function')
        AND ($1::text IS NULL OR ar.resource_type = $1)
        AND ($2::boolean IS FALSE
             OR parent.resource_type IS DISTINCT FROM 'module')
        AND ($3::text IS NULL
             OR ar.display_name ILIKE '%' || $3 || '%'
             OR ar.resource_id ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL
             OR ar.attributes->>'data_source_id' = $4)
      ORDER BY ds_display_name NULLS LAST, ar.resource_type, ar.display_name
      LIMIT 5000
    `;

    const result = await authzPool.query(sql, params);

    const rows = result.rows.map(r => ({
      resource_id: r.resource_id,
      resource_type: r.resource_type as 'table' | 'view' | 'function',
      display_name: r.display_name,
      data_source_id: r.data_source_id,
      ds_display_name: r.ds_display_name,
      ds_db_type: r.ds_db_type,
      schema: r.schema,
      mapped_to_module: r.parent_resource_type === 'module' ? {
        resource_id: r.parent_id,
        display_name: r.parent_display_name,
      } : null,
      created_at: r.created_at,
    }));

    res.json({
      total: rows.length,
      truncated: rows.length === 5000,
      rows,
    });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ─── Stats summary (cheap aggregate for the StatStrip) ───
discoverRouter.get('/stats', async (_req, res) => {
  try {
    const sql = `
      SELECT
        ar.resource_type,
        COUNT(*)                                                    AS total,
        COUNT(*) FILTER (WHERE parent.resource_type = 'module')     AS mapped,
        COUNT(*) FILTER (WHERE parent.resource_type IS DISTINCT FROM 'module') AS unmapped,
        COUNT(DISTINCT ar.attributes->>'data_source_id')            AS ds_count
      FROM authz_resource ar
      LEFT JOIN authz_resource parent
             ON parent.resource_id = ar.parent_id
      WHERE ar.is_active = TRUE
        AND ar.resource_type IN ('table', 'view', 'function')
      GROUP BY ar.resource_type
    `;
    const result = await authzPool.query(sql);

    const summary = {
      table: { total: 0, mapped: 0, unmapped: 0 },
      view: { total: 0, mapped: 0, unmapped: 0 },
      function: { total: 0, mapped: 0, unmapped: 0 },
      ds_count: 0,
    };
    for (const row of result.rows) {
      const t = row.resource_type as 'table' | 'view' | 'function';
      summary[t] = {
        total: Number(row.total),
        mapped: Number(row.mapped),
        unmapped: Number(row.unmapped),
      };
      summary.ds_count = Math.max(summary.ds_count, Number(row.ds_count));
    }
    res.json(summary);
  } catch (err) {
    handleApiError(res, err);
  }
});
