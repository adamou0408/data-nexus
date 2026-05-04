// shared/atoms/ModuleBreadcrumb.tsx
//
// Module-tree position breadcrumb atom — shows the *static* hierarchy
// path of a module/page in the module tree. NOT the same as
// `catalog/Breadcrumbs.tsx`, which shows the user's drill-down stack.
//
// Owner: Agent A (per catalog-workspace-unified-design.md §11.1).
// Consumers: Agent B (DetailView, PageInspector), Agent C (GridView headers,
// ModuleInspector), and Phase-2 DagTab publish dialog.
//
// The internal walk logic mirrors `components/modules/ModuleDetail.tsx`
// `buildBreadcrumb` (lines 14-22) so the three duplicate inline
// implementations collapse to a single atom.

import type { ModuleTreeNode } from '../../../api';
import { ChevronRight } from 'lucide-react';

export type ModuleBreadcrumbProps = {
  /** Starting module — null means no module hierarchy, render only rootLabel + leaf. */
  moduleId: string | null;
  /** Module tree (caller-supplied to avoid every consumer re-fetching). */
  modules?: ModuleTreeNode[];
  /** Optional terminal segment, e.g. page title or 'Pages'. Non-clickable. */
  leaf?: { label: string };
  /** Root label, default 'Catalog'. Always non-clickable (sidebar IA consistency). */
  rootLabel?: string;
  /**
   * Optional click handler for middle module segments. When omitted, all
   * module segments are non-clickable text.
   */
  onClickModule?: (id: string) => void;
  /** Optional className to merge into the wrapper. */
  className?: string;
  /** Optional testid (callers like DagTab publish dialog set their own). */
  'data-testid'?: string;
};

/** Walk parent_id chain from `moduleId` up to root, returning root → current. */
function buildBreadcrumb(
  moduleId: string,
  nodes: ModuleTreeNode[],
): { id: string; name: string }[] {
  const nodeMap = new Map(nodes.map(n => [n.resource_id, n]));
  const path: { id: string; name: string }[] = [];
  let current: string | '' = moduleId;
  while (current) {
    const node = nodeMap.get(current);
    if (!node) break;
    path.unshift({ id: node.resource_id, name: node.display_name });
    current = node.parent_id || '';
  }
  return path;
}

/**
 * Module hierarchy breadcrumb.
 *
 * Renders: `{rootLabel} › {module1} › {module2} › ... › {leaf?}`
 *  - rootLabel: always non-clickable.
 *  - middle module segments: clickable iff `onClickModule` is supplied.
 *  - leaf: always non-clickable (current page).
 *  - Null moduleId or empty walk: renders just rootLabel (› leaf if provided).
 */
export function ModuleBreadcrumb({
  moduleId,
  modules = [],
  leaf,
  rootLabel = 'Catalog',
  onClickModule,
  className = '',
  'data-testid': testId,
}: ModuleBreadcrumbProps) {
  const path = (moduleId && modules.length > 0)
    ? buildBreadcrumb(moduleId, modules)
    : [];

  // Total segments to render: root + each module + optional leaf.
  // The last rendered segment (leaf if present, else last module, else root)
  // is non-clickable.
  const segments: Array<{
    key: string;
    label: string;
    clickable: boolean;
    onClick?: () => void;
  }> = [];

  // Root — never clickable.
  segments.push({ key: 'root', label: rootLabel, clickable: false });

  // Module segments — clickable iff onClickModule provided AND not the leaf.
  // If a leaf is provided, all module segments are middle segments (potentially clickable).
  // If no leaf is provided, the last module segment is the "current page" — non-clickable.
  const lastModuleIsLeaf = !leaf;
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    const isLastModule = i === path.length - 1;
    const isCurrent = lastModuleIsLeaf && isLastModule;
    const clickable = !!onClickModule && !isCurrent;
    segments.push({
      key: `m:${node.id}`,
      label: node.name,
      clickable,
      onClick: clickable && onClickModule
        ? () => onClickModule(node.id)
        : undefined,
    });
  }

  // Optional leaf — never clickable (current page).
  if (leaf) {
    segments.push({ key: 'leaf', label: leaf.label, clickable: false });
  }

  return (
    <nav
      className={`flex items-center gap-1 text-sm text-slate-500 ${className}`.trim()}
      aria-label="Module breadcrumb"
      data-testid={testId}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={seg.key} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={14} className="text-slate-300" />}
            {seg.clickable && seg.onClick ? (
              <button
                type="button"
                onClick={seg.onClick}
                className="hover:text-slate-800 hover:underline"
              >
                {seg.label}
              </button>
            ) : (
              <span className={isLast ? 'text-slate-800 font-medium' : ''}>
                {seg.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
