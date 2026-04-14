import { Pool } from 'pg';
import * as crypto from 'crypto';
import { RewritePipeline } from './rewriter/pipeline';
import type { PolicyEvalResult, RewritePolicy } from './rewriter/types';

// ============================================================
// Shared masked query builder
// Used by: config-exec.ts, rls-simulate.ts
// SSOT: columns from information_schema, masks from authz_resolve(),
//       denied columns from authz_role_permission, filter from authz_filter()
//
// v2 (EdgePolicy fusion): Masking now done via SQL Rewrite Pipeline.
// The pipeline rewrites SQL at AST level — original values never leave
// the database. JS mask functions kept as fallback for non-SQL sources.
// ============================================================

const pipeline = new RewritePipeline();

export type ColumnDef = {
  key: string;
  label: string;
  data_type: string;
  // From columns_override:
  render?: string;
  sortable?: boolean;
  align?: string;
  hidden?: boolean;
};

export type MaskedQueryResult = {
  rows: Record<string, unknown>[];
  totalCount: number;
  filteredCount: number;
  filterClause: string;
  columns: ColumnDef[];
  columnMasks: Record<string, string>;
  resolvedRoles: string[];
  validColumns: Set<string>; // SSOT from information_schema — callers can use for validation
  rewrittenSql?: string;     // SQL after pipeline rewrite (for debugging/audit)
};

// Validate orderBy clause — each column must exist in the table (SSOT: information_schema)
function sanitizeOrderBy(orderBy: string, validCols: Set<string>): string {
  return orderBy.split(',').map(part => {
    const trimmed = part.trim();
    const col = trimmed.replace(/\s+(ASC|DESC)$/i, '').trim();
    return validCols.has(col) ? trimmed : null;
  }).filter(Boolean).join(', ') || 'created_at DESC';
}

// ── JS mask functions (equivalent to PG fn_mask_*) ──

function jsMaskFull(_value: unknown): string {
  return '****';
}

function jsMaskPartial(value: unknown): string {
  const s = String(value ?? '');
  if (s.length <= 2) return '****';
  return s[0] + '****' + s[s.length - 1];
}

