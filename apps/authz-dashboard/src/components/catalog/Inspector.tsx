// catalog/Inspector.tsx
//
// Slide-in drawer that hosts inspector renderers from InspectorRegistry.
// Owner: Agent A.

import type { CatalogFrame, InspectorTarget } from './types';
import { getInspector } from './InspectorRegistry';
import { X } from 'lucide-react';

type Props = {
  target: InspectorTarget | null;
  onClose: () => void;
  onOpen: (frame: CatalogFrame) => void;
};

export function Inspector({ target, onClose, onOpen }: Props) {
  if (!target) return null;
  const renderer = getInspector(target.kind);

  return (
    <aside
      className="fixed top-0 right-0 h-full w-[420px] bg-white border-l border-slate-200 shadow-xl z-40 flex flex-col"
      data-testid="catalog-inspector"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <div className="text-sm font-medium text-slate-700">Inspector</div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-slate-100 text-slate-500"
          aria-label="Close inspector"
        >
          <X size={16} />
        </button>
      </header>
      <div className="flex-1 overflow-auto">
        {renderer
          ? renderer({ target, onClose, onOpen })
          : (
            <div className="p-6 text-sm text-slate-500">
              Inspector unavailable for kind <code>{target.kind}</code>.
            </div>
          )}
      </div>
    </aside>
  );
}
