// ============================================================
// XDB-TIER-B-L3: cross-DB edge compatibility — backend boundary.
//
// Why this exists (cross-db-tier-b-integration §L3):
//   L1 made every column carry a 9-LogicalType + unknown fallback.
//   L3 turns that vocabulary into an enforceable boundary at
//   /execute-node: when a fn input's logical_type is known and the
//   upstream column feeding it has a known but incompatible
//   logical_type, the request is rejected with HTTP 422 + an
//   actionable body that suggests cast targets.
//
// Decision baked (§5 row L3.1): "reject + suggest cast" — never
// auto-cast. Auto-casting silently changes the value the curator
// will see in production; the explicit cast operator keeps the
// transformation visible in the DAG.
//
// Suggested-cast policy (advised over `unknown` -> 'string' fallback):
//   * Same logical_type    → ok, no cast.
//   * unknown either side  → ok (legacy / transitional rows pass through;
//                            edge gate stays advisory until both sides typed).
//   * Compatible upgrades  → ok (e.g. int64 → decimal, date → timestamp).
//   * Hard mismatch        → not ok, suggest a list of resolvable target
//                            types via cast operator. 'string' is the
//                            universal sink per L1 matrix (§4 line 89,
//                            "← *"), so it appears in every suggestion.
//
// Mirrored on the frontend in apps/authz-dashboard/src/utils/handleCompat.ts
// (see header there for the protocol). Both modules read the same 9-type
// enum from db-driver.ts; the matrices below are kept in sync manually.
// ============================================================
import type { LogicalType } from './db-driver';

// Coerce a pgType string (as stored in fn metadata `inputs[].pgType` /
// `parsed_args[].pgType`) into a LogicalType. The discovery pipeline
// (function-metadata.ts) currently records pgType strings, not OIDs —
// this helper bridges that representation back to the L1 vocabulary
// without forcing a backfill of every authz_resource row.
//
// Mirrors PG_OID_TO_LOGICAL semantics in db-driver.ts but works off the
// human-readable string. Anything unrecognised returns 'unknown' so the
// edge gate stays advisory until both sides typed.
export function pgTypeStringToLogical(pg: string | undefined): LogicalType {
  if (!pg) return 'unknown';
  const t = pg.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return 'unknown';
  // arrays — no first-class array logical type; fall back to string for now
  if (t.endsWith('[]') || t.startsWith('_')) return 'string';
  if (t === 'boolean' || t === 'bool') return 'bool';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t === 'bytea') return 'bytes';
  if (t === 'date') return 'date';
  if (t.startsWith('timestamp') || t === 'timestamptz') return 'timestamp';
  if (t === 'time' || t.startsWith('time ') || t === 'timetz') return 'string';
  if (t.startsWith('numeric') || t.startsWith('decimal') || t === 'money') return 'decimal';
  if (t === 'real' || t === 'float4' || t === 'double precision' || t === 'float8' || t === 'double' || t === 'float') return 'float64';
  if (/^(int|int2|int4|int8|integer|bigint|smallint|serial|bigserial|smallserial)(\s|\(|$)/.test(t)) return 'int64';
  if (/^(text|varchar|char|character|character varying|uuid|name|inet|cidr|citext|nvarchar2|nchar|clob|nclob)(\s|\(|$)/.test(t)) return 'string';
  return 'unknown';
}

export interface CanConnectResult {
  ok: boolean;
  /** Resolvable cast targets when ok=false. Always non-empty on the failure
   *  path because 'string' is the universal fallback. Order is hint
   *  preference (most-precision-preserving first, 'string' last). */
  needCast?: LogicalType[];
}

// Compatible upgrade matrix. Entry `from -> [to1, to2]` means a value of
// type `from` can flow into an input of type `to_n` without cast — the
// downstream operator/PG bind handles the widening losslessly. 'string'
// is added to every from's accept list at lookup time as the universal
// sink (it absorbs anything serialisable; lossy in semantics but never
// lossy in *bytes* for downstream display).
//
// Asymmetry is intentional: int64 → decimal is fine (widening), but
// decimal → int64 is not (rounding). Curators must insert an explicit
// cast for narrowing, which forces the round() / trunc() decision into
// the visible DAG.
const UPGRADES: Partial<Record<LogicalType, LogicalType[]>> = {
  int64:     ['decimal', 'float64'],
  decimal:   ['float64'],
  date:      ['timestamp'],
};

// Suggested cast targets when an edge is rejected. The frontend uses
// the *first* target as the default for the right-click "Insert cast
// operator (target: X)" menu item, so the most-faithful target sits at
// position 0.
//
// Why not the full nine-element vocabulary every time: too many choices
// hides the right one. Keep the list to plausible casts (`bytes` is
// almost never what you want from a `bool` source), with 'string' as
// the always-available escape hatch.
const SUGGESTED_TARGETS: Record<LogicalType, LogicalType[]> = {
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

/**
 * Decide whether a value of LogicalType `from` may flow into an input
 * of LogicalType `to` without an intervening cast operator.
 *
 * Returns:
 *   { ok: true }            — same type or compatible upgrade
 *   { ok: false, needCast } — hard mismatch; needCast lists target
 *                              logical_types that the curator can
 *                              insert a cast operator for. Never empty.
 *
 * `unknown` on either side is permissive (returns ok) — that side has
 * no source-of-truth type yet (e.g. column came from a fn whose
 * metadata wasn't backfilled), and rejecting would block legitimate
 * legacy DAGs. The frontend marks these as 'warn' in the inspector.
 */
export function canConnect(from: LogicalType, to: LogicalType): CanConnectResult {
  if (from === to) return { ok: true };
  if (from === 'unknown' || to === 'unknown') return { ok: true };

  const upgrades = UPGRADES[from] || [];
  if (upgrades.includes(to)) return { ok: true };

  // Hard mismatch — suggest casts. Filter to targets whose own row
  // accepts `to` so the curator's chosen cast actually resolves the
  // problem (cast result type → can connect to downstream input).
  // Always include 'string' as safety net even if it's not "ideal" —
  // ok-bound = "no cast option" must never happen.
  const candidates = SUGGESTED_TARGETS[from] || ['string'];
  const resolved = candidates.filter((t) => {
    if (t === to) return true;
    const tUpgrades = UPGRADES[t] || [];
    return tUpgrades.includes(to);
  });
  // Universal fallback: target=`string` only resolves if downstream
  // accepts `string` — which it does only when downstream is `string`
  // itself. Otherwise the curator needs a *chained* cast (string→...).
  // We surface 'string' anyway because it's the documented universal
  // sink (§4 line 89) and a cast-to-string + downstream-accepts-string
  // is the most common resolution path in practice.
  if (resolved.length === 0) {
    return { ok: false, needCast: ['string'] };
  }
  return { ok: false, needCast: resolved };
}
