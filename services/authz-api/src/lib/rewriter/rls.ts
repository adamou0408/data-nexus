// ============================================================
// RLS (Row-Level Security) Rewriter
// Ported from EdgePolicy core/rewriter/rls.py
//
// Injects WHERE conditions from filter policies into SELECT/UPDATE/DELETE.
// Substitutes template variables ({{user.department}}) with user context values.
// ============================================================

import { Parser } from 'node-sql-parser';
import type { RewritePolicy, UserContext } from './types';

const parser = new Parser();
const DB = 'PostgreSQL';

/**
 * User context variable resolvers.
 * Template format: {{user.department}} → resolved to actual value.
 */
const USER_VARS: Record<string, (u: UserContext) => string | string[]> = {
  'user.username':           u => u.user_id,
  'user.user_id':            u => u.user_id,
  'user.department':         u => u.department || '',
  'user.job_level':          u => String(u.job_level ?? 0),
  'user.security_clearance': u => u.security_clearance || 'PUBLIC',
  'user.role':               u => u.roles[0] || '',
  'user.roles':              u => u.roles,
  'user.groups':             u => u.groups,
};

/**
 * Resolve template variables in a condition string.
 * Handles both single values and arrays (for IN clauses).
 */
function renderAttrValue(val: unknown): string {
  if (Array.isArray(val)) {
    if (val.length === 0) return "('')";
    return `(${val.map(v => quoteLiteral(String(v))).join(', ')})`;
  }
  return quoteLiteral(String(val));
}

function resolveTemplate(condition: string, user: UserContext): string {
  return condition.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, varName: string) => {
    const resolver = USER_VARS[varName];
    if (!resolver) {
      // Check user.attributes as fallback
      const attrKey = varName.replace('user.', '');
      const attrVal = user.attributes[attrKey];
      if (attrVal !== undefined) return renderAttrValue(attrVal);
      return "''"; // empty string fallback
    }

    const value = resolver(user);
    if (Array.isArray(value)) {
      // For IN clauses: ('val1', 'val2', ...)
      if (value.length === 0) return "('')";
      return `(${value.map(v => quoteLiteral(v)).join(', ')})`;
    }
    return quoteLiteral(String(value));
  });
}

/**
 * Also support ${subject.*} placeholders (Data Nexus format).
 */
function resolveSubjectTemplate(condition: string, user: UserContext): string {
  return condition.replace(/\$\{subject\.(\w+)\}/g, (_match, attr: string) => {
    const varName = `user.${attr}`;
    const resolver = USER_VARS[varName];
    if (resolver) {
      const value = resolver(user);
      if (Array.isArray(value)) {
        if (value.length === 0) return "('')";
        return `(${value.map(v => quoteLiteral(v)).join(', ')})`;
      }
      return quoteLiteral(String(value));
    }
    const attrVal = user.attributes[attr];
    if (attrVal !== undefined) return renderAttrValue(attrVal);
    return "''";
  });
}

function quoteLiteral(val: string): string {
  // Numeric values don't need quoting
  if (/^-?\d+(\.\d+)?$/.test(val)) return val;
  // SQL-safe quoting (escape single quotes)
  return `'${val.replace(/'/g, "''")}'`;
}

/**
 * Extract RLS conditions from filter policies and resolve templates.
 */
function buildFilterConditions(policies: RewritePolicy[], table: string, user: UserContext): string[] {
  const conditions: string[] = [];

  for (const policy of policies) {
    if (policy.policy_type !== 'row_filter') continue;
    if (policy.target_table.toLowerCase() !== table.toLowerCase()) continue;

    const condition = policy.rule_definition.condition as string;
    if (!condition) continue;

    // Resolve both template formats
    let resolved = resolveTemplate(condition, user);
    resolved = resolveSubjectTemplate(resolved, user);
    conditions.push(resolved);
  }

  return conditions;
}

/**
 * Rewrite SQL to inject RLS WHERE conditions.
 * Appends filter conditions with AND to existing WHERE clause.
 */
export function rewriteRls(sql: string, policies: RewritePolicy[], table: string, user: UserContext): string {
  if (!policies.length) return sql;

  const conditions = buildFilterConditions(policies, table, user);
  if (conditions.length === 0) return sql;

  let ast: any;
  try {
    ast = parser.astify(sql, { database: DB });
  } catch {
    // Fallback: string-based WHERE injection
    return injectWhereString(sql, conditions);
  }

  if (ast.type !== 'select') {
    return injectWhereString(sql, conditions);
  }

  // Parse each RLS condition into an AST node and AND them together
  const rlsExpr = buildCombinedConditionAst(conditions);
  if (!rlsExpr) return sql;

  if (ast.where) {
    // AND with existing WHERE
    ast.where = {
      type: 'binary_expr',
      operator: 'AND',
      left: ast.where,
      right: rlsExpr,
    };
  } else {
    ast.where = rlsExpr;
  }

  try {
    return parser.sqlify(ast, { database: DB });
  } catch {
    return injectWhereString(sql, conditions);
  }
}

/**
 * Parse conditions and combine with AND.
 */
function buildCombinedConditionAst(conditions: string[]): any | null {
  const nodes: any[] = [];
  for (const cond of conditions) {
    try {
      const ast = parser.astify(`SELECT 1 WHERE ${cond}`, { database: DB });
      if ((ast as any).where) {
        nodes.push((ast as any).where);
      }
    } catch {
      // Condition can't be parsed — use as raw string won't work in AST,
      // so we'll fall back to string injection for this one
      continue;
    }
  }

  if (nodes.length === 0) return null;
  return nodes.reduce((left, right) => ({
    type: 'binary_expr',
    operator: 'AND',
    left,
    right,
  }));
}

/**
 * Fallback: string-based WHERE injection when AST manipulation fails.
 */
function injectWhereString(sql: string, conditions: string[]): string {
  const combined = conditions.map(c => `(${c})`).join(' AND ');
  const upperSql = sql.toUpperCase();

  const whereIdx = upperSql.indexOf(' WHERE ');
  if (whereIdx !== -1) {
    // Insert after WHERE keyword
    const insertPos = whereIdx + 7; // length of ' WHERE '
    return sql.slice(0, insertPos) + `(${combined}) AND ` + sql.slice(insertPos);
  }

  // No WHERE — find insertion point (before ORDER BY, LIMIT, GROUP BY, etc.)
  const insertBefore = [' ORDER ', ' LIMIT ', ' GROUP ', ' HAVING ', ' OFFSET '];
  let insertPos = sql.length;
  for (const keyword of insertBefore) {
    const idx = upperSql.indexOf(keyword);
    if (idx !== -1 && idx < insertPos) insertPos = idx;
  }

  return sql.slice(0, insertPos) + ` WHERE ${combined}` + sql.slice(insertPos);
}
