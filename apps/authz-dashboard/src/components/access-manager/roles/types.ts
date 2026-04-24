// Types shared across Permission Studio views.
// A "perm row" is a single (action_id × resource_id) grant with an effect.
// Permissions are immutable (no UPDATE) — to change effect or scope, delete + create.

export type Effect = 'allow' | 'deny';

export type PermRow = {
  id: number | null;           // null for pending-create rows
  action_id: string;
  resource_id: string;         // may include wildcard suffix '*'
  effect: Effect;
  resource_name?: string;
};

// Staged operations, keyed by a stable composite key.
// - create:  key = `CREATE:${action}|${resource}|${effect}`
// - delete:  key = `DELETE:${perm_id}`
export type PendingOp =
  | { kind: 'create'; action_id: string; resource_id: string; effect: Effect }
  | { kind: 'delete'; perm_id: number; snapshot: PermRow };

export type ActionMeta = {
  action_id: string;
  display_name: string;
  description?: string;
  applicable_paths: string[];  // ['A','B','C']
};

export type ResourceMeta = {
  resource_id: string;
  resource_type: string;
  display_name: string;
  parent_id?: string | null;
};

// The typical resource_type buckets we group by in the picker.
// Schema prefix is sniffed from resource_id (e.g., 'function:tiptop.xxx' → 'tiptop').
export const RESOURCE_TYPE_ORDER = [
  'module', 'web_page', 'web_api',
  'table', 'view', 'function', 'column',
  'dag', 'db_pool', 'page', 'other',
] as const;

// Map action → natural resource_type bucket(s). Keyed by action_id;
// falls back to applicable_paths → default types.
// This drives the auto-filter and Suggest when user picks an action.
export const ACTION_TYPE_HINT: Record<string, string[]> = {
  execute: ['function'],
  connect: ['db_pool', 'function'],
  approve: ['web_page', 'module'],
  hold:    ['web_page', 'module'],
  release: ['web_page', 'module'],
  export:  ['table', 'view', 'module'],
};

export function defaultResourceTypesForAction(action: ActionMeta | null | undefined): string[] {
  if (!action) return [];
  const hint = ACTION_TYPE_HINT[action.action_id];
  if (hint) return hint;
  const paths = new Set(action.applicable_paths || []);
  if (paths.has('C')) return ['table', 'view', 'column', 'function'];
  if (paths.has('A') || paths.has('B')) return ['web_page', 'web_api', 'module'];
  return [];
}

// Parse schema prefix from structured resource_id like 'function:tiptop.fn_abc'.
// Returns '' when no recognizable schema segment exists.
export function schemaOf(resource_id: string): string {
  const m = resource_id.match(/^[a-z_]+:([a-z0-9_]+)\./i);
  return m ? m[1] : '';
}

// Check if a grant resource_id (possibly ending in '*') covers a concrete resource.
export function prefixCovers(grant: string, concrete: string): boolean {
  if (grant === concrete) return true;
  if (grant === '*') return true;
  if (grant.endsWith(':*')) return concrete.startsWith(grant.slice(0, -1));
  if (grant.endsWith('.*')) return concrete.startsWith(grant.slice(0, -1));
  if (grant.endsWith('*'))  return concrete.startsWith(grant.slice(0, -1));
  return false;
}

export function pendingKey(op: PendingOp): string {
  if (op.kind === 'create') return `CREATE:${op.action_id}|${op.resource_id}|${op.effect}`;
  return `DELETE:${op.perm_id}`;
}
