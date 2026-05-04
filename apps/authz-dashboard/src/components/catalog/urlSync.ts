// catalog/urlSync.ts
//
// Hash <-> stack serialization + history sync for the Catalog Workspace.
// Owner: Agent A. See catalog-workspace-unified-design.md §2 + §4 item 3.
//
// All `window.history.*` calls in the catalog/ tree MUST live in this file.
// Frame components mutating the URL must go through `replaceQueryParam`.
//
// Hash schema:
//   #/cat/<preset>/<frame0>[/<frame1>[/<frame2>...]]
//   <frameN> = <kind>[~k1=v1[~k2=v2]...]
//
// Param keys (no spaces, no `/`, no `~`):
//   m       moduleId / selectedModuleId
//   id      pageId (auto:src:schema.table preserved verbatim)
//   module  filter.module_id
//   status  filter.status
//   pool    filter.pool
//   t       table (schema.table)
//   type    resourceType
//   h       handlerName
//   p       handler's origin pageId
//   pv:<k>  formValues[k] (URL-encoded JSON-encoded value)

import type {
  CatalogFrame,
  CatalogPreset,
  CatalogStackAPI,
  FrameKind,
} from './types';
import { isCatalogPreset, getPreset } from './presets';

/* ============================================================
 * Encode helpers
 * ============================================================ */

// Encode a param value: spaces, `/`, `~`, `?`, `#`, `&`, `=`
// must not appear unescaped. We use encodeURIComponent then re-allow
// `:` and `.` since they're common in pageIds and table names.
function encVal(v: string): string {
  return encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%2E/gi, '.');
}

