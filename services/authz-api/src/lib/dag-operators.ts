// ============================================================
// Composer-native operator runtime — composer-operator-and-sink plan §3.3.
//
// Operator nodes are passthrough or constant-emitting transforms that run
// inside the composer (not registered as PG functions in authz_resource).
// They inherit AuthZ from the upstream fn whose output they shape — see
// plan §3.2 for the rationale.
//
// V1 kinds: literal | filter | cast | aggregate | sort | limit | projection.
// ============================================================

// LogicalType is sourced from db-driver to keep one source-of-truth
// for the 9-type cross-DB enum (cross-db-tier-b-integration §L1).
import type { LogicalType } from './db-driver';

export interface OperatorColumn {
  name: string;
  pgType?: string;            // legacy axis, kept for backward compat with cast/filter/coerce paths
  logical_type?: LogicalType; // primary axis going forward (L1+); optional during rollout
  semantic_type?: string;
  dataTypeID?: number;
}

export interface UpstreamFrame {
  columns: OperatorColumn[];
  row0?: Record<string, unknown>;
  rows?: Record<string, unknown>[];   // operators need full rows (filter/cast); fn-only path may skip
}

export interface OperatorRunResult {
  columns: OperatorColumn[];
  rows: Record<string, unknown>[];
  row_count: number;
  elapsed_ms: number;
  lineage: Array<{ input: string; source: string }>;
}

type OpKind = 'literal' | 'filter' | 'cast' | 'aggregate' | 'sort' | 'limit' | 'projection';

export type AggregateFn = 'sum' | 'count' | 'min' | 'max' | 'avg' | 'array_agg';
export interface AggregateSpec {
  fn: AggregateFn;
  column: string;       // upstream column name; for 'count' the value is largely irrelevant — non-null rows
  alias?: string;       // output column name; defaults to '<fn>_<column>'
}

// LogicalType → best-effort PG type string. Used when the cast operator
// has only target_logical_type set but downstream paths still want a
// pgType hint. Bidirectional with pgTypeToLogical (db-driver) for the
// common cases; lossy on int4 vs int8 etc — not the source-of-truth.
export function logicalToPgType(lt: LogicalType | undefined): string | undefined {
  if (!lt) return undefined;
  switch (lt) {
    case 'string':    return 'text';
    case 'int64':     return 'int8';
    case 'decimal':   return 'numeric';
    case 'float64':   return 'float8';
    case 'bool':      return 'bool';
    case 'date':      return 'date';
    case 'timestamp': return 'timestamptz';
    case 'bytes':     return 'bytea';
    case 'json':      return 'jsonb';
    default:          return 'text';
  }
}

// ── Coercion by logical_type — the cross-DB-aware coerce path
// (cross-db-tier-b-integration §L1). Cast operator prefers this when
// `target_logical_type` is set in op_config; otherwise falls back to
// the legacy pgType-keyed coerceLiteral below.
export function coerceByLogicalType(raw: unknown, lt: LogicalType): unknown {
  if (raw === null || raw === undefined) return raw;
  switch (lt) {
    case 'string':
      // Stringify primitives; pass strings through; JSON.stringify objects so
      // downstream rendering gets a stable text payload regardless of source DB.
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') return String(raw);
      if (raw instanceof Date) return raw.toISOString();
      try { return JSON.stringify(raw); } catch { return String(raw); }
    case 'int64':
    case 'decimal':
    case 'float64': {
      if (typeof raw === 'number' || typeof raw === 'bigint') return raw;
      const n = Number(raw as any);
      return Number.isFinite(n) ? n : raw;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      return s === 'true' || s === '1' || s === 't' || s === 'y' || s === 'yes';
    }
    case 'json':
      if (typeof raw !== 'string') return raw;
      try { return JSON.parse(raw); } catch { return raw; }
    case 'date':
    case 'timestamp':
      // Pass through — downstream binding handles Date / ISO string parse.
      return raw;
    case 'bytes':
      // Bytes stay opaque at L1 (Buffer / b64 string passthrough).
      return raw;
    default:
      return raw;
  }
}

