// ============================================================
// SQL function quality lint (FN-QUALITY-LINT-V01).
//
// Pure-text + parsed-metadata lint. Surfaces house conventions that
// the AI assistant already recommends, but as inline advisory pills
// next to the SQL editor — so curators learn the rules WHILE writing,
// not only when they ask the AI.
//
// Non-blocking by design. Severity is 'warn' for things that bite
// at runtime (volatility, SELECT *) and 'info' for soft conventions
// (naming, p_ prefix). Curators can always Deploy through the noise.
//
// Why these specific rules:
//   FQL-01 STABLE missing — read-only fns left as VOLATILE prevent the
//          planner from folding them across rows; on a 50k-row LATERAL
//          driver this is the difference between 1× and 50k× call cost.
//   FQL-02 SELECT * — return shape silently shifts when upstream tables
//          gain columns; downstream Composer nodes break with no diff.
//   FQL-03 p_<snake> param — without prefix, `WHERE col = arg_name`
//          quietly resolves to the column itself (always true) when
//          col is in scope. Real bugs traced to this in past sprints.
//   FQL-04 naming convention — keyword/summary/aspect/search prefixes
//          let the catalog page be scanned by layer at a glance.
// ============================================================

export interface LintInput {
  sql: string;
  /** Function name without schema (parsed from header). */
  function_name: string;
  /** Parsed argument names — already extracted by the validate route. */
  arg_names: string[];
  /** As reported by pg_proc.provolatile after CREATE. */
  volatility: 'IMMUTABLE' | 'STABLE' | 'VOLATILE';
}

export interface LintIssue {
  severity: 'warn' | 'info';
  code: 'FQL-01' | 'FQL-02' | 'FQL-03' | 'FQL-04';
  /** Short headline shown on the pill. */
  message: string;
  /** Long-form fix shown in tooltip / detail panel. */
  hint: string;
  /** Optional offending substring to help the editor highlight. */
  context?: string;
}

const NAME_PATTERNS: Array<{ rx: RegExp; label: string }> = [
  { rx: /^fn_search_[a-z][a-z0-9_]*$/, label: 'fn_search_<entity>' },
  { rx: /^fn_[a-z][a-z0-9_]*_summary$/, label: 'fn_<entity>_summary' },
  { rx: /^fn_keyword_[a-z][a-z0-9_]*_[a-z][a-z0-9_]*$/, label: 'fn_keyword_<entity>_<aspect>' },
  { rx: /^fn_[a-z][a-z0-9_]+_[a-z][a-z0-9_]+$/, label: 'fn_<entity>_<aspect>' },
];

// Strip line comments, block comments, and single-quoted string literals so
// we only lint actual SQL. We deliberately do NOT strip dollar-quoted bodies
// ($$...$$) — that IS the SQL the curator writes (the FROM clause, the
// SELECT, the optional INSERT). Stripping it would silently disable every
// rule on every fn that uses the canonical $$ body wrapping.
function stripStringsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''");
}

export function lintFunction(input: LintInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const stripped = stripStringsAndComments(input.sql);
  const lowerStripped = stripped.toLowerCase();

  // FQL-01: VOLATILE on a read-only fn → suggest STABLE.
  // We treat the body as read-only when no DML keywords appear in stripped SQL.
  // (CREATE FUNCTION header itself contains no DML, so a clean signal.)
  if (input.volatility === 'VOLATILE') {
    const hasDml = /\b(insert\s+into|update\s+\w|delete\s+from|merge\s+into|truncate\s+\w|copy\s+\w)\b/i.test(stripped);
    if (!hasDml) {
      issues.push({
        severity: 'warn',
        code: 'FQL-01',
        message: 'VOLATILE on read-only fn — should be STABLE',
        hint:
          'No DML detected in the body, but volatility is VOLATILE (the PG default). ' +
          'Add `STABLE` after the argument list so the planner can fold this fn across rows. ' +
          'Without STABLE, a LATERAL driver re-executes per row — order-of-magnitude slower on 1k+ row inputs.',
      });
    }
  }

  // FQL-02: SELECT * — explicit columns prevent shape drift.
  const starMatch = /\bselect\s+\*/i.exec(lowerStripped);
  if (starMatch) {
    issues.push({
      severity: 'warn',
      code: 'FQL-02',
      message: 'SELECT * — list columns explicitly',
      hint:
        'Functions with `SELECT *` change return shape silently when an upstream table gains columns. ' +
        'Composer/DAG downstream nodes that bind by column name will break or pick up unintended fields. ' +
        'List columns explicitly so the contract is visible at the call site.',
      context: starMatch[0],
    });
  }

  // FQL-03: parameter naming — p_<snake> prevents column shadowing inside SQL body.
  const offenders = input.arg_names.filter((n) => n && !/^p_/.test(n));
  if (offenders.length > 0) {
    issues.push({
      severity: 'info',
      code: 'FQL-03',
      message: `Param(s) missing p_ prefix: ${offenders.join(', ')}`,
      hint:
        'Use `p_<snake>` for parameters so they cannot collide with column names inside the SQL body. ' +
        'A parameter named `material_no` will quietly resolve to the column `material_no` when it is in scope, ' +
        'producing always-true predicates with no error.',
    });
  }

  // FQL-04: function name pattern — soft convention, info-level.
  const matchedPattern = NAME_PATTERNS.find((p) => p.rx.test(input.function_name));
  if (!matchedPattern) {
    issues.push({
      severity: 'info',
      code: 'FQL-04',
      message: `Name '${input.function_name}' doesn't match house patterns`,
      hint:
        'Names like `fn_search_<entity>` / `fn_<entity>_summary` / `fn_<entity>_<aspect>` / ' +
        '`fn_keyword_<entity>_<aspect>` make the catalog scannable by layer (search → summary → ' +
        'aspect → keyword-driven). Renaming is optional but strongly preferred for new fns.',
    });
  }

  return issues;
}
