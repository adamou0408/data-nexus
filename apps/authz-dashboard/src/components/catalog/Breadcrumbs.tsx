// catalog/Breadcrumbs.tsx
//
// Drill-down trail breadcrumb — shows the user's pushed-frame chain in the
// active workspace. NOT the same as ModuleBreadcrumb (atom showing static
// module-tree position).
//
// Owner: Agent A. See catalog-workspace-unified-design.md §4 item 8 + §10 glossary.

import type { CatalogFrame, CatalogPreset } from './types';
import { getPreset } from './presets';
import { ChevronRight } from 'lucide-react';

type Props = {
  preset: CatalogPreset;
  frames: readonly CatalogFrame[];
  onGoTo: (index: number) => void;
};

function frameLabel(frame: CatalogFrame): string {
  switch (frame.kind) {
    case 'card-grid':     return 'Home';
    case 'module-tree':   return 'Modules';
    case 'module-detail': return `Module: ${frame.moduleId}`;
    case 'page-grid':     return 'Pages';
    case 'page-detail':   return `Page: ${frame.pageId}`;
    case 'table-grid':    return 'Tables';
    case 'table-schema':  return `Schema: ${frame.table}`;
    case 'resource-grid': return frame.resourceType ? `Resources: ${frame.resourceType}` : 'Resources';
    case 'handler':       return frame.handlerName;
  }
}

export function Breadcrumbs({ preset, frames, onGoTo }: Props) {
  const presetSpec = getPreset(preset);
  // Crumb 0 is the preset root label (acts as Home equivalent — no separate Home button).
  // We render preset title as the first crumb, then frame labels for indices 1..n.
  // If frames[0] is the preset root, its label is presetSpec.title; otherwise show
  // both preset title (clickable -> goTo 0 + reset) and frame labels.

  // Compose crumbs: [preset.title, ...frames.map(label)] but skip duplicate
  // when frames[0]'s label equals preset title (typical root case).
  const labels: string[] = [];
  labels.push(presetSpec.title);
  for (let i = 0; i < frames.length; i++) {
    const lbl = frameLabel(frames[i]);
    if (i === 0 && lbl === presetSpec.title) continue;
    labels.push(lbl);
  }

  // Map crumb-index back to frame-index. The first crumb maps to frame 0;
  // subsequent crumbs map to (i + skipOffset).
  const skipped = (frames.length > 0 && frameLabel(frames[0]) === presetSpec.title) ? 1 : 0;

  return (
    <nav
      className="flex items-center gap-1 text-sm text-slate-500 px-4 py-2 border-b border-slate-200"
      aria-label="Catalog breadcrumb"
      data-testid="catalog-breadcrumbs"
    >
      {labels.map((label, i) => {
        const isLast = i === labels.length - 1;
        const targetFrameIndex = i === 0 ? 0 : i - 1 + skipped;
        const clickable = !isLast && targetFrameIndex < frames.length;
        return (
          <span key={`${i}-${label}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={14} className="text-slate-300" />}
            {clickable ? (
              <button
                type="button"
                onClick={() => onGoTo(targetFrameIndex)}
                className="hover:text-slate-800 hover:underline"
              >
                {label}
              </button>
            ) : (
              <span className={isLast ? 'text-slate-800 font-medium' : ''}>
                {label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
