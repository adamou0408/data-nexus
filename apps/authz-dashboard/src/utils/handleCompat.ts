// Handle compatibility for Flow Composer (DagTab) edge connections.
//
// Two-tier compatibility check:
//   1) If both sides have a non-'unknown' semantic_type, require strict equality.
//   2) Otherwise fall back to pgType "kind" family (text / number / date ...).
//
// The fallback is needed because the function-discovery pipeline only persists
// `parsed_args` + `return_shape.columns` with `pgType` and `kind` — it does NOT
// populate `semantic_type` on tiptop schema functions. Strict equality at that
// point blocks legitimate varchar→text connections.

export type IOLike = {
  name: string;
  semantic_type?: string;
  pgType?: string;
};

export type PgKind = 'text' | 'number' | 'bool' | 'date' | 'array' | 'json' | 'any';

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

export function isCompatibleHandle(out: IOLike, inp: IOLike): boolean {
  const oSem = out.semantic_type;
  const iSem = inp.semantic_type;
  if (oSem && iSem && oSem !== 'unknown' && iSem !== 'unknown') {
    return oSem === iSem;
  }
  const oKind = classifyKind(out.pgType);
  const iKind = classifyKind(inp.pgType);
  return oKind === iKind || oKind === 'any' || iKind === 'any';
}
