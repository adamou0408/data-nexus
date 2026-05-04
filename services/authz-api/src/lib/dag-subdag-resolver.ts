// ============================================================
// Sub-DAG embed resolver — DAG-SUBDAG-EMBED-V01.
//
// Why this exists:
//   At parent publish time, any node with type='subdag' is replaced
//   inline with the child published_dag's flat snapshot. The result
//   is a flat parent.dag_snapshot that dag-exec can run unchanged.
//   Sub-DAG is therefore a publish-time concept; runtime never sees it.
//
// Plan: .claude/plans/v3-phase-1/dag-subdag-embed-v01-plan.md
// ============================================================

import { PoolClient } from 'pg';
import { DagNode, DagEdge } from './dag-exec';

export interface SubdagExpansionInput {
  parentNodes: DagNode[];
  parentEdges: DagEdge[];
  parentDataSourceId: string;
  blessedBy: string;       // parent author user_id (transitive read check)
  client: PoolClient;      // share parent publish transaction
}

export interface EmbeddedSubdagRecord {
  subdag_node_id: string;
  child_rid: string;
  child_output_node_id: string;
  child_user_inputs_surfaced: string[];
}

export interface SubdagExpansionResult {
  nodes: DagNode[];
  edges: DagEdge[];
  embedded_subdags: EmbeddedSubdagRecord[];
}

export type SubdagExpansionReason =
  | 'not_found' | 'cross_ds' | 'authz_denied' | 'malformed' | 'nested_unresolved';

export class SubdagExpansionError extends Error {
  constructor(public subdag_node_id: string, public reason: SubdagExpansionReason, message: string) {
    super(`Sub-DAG node '${subdag_node_id}': ${message}`);
    this.name = 'SubdagExpansionError';
  }
}

