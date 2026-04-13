// ============================================================
// Column ACL Rewriter
// Ported from EdgePolicy core/rewriter/column_acl.py
//
// Removes denied columns from SELECT projection.
// Security: blocks entire query if denied column appears in WHERE/JOIN/ORDER BY.
// ============================================================

import { Parser } from 'node-sql-parser';

const parser = new Parser();
const DB = 'PostgreSQL';

/**
 * Extract column name from a node-sql-parser column expression.
 */
function extractColumnName(expr: any): string | null {
  if (!expr) return null;
  if (expr.type === 'column_ref') {
    return expr.column?.expr?.value ?? expr.column ?? null;
  }
  return null;
}

/**
 * Check if an expression tree references any of the denied columns.
 * Used to block queries where denied columns appear in WHERE/JOIN/ORDER BY.
 */
function exprReferencesDenied(node: any, denied: Set<string>): boolean {
  if (!node || typeof node !== 'object') return false;

  if (node.type === 'column_ref') {
    const col = extractColumnName(node);
    if (col && denied.has(col.toLowerCase())) return true;
  }

  // Recurse into all object/array children
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (exprReferencesDenied(item, denied)) return true;
      }
    } else if (child && typeof child === 'object') {
      if (exprReferencesDenied(child, denied)) return true;
    }
  }
  return false;
}

/**
 * Rewrite SQL to remove denied columns from SELECT projection.
 * If a denied column is referenced in WHERE/JOIN/ORDER BY, returns an empty-result query.
 */
export function rewriteColumnAcl(sql: string, deniedColumns: string[]): string {
  if (!deniedColumns.length) return sql;

  const denied = new Set(deniedColumns.map(c => c.toLowerCase()));

  let ast: any;
  try {
    ast = parser.astify(sql, { database: DB });
  } catch {
    // Can't parse → return original (fail-open for non-DML)
    return sql;
  }

  if (ast.type !== 'select') return sql;

  // Security check: denied columns in WHERE, ORDER BY, or JOIN conditions → block
  if (exprReferencesDenied(ast.where, denied)) {
    return `SELECT NULL AS _denied_access WHERE 1=0`;
  }
  if (ast.orderby && exprReferencesDenied(ast.orderby, denied)) {
    return `SELECT NULL AS _denied_access WHERE 1=0`;
  }
  if (ast.from) {
    for (const f of ast.from) {
      if (f.on && exprReferencesDenied(f.on, denied)) {
        return `SELECT NULL AS _denied_access WHERE 1=0`;
      }
    }
  }

  // Remove denied columns from SELECT projection
  if (Array.isArray(ast.columns)) {
    ast.columns = ast.columns.filter((col: any) => {
      const colName = extractColumnName(col.expr);
      if (!colName) return true; // keep non-column expressions (functions, literals)
      return !denied.has(colName.toLowerCase());
    });

    // If all columns removed, return empty result
    if (ast.columns.length === 0) {
      return `SELECT NULL AS _denied_access WHERE 1=0`;
    }
  }

  try {
    return parser.sqlify(ast, { database: DB });
  } catch {
    return sql;
  }
}