function decVal(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function joinParams(parts: Array<[string, string]>): string {
  if (parts.length === 0) return '';
  return '~' + parts.map(([k, v]) => `${k}=${encVal(v)}`).join('~');
}

/* ============================================================
 * Frame serialize / parse
 * ============================================================ */

export function serializeFrame(frame: CatalogFrame): string {
  switch (frame.kind) {
    case 'card-grid':
      return 'card-grid';
    case 'module-tree': {
      const parts: Array<[string, string]> = [];
      if (frame.selectedModuleId) parts.push(['m', frame.selectedModuleId]);
      return 'module-tree' + joinParams(parts);
    }
    case 'module-detail':
      return 'module-detail' + joinParams([['m', frame.moduleId]]);
    case 'page-grid': {
      const parts: Array<[string, string]> = [];
      if (frame.filter?.module_id) parts.push(['module', frame.filter.module_id]);
      if (frame.filter?.status) parts.push(['status', frame.filter.status]);
      return 'page-grid' + joinParams(parts);
    }
    case 'page-detail': {
      const parts: Array<[string, string]> = [['id', frame.pageId]];
      // formValues -> pv:<k>=<json>
      if (frame.params && typeof frame.params === 'object') {
        for (const [k, v] of Object.entries(frame.params)) {
          if (v === undefined) continue;
          parts.push([`pv:${k}`, JSON.stringify(v)]);
        }
      }
      return 'page-detail' + joinParams(parts);
    }
    case 'table-grid': {
      const parts: Array<[string, string]> = [];
      if (frame.filter?.module_id) parts.push(['module', frame.filter.module_id]);
      if (frame.filter?.pool) parts.push(['pool', frame.filter.pool]);
      return 'table-grid' + joinParams(parts);
    }
    case 'table-schema':
      return 'table-schema' + joinParams([['t', frame.table]]);
    case 'resource-grid': {
      const parts: Array<[string, string]> = [];
      if (frame.resourceType) parts.push(['type', frame.resourceType]);
      return 'resource-grid' + joinParams(parts);
    }
    case 'handler':
      return 'handler' + joinParams([
        ['h', frame.handlerName],
        ['p', frame.pageId],
      ]);
  }
}

const KNOWN_KINDS: ReadonlyArray<FrameKind> = [
  'card-grid', 'module-tree', 'module-detail', 'page-grid', 'page-detail',
  'table-grid', 'table-schema', 'resource-grid', 'handler',
];

function isKnownKind(s: string): s is FrameKind {
  return (KNOWN_KINDS as ReadonlyArray<string>).includes(s);
}

const RESOURCE_TYPES: ReadonlyArray<string> = [
  'module', 'table', 'view', 'column', 'function',
  'dag', 'web_page', 'web_api', 'db_pool', 'page',
];

export function parseFrame(token: string): CatalogFrame | null {
  if (!token) return null;
  const segments = token.split('~');
  const kindRaw = segments[0];
  if (!isKnownKind(kindRaw)) return null;

  const params: Record<string, string> = {};
  const formValues: Record<string, unknown> = {};
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    const k = seg.slice(0, eq);
    const v = decVal(seg.slice(eq + 1));
    if (k.startsWith('pv:')) {
      const formKey = k.slice(3);
      try {
        formValues[formKey] = JSON.parse(v);
      } catch {
        formValues[formKey] = v;
      }
    } else {
      params[k] = v;
    }
  }

  switch (kindRaw) {
    case 'card-grid':
      return { kind: 'card-grid' };
    case 'module-tree':
      return {
        kind: 'module-tree',
        selectedModuleId: params.m ?? null,
      };
    case 'module-detail': {
      if (!params.m) return null;
      return { kind: 'module-detail', moduleId: params.m };
    }
    case 'page-grid': {
      const filter: { module_id?: string; status?: 'published' | 'draft' } = {};
      if (params.module) filter.module_id = params.module;
      if (params.status === 'published' || params.status === 'draft') {
        filter.status = params.status;
      }
      const frame: CatalogFrame = { kind: 'page-grid' };
      if (Object.keys(filter).length > 0) frame.filter = filter;
      return frame;
    }
    case 'page-detail': {
      if (!params.id) return null;
      return {
        kind: 'page-detail',
        pageId: params.id,
        params: formValues,
      };
    }
    case 'table-grid': {
      const filter: { module_id?: string; pool?: string } = {};
      if (params.module) filter.module_id = params.module;
      if (params.pool) filter.pool = params.pool;
      const frame: CatalogFrame = { kind: 'table-grid' };
      if (Object.keys(filter).length > 0) frame.filter = filter;
      return frame;
    }
    case 'table-schema': {
      if (!params.t) return null;
      return { kind: 'table-schema', table: params.t };
    }
    case 'resource-grid': {
      const t = params.type;
      if (t && RESOURCE_TYPES.includes(t)) {
        // Narrow via the union literal rather than a conditional infer.
        type RT = NonNullable<Extract<CatalogFrame, { kind: 'resource-grid' }>['resourceType']>;
        return { kind: 'resource-grid', resourceType: t as RT };
      }
      return { kind: 'resource-grid', resourceType: null };
    }
    case 'handler': {
      if (!params.h || !params.p) return null;
      return { kind: 'handler', handlerName: params.h, pageId: params.p };
    }
  }
  return null;
}

/* ============================================================
 * Hash <-> stack
 * ============================================================ */

const HASH_PREFIX = '#/cat/';

export function serializeHash(
  preset: CatalogPreset,
  frames: readonly CatalogFrame[],
): string {
  const tail = frames.map(serializeFrame).join('/');
  return tail ? `${HASH_PREFIX}${preset}/${tail}` : `${HASH_PREFIX}${preset}`;
}

export function parseHash(
  hash: string,
): { preset: CatalogPreset; frames: CatalogFrame[] } | null {
  if (!hash) return null;
  // Accept with or without leading `#`.
  const h = hash.startsWith('#') ? hash : `#${hash}`;
  if (!h.startsWith(HASH_PREFIX)) return null;
  const rest = h.slice(HASH_PREFIX.length);
  if (!rest) return null;
  // Strip trailing `?...` if a caller accidentally appended query.
  const qIdx = rest.indexOf('?');
  const cleaned = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const presetRaw = parts[0];
  if (!isCatalogPreset(presetRaw)) return null;
  const frames: CatalogFrame[] = [];
  for (let i = 1; i < parts.length; i++) {
    const f = parseFrame(parts[i]);
    if (!f) return null;
    frames.push(f);
  }
  // If the hash carried just a preset, return preset's root frame.
  if (frames.length === 0) {
    frames.push(getPreset(presetRaw).rootFrame);
  }
  return { preset: presetRaw, frames };
}

