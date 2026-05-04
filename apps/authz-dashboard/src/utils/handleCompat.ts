// Handle compatibility for Flow Composer (DagTab) edge connections.
//
// Hybrid model (post-2026-04-29 downgrade — Q1 redesign):
//   • pgType family is the **hard rule** (PG is the SSOT, no curator vocab to maintain).
//     If pgType kinds differ (e.g. text → number), connection is blocked at the rubber-band level.
//   • semantic_type is **advisory only**. Same pgType but different semantic_type produces a
//     warning (yellow ring + warn toast) but the edge is allowed. Curator can choose to insert
//     a Cast node or align metadata, but is not forced to.
//
// Why we downgraded semantic_type:
//   The string namespace had no SSOT and was already colliding (`status` from work-orders vs
//   shipments vs materials). Treating it as advisory removes the maintenance burden while keeping
//   colour cues + palette suggest. pgType-only is what the runtime PG bind already enforces.
//
// Why we kept the old `isCompatibleHandle` boolean export:
//   A handful of call sites (FunctionNode ring, isValidConnection drop guard) just want
//   "should this connect at all?". They keep working: the boolean now answers "level !== block".
//   Call sites that want the advisory level call `checkHandleCompat` directly.
//
// XDB-TIER-B-L3 protocol (cross-db-tier-b-integration §L3):
//   The CompatResult shape now carries an optional `suggestedCasts: LogicalType[]` populated
//   when level==='block' AND both sides have a known LogicalType. EdgeWithType reads this to
//   render a red line + right-click "Insert cast operator (target: X)" entries. The list mirrors
//   services/authz-api/src/lib/logical-type-compat.ts (SUGGESTED_TARGETS / UPGRADES) — keep them
//   in sync manually. 'string' is the universal sink (§4 line 89) and is always reachable on the
//   failure path so the curator never sees an empty suggestion list.
//
//   IMPORTANT for future agents: Do NOT re-extend the type vocabulary on this side. The 9
//   LogicalType values + unknown are the SSOT (mirrored from db-driver.ts). Adding a new shape
//   beyond the existing tri-state + suggestedCasts is the path to drift; resist it. If you need
//   another axis, lift it backend-side first and let it flow back through the existing API.

// 9 LogicalType values + unknown — DB-agnostic interchange across PG/Oracle.
// Mirrors services/authz-api/src/lib/db-driver.ts; kept in sync manually (small enum).
export type LogicalType =
  | 'string' | 'int64' | 'decimal' | 'float64'
  | 'bool' | 'date' | 'timestamp' | 'bytes' | 'json' | 'unknown';

export type IOLike = {
  name: string;
  semantic_type?: string;
  pgType?: string;
  logical_type?: LogicalType;
};

export type PgKind = 'text' | 'number' | 'bool' | 'date' | 'array' | 'json' | 'any';

export type CompatLevel = 'ok' | 'warn' | 'block';
export interface CompatResult {
  level: CompatLevel;
  reason?: string;     // human-readable hint surfaced in toast / tooltip
  outKind: PgKind;
  inKind: PgKind;
  // XDB-TIER-B-L3: only populated when level==='block' AND both sides have a known
  // LogicalType. Order is hint preference (most-precision-preserving first, 'string'
  // last). EdgeWithType uses suggestedCasts[0] as the default for the right-click
  // "Insert cast operator (target: X)" menu entry.
  suggestedCasts?: LogicalType[];
  // The from/to LogicalType pair that produced suggestedCasts. Surfaced for the
  // Inspector / toast wording so the user sees "timestamp → string" not just kind.
  fromLogical?: LogicalType;
  toLogical?: LogicalType;
}

// L3 upgrade matrix — mirrors services/authz-api/src/lib/logical-type-compat.ts.
// Keep entries in sync manually. Same-type and unknown pass before this matrix
// is consulted; this only encodes the *non-trivial* widening allowances.
const L3_UPGRADES: Partial<Record<LogicalType, LogicalType[]>> = {
  int64:   ['decimal', 'float64'],
  decimal: ['float64'],
  date:    ['timestamp'],
};

// L3 suggested-cast targets — mirrors backend SUGGESTED_TARGETS. 'string' is the
// universal fallback per §L1 line 89 and always appears on the failure path so
// the curator never gets an empty needCast list.
const L3_SUGGESTED_TARGETS: Record<LogicalType, LogicalType[]> = {
  string:    ['string'],
  int64:     ['decimal', 'float64', 'string'],
  decimal:   ['float64', 'string'],
  float64:   ['decimal', 'string'],
  bool:      ['string'],
  date:      ['timestamp', 'string'],
  timestamp: ['date', 'string'],
  bytes:     ['string'],
  json:      ['string'],
  unknown:   ['string'],
};