// ── Coercion: turn a string-typed UI value into the right JS primitive based
// on pgType so downstream PG fn binding doesn't choke. Mirrors the loose
// classification in apps/authz-dashboard/src/utils/handleCompat.ts.
export function coerceLiteral(raw: unknown, pgType?: string): unknown {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== 'string') return raw;
  const t = (pgType || '').toLowerCase().trim();
  if (!t || t === 'text' || t.includes('char') || t === 'uuid' || t === 'citext') return raw;
  if (t === 'boolean' || t === 'bool') return raw === 'true' || raw === '1' || raw.toLowerCase() === 't';
  if (
    t.includes('int') || t === 'numeric' || t.startsWith('numeric') ||
    t.includes('decimal') || t === 'real' || t === 'double precision' ||
    t === 'float4' || t === 'float8' || t === 'money'
  ) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (t === 'json' || t === 'jsonb') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (t.endsWith('[]')) {
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return raw;
}

// ── Aggregate value reducer. NULLs are skipped (SQL semantics). For numeric
// aggregations a non-finite cast yields NULL for that row's contribution —
// keeps a single bad row from poisoning the whole group.
function computeAgg(fn: AggregateFn, values: unknown[]): unknown {
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (fn === 'count') return nonNull.length;
  // Why empty → []: PG's array_agg returns NULL on empty group, but downstream
  // fns that take text[] as required input would NPE in JS on null; an empty
  // array fails their "1~5 keywords" check loudly instead.
  if (fn === 'array_agg') return nonNull;
  if (nonNull.length === 0) return null;
  if (fn === 'min' || fn === 'max') {
    return nonNull.reduce((acc, v) => {
      if (acc === null) return v;
      const aN = Number(acc), vN = Number(v);
      const numericPath = Number.isFinite(aN) && Number.isFinite(vN);
      if (numericPath) return fn === 'min' ? (vN < aN ? v : acc) : (vN > aN ? v : acc);
      const aS = String(acc), vS = String(v);
      return fn === 'min' ? (vS < aS ? v : acc) : (vS > aS ? v : acc);
    }, null as unknown);
  }
  // sum / avg — numeric only.
  const nums = nonNull.map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  const total = nums.reduce((a, b) => a + b, 0);
  return fn === 'sum' ? total : total / nums.length;
}

// ── Predicate evaluator for `filter` operator.
type FilterOp = 'eq' | 'ne' | 'in' | 'gt' | 'lt' | 'like';

interface LeafCondition {
  column: string;
  op: FilterOp;
  value: string;
}
type CompoundCondition =
  | LeafCondition
  | { and: CompoundCondition[] }
  | { or: CompoundCondition[] };

function isLeafCondition(c: unknown): c is LeafCondition {
  return !!c && typeof c === 'object' && 'column' in (c as object);
}

// Single-row leaf evaluator — extracted so compound AND/OR can short-circuit
// per row without rebuilding rowset filters.
function evalLeaf(row: Record<string, unknown>, column: string, op: FilterOp, value: string): boolean {
  switch (op) {
    case 'eq':
      return String(row[column] ?? '') === value;
    case 'ne':
      return String(row[column] ?? '') !== value;
    case 'in': {
      const set = new Set(value.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
      return set.has(String(row[column] ?? ''));
    }
    case 'gt':
    case 'lt': {
      const n = Number(value);
      const m = Number(row[column]);
      if (!Number.isFinite(m)) return false;
      return op === 'gt' ? m > n : m < n;
    }
    case 'like': {
      // Escape regex meta chars first, THEN translate SQL LIKE wildcards.
      // Without escape, user input like `(`, `[`, `+`, `\` would throw or
      // trigger catastrophic backtrack. try/catch is belt-and-braces — a
      // malformed pattern just yields zero matches instead of crashing the run.
      const safe = value
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/_/g, '.');
      let re: RegExp;
      try {
        re = new RegExp(safe, 'i');
      } catch {
        return false;
      }
      return re.test(String(row[column] ?? ''));
    }
    default:
      return true;
  }
}

function applyPredicate(
  rows: Record<string, unknown>[],
  column: string,
  op: FilterOp,
  value: string,
): Record<string, unknown>[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter((r) => evalLeaf(r, column, op, value));
}