/* ============================================================
 * History sync
 * ============================================================ */

/**
 * Wires the stack API to window.history.
 *  - Stack mutations -> pushState/replaceState (via observe pattern).
 *  - popstate -> recompute target stack and call api.reset(...) via a callback
 *    the caller wires up.
 *
 * Since the stack API is owned by useStack (React state), we can't reach
 * inside from urlSync. Instead, urlSync exposes:
 *   - syncToHash(preset, frames): push or replace URL without dirtying state
 *   - onPopState(handler): subscribe to back/forward events
 *
 * `installHistorySync` wraps both with idempotency guarding.
 */

export type HistorySyncHandle = {
  /** Call after every stack mutation; idempotent vs current location. */
  syncToHash: (preset: CatalogPreset, frames: readonly CatalogFrame[], mode?: 'push' | 'replace') => void;
  /** Mutate ?key=val without touching the hash. Pass null to remove. */
  replaceQueryParam: (key: string, val: string | null) => void;
  /** Tear down listener. */
  dispose: () => void;
};

export type PopStateHandler = (
  parsed: { preset: CatalogPreset; frames: CatalogFrame[] } | null,
) => void;

/**
 * Install the listener and return helpers the workspace can call.
 *
 * The caller (CatalogWorkspace) is expected to:
 *   1) Call syncToHash whenever the stack changes.
 *   2) On popstate, receive the parsed target and reset its in-memory stack.
 *
 * Note: this function does NOT directly reach into stack state. The catalog
 * workspace is responsible for plugging the parsed result back via reset/goTo.
 */
export function installHistorySync(
  onPop: PopStateHandler,
): HistorySyncHandle {
  // window.history mutations confined to this file (per design §4 item 3).
  const handler = () => {
    onPop(parseHash(window.location.hash));
  };
  window.addEventListener('popstate', handler);

  const syncToHash = (
    preset: CatalogPreset,
    frames: readonly CatalogFrame[],
    mode: 'push' | 'replace' = 'push',
  ) => {
    const target = serializeHash(preset, frames);
    // Preserve existing query string.
    const url = `${window.location.pathname}${window.location.search}${target}`;
    if (window.location.hash === target) return; // idempotent
    if (mode === 'replace') {
      window.history.replaceState(null, '', url);
    } else {
      window.history.pushState(null, '', url);
    }
  };

  const replaceQueryParam = (key: string, val: string | null) => {
    // Mutates ?<key>=<val> ONLY; never touches hash.
    const search = new URLSearchParams(window.location.search);
    if (val === null) {
      search.delete(key);
    } else {
      search.set(key, val);
    }
    const qs = search.toString();
    const newSearch = qs ? `?${qs}` : '';
    if (newSearch === window.location.search) return; // idempotent
    const url = `${window.location.pathname}${newSearch}${window.location.hash}`;
    window.history.replaceState(null, '', url);
  };

  return {
    syncToHash,
    replaceQueryParam,
    dispose: () => window.removeEventListener('popstate', handler),
  };
}

/**
 * Convenience helper used at workspace mount time to compute the initial
 * stack from window.location.hash, falling back to the preset root.
 */
export function readInitialStack(
  preset: CatalogPreset,
): { preset: CatalogPreset; frames: CatalogFrame[] } {
  const parsed = parseHash(typeof window !== 'undefined' ? window.location.hash : '');
  if (parsed && parsed.preset === preset) return parsed;
  return { preset, frames: [getPreset(preset).rootFrame] };
}
