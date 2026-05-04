// Module-scope cache of api.moduleTree() so DetailView and PageInspector
// (and any future catalog consumer) don't refetch on every mount.
// Module-scope (not useRef) so the cache survives LRU unmount+remount.

import { api, type ModuleTreeNode } from '../../api';

let cache: ModuleTreeNode[] | null = null;
let inflight: Promise<ModuleTreeNode[]> | null = null;

export function loadModuleTreeCached(): Promise<ModuleTreeNode[]> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api.moduleTree()
    .then((tree) => { cache = tree; return tree; })
    .catch((err) => { inflight = null; throw err; });
  return inflight;
}

export function peekModuleTreeCache(): ModuleTreeNode[] {
  return cache ?? [];
}
