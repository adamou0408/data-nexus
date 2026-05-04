// catalog/CardGridView.tsx
//
// Root-tile landing for the `card-grid` frame. 4 tiles linking to
// Modules / Pages / Tables / Resources via stack.replace(...) — preset
// stays `home` while the root frame swaps under it.
//
// Owner: Agent A.

import type { CatalogFrame, CatalogStackAPI } from './types';
import { Boxes, FileText, Database, Layers } from 'lucide-react';
import type { ReactNode } from 'react';

type Tile = {
  label: string;
  description: string;
  icon: ReactNode;
  frame: CatalogFrame;
};

const TILES: Tile[] = [
  {
    label: 'Modules',
    description: 'Browse the module tree, manage child modules and tables.',
    icon: <Boxes size={28} />,
    frame: { kind: 'module-tree', selectedModuleId: null },
  },
  {
    label: 'Pages',
    description: 'Published admin pages and auto-pages across data sources.',
    icon: <FileText size={28} />,
    frame: { kind: 'page-grid' },
  },
  {
    label: 'Tables',
    description: 'Raw catalog of tables with RLS / column-mask awareness.',
    icon: <Database size={28} />,
    frame: { kind: 'table-grid' },
  },
  {
    label: 'Resources',
    description: 'Cross-type resource view — modules, pages, columns, DAGs.',
    icon: <Layers size={28} />,
    frame: { kind: 'resource-grid', resourceType: null },
  },
];

type Props = {
  api: CatalogStackAPI;
};

export function CardGridView({ api }: Props) {
  return (
    <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl mx-auto" data-testid="catalog-card-grid">
      {TILES.map(tile => (
        <button
          type="button"
          key={tile.label}
          onClick={() => api.replace(tile.frame)}
          className="text-left bg-white border border-slate-200 rounded-lg p-5 hover:border-blue-400 hover:shadow-sm transition"
        >
          <div className="text-blue-600 mb-3">{tile.icon}</div>
          <div className="text-base font-medium text-slate-800">{tile.label}</div>
          <div className="text-sm text-slate-500 mt-1">{tile.description}</div>
        </button>
      ))}
    </div>
  );
}