function jsMaskHash(value: unknown): string {
  const s = String(value ?? '');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function jsMaskRange(value: unknown): string {
  const n = Number(value);
  if (isNaN(n)) return '****';
  if (n < 10) return '0-10';
  if (n < 50) return '10-50';
  if (n < 100) return '50-100';
  if (n < 500) return '100-500';
  if (n < 1000) return '500-1K';
  if (n < 10000) return '1K-10K';
  return '10K+';
}

const JS_MASK_FNS: Record<string, (v: unknown) => string> = {
  fn_mask_full: jsMaskFull,
  fn_mask_partial: jsMaskPartial,
  fn_mask_hash: jsMaskHash,
  fn_mask_range: jsMaskRange,
};

// Map Data Nexus fn_mask_* names to EdgePolicy MaskFunction names
function mapMaskFnName(fnName: string): string {
  const mapping: Record<string, string> = {
    fn_mask_full:    'full_mask',
    fn_mask_partial: 'partial_mask',
    fn_mask_hash:    'hash',
    fn_mask_range:   'full_mask', // range not supported in SQL rewrite — fallback to full
    fn_mask_null:    'nullify',
    fn_mask_nullify: 'nullify',
    fn_mask_email:   'email_mask',
    fn_mask_redact:  'redact',
  };
  return mapping[fnName] || 'full_mask';
}

export async function buildMaskedSelect(opts: {
  authzPool: Pool;
  dataPool: Pool;
  table: string;
  userId: string;
  groups: string[];
  attributes?: Record<string, unknown>;
  extraWhere?: string;
  orderBy: string;
  limit?: number;
  columnsOverride?: Record<string, Partial<Omit<ColumnDef, 'key' | 'data_type'>>>;
  path?: string;
}): Promise<MaskedQueryResult> {
  const {
    authzPool, dataPool, table, userId, groups,
    attributes = {}, extraWhere, orderBy, limit = 1000,
    columnsOverride = {}, path = 'A',
  } = opts;

  // Try view: prefix first, fall back to table:
  const viewCheck = await authzPool.query(
    `SELECT 1 FROM authz_resource WHERE resource_id = $1 AND is_active = TRUE`,
    [`view:${table}`]
  );
  const resourceType = viewCheck.rows.length > 0 ? `view:${table}` : `table:${table}`;

  // Step 1: Get RLS filter from authz_filter()
  const filterResult = await authzPool.query(
    'SELECT authz_filter($1, $2, $3, $4, $5) AS filter_clause',
    [userId, groups, JSON.stringify(attributes), resourceType, path]
  );
  const authzFilterClause = filterResult.rows[0].filter_clause;

  // Step 2: Get L2 column masks from authz_resolve()
  const resolveResult = await authzPool.query(
    'SELECT authz_resolve($1, $2, $3) AS config',
    [userId, groups, JSON.stringify(attributes)]
  );
  const resolvedConfig = resolveResult.rows[0].config;
  const allColumnMasks = resolvedConfig.L2_column_masks || {};

  // Build mask map for this table
  const tableMasks: Record<string, { function: string; mask_type: string }> = {};
  for (const [, rules] of Object.entries(allColumnMasks)) {
    for (const [colKey, maskDef] of Object.entries(rules as Record<string, { function: string; mask_type: string }>)) {
      const [maskTable, maskCol] = colKey.split('.');
      if (maskTable === table && maskCol) {
        tableMasks[maskCol] = maskDef;
      }
    }
  }

  // Step 3: Get actual columns from information_schema (SSOT for column validation)
  const colResult = await dataPool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);

  const validColumns = new Set(colResult.rows.map((r: { column_name: string }) => r.column_name));

  // Step 4: Resolve roles and find denied columns
  const roleResult = await authzPool.query(
    'SELECT _authz_resolve_roles($1, $2) AS roles',
    [userId, groups]
  );
  const resolvedRoles: string[] = roleResult.rows[0].roles || [];

  const denyResult = await authzPool.query(`
    SELECT rp.resource_id FROM authz_role_permission rp
    JOIN authz_resource ar ON ar.resource_id = rp.resource_id
    WHERE rp.role_id = ANY($1) AND rp.effect = 'deny' AND rp.is_active
      AND ar.resource_type = 'column'
      AND rp.resource_id LIKE $2
  `, [resolvedRoles, `column:${table}.%`]);

  const deniedCols = new Set(
    denyResult.rows.map((r: { resource_id: string }) => r.resource_id.split('.').pop())
  );

  // Step 5: Build column list and plain SELECT (no mask functions in SQL)
  const columns: ColumnDef[] = [];
  const selectColumns: string[] = [];
  const maskedColSet = new Set<string>();  // columns needing JS post-processing
  const deniedColSet = new Set<string>();  // columns to replace with [DENIED]

  for (const col of colResult.rows as { column_name: string; data_type: string }[]) {
    const override = columnsOverride[col.column_name] || {};
    if (override.hidden) continue;

    const colDef: ColumnDef = {
      key: col.column_name,
      label: override.label || col.column_name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      data_type: col.data_type,
      ...override,
    };
    columns.push(colDef);
    selectColumns.push(col.column_name);

    if (deniedCols.has(col.column_name)) {
      deniedColSet.add(col.column_name);
    } else if (tableMasks[col.column_name]) {
      maskedColSet.add(col.column_name);
    }
  }

  // Step 6: Build WHERE clause (authz_filter AND extraWhere)
  const whereParts: string[] = [];
  if (authzFilterClause && authzFilterClause !== '1=1' && authzFilterClause !== 'TRUE') {
    whereParts.push(`(${authzFilterClause})`);
  }
  if (extraWhere && extraWhere !== '1=1') {
    whereParts.push(`(${extraWhere})`);
  }
  const finalWhere = whereParts.length > 0 ? whereParts.join(' AND ') : '1=1';

  // Step 6.5: Convert SSOT results into PolicyEvalResult for the rewrite pipeline
  const maskPolicies: RewritePolicy[] = [];
  for (const [col, maskDef] of Object.entries(tableMasks)) {
    if (!deniedCols.has(col)) {
      maskPolicies.push({
        name: `mask_${table}_${col}`,
        policy_type: 'column_mask',
        target_schema: 'public',
        target_table: table,
        target_columns: [col],
        rule_definition: { mask_function: mapMaskFnName(maskDef.function) },
        priority: 100,
      });
    }
  }

  const evalResult: PolicyEvalResult = {
    action: deniedColSet.size > 0 || maskPolicies.length > 0 ? 'MASK' : 'ALLOW',
    denied_columns: Array.from(deniedCols) as string[],
    mask_policies: maskPolicies,
    filter_policies: [], // RLS already handled in finalWhere via authz_filter()
    applied_policy_names: maskPolicies.map(p => p.name),
    operation_denied: false,
  };

  // Step 7: Build base SQL, then rewrite via pipeline (mask + ACL at SQL level)
  const safeOrderBy = sanitizeOrderBy(orderBy, validColumns);
  const baseSql = `SELECT ${selectColumns.join(', ')} FROM ${table} WHERE ${finalWhere} ORDER BY ${safeOrderBy} LIMIT ${limit}`;

  const userCtx = {
    user_id: userId,
    groups,
    roles: resolvedRoles,
    department: (attributes.department as string) || undefined,
    job_level: (attributes.job_level as number) || undefined,
    security_clearance: (attributes.security_clearance as string) || undefined,
    attributes,
  };

  const rewriteResult = pipeline.rewrite(baseSql, evalResult, userCtx, table);
  const dataResult = await dataPool.query(rewriteResult.rewritten_sql);
  const totalResult = await dataPool.query(`SELECT count(*)::int AS total FROM ${table}`);

  // Step 8: JS fallback mask — only for columns that the SQL rewriter couldn't handle
  // (e.g., data sources that don't support SQL functions like MongoDB)
  // For PG sources, the pipeline already masked everything at SQL level.
  const maskedRows = rewriteResult.was_modified
    ? dataResult.rows  // Pipeline handled masking — rows already masked
    : dataResult.rows.map((row: Record<string, unknown>) => {
        const newRow = { ...row };
        for (const col of deniedColSet) {
          newRow[col] = '[DENIED]';
        }
        for (const col of maskedColSet) {
          const maskDef = tableMasks[col];
          const maskFn = JS_MASK_FNS[maskDef.function];
          if (maskFn) {
            newRow[col] = maskFn(row[col]);
          } else {
            newRow[col] = '****';
          }
        }
        return newRow;
      });

  // Step 9: Build mask info for UI
  const columnMasks: Record<string, string> = {};
  for (const [col, mask] of Object.entries(tableMasks)) {
    if (deniedCols.has(col)) {
      columnMasks[col] = 'DENIED (L0 deny overrides mask)';
    } else {
      columnMasks[col] = `${mask.mask_type} (${mask.function})`;
    }
  }
  for (const col of deniedCols) {
    if (!columnMasks[col as string]) {
      columnMasks[col as string] = 'DENIED (L0 column deny)';
    }
  }

  return {
    rows: maskedRows,
    totalCount: totalResult.rows[0].total,
    filteredCount: dataResult.rowCount ?? 0,
    filterClause: finalWhere,
    columns,
    columnMasks,
    resolvedRoles,
    validColumns,
    rewrittenSql: rewriteResult.was_modified ? rewriteResult.rewritten_sql : undefined,
  };
}
