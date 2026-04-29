// ============================================================
// DAG validation engine (W4 of the L3 composition roadmap).
// Covers spec §3.5: DV-01 type consistency, DV-03 cycle detection,
// DV-04 orphan detection, plus required-input coverage.
//
// Input shape is deliberately permissive so the frontend can hand
// us React Flow's {nodes, edges} dictionary verbatim.
// ============================================================

export interface DagNode {
  id: string;
  type?: string;                 // 'fn' (default) | 'literal' | 'filter' | 'cast' | 'aggregate' | 'sink'
                                 // Validation is permissive: unknown types pass through; only edges
                                 // and inputs/outputs metadata drive type/cycle/missing-input checks.
                                 // Sinks have no outputs, so they never trigger type_mismatch.
  data?: {
    resource_id?: string;
    function_name?: string;
    inputs?: Array<{ name: string; semantic_type?: string; hasDefault?: boolean; pgType?: string }>;
    outputs?: Array<{ name: string; semantic_type?: string; pgType?: string }>;
    bound_params?: Record<string, unknown>; // user-supplied constants
    op_kind?: 'literal' | 'filter' | 'cast' | 'aggregate';
    sink_kind?: 'page';
    sink_config?: Record<string, unknown>;
    op_config?: Record<string, unknown>;
  };
}

export interface DagEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;  // upstream output name
  targetHandle?: string | null;  // downstream input name
}

export interface DagDoc {
  nodes: DagNode[];
  edges: DagEdge[];
}

export interface ValidationIssue {
  severity: 'error' | 'warn';
  code:
    | 'type_mismatch'
    | 'cycle'
    | 'orphan'
    | 'missing_input'
    | 'unknown_source'
    | 'unknown_target'
    | 'unknown_handle';
  message: string;
  node_id?: string;
  edge_id?: string;
}

