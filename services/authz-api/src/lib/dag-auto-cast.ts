// ============================================================
// DAG auto-cast (DAG-AUTOCAST-V01).
//
// Turn DV-01 kindFamily mismatches into auto-inserted cast nodes
// when the conversion direction is provably safe (widening only).
//
// Why "widening only":
//   - numeric → int4 truncates silently (data loss)
//   - text    → int4 fails at runtime when the value isn't parseable
//   - text    → date is format-dependent (locale / timezone surprise)
//   So we never silently convert in directions that can drop data
//   or fail at execute time. Mismatches outside the safe whitelist
//   fall through to the original DV-01 error so the curator gets
//   the existing hint and decides manually.
//
// Cast nodes inserted here are PERSISTED, VISIBLE nodes — same as
// if the curator dragged them in. They show up on the canvas, can
// be edited or deleted. No silent runtime decoration: the curator
// always sees what was added and why.
//
// R1 whitelist (conservative, expand later when evidence justifies):
//   ANY scalar → text   (PG castable, never fails at runtime)
//
// Wiring: original edge `src.col → tgt.input` becomes
//   src --[col]-->                  cast (__upstream, semantic=__rowset)
//   cast --[col, pgType=target]--> tgt --[input]
// dag-validate already type-skips edges that touch __upstream /
// semantic=__rowset, so the inbound edge passes; the outbound
// edge re-passes type check because cast.outputs declares the
// column at the target pgType.
// ============================================================

import { kindFamily } from './dag-validate';
import type { DagDoc, DagNode, DagEdge } from './dag-validate';

export interface AutoCastInsert {
  /** id of the original edge that triggered the cast */
  edge_id: string;
  source_node: string;
  source_handle: string;
  target_node: string;
  target_handle: string;
  from_pgtype: string;
  to_pgtype: string;
  /** id of the cast node inserted between source and target */
  inserted_node_id: string;
}

export interface AutoCastResult {
  doc: DagDoc;
  inserted: AutoCastInsert[];
}

/**
 * Pick a safe target pgType for a cast node when src.kindFamily ≠ tgt.kindFamily.
 * Conservative whitelist — returns null if no safe direction exists, in which
 * case the caller leaves the edge alone and the original DV-01 error stands.
 */
export function pickSafeCastTarget(srcPg: string, tgtPg: string): string | null {
  const srcFam = kindFamily(srcPg);
  const tgtFam = kindFamily(tgtPg);
  if (srcFam === tgtFam) return null;
  if (srcFam === 'any' || tgtFam === 'any') return null;
  // R1 whitelist: ANY → text is universally PG-safe (every scalar has a
  // canonical text representation; cast never fails at runtime).
  if (tgtFam === 'text') return tgtPg;
  // Other directions (number→date, text→number, …) are out of whitelist.
  return null;
}

/**
 * Walk all edges, detect kindFamily mismatches, insert auto-cast nodes when safe.
 * Returns a new doc (immutable input) + list of inserts for response transparency.
 */
export function applyAutoCasts(doc: DagDoc): AutoCastResult {
  const inserted: AutoCastInsert[] = [];
  const nodes: DagNode[] = [...doc.nodes];
  const newEdges: DagEdge[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const e of doc.edges) {
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (!src || !tgt) { newEdges.push(e); continue; }

    const outName = e.sourceHandle;
    const inName = e.targetHandle;
    if (!outName || !inName) { newEdges.push(e); continue; }

    const srcOut = (src.data?.outputs || []).find((o) => o.name === outName);
    const tgtIn = (tgt.data?.inputs || []).find((i) => i.name === inName);
    if (!srcOut || !tgtIn) { newEdges.push(e); continue; }

    // Skip operator passthrough edges — already type-skipped by dag-validate.
    const isOperatorHandle =
      outName === '__downstream' || inName === '__upstream' ||
      srcOut.semantic_type === '__rowset' || tgtIn.semantic_type === '__rowset';
    if (isOperatorHandle) { newEdges.push(e); continue; }

    const srcFam = kindFamily(srcOut.pgType);
    const tgtFam = kindFamily(tgtIn.pgType);
    if (srcFam === tgtFam || srcFam === 'any' || tgtFam === 'any') {
      newEdges.push(e);
      continue;
    }

    const safeTargetPg = pickSafeCastTarget(srcOut.pgType || '', tgtIn.pgType || '');
    if (!safeTargetPg) { newEdges.push(e); continue; }

    // Build a visible cast node. We deliberately diverge from the manual cast
    // UI's outputs shape:
    //   manual cast  : outputs=[{name:'__downstream', semantic_type:'__rowset'}]
    //                  (used inside operator chains; isOperatorHandle skip)
    //   auto-cast    : outputs=[{name:outName, pgType:safeTargetPg}]
    //                  (sits between two fn column edges; outbound edge must
    //                  pass DV-01 type check AND runtime fn binding looks up
    //                  up.row0[outName] — runtime cast preserves column name).
    // Cosmetic fields (resource_id/subtype/label/bound_params + op_config.kind)
    // mirror addOperatorNode in DagTab.tsx so the inspector form and downstream
    // walks treat the auto-inserted node identically to a hand-placed one.
    const castNodeId = `autocast_${e.id}`;
    // resource_id:'' + bound_params:{} mirror addOperatorNode (DagTab.tsx) so
    // upstream-resource walks and inspector form treat the inserted node like
    // any hand-placed operator. label/subtype live on the frontend NodeData
    // shape (not DagNode); the React component falls back to op_kind for both.
    const castNode: DagNode = {
      id: castNodeId,
      type: 'cast',
      data: {
        resource_id: '',
        bound_params: {},
        op_kind: 'cast',
        op_config: {
          kind: 'cast',
          source_column: outName,
          target_pgType: safeTargetPg,
        },
        inputs: [{ name: '__upstream', semantic_type: '__rowset' }],
        outputs: [{
          name: outName,
          pgType: safeTargetPg,
          semantic_type: srcOut.semantic_type,
        }],
      },
    };
    nodes.push(castNode);
    byId.set(castNodeId, castNode);

    // Replace original edge with two new edges. ID convention:
    //   <orig>_acin  — fn → cast inbound (passthrough handle)
    //   <orig>_acout — cast → fn outbound (real column handle)
    const eIn: DagEdge = {
      id: `${e.id}_acin`,
      source: e.source,
      sourceHandle: outName,
      target: castNodeId,
      targetHandle: '__upstream',
    };
    const eOut: DagEdge = {
      id: `${e.id}_acout`,
      source: castNodeId,
      sourceHandle: outName,
      target: e.target,
      targetHandle: inName,
    };
    newEdges.push(eIn, eOut);

    inserted.push({
      edge_id: e.id,
      source_node: e.source,
      source_handle: outName,
      target_node: e.target,
      target_handle: inName,
      from_pgtype: srcOut.pgType || 'unknown',
      to_pgtype: safeTargetPg,
      inserted_node_id: castNodeId,
    });
  }

  return { doc: { nodes, edges: newEdges }, inserted };
}
