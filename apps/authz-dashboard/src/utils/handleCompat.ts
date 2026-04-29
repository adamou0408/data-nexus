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

export type IOLike = {
  name: string;
  semantic_type?: string;
  pgType?: string;
};

export type PgKind = 'text' | 'number' | 'bool' | 'date' | 'array' | 'json' | 'any';

export type CompatLevel = 'ok' | 'warn' | 'block';
export interface CompatResult {
  level: CompatLevel;
  reason?: string;     // human-readable hint surfaced in toast / tooltip
  outKind: PgKind;
  inKind: PgKind;
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

// Tri-state compatibility check. See module header for the policy.
export function checkHandleCompat(out: IOLike, inp: IOLike): CompatResult {
  const outKind = classifyKind(out.pgType);
  const inKind = classifyKind(inp.pgType);

  // 1. pgType is the hard rule. 'any' acts as a wildcard so untyped legacy IO still connects.
  const pgOk = outKind === inKind || outKind === 'any' || inKind === 'any';
  if (!pgOk) {
    return {
      level: 'block',
      reason: `pgType ${outKind} → ${inKind} mismatch`,
      outKind,
      inKind,
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
