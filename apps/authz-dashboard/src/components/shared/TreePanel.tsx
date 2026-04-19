import { useState, useMemo, useEffect, ReactNode } from 'react';
import { ChevronRight, ChevronDown, Search, Plus, ChevronsUpDown, ChevronsDownUp } from 'lucide-react';

// ─── Generic tree node contract ────────────────────────────
export type TreeNodeBase = {
  id: string;
  label: string;
  parentId: string | null;
};

type TreeItem<T extends TreeNodeBase> = T & { children: TreeItem<T>[]; level: number };

// ─── Tree helpers ──────────────────────────────────────────
function buildTree<T extends TreeNodeBase>(nodes: T[]): TreeItem<T>[] {
  const map = new Map<string, TreeItem<T>>();
  for (const n of nodes) {
    map.set(n.id, { ...n, children: [], level: 0 });
  }
  const roots: TreeItem<T>[] = [];
  for (const item of map.values()) {
    if (item.parentId && map.has(item.parentId)) {
      const parent = map.get(item.parentId)!;
      item.level = parent.level + 1;
      parent.children.push(item);
    } else {
      roots.push(item);
    }
  }
  return roots;
}

function flattenVisible<T extends TreeNodeBase>(items: TreeItem<T>[], expanded: Set<string>): TreeItem<T>[] {
  const result: TreeItem<T>[] = [];
  for (const item of items) {
    result.push(item);
    if (expanded.has(item.id) && item.children.length > 0) {
      result.push(...flattenVisible(item.children, expanded));
    }
  }
  return result;
}

function matchesSearch<T extends TreeNodeBase>(node: TreeItem<T>, term: string): boolean {
  if (node.label.toLowerCase().includes(term) || node.id.toLowerCase().includes(term)) return true;
  return node.children.some(c => matchesSearch(c, term));
}

function collectAllIds<T extends TreeNodeBase>(items: TreeItem<T>[]): Set<string> {
  const ids = new Set<string>();
  function walk(list: TreeItem<T>[]) { for (const i of list) { ids.add(i.id); walk(i.children); } }
  walk(items);
  return ids;
}

// ─── Props ─────────────────────────────────────────────────
export type TreePanelProps<T extends TreeNodeBase> = {
  nodes: T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Render icon + badges for each row */
  renderNode: (node: T, opts: { isSelected: boolean }) => ReactNode;
  /** Hover action slot (e.g. add child button) */
  renderHoverAction?: (node: T) => ReactNode;
  /** Summary badges (e.g. "3t 2m") — hidden on hover */
  renderBadges?: (node: T) => ReactNode;
  /** Footer slot (e.g. create button) */
  footer?: ReactNode;
  /** Search placeholder */
  searchPlaceholder?: string;
  /** Count label */
  countLabel?: string;
};

export function TreePanel<T extends TreeNodeBase>({
  nodes, selectedId, onSelect,
  renderNode, renderHoverAction, renderBadges,
  footer, searchPlaceholder = 'Search...', countLabel,
}: TreePanelProps<T>) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const allIds = useMemo(() => collectAllIds(tree), [tree]);

  // Auto-expand root nodes on initial load
  useEffect(() => {
    if (tree.length > 0 && expanded.size === 0) {
      setExpanded(new Set(tree.map(r => r.id)));
    }
  }, [tree]);

  // Search filter
  const filteredTree = useMemo(() => {
    if (!search.trim()) return tree;
    const term = search.toLowerCase();
    function filterItems(items: TreeItem<T>[]): TreeItem<T>[] {
      return items.filter(item => matchesSearch(item, term))
        .map(item => ({ ...item, children: filterItems(item.children) }));
    }
    return filterItems(tree);
  }, [tree, search]);

  const effectiveExpanded = useMemo(() => {
    if (search.trim()) return allIds;
    return expanded;
  }, [search, expanded, allIds]);

  const visible = useMemo(() => flattenVisible(filteredTree, effectiveExpanded), [filteredTree, effectiveExpanded]);

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const expandAll = () => setExpanded(new Set(allIds));
  const collapseAll = () => setExpanded(new Set());

  return (
    <div className="card flex flex-col h-full">
      {/* Header with search + expand/collapse */}
      <div className="p-3 border-b border-slate-200 space-y-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9 text-xs"
            placeholder={searchPlaceholder}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-400 font-medium">
            {countLabel ?? `${nodes.length} items`}
          </span>
          <div className="flex gap-1">
            <button onClick={expandAll} className="btn-ghost p-1 rounded" title="Expand all">
              <ChevronsUpDown size={13} className="text-slate-400" />
            </button>
            <button onClick={collapseAll} className="btn-ghost p-1 rounded" title="Collapse all">
              <ChevronsDownUp size={13} className="text-slate-400" />
            </button>
          </div>
        </div>
      </div>

      {/* Tree list */}
      <div className="flex-1 overflow-y-auto py-1">
        {visible.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-xs">
            {search ? 'No items match your search' : 'No items found'}
          </div>
        ) : (
          visible.map(item => {
            const hasChildren = item.children.length > 0;
            const isExpanded = effectiveExpanded.has(item.id);
            const isSelected = selectedId === item.id;
            const isHovered = hovered === item.id;
            const indent = 12 + item.level * 24;

            return (
              <div
                key={item.id}
                className={`group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer text-xs transition-colors
                  ${isSelected
                    ? 'bg-blue-50 border-l-2 border-blue-500 text-blue-900'
                    : 'border-l-2 border-transparent hover:bg-slate-50 text-slate-700'}`}
                style={{ paddingLeft: indent }}
                onClick={() => onSelect(item.id)}
                onMouseEnter={() => setHovered(item.id)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* Expand/collapse */}
                <button
                  className={`shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 ${hasChildren ? '' : 'invisible'}`}
                  onClick={e => { e.stopPropagation(); toggle(item.id); }}
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>

                {/* Custom node rendering */}
                {renderNode(item, { isSelected })}

                {/* Hover action slot */}
                {isHovered && renderHoverAction?.(item)}

                {/* Badges (hidden on hover) */}
                {!isHovered && renderBadges?.(item)}
              </div>
            );
          })
        )}
      </div>

      {/* Footer slot */}
      {footer}
    </div>
  );
}
