// ============================================================
// Composer-native operator runtime — composer-operator-and-sink plan §3.3.
//
// Operator nodes are passthrough or constant-emitting transforms that run
// inside the composer (not registered as PG functions in authz_resource).
// They inherit AuthZ from the upstream fn whose output they shape — see
// plan §3.2 for the rationale.
//
// Phase 1 kinds: literal | filter | cast.
// ============================================================

export interface OperatorColumn {
  name: string;
  pgType?: string;
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

type OpKind = 'literal' | 'filter' | 'cast' | 'aggregate';

export type AggregateFn = 'sum' | 'count' | 'min' | 'max' | 'avg';
export interface AggregateSpec {
  fn: AggregateFn;
  column: string;       // upstream column name; for 'count' the value is largely irrelevant — non-null rows
  alias?: string;       // output column name; defaults to '<fn>_<column>'
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

function applyPredicate(
  rows: Record<string, unknown>[],
  column: string,
  op: FilterOp,
  value: string,
): Record<string, unknown>[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  switch (op) {
    case 'eq':
      return rows.filter((r) => String(r[column] ?? '') === value);
    case 'ne':
      return rows.filter((r) => String(r[column] ?? '') !== value);
    case 'in': {
      const set = new Set(value.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
      return rows.filter((r) => set.has(String(r[column] ?? '')));
    }
    case 'gt':
    case 'lt': {
      const n = Number(value);
      const cmp = op === 'gt' ? (a: number) => a > n : (a: number) => a < n;
      return rows.filter((r) => {
        const m = Number(r[column]);
        return Number.isFinite(m) && cmp(m);
      });
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
        return [];
      }
      return rows.filter((r) => re.test(String(r[column] ?? '')));
    }
    default:
      return rows;
  }
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
    const targetPg = (op_config.target_pgType as string) || 'text';
    const targetSem = op_config.target_semantic_type as string | undefined;
    if (!sourceColumn) throw new Error(`Operator ${node_id} (cast): op_config.source_column is required.`);
    const patchedCols: OperatorColumn[] = upCols.map((c) =>
      c.name === sourceColumn ? { ...c, pgType: targetPg, semantic_type: targetSem ?? c.semantic_type } : c
    );
    // Coerce values in that column row-by-row to make the cast effective at runtime,
    // not just metadata. Downstream fn binding will see the new JS type.
    const patchedRows = upRows.map((r) => ({
      ...r,
      [sourceColumn]: coerceLiteral(r[sourceColumn], targetPg),
    }));
    lineage.push({ input: '__upstream', source: `${src.source} (cast ${sourceColumn} → ${targetPg})` });
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
