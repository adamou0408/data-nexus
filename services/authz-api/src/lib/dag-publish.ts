// ============================================================
// Pure helpers for DAG publish flow — XDB-TIER-B-L4.
//
// Plan: .claude/plans/v3-phase-1/cross-db-tier-b-integration.md §4 L4
//
// ── Why pure ──
//   The publish route owns the side-effecting "run-once-and-freeze"
//   step (it needs `client` + `userId`). The validation logic is pure:
//   given a snapshot + render_mode + column_renames, decide whether
//   the publish payload is well-formed.  Keeping it pure means the
//   route is testable with table-driven cases and the helper itself
//   can be reused from the front-end if we ever need to pre-validate
//   on the client.
//
// ── Conflict scope ──
//   Cross-DS DAGs can expose more than one output frame (V086-FU
//   exposed_node_ids).  Each exposed frame contributes its own column
//   namespace.  When we flatten those frames into a single tabular
//   page, two frames may emit the same column name ('id' from
//   ds_a.fn_a and 'id' from ds_b.fn_b), and the consumer sees a
//   collision.  This helper detects those collisions across the
//   exposed set and returns one entry per colliding name.
//
//   Intra-frame collisions (same node emitting two columns with the
//   same name) are NOT this helper's responsibility — `validateDag`
//   already rejects them at save time.
//
// ── Key shape ──
//   `column_renames` keys are `${node_id}__${column_name}` so the
//   curator can distinguish two `id` columns coming from `node_a`
//   and `node_b`.  Values are the new flat column name visible to
//   the page consumer.
// ============================================================

import type { PublishedDagSnapshot } from './dag-exec';

export interface ColumnConflict {
  /** Colliding flat name (the column name that two+ exposed nodes share). */
  name: string;
  /** node_ids of the exposed frames that contributed this name. Stable order. */
  sourceNodes: string[];
}

export interface DetectColumnConflictsResult {
  conflicts: ColumnConflict[];
}

/**
 * Detect column-name collisions across the exposed frames of a snapshot.
 *
 * Pure — no DB, no IO. Reads only:
 *   - snapshot.nodes (each node's data.outputs[].name)
 *   - snapshot.exposed_node_ids (or [output_node_id] for V086 fallback)
 *
 * Returns empty array when no collision.  Stable order: conflicts
 * sorted by name; sourceNodes within each conflict in exposed-set order.
 */
export function detectColumnConflicts(
  snapshot: PublishedDagSnapshot,
): DetectColumnConflictsResult {
  const exposed = (snapshot.exposed_node_ids && snapshot.exposed_node_ids.length > 0)
    ? snapshot.exposed_node_ids
    : [snapshot.output_node_id];

  // For single-frame pages there's nothing to collide with — short-circuit.
  if (exposed.length <= 1) return { conflicts: [] };

  // name → ordered list of nodeIds that emit it.
  const nameToNodes = new Map<string, string[]>();
  for (const nodeId of exposed) {
    const node = snapshot.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const cols = node.data?.outputs || [];
    for (const col of cols) {
      if (!col?.name) continue;
      const list = nameToNodes.get(col.name) || [];
      // Dedup in case the same node id appears twice in exposed_node_ids.
      if (!list.includes(nodeId)) list.push(nodeId);
      nameToNodes.set(col.name, list);
    }
  }

  const conflicts: ColumnConflict[] = [];
  for (const [name, sourceNodes] of nameToNodes.entries()) {
    if (sourceNodes.length >= 2) conflicts.push({ name, sourceNodes });
  }
  conflicts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { conflicts };
}

export type ValidatePublishPayloadResult =
  | { ok: true }
  | { ok: false; error: string; detail?: unknown };

const VALID_RENDER_MODES = new Set(['snapshot', 'live']);

/**
 * Validate a publish payload against the snapshot's column-conflict needs.
 *
 * Pure — no DB, no IO.
 *
 * Rules:
 *   1. render_mode must be 'snapshot' or 'live'.
 *   2. column_renames must be a plain object (or absent).
 *   3. Every conflict reported by detectColumnConflicts must have a
 *      rename entry for at least all-but-one of the colliding nodes
 *      — i.e., after applying renames the resulting flat names are
 *      all distinct.  We require an explicit rename for each colliding
 *      node so the curator has to acknowledge the choice (no silent
 *      "first node wins").  Rename targets must themselves be unique
 *      and must not re-introduce an existing non-conflicting name.
 *   4. column_renames keys must use `${node_id}__${column_name}` shape
 *      and reference real exposed nodes / columns.  Stray keys are a
 *      hard error to catch typos.
 */
