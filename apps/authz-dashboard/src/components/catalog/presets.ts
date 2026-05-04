// catalog/presets.ts
//
// Preset → root-frame definitions. Owner: Agent A.
// See catalog-workspace-unified-design.md §4 Agent A item 4.

import type { CatalogPreset, PresetSpec } from './types';

export const PRESETS: Record<CatalogPreset, PresetSpec> = {
  modules: {
    id: 'modules',
    rootFrame: { kind: 'module-tree', selectedModuleId: null },
    title: 'Modules',
  },
  pages: {
    id: 'pages',
    rootFrame: { kind: 'page-grid' },
    title: 'Pages',
  },
  tables: {
    id: 'tables',
    rootFrame: { kind: 'table-grid' },
    title: 'Raw Tables',
  },
  resources: {
    id: 'resources',
    rootFrame: { kind: 'resource-grid', resourceType: null },
    title: 'Resources',
  },
  home: {
    id: 'home',
    rootFrame: { kind: 'card-grid' },
    title: 'Catalog',
  },
};

/** Type guard for runtime preset strings (e.g. parsed from URL). */
export function isCatalogPreset(s: string): s is CatalogPreset {
  return s === 'modules' || s === 'pages' || s === 'tables'
      || s === 'resources' || s === 'home';
}

export function getPreset(id: CatalogPreset): PresetSpec {
  return PRESETS[id];
}