export async function expandSubdags(opts: SubdagExpansionInput): Promise<SubdagExpansionResult> {
  const { parentNodes, parentEdges, parentDataSourceId, blessedBy, client } = opts;

  const subdagNodes = parentNodes.filter((n) => n.type === 'subdag');
  if (subdagNodes.length === 0) {
    return { nodes: parentNodes, edges: parentEdges, embedded_subdags: [] };
  }

  // Resolve user groups once for transitive authz_check.
  const grpRes = await client.query(
    'SELECT authz_resolve_user_groups($1) AS groups',
    [blessedBy]
  );
  const groupRaw: string[] = grpRes.rows[0]?.groups || [];
  const groups = groupRaw.map((g) => (g.startsWith('group:') ? g.slice('group:'.length) : g));

  const subdagIds = new Set(subdagNodes.map((n) => n.id));

  // Carry through non-subdag nodes verbatim.
  const newNodes: DagNode[] = parentNodes.filter((n) => !subdagIds.has(n.id));

  // Carry through parent edges that don't touch a subdag node; the rest get rewired.
  const newEdges: DagEdge[] = parentEdges.filter(
    (e) => !subdagIds.has(e.source) && !subdagIds.has(e.target)
  );

  const embedded: EmbeddedSubdagRecord[] = [];

  for (const subdag of subdagNodes) {
    const childRid = subdag.data?.resource_id;
    if (!childRid || !childRid.startsWith('published_dag:')) {
      throw new SubdagExpansionError(
        subdag.id, 'malformed',
        `data.resource_id must start with 'published_dag:' (got: ${childRid ?? 'undefined'})`
      );
    }

    // Transitive authz: parent author needs read on the child published_dag.
    const chk = await client.query(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [blessedBy, groups, 'read', childRid]
    );
    if (!chk.rows[0]?.allowed) {
      throw new SubdagExpansionError(
        subdag.id, 'authz_denied',
        `${blessedBy} lacks read on ${childRid}`
      );
    }

    // Fetch child's flat snapshot. authz_ui_page.resource_id keys on
    // 'published_dag:<dagId>' — the same identifier the subdag node carries.
    const childRow = await client.query(
      `SELECT dag_snapshot
         FROM authz_ui_page
        WHERE resource_id = $1 AND is_active = TRUE`,
      [childRid]
    );
    if (childRow.rowCount === 0) {
      throw new SubdagExpansionError(
        subdag.id, 'not_found',
        `published_dag not found or inactive: ${childRid}`
      );
    }
    const childSnap = childRow.rows[0].dag_snapshot;
    if (!childSnap || !Array.isArray(childSnap.nodes) || !Array.isArray(childSnap.edges)) {
      throw new SubdagExpansionError(
        subdag.id, 'malformed',
        `child snapshot missing nodes/edges`
      );
    }

    // XDB-TIER-B-L4: cross-DS subdag is now permitted. We don't reject when
    // child.data_source_id differs from parent's. Per-node DS stamping (L2)
    // lets the executor route each fn against the right pool, so a subdag
    // that lives on ds_a can embed cleanly into a parent on ds_b — the
    // child's nodes keep their own data_source_id stamp. We keep the
    // 'cross_ds' reason in the enum for telemetry but never throw it now;
    // future stricter modes (e.g. project-level isolation) can re-enable.

    // Defense in depth: child snapshots are always flat post-publish, so
    // an unresolved subdag inside should be impossible. If it shows up,
    // someone hand-edited a snapshot — refuse rather than recurse.
    for (const cn of childSnap.nodes as DagNode[]) {
      if (cn.type === 'subdag') {
        throw new SubdagExpansionError(
          subdag.id, 'nested_unresolved',
          `child contains unresolved subdag '${cn.id}' — re-publish the child first`
        );
      }
    }

    // Pick which child output to plug into parent.
    const exposedIds: string[] = Array.isArray(childSnap.exposed_node_ids) && childSnap.exposed_node_ids.length > 0
      ? childSnap.exposed_node_ids
      : [childSnap.output_node_id];
    const declaredOutputId = (subdag.data as { subdag_source_output_node_id?: string })
      ?.subdag_source_output_node_id;
    const chosenOutputId = declaredOutputId || childSnap.output_node_id;
    if (!exposedIds.includes(chosenOutputId)) {
      throw new SubdagExpansionError(
        subdag.id, 'malformed',
        `subdag_source_output_node_id '${chosenOutputId}' not in child exposed_node_ids [${exposedIds.join(', ')}]`
      );
    }

    const surfacedRaw = (subdag.data as { subdag_user_inputs?: string[] })?.subdag_user_inputs;
    const userInputsSurfaced: string[] = Array.isArray(surfacedRaw) ? surfacedRaw : [];
    const boundOverridesRaw = (subdag.data as { bound_subdag_params?: Record<string, unknown> })
      ?.bound_subdag_params;
    const boundOverrides: Record<string, unknown> = boundOverridesRaw && typeof boundOverridesRaw === 'object'
      ? boundOverridesRaw : {};
    const surfacedSet = new Set(userInputsSurfaced);

    // Inline-expand: prefix every child node id, drop sinks, demote unchosen
    // user_inputs into bound_params (so dag-exec doesn't try to read them
    // from the parent form).
    const prefix = `${subdag.id}__`;
    const childSinkIds = new Set(
      (childSnap.nodes as DagNode[]).filter((n) => n.type === 'sink').map((n) => n.id)
    );

    for (const cn of childSnap.nodes as DagNode[]) {
      if (cn.type === 'sink') continue;                           // sinks don't replay at runtime

      const newData: DagNode['data'] = { ...cn.data };

      // XDB-TIER-B-L4: stamp child-DAG DS onto the embedded child node when
      // it lacks its own data_source_id. Without this, a cross-DS embed
      // would fall back to the *parent* dag's data_source_id at run time
      // (executor's `||` chain) and query the wrong pool. Pre-L2 child
      // snapshots may not have per-node DS, so backfill from the child's
      // dag-level default to keep them on their original DS.
      if ((cn.type === 'fn' || !cn.type) && !newData.data_source_id && childSnap.data_source_id) {
        newData.data_source_id = childSnap.data_source_id;
      }

      if ((cn.type === 'fn' || !cn.type) && Array.isArray(cn.data?.user_input_params)) {
        const origInputs = cn.data.user_input_params || [];
        const keptInputs: string[] = [];
        const newBound: Record<string, unknown> = { ...(cn.data?.bound_params || {}) };

        for (const inputName of origInputs) {
          if (surfacedSet.has(inputName)) {
            keptInputs.push(inputName);                            // stays as form input on parent page
            continue;
          }
          // Demoted: parent override beats child snapshot's bound default;
          // if neither, keep whatever was already in newBound (child default).
          if (Object.prototype.hasOwnProperty.call(boundOverrides, inputName)) {
            newBound[inputName] = boundOverrides[inputName];
          }
        }

        newData.user_input_params = keptInputs;
        newData.bound_params = newBound;
      }

      newNodes.push({ ...cn, id: prefix + cn.id, data: newData });
    }

    // Carry over child edges (excluding sink-incident ones), prefixing both endpoints.
    for (const ce of (childSnap.edges as Array<DagEdge & { id?: string }>) || []) {
      if (childSinkIds.has(ce.source) || childSinkIds.has(ce.target)) continue;
      newEdges.push({
        ...ce,
        ...(ce.id ? { id: prefix + ce.id } as object : {}),
        source: prefix + ce.source,
        target: prefix + ce.target,
      } as DagEdge);
    }

    // Rewire parent edges that originated from the subdag node — they now
    // come from the prefixed child output. Inbound parent → subdag edges are
    // dropped silently in v01 (subdag inputs come from form/bound, not parent
    // upstream). Authoring-time validator should already flag these.
    const prefixedChildOutputId = prefix + chosenOutputId;
    for (const pe of parentEdges) {
      if (pe.source === subdag.id) {
        newEdges.push({ ...pe, source: prefixedChildOutputId } as DagEdge);
      }
      // pe.target === subdag.id → silently dropped
    }

    embedded.push({
      subdag_node_id: subdag.id,
      child_rid: childRid,
      child_output_node_id: chosenOutputId,
      child_user_inputs_surfaced: userInputsSurfaced,
    });
  }

  return { nodes: newNodes, edges: newEdges, embedded_subdags: embedded };
}
