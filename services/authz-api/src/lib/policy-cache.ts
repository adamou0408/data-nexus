// ============================================================
// FEAT-01: in-memory cache for authz_resolve() output
//
// Scope: dashboard /api/resolve hot path (Path A render). NOT used
// by /api/check — cached L0_functional does not expand resource
// ancestors, so check fast-path would diverge from the SQL
// authz_check() semantics. See V037 resource_ancestors mat view.
//
// Invalidation: full clear on any LISTEN authz_policy_changed event
// (V012 triggers fire on authz_policy / authz_role_permission /
// authz_subject_role mutations). Conservative; revisit if cache
// thrash becomes measurable.
// ============================================================

const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

type Entry = { value: unknown; expiresAt: number };

const store = new Map<string, Entry>();
const stats = { hits: 0, misses: 0, sets: 0, evictions: 0, clears: 0 };

export function makeKey(userId: string, groups: string[], attributes: Record<string, unknown>): string {
  const sortedGroups = [...groups].sort().join(',');
  const sortedAttrKeys = Object.keys(attributes).sort();
  const attrStr = sortedAttrKeys.map((k) => `${k}=${JSON.stringify(attributes[k])}`).join('|');
  return `${userId}::${sortedGroups}::${attrStr}`;
}

export function get(key: string): unknown | undefined {
  const entry = store.get(key);
  if (!entry) {
    stats.misses++;
    return undefined;
  }
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    stats.misses++;
    return undefined;
  }
  stats.hits++;
  return entry.value;
}

export function set(key: string, value: unknown): void {
  if (store.size >= MAX_ENTRIES) {
    // Map preserves insertion order; drop oldest to bound memory.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      store.delete(oldest);
      stats.evictions++;
    }
  }
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
  stats.sets++;
}

export function clearAll(): number {
  const cleared = store.size;
  store.clear();
  stats.clears++;
  return cleared;
}

export function getStats(): Readonly<typeof stats> & { size: number; ttlMs: number } {
  return { ...stats, size: store.size, ttlMs: TTL_MS };
}
