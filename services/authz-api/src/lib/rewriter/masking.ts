// ============================================================
// Column Masking Rewriter
// Ported from EdgePolicy core/rewriter/masking.py
//
// Replaces column references in SELECT with mask SQL expressions.
// Masks execute in SQL — original values never leave the database.
// ============================================================

import { Parser } from 'node-sql-parser';
import type { MaskFunction, RewritePolicy } from './types';

const parser = new Parser();
const DB = 'PostgreSQL';

/**
 * Mapping of mask function names to SQL expression templates.
 * {col} is replaced with the actual column reference.
 * {show} is replaced with partial_show_chars (default 4).
 */
const MASK_SQL: Record<MaskFunction, string> = {
  full_mask:    "'***'",
  nullify:      'NULL',
  redact:       "'[REDACTED]'",
  email_mask:   "CONCAT(LEFT({col}, 1), '***@', SUBSTRING({col} FROM POSITION('@' IN {col}) + 1))",
  partial_mask: "CONCAT(REPEAT('*', GREATEST(LENGTH(CAST({col} AS TEXT)) - {show}, 0)), RIGHT(CAST({col} AS TEXT), {show}))",
  hash:         'MD5(CAST({col} AS TEXT))',
};

function extractColumnName(expr: any): string | null {
  if (!expr) return null;
  if (expr.type === 'column_ref') {
    return expr.column?.expr?.value ?? expr.column ?? null;
  }
  return null;
}

/**
 * Build a mask map from policies: column_name → mask SQL expression.
 */
function buildMaskMap(
  policies: RewritePolicy[],
  table: string,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const policy of policies) {
    if (policy.policy_type !== 'column_mask') continue;
    if (policy.target_table.toLowerCase() !== table.toLowerCase()) continue;

    const fn = (policy.rule_definition.mask_function as MaskFunction) || 'full_mask';
    const show = (policy.rule_definition.partial_show_chars as number) || 4;
    const template = MASK_SQL[fn] || MASK_SQL.full_mask;

    for (const col of policy.target_columns) {
      // Don't overwrite — first policy (highest priority) wins
      if (!map.has(col.toLowerCase())) {
        const sqlExpr = template
          .replace(/\{col\}/g, col)
          .replace(/\{show\}/g, String(show));
        map.set(col.toLowerCase(), sqlExpr);
      }
    }
  }
  return map;
}

/**
 * Parse a SQL expression fragment into an AST node.
 * Strategy: wrap in "SELECT <expr> AS _m" then extract the expr.
 */
function parseMaskExpr(maskSql: string, alias: string): any {
  try {
    const ast = parser.astify(`SELECT ${maskSql} AS _m`, { database: DB });
    const expr = (ast as any).columns[0].expr;
    return { type: 'expr', expr, as: alias };
  } catch {
    // Fallback: literal '***'
    return { type: 'expr', expr: { type: 'single_quote_string', value: '***' }, as: alias };
  }
}

/**
 * Rewrite SQL to apply column masking.
 * Replaces column references in SELECT with mask SQL expressions.
 */
export function rewriteMasking(sql: string, policies: RewritePolicy[], table: string): string {
  if (!policies.length) return sql;

  const maskMap = buildMaskMap(policies, table);
  if (maskMap.size === 0) return sql;

  let ast: any;
  try {
    ast = parser.astify(sql, { database: DB });
  } catch {
    return sql;
  }

  if (ast.type !== 'select' || !Array.isArray(ast.columns)) return sql;

  ast.columns = ast.columns.map((col: any) => {
    const colName = extractColumnName(col.expr);
    if (!colName) return col;

    const maskSql = maskMap.get(colName.toLowerCase());
    if (!maskSql) return col;

    // Preserve original alias or use column name
    const alias = col.as || colName;
    return parseMaskExpr(maskSql, alias);
  });

  try {
    return parser.sqlify(ast, { database: DB });
  } catch {
    return sql;
  }
}