// Compound condition evaluator with depth guard. Why max depth 3: prevents a
// curator copy-pasting a giant logic blob into one filter; chain multiple
// filter nodes instead. 3 covers `(A AND B) OR (C AND D)` which is practical.
function evalCompound(
  row: Record<string, unknown>,
  cond: CompoundCondition,
  depth: number,
  nodeId: string,
): boolean {
  if (depth > 3) {
    throw new Error(`Operator ${nodeId} (filter): nested condition depth exceeds 3.`);
  }
  if (isLeafCondition(cond)) {
    return evalLeaf(row, cond.column, (cond.op || 'eq') as FilterOp, String(cond.value ?? ''));
  }
  if ('and' in cond && Array.isArray(cond.and)) {
    for (const sub of cond.and) {
      if (!evalCompound(row, sub, depth + 1, nodeId)) return false;
    }
    return true;
  }
  if ('or' in cond && Array.isArray(cond.or)) {
    for (const sub of cond.or) {
      if (evalCompound(row, sub, depth + 1, nodeId)) return true;
    }
    return false;
  }
  return true;
}

// ── Main entry: dispatch on op_kind. Caller passes resolved upstream frames
// keyed by source node id, and the inbound edges that target this operator.
export function runOperator(opts: {
  op_kind: OpKind;
  op_config: Record<string, unknown>;
  inbound: Array<{ source: string; sourceHandle?: string | null; targetHandle?: string | null }>;
  upstream: Record<string, UpstreamFrame>;
  node_id: string;
}): OperatorRunResult {
  const t0 = Date.now();
  const { op_kind, op_config, inbound, upstream, node_id } = opts;
  const lineage: Array<{ input: string; source: string }> = [];

  if (op_kind === 'literal') {
    const value = coerceLiteral(op_config.value, op_config.pgType as string | undefined);
    const col: OperatorColumn = {
      name: 'value',
      pgType: (op_config.pgType as string) || 'text',
      semantic_type: (op_config.semantic_type as string) || undefined,
    };
    lineage.push({ input: 'value', source: 'literal' });
    return {
      columns: [col],
      rows: [{ value }],
      row_count: 1,
      elapsed_ms: Date.now() - t0,
      lineage,
    };
  }

  // filter / cast both require exactly one upstream rowset.
  if (inbound.length === 0) {
    throw new Error(`Operator ${node_id} (${op_kind}): no inbound edge — connect an upstream node first.`);
  }
  const src = inbound[0];
  const frame = upstream[src.source];
  if (!frame) {
    throw new Error(`Operator ${node_id} (${op_kind}): upstream node ${src.source} has no result yet — run it first.`);
  }
  const upRows = frame.rows || (frame.row0 ? [frame.row0] : []);
  const upCols = frame.columns || [];

  if (op_kind === 'filter') {
    // Compound shape detection: `op_config.and` / `op_config.or` triggers the
    // new path; legacy single-condition payloads still flow through the leaf.
    // Why backward compatible (not filter_v2): old DAGs already published with
    // single-condition filters must keep working without re-publish.
    const hasAnd = Array.isArray((op_config as { and?: unknown[] }).and);
    const hasOr = Array.isArray((op_config as { or?: unknown[] }).or);
    if (hasAnd || hasOr) {
      const cond = op_config as unknown as CompoundCondition;
      const filtered = upRows.filter((r) => evalCompound(r, cond, 1, node_id));
      lineage.push({ input: '__upstream', source: `${src.source} (filter compound ${hasAnd ? 'AND' : 'OR'})` });
      return {
        columns: upCols,
        rows: filtered,
        row_count: filtered.length,
        elapsed_ms: Date.now() - t0,
        lineage,
      };
    }
    const column = String(op_config.column || '');
    const op = (op_config.op || 'eq') as FilterOp;
    const value = String(op_config.value ?? '');
    if (!column) throw new Error(`Operator ${node_id} (filter): op_config.column is required.`);
    const filtered = applyPredicate(upRows, column, op, value);
    lineage.push({ input: '__upstream', source: `${src.source} (filter ${column} ${op} ${value})` });
    return {
      columns: upCols,
      rows: filtered,
      row_count: filtered.length,
      elapsed_ms: Date.now() - t0,
      lineage,
    };
  }

  if (op_kind === 'sort') {
    // Why an op (not an aggregate flag): sort is order-preserving identity;
    // aggregate transforms shape. Mixing muddles semantics.
    const orderByRaw = (op_config as { order_by?: unknown }).order_by;
    const orderBy: Array<{ column: string; dir: 'asc' | 'desc' }> = Array.isArray(orderByRaw)
      ? (orderByRaw as unknown[]).map((o) => {
          const obj = o as { column?: string; dir?: string };
          const dir: 'asc' | 'desc' = obj.dir === 'desc' ? 'desc' : 'asc';
          return { column: String(obj.column || ''), dir };
        }).filter((o) => o.column)
      : [];
    if (orderBy.length === 0) {
      throw new Error(`Operator ${node_id} (sort): op_config.order_by[] is required (at least one key).`);
    }
    const NUMERIC_PG = new Set(['integer', 'bigint', 'numeric', 'double precision', 'real', 'smallint', 'int', 'int2', 'int4', 'int8', 'float4', 'float8']);
    const isNumericCol = (col: string): boolean => {
      const u = upCols.find((c) => c.name === col);
      const t = (u?.pgType || '').toLowerCase().trim();
      if (!t) return false;
      if (NUMERIC_PG.has(t)) return true;
      return t.includes('int') || t.startsWith('numeric') || t.includes('decimal');
    };
    // Sorted via Array.prototype.sort (stable since ES2019). Multi-key
    // tie-break runs in declared order. Nulls always last regardless of dir
    // — end users find that less surprising than PG's NULLS-FIRST-on-DESC.
    const sorted = [...upRows].sort((a, b) => {
      for (const k of orderBy) {
        const av = a[k.column];
        const bv = b[k.column];
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull && bNull) continue;
        if (aNull) return 1;                                       // null → end (always last)
        if (bNull) return -1;
        let cmp: number;
        if (isNumericCol(k.column)) {
          const an = Number(av), bn = Number(bv);
          cmp = an < bn ? -1 : an > bn ? 1 : 0;
        } else {
          const as = String(av), bs = String(bv);
          cmp = as < bs ? -1 : as > bs ? 1 : 0;
        }
        if (cmp !== 0) return k.dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
    lineage.push({ input: '__upstream', source: `${src.source} (sort ${orderBy.map((o) => `${o.column} ${o.dir}`).join(', ')})` });
    return {
      columns: upCols,
      rows: sorted,
      row_count: sorted.length,
      elapsed_ms: Date.now() - t0,
      lineage,
    };
  }

  if (op_kind === 'limit') {
    const n = (op_config as { n?: unknown }).n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error(`Operator ${node_id} (limit): op_config.n must be a non-negative integer.`);
    }
    // n=0 → empty rows, columns preserved (NOT a noop / NOT an error).
    const limited = upRows.slice(0, n);
    lineage.push({ input: '__upstream', source: `${src.source} (limit ${n})` });
    return {
      columns: upCols,
      rows: limited,
      row_count: limited.length,
      elapsed_ms: Date.now() - t0,
      lineage,
    };
  }

  if (op_kind === 'projection') {
    // Why one op for keep+rename+add: they almost always co-occur (build a
    // presentation layer). Three ops would mean three nodes for one logical
    // operation. Order: keep → rename → add.
    const keepRaw = (op_config as { keep?: unknown }).keep;
    const renameRaw = (op_config as { rename?: unknown }).rename;
    const addRaw = (op_config as { add?: unknown }).add;
    const keep: string[] | undefined = Array.isArray(keepRaw) ? keepRaw.map(String) : undefined;
    const rename: Record<string, string> = renameRaw && typeof renameRaw === 'object'
      ? Object.fromEntries(Object.entries(renameRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {};
    const add: Array<{ name: string; expr: string; pgType?: string }> = Array.isArray(addRaw)
      ? (addRaw as unknown[]).map((a) => {
          const o = a as { name?: string; expr?: string; pgType?: string };
          return { name: String(o.name || ''), expr: String(o.expr ?? ''), pgType: o.pgType };
        }).filter((a) => a.name)
      : [];

    // Step 1: keep — restrict columns. Drops unmentioned columns.
    const keptCols: OperatorColumn[] = keep
      ? keep.map((n) => upCols.find((c) => c.name === n)).filter((c): c is OperatorColumn => !!c)
      : [...upCols];

    // Step 2: rename — translate kept columns' names, preserve metadata.
    const renamedCols: OperatorColumn[] = keptCols.map((c) =>
      rename[c.name] ? { ...c, name: rename[c.name] } : c,
    );

    // Step 3: build per-row template substitution. Why string templates only,
    // not eval: sandboxed eval is an attack surface for ops costs. Templates
    // cover 80% case (label / concat). For arithmetic, use aggregate or SQL fn.
    // Expr resolves against POST-rename column names (rename runs before add
    // per spec) so curators reference what they just renamed.
    const TEMPLATE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    const warnedRefs = new Set<string>();
    const postRenameNames = new Set(renamedCols.map((c) => c.name));
    const evalExpr = (row: Record<string, unknown>, expr: string): unknown => {
      let hadRef = false;
      let nullDueToMissing = false;
      const out = expr.replace(TEMPLATE_RE, (_m, ref: string) => {
        hadRef = true;
        if (!postRenameNames.has(ref)) {
          if (!warnedRefs.has(ref)) {
            warnedRefs.add(ref);
            lineage.push({ input: `add:expr`, source: `warning: column '${ref}' not found in upstream` });
          }
          nullDueToMissing = true;
          return '';
        }
        const v = row[ref];
        return v === null || v === undefined ? '' : String(v);
      });
      // Mixed text + missing ref → null (per spec: missing → null + warning).
      if (hadRef && nullDueToMissing) return null;
      return out;
    };

    const outRows = upRows.map((r) => {
      const next: Record<string, unknown> = {};
      // Copy kept columns under their new names if renamed (so expr sees them).
      for (const oldC of keptCols) {
        const newName = rename[oldC.name] || oldC.name;
        next[newName] = r[oldC.name];
      }
      // Evaluate add exprs against the post-rename row.
      for (const a of add) {
        next[a.name] = evalExpr(next, a.expr);
      }
      return next;
    });

    const addedCols: OperatorColumn[] = add.map((a) => ({
      name: a.name,
      pgType: a.pgType || 'text',
    }));
    const outCols: OperatorColumn[] = [...renamedCols, ...addedCols];

    lineage.push({
      input: '__upstream',
      source: `${src.source} (projection keep=${keep ? keep.length : 'all'} rename=${Object.keys(rename).length} add=${add.length})`,
    });
    return {
      columns: outCols,
      rows: outRows,
      row_count: outRows.length,
      elapsed_ms: Date.now() - t0,
      lineage,
    };
  }

  if (op_kind === 'aggregate') {
    // Composer-native group-by + aggregate. Curator UX mirrors Power Query /
    // Alteryx: pick group_by columns, declare aggregations as a list. Output
    // columns = group_by columns ++ one column per aggregation (alias falls
    // back to '<fn>_<column>').
    //
    // Type inference: group_by columns inherit pgType from upstream; sum/min/
    // max also inherit from upstream; avg becomes 'numeric' (precision wins);
    // count becomes 'bigint'. This is a deliberate simplification — full
    // numeric promotion (int → bigint on overflow, etc.) is downstream's
    // problem, not the operator's.
    const groupByRaw = op_config.group_by;
    const groupBy: string[] = Array.isArray(groupByRaw) ? groupByRaw.map(String) : [];
    const aggsRaw = op_config.aggregations;
    const aggs: AggregateSpec[] = Array.isArray(aggsRaw)
      ? (aggsRaw as unknown[]).map((a) => {
          const o = a as Partial<AggregateSpec>;
          return { fn: o.fn as AggregateFn, column: String(o.column || ''), alias: o.alias };
        }).filter((a) => a.fn && a.column)
      : [];
    if (aggs.length === 0) {
      throw new Error(`Operator ${node_id} (aggregate): op_config.aggregations[] is required (at least one).`);
    }

    const groups = new Map<string, Record<string, unknown>[]>();
    if (groupBy.length === 0) {
      groups.set('__all__', upRows);
    } else {
      for (const r of upRows) {
        const key = groupBy.map((c) => `${c}=${String(r[c] ?? '')}`).join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
    }

    const outRows: Record<string, unknown>[] = [];
    for (const [, groupRows] of groups) {
      const out: Record<string, unknown> = {};
      if (groupBy.length > 0) {
        for (const c of groupBy) out[c] = groupRows[0]?.[c] ?? null;
      }
      for (const a of aggs) {
        const alias = a.alias || `${a.fn}_${a.column}`;
        const values = groupRows.map((r) => r[a.column]);
        out[alias] = computeAgg(a.fn, values);
      }
      outRows.push(out);
    }

    const outCols: OperatorColumn[] = [
      ...groupBy.map((c) => upCols.find((u) => u.name === c) || { name: c, pgType: 'text' }),
      ...aggs.map((a) => {
        const alias = a.alias || `${a.fn}_${a.column}`;
        const upCol = upCols.find((u) => u.name === a.column);
        const pgType =
          a.fn === 'count' ? 'bigint'
          : a.fn === 'avg' ? 'numeric'
          : a.fn === 'array_agg' ? (upCol?.pgType ? `${upCol.pgType}[]` : 'text[]')
          : (upCol?.pgType || 'numeric');
        return { name: alias, pgType };
      }),
    ];

    lineage.push({
      input: '__upstream',
      source: `${src.source} (aggregate group_by=${groupBy.join(',')||'<none>'} aggs=${aggs.map((a) => `${a.fn}(${a.column})`).join(',')})`,
    });
    return {
      columns: outCols,
      rows: outRows,
      row_count: outRows.length,
      elapsed_ms: Date.now() - t0,
      lineage,
    };
  }

  if (op_kind === 'cast') {
    const sourceColumn = String(op_config.source_column || '');
    // L1 (cross-db-tier-b-integration §L1): target_logical_type is the new
    // primary axis. target_pgType retained as legacy fallback so existing
    // saved DAGs keep working without re-publish. When both set, logical_type
    // wins because it carries cross-DB semantics; pgType is computed
    // best-effort for downstream PG-binding paths.
    const targetLogical = op_config.target_logical_type as LogicalType | undefined;
    const targetPgRaw = op_config.target_pgType as string | undefined;
    const targetPg = targetPgRaw || logicalToPgType(targetLogical) || 'text';
    const targetSem = op_config.target_semantic_type as string | undefined;
    if (!sourceColumn) throw new Error(`Operator ${node_id} (cast): op_config.source_column is required.`);
    if (!targetLogical && !targetPgRaw) {
      throw new Error(`Operator ${node_id} (cast): op_config.target_logical_type or target_pgType is required.`);
    }
    const patchedCols: OperatorColumn[] = upCols.map((c) =>
      c.name === sourceColumn
        ? {
            ...c,
            pgType: targetPg,
            logical_type: targetLogical ?? c.logical_type,
            semantic_type: targetSem ?? c.semantic_type,
          }
        : c
    );
    // Coerce values in that column row-by-row to make the cast effective at runtime,
    // not just metadata. Downstream fn binding will see the new JS type.
    const coerce = targetLogical
      ? (v: unknown) => coerceByLogicalType(v, targetLogical)
      : (v: unknown) => coerceLiteral(v, targetPg);
    const patchedRows = upRows.map((r) => ({
      ...r,
      [sourceColumn]: coerce(r[sourceColumn]),
    }));
    const castLabel = targetLogical || targetPg;
    lineage.push({ input: '__upstream', source: `${src.source} (cast ${sourceColumn} → ${castLabel})` });
    return {
      columns: patchedCols,
      rows: patchedRows,
      row_count: patchedRows.length,
      elapsed_ms: Date.now() - t0,
      lineage,
    };
  }

  throw new Error(`Operator ${node_id}: unknown op_kind '${op_kind}'`);
}

// ── AuthZ derivation: operator inherits the resource_id of the upstream fn.
// Caller uses this for both the authz_check call and the audit log resource_id
// so existing RBAC / forensic queries don't need new resource types.
export function deriveOperatorResourceId(opts: {
  op_kind: OpKind;
  inbound: Array<{ source: string }>;
  upstreamResourceIds: Record<string, string | undefined>;  // node_id → fn resource_id
}): string {
  const { op_kind, inbound, upstreamResourceIds } = opts;
  if (op_kind === 'literal') return 'operator:literal';
  for (const e of inbound) {
    const rid = upstreamResourceIds[e.source];
    if (rid) return rid;   // first upstream fn wins
  }
  return `operator:${op_kind}:no_upstream`;
}