export function validatePublishPayload(
  snapshot: PublishedDagSnapshot,
  render_mode: string,
  column_renames: Record<string, string> | null | undefined,
): ValidatePublishPayloadResult {
  // ── 1. render_mode literal ──
  if (!VALID_RENDER_MODES.has(render_mode)) {
    return {
      ok: false,
      error: 'invalid_render_mode',
      detail: { got: render_mode, expected: ['snapshot', 'live'] },
    };
  }

  // ── 2. column_renames shape ──
  const renames = column_renames || {};
  if (typeof renames !== 'object' || Array.isArray(renames)) {
    return { ok: false, error: 'column_renames_not_object' };
  }
  for (const [k, v] of Object.entries(renames)) {
    if (typeof v !== 'string' || v.length === 0) {
      return {
        ok: false,
        error: 'column_renames_value_invalid',
        detail: { key: k, value: v },
      };
    }
  }

  // ── 3. collect exposed name map for sanity-checking keys ──
  const exposed = (snapshot.exposed_node_ids && snapshot.exposed_node_ids.length > 0)
    ? snapshot.exposed_node_ids
    : [snapshot.output_node_id];
  const exposedSet = new Set(exposed);
  const realKeys = new Set<string>();
  // node_id__name for every column that actually exists in the exposed frames.
  const nameByNode = new Map<string, Set<string>>();
  for (const nodeId of exposed) {
    const node = snapshot.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const cols = node.data?.outputs || [];
    const set = new Set<string>();
    for (const col of cols) {
      if (!col?.name) continue;
      set.add(col.name);
      realKeys.add(`${nodeId}__${col.name}`);
    }
    nameByNode.set(nodeId, set);
  }

  // ── 4. validate every rename key references a real (node, column) ──
  for (const k of Object.keys(renames)) {
    const sep = k.indexOf('__');
    if (sep <= 0) {
      return { ok: false, error: 'column_renames_key_malformed', detail: { key: k } };
    }
    const nodeId = k.slice(0, sep);
    const colName = k.slice(sep + 2);
    if (!exposedSet.has(nodeId)) {
      return {
        ok: false,
        error: 'column_renames_unknown_node',
        detail: { key: k, node_id: nodeId },
      };
    }
    const cols = nameByNode.get(nodeId) || new Set<string>();
    if (!cols.has(colName)) {
      return {
        ok: false,
        error: 'column_renames_unknown_column',
        detail: { key: k, node_id: nodeId, column: colName },
      };
    }
  }

  // ── 5. enforce conflicts have renames AND post-rename names are unique ──
  const { conflicts } = detectColumnConflicts(snapshot);

  // Build the set of conflicting keys that MUST receive a rename.
  // Rule: for each conflict, at least N-1 of the source nodes must be
  // renamed (one node may keep the original name).  We enforce a
  // stricter "every source node must be renamed" only when the
  // remaining un-renamed name would still collide with something.
  // Simpler implementation: simulate the post-rename namespace and
  // demand it has no duplicates.

  // Final flat-name set after applying renames.  Track the source key
  // so we can return a nice error.
  const finalNames = new Map<string, string>();          // flat name → source key (e.g., 'a_id' → 'node_a__id')
  const missingForConflicts: ColumnConflict[] = [];

  for (const nodeId of exposed) {
    const node = snapshot.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    for (const col of (node.data?.outputs || [])) {
      if (!col?.name) continue;
      const renameKey = `${nodeId}__${col.name}`;
      const finalName = renames[renameKey] || col.name;
      const prior = finalNames.get(finalName);
      if (prior) {
        // We have a duplicate after renames — find the conflict entry
        // (if any) so the curator knows which one needs attention.
        const conflict = conflicts.find((c) => c.name === col.name)
          || { name: col.name, sourceNodes: [nodeId] };
        if (!missingForConflicts.find((m) => m.name === conflict.name)) {
          missingForConflicts.push(conflict);
        }
      } else {
        finalNames.set(finalName, renameKey);
      }
    }
  }

  if (missingForConflicts.length > 0) {
    return {
      ok: false,
      error: 'column_conflicts_unresolved',
      detail: {
        conflicts: missingForConflicts,
        hint: 'Provide column_renames entries keyed by `${node_id}__${column_name}` so all post-rename flat names are unique.',
      },
    };
  }

  return { ok: true };
}

/**
 * Apply a rename map to a single output frame (node-scoped).
 * Returns a new columns array + a row-mapper; the route layer applies
 * the row mapper at render time so live + snapshot modes share logic.
 *
 * Pure — no IO.
 */
export function applyColumnRenamesToFrame<C extends { name: string }>(
  nodeId: string,
  columns: C[],
  rows: Record<string, unknown>[],
  column_renames: Record<string, string>,
): { columns: C[]; rows: Record<string, unknown>[] } {
  // Fast path: no renames target this node.
  const prefix = `${nodeId}__`;
  let any = false;
  for (const k of Object.keys(column_renames || {})) {
    if (k.startsWith(prefix)) { any = true; break; }
  }
  if (!any) return { columns, rows };

  const renamedCols = columns.map((c) => {
    const k = `${nodeId}__${c.name}`;
    const target = column_renames[k];
    return target ? { ...c, name: target } : c;
  });

  const renamedRows = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(row)) {
      const k = `${nodeId}__${key}`;
      const target = column_renames[k];
      out[target || key] = val;
    }
    return out;
  });

  return { columns: renamedCols, rows: renamedRows };
}