// pgType "kind" family — mirrors apps/authz-dashboard/src/utils/handleCompat.ts.
// Kept inline so dag-validate has zero cross-package imports.
function kindFamily(pg?: string): 'text' | 'number' | 'bool' | 'date' | 'array' | 'json' | 'any' {
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

export function validateDag(doc: DagDoc): { ok: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, DagNode>();
  for (const n of doc.nodes) byId.set(n.id, n);

  // 1. Edges reference real nodes + handles
  for (const e of doc.edges) {
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (!src) {
      issues.push({ severity: 'error', code: 'unknown_source', message: `Edge ${e.id}: source ${e.source} not found`, edge_id: e.id });
      continue;
    }
    if (!tgt) {
      issues.push({ severity: 'error', code: 'unknown_target', message: `Edge ${e.id}: target ${e.target} not found`, edge_id: e.id });
      continue;
    }

    const outName = e.sourceHandle;
    const inName = e.targetHandle;
    const srcOut = outName ? (src.data?.outputs || []).find((o) => o.name === outName) : undefined;
    const tgtIn = inName ? (tgt.data?.inputs || []).find((i) => i.name === inName) : undefined;

    if (outName && !srcOut) {
      issues.push({ severity: 'error', code: 'unknown_handle', message: `Edge ${e.id}: source has no output '${outName}'`, edge_id: e.id });
      continue;
    }
    if (inName && !tgtIn) {
      issues.push({ severity: 'error', code: 'unknown_handle', message: `Edge ${e.id}: target has no input '${inName}'`, edge_id: e.id });
      continue;
    }

    // Operator handles (`__upstream` / `__downstream` / semantic_type='__rowset')
    // are passthrough by design — type compatibility is checked at the upstream
    // or downstream fn boundary, not inside the operator chain. Skip strict
    // checks when either side is operator-flavored.
    const isOperatorHandle =
      outName === '__downstream' || inName === '__upstream' ||
      srcOut?.semantic_type === '__rowset' || tgtIn?.semantic_type === '__rowset';
    if (isOperatorHandle) continue;

    // DV-01 — type consistency. Hybrid model (mirrors apps/.../utils/handleCompat.ts
    // post-2026-04-29 redesign):
    //   • pgType family mismatch → severity='error' (hard rule, blocks save).
    //   • Same pgType but different semantic_type → severity='warn' (advisory only).
    //     Curator may insert a Cast or align metadata, but is not forced.
    //   • semantic_type is no longer the SSOT — it's a curator-defined string with no
    //     canonical vocabulary, so we don't fail saves on it. PG runtime is the truth.
    const outSem = srcOut?.semantic_type;
    const inSem = tgtIn?.semantic_type;
    const outPg = srcOut?.pgType;
    const inPg = tgtIn?.pgType;
    const renderSide = (sem?: string, pg?: string) => {
      const semPart = sem && sem !== 'unknown' ? sem : 'unclassified';
      const pgPart = pg || 'unknown';
      return `${semPart}/${pgPart}`;
    };
    const kindMismatch =
      kindFamily(outPg) !== 'any' && kindFamily(inPg) !== 'any' &&
      kindFamily(outPg) !== kindFamily(inPg);
    const semStrictMismatch =
      !!(outSem && inSem && outSem !== 'unknown' && inSem !== 'unknown' && outSem !== inSem);
    if (kindMismatch) {
      issues.push({
        severity: 'error',
        code: 'type_mismatch',
        message:
          `Edge ${e.id}: ` +
          `'${outName}' (${renderSide(outSem, outPg)}) → ` +
          `'${inName}' (${renderSide(inSem, inPg)}) — ` +
          `pgType family mismatch (${kindFamily(outPg)} vs ${kindFamily(inPg)}). ` +
          `Hint: insert a Cast node to coerce ${kindFamily(outPg)} → ${kindFamily(inPg)}.`,
        edge_id: e.id,
      });
    } else if (semStrictMismatch) {
      issues.push({
        severity: 'warn',
        code: 'type_mismatch',
        message:
          `Edge ${e.id}: ` +
          `'${outName}' (${renderSide(outSem, outPg)}) → ` +
          `'${inName}' (${renderSide(inSem, inPg)}) — ` +
          `semantic_type mismatch (${outSem} vs ${inSem}, advisory). ` +
          `pgType is compatible; curator may align semantic_type or insert a Cast if domains truly differ.`,
        edge_id: e.id,
      });
    }
  }

  // 2. DV-03 — cycle detection (DFS with colour marking)
  const adj = new Map<string, string[]>();
  for (const n of doc.nodes) adj.set(n.id, []);
  for (const e of doc.edges) {
    if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
  }
  const colour = new Map<string, 0 | 1 | 2>(); // 0=white, 1=grey, 2=black
  for (const n of doc.nodes) colour.set(n.id, 0);
  function dfs(nid: string, path: string[]): boolean {
    colour.set(nid, 1);
    for (const next of adj.get(nid) || []) {
      const c = colour.get(next) || 0;
      if (c === 1) {
        issues.push({
          severity: 'error',
          code: 'cycle',
          message: `Cycle detected: ${[...path, nid, next].join(' → ')}`,
          node_id: nid,
        });
        return true;
      }
      if (c === 0 && dfs(next, [...path, nid])) return true;
    }
    colour.set(nid, 2);
    return false;
  }
  for (const n of doc.nodes) {
    if (colour.get(n.id) === 0) dfs(n.id, []);
  }

  // 3. Required inputs — each non-default input must be connected OR bound
  const inboundByNode = new Map<string, Set<string>>(); // target node → connected input names
  for (const e of doc.edges) {
    if (!e.targetHandle) continue;
    if (!inboundByNode.has(e.target)) inboundByNode.set(e.target, new Set());
    inboundByNode.get(e.target)!.add(e.targetHandle);
  }
  for (const n of doc.nodes) {
    const inputs = n.data?.inputs || [];
    const bound = n.data?.bound_params || {};
    const connected = inboundByNode.get(n.id) || new Set();
    for (const i of inputs) {
      if (i.hasDefault) continue;
      if (connected.has(i.name)) continue;
      if (Object.prototype.hasOwnProperty.call(bound, i.name)) continue;
      issues.push({
        severity: 'error',
        code: 'missing_input',
        message: `Node ${n.id}: required input '${i.name}' is neither connected nor bound`,
        node_id: n.id,
      });
    }
  }

  // 4. DV-04 — orphan detection (no inbound AND no outbound, and DAG has >1 nodes)
  if (doc.nodes.length > 1) {
    const hasOut = new Set<string>();
    const hasIn = new Set<string>();
    for (const e of doc.edges) {
      hasOut.add(e.source);
      hasIn.add(e.target);
    }
    for (const n of doc.nodes) {
      if (!hasOut.has(n.id) && !hasIn.has(n.id)) {
        issues.push({
          severity: 'warn',
          code: 'orphan',
          message: `Node ${n.id} is orphaned (no edges)`,
          node_id: n.id,
        });
      }
    }
  }

  const ok = issues.every((i) => i.severity !== 'error');
  return { ok, issues };
}

// Topological sort — returns node IDs in execution order, or null on cycle.
export function topoSort(doc: DagDoc): string[] | null {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of doc.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of doc.edges) {
    if (!indeg.has(e.target) || !adj.has(e.source)) continue;
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
    adj.get(e.source)!.push(e.target);
  }
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of adj.get(id) || []) {
      const d = (indeg.get(next) || 1) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return out.length === doc.nodes.length ? out : null;
}