// Decide same-type / upgrade compatibility between two LogicalType values.
// Returns the mirror of canConnect()'s ok-bound on the backend.
function logicalCanConnect(from: LogicalType, to: LogicalType): boolean {
  if (from === to) return true;
  if (from === 'unknown' || to === 'unknown') return true;
  return (L3_UPGRADES[from] || []).includes(to);
}

// Compute suggestedCasts list — mirror of backend canConnect()'s needCast bound.
// Returns at minimum ['string'] when called with a real mismatch.
function computeSuggestedCasts(from: LogicalType, to: LogicalType): LogicalType[] {
  const candidates = L3_SUGGESTED_TARGETS[from] || ['string'];
  const resolved = candidates.filter((t) => {
    if (t === to) return true;
    return (L3_UPGRADES[t] || []).includes(to);
  });
  return resolved.length === 0 ? ['string'] : resolved;
}

export function classifyKind(pg?: string): PgKind {
  if (!pg) return 'any';
  const p = pg.toLowerCase().trim();
  if (p.includes('[]') || p.startsWith('_')) return 'array';
  if (p.includes('char') || p === 'text' || p === 'name' || p === 'citext' || p === 'uuid') return 'text';
  if (
    p.includes('int') || p.includes('numeric') || p.includes('decimal') ||
    p === 'real' || p === 'double precision' || p === 'float4' || p === 'float8' ||
    p === 'money' || p === 'serial' || p === 'bigserial'
  ) return 'number';
  if (p === 'boolean' || p === 'bool') return 'bool';
  if (p.includes('timestamp') || p === 'date' || p === 'time' || p === 'timetz' || p === 'interval') return 'date';
  if (p === 'json' || p === 'jsonb') return 'json';
  return 'any';
}

// L1 cross-DB fallback: when pgType is absent (Oracle source columns carry only
// logical_type), classify by logical_type so the edge gate stays meaningful
// instead of degrading to 'any' wildcard.
export function logicalToKind(lt?: LogicalType): PgKind {
  if (!lt) return 'any';
  switch (lt) {
    case 'string': return 'text';
    case 'int64': case 'decimal': case 'float64': return 'number';
    case 'bool': return 'bool';
    case 'date': case 'timestamp': return 'date';
    case 'json': return 'json';
    case 'bytes': return 'any'; // no kind for bytes; permissive until there's a use case
    case 'unknown': default: return 'any';
  }
}

// Prefer pgType when present (PG SSOT); fall back to logical_type for Oracle/cross-DB IO.
function ioToKind(io: IOLike): PgKind {
  if (io.pgType) return classifyKind(io.pgType);
  return logicalToKind(io.logical_type);
}

// Tri-state compatibility check. See module header for the policy.
export function checkHandleCompat(out: IOLike, inp: IOLike): CompatResult {
  const outKind = ioToKind(out);
  const inKind = ioToKind(inp);

  // 1. pgType is the hard rule. 'any' acts as a wildcard so untyped legacy IO still connects.
  const pgOk = outKind === inKind || outKind === 'any' || inKind === 'any';
  if (!pgOk) {
    // XDB-TIER-B-L3: when both sides carry a known LogicalType, surface a
    // mirrored canConnect verdict so the edge can offer "Insert cast" with a
    // pre-filled target_logical_type. When either side is missing/unknown,
    // suggestedCasts stays undefined and the UI falls back to a generic
    // "fix the types" hint via `reason`.
    const fromLT = out.logical_type;
    const toLT = inp.logical_type;
    const haveBothLT = !!fromLT && !!toLT && fromLT !== 'unknown' && toLT !== 'unknown';
    const suggestedCasts = haveBothLT && !logicalCanConnect(fromLT!, toLT!)
      ? computeSuggestedCasts(fromLT!, toLT!)
      : undefined;
    return {
      level: 'block',
      reason: haveBothLT
        ? `${fromLT} → ${toLT} mismatch (insert cast: ${(suggestedCasts || ['string'])[0]})`
        : `pgType ${outKind} → ${inKind} mismatch`,
      outKind,
      inKind,
      suggestedCasts,
      fromLogical: haveBothLT ? fromLT : undefined,
      toLogical: haveBothLT ? toLT : undefined,
    };
  }

  // 2. Same pgType but different semantic_type → advisory warn (allowed).
  const oSem = out.semantic_type;
  const iSem = inp.semantic_type;
  const semStrictMismatch =
    oSem && iSem && oSem !== 'unknown' && iSem !== 'unknown' && oSem !== iSem;
  if (semStrictMismatch) {
    return {
      level: 'warn',
      reason: `semantic ${oSem} ≠ ${iSem} (advisory — pgType still matches)`,
      outKind,
      inKind,
    };
  }

  return { level: 'ok', outKind, inKind };
}

// Back-compat boolean — only blocks pgType mismatch now. Used by isValidConnection (xyflow drop
// guard) and by FunctionNode ring "should this rubber-band even connect" check.
export function isCompatibleHandle(out: IOLike, inp: IOLike): boolean {
  return checkHandleCompat(out, inp).level !== 'block';
}
