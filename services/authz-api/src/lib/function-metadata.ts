// ============================================================
// Function metadata parser — shared by discovery + query-exec.
//
// Parses PostgreSQL function signatures from pg_get_function_arguments
// and pg_get_function_result into structured, UI-renderable form.
//
// Feeds the unified node model (spec §3.2): every node exposes
// { inputs, outputs, side_effects, idempotent } so that DAG edges
// can type-check and the UI can auto-generate forms.
// ============================================================

export type ParamKind =
  | 'text' | 'number' | 'bool' | 'date' | 'datetime'
  | 'array' | 'json' | 'unknown';

export interface ParsedArg {
  name: string;
  pgType: string;
  kind: ParamKind;
  hasDefault: boolean;
  mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
}

export interface OutputColumn {
  name: string;
  pgType: string;
  kind: ParamKind;
}

export type ReturnShape =
  | { shape: 'table'; columns: OutputColumn[] }       // TABLE(col t, ...)
  | { shape: 'setof'; pgType: string; kind: ParamKind } // SETOF <type>
  | { shape: 'scalar'; pgType: string; kind: ParamKind }
  | { shape: 'void' }
  | { shape: 'unknown'; raw: string };

export type FunctionSubtype = 'query' | 'calculation' | 'action' | 'report';

export interface FunctionMetadata {
  arguments: string;          // raw pg_get_function_arguments output (preserved for display)
  return_type: string;        // raw pg_get_function_result output
  parsed_args: ParsedArg[];
  return_shape: ReturnShape;
  subtype: FunctionSubtype;
  volatility: 'IMMUTABLE' | 'STABLE' | 'VOLATILE';
  idempotent: boolean;
  side_effects: boolean;
}

// ── Type classification (drives UI form rendering, Appendix A) ──

export function classifyType(pgType: string): ParamKind {
  const t = pgType.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return 'unknown';
  if (t.endsWith('[]') || t.startsWith('_')) return 'array';
  if (t === 'boolean' || t === 'bool') return 'bool';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (/^(int|int2|int4|int8|integer|bigint|smallint|numeric|decimal|real|double\s+precision|double|float|float4|float8|money|serial|bigserial|smallserial)(\s|\(|$)/.test(t)) return 'number';
  if (t.startsWith('timestamp')) return 'datetime';
  if (t === 'date') return 'date';
  if (t === 'time' || t.startsWith('time ')) return 'datetime';
  if (/^(text|varchar|char|character|character\s+varying|uuid|bytea|name|inet|cidr|citext)(\s|\(|$)/.test(t)) return 'text';
  return 'unknown';
}

// ── Argument parser (handles DEFAULT, VARIADIC, OUT, nested parens) ──

export function parseFunctionArgs(argString: string): ParsedArg[] {
  if (!argString || !argString.trim()) return [];

  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of argString) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());

  return parts.map((raw) => {
    let work = raw.trim();
    let mode: ParsedArg['mode'] = 'IN';
    const modeMatch = work.match(/^(IN|OUT|INOUT|VARIADIC)\s+/i);
    if (modeMatch) {
      mode = modeMatch[1].toUpperCase() as ParsedArg['mode'];
      work = work.slice(modeMatch[0].length);
    }

    const defaultMatch = work.match(/\s+DEFAULT\s+/i);
    const beforeDefault = defaultMatch ? work.slice(0, defaultMatch.index) : work;
    const tokens = beforeDefault.trim().split(/\s+/);
    const name = tokens[0];
    const pgType = tokens.slice(1).join(' ');

    return {
      name,
      pgType,
      kind: classifyType(pgType),
      hasDefault: !!defaultMatch,
      mode,
    };
  });
}

// ── Return-type parser (TABLE(...), SETOF, scalar, void) ──

export function parseReturnType(returnType: string): ReturnShape {
  const raw = (returnType || '').trim();
  if (!raw) return { shape: 'unknown', raw };
  if (/^void$/i.test(raw)) return { shape: 'void' };

  const tableMatch = raw.match(/^TABLE\s*\(([\s\S]*)\)\s*$/i);
  if (tableMatch) {
    const columns = splitTopLevel(tableMatch[1]).map((col) => {
      const tokens = col.trim().split(/\s+/);
      // Column names may be double-quoted: "col name" type
      const nameMatch = col.match(/^\s*("([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+([\s\S]+)$/);
      if (nameMatch) {
        const name = nameMatch[2] || nameMatch[3];
        const pgType = nameMatch[4].trim();
        return { name, pgType, kind: classifyType(pgType) };
      }
      return { name: tokens[0] || '?', pgType: tokens.slice(1).join(' '), kind: classifyType(tokens.slice(1).join(' ')) };
    });
    return { shape: 'table', columns };
  }

  const setofMatch = raw.match(/^SETOF\s+(.+)$/i);
  if (setofMatch) {
    const inner = setofMatch[1].trim();
    return { shape: 'setof', pgType: inner, kind: classifyType(inner) };
  }

  return { shape: 'scalar', pgType: raw, kind: classifyType(raw) };
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let inQuote = false;
  for (const c of s) {
    if (c === '"') inQuote = !inQuote;
    if (!inQuote) {
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) {
        if (current.trim()) out.push(current.trim());
        current = '';
        continue;
      }
    }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// ── Subtype classification (Appendix B.1-B.4) ──

// Action verbs — match as a whole word anywhere in the name (e.g. fn_material_attr_sync).
const ACTION_NAME_RE = /(^|_)(do|run|exec|execute|create|update|delete|insert|upsert|refresh|sync|reset|trigger|apply|submit|send|notify|grant|revoke|enable|disable|start|stop|cancel|import|export|rebuild|reindex|vacuum)(_|$)/i;
const REPORT_NAME_RE = /(report|summary|stats|statistics|dashboard|kpi|trend|aggregate|breakdown|card|scorecard)/i;

export function classifySubtype(opts: {
  name: string;
  volatility: 'IMMUTABLE' | 'STABLE' | 'VOLATILE';
  returnShape: ReturnShape;
}): FunctionSubtype {
  const { name, volatility, returnShape } = opts;

  // Action: write side-effects (volatile + action-verb name, or void return)
  if (returnShape.shape === 'void') return 'action';
  if (volatility === 'VOLATILE' && ACTION_NAME_RE.test(name)) return 'action';

  // Report: only when the name signals it — column count alone is a poor proxy
  // since wide point-lookups (e.g. fn_material_lookup) return many columns too.
  if (REPORT_NAME_RE.test(name)) return 'report';

  // Query: set-returning
  if (returnShape.shape === 'table' || returnShape.shape === 'setof') return 'query';

  // Calculation: scalar pure function
  return 'calculation';
}

// ── One-shot umbrella (used by discovery) ──

export function extractFunctionMetadata(opts: {
  name: string;
  arguments: string;
  return_type: string;
  volatility: 'IMMUTABLE' | 'STABLE' | 'VOLATILE';
}): FunctionMetadata {
  const parsed_args = parseFunctionArgs(opts.arguments);
  const return_shape = parseReturnType(opts.return_type);
  const subtype = classifySubtype({
    name: opts.name,
    volatility: opts.volatility,
    returnShape: return_shape,
  });

  return {
    arguments: opts.arguments,
    return_type: opts.return_type,
    parsed_args,
    return_shape,
    subtype,
    volatility: opts.volatility,
    idempotent: opts.volatility !== 'VOLATILE',
    side_effects: subtype === 'action',
  };
}
