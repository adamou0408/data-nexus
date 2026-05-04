// Catalog TreeView — renders module-tree frames.
//
// Master-detail layout:
//   - left  : tree of modules (api.moduleTree)
//   - right : selected-module summary + "Open module" → push module-detail
//
// Tree expansion is routed through stack.viewState.expandedIds (NOT local
// useState) so goBack from a deeper frame restores the user's expansion
// state. Selected module is owned by frame.selectedModuleId; selecting a
// node calls stack.replace to update the frame in-place.
//
// We don't reuse <TreePanel> from shared/ because it owns its own internal
// `expanded` state and exposes no override prop — Phase 2 may refactor
// TreePanel to accept controlled expansion; for now we render a flat list
// inline.

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight, ChevronDown, Search, Boxes, Loader2,
  ChevronsUpDown, ChevronsDownUp, ExternalLink,
} from 'lucide-react';
import { api, ModuleTreeNode } from '../../api';
import type {
  CatalogStackAPI,
  ModuleTreeFrame,
  TreeViewState,
} from './types';
import { UsageBadge, useUsageStats } from './UsageBadge';

type TreeItem = ModuleTreeNode & { children: TreeItem[]; level: number };

function buildTree(nodes: ModuleTreeNode[]): TreeItem[] {
  const map = new Map<string, TreeItem>();
  for (const n of nodes) map.set(n.resource_id, { ...n, children: [], level: 0 });
  const roots: TreeItem[] = [];
  for (const item of map.values()) {
    if (item.parent_id && map.has(item.parent_id)) {
      const parent = map.get(item.parent_id)!;
      item.level = parent.level + 1;
      parent.children.push(item);
    } else {
      roots.push(item);
    }
  }
  return roots;
}

function flattenVisible(items: TreeItem[], expanded: Set<string>): TreeItem[] {
  const out: TreeItem[] = [];
  for (const item of items) {
    out.push(item);
    if (expanded.has(item.resource_id) && item.children.length > 0) {
      out.push(...flattenVisible(item.children, expanded));
    }
  }
  return out;
}

function matchesSearch(node: TreeItem, term: string): boolean {
  if (
    node.display_name.toLowerCase().includes(term) ||
    node.resource_id.toLowerCase().includes(term)
  ) return true;
  return node.children.some((c) => matchesSearch(c, term));
}

function collectAllIds(items: TreeItem[]): Set<string> {
  const ids = new Set<string>();
  function walk(list: TreeItem[]) { for (const i of list) { ids.add(i.resource_id); walk(i.children); } }
  walk(items);
  return ids;
}

function readTreeState(stack: CatalogStackAPI): TreeViewState {
  if (stack.viewState.viewMode === 'tree') return stack.viewState;
  return { viewMode: 'tree', expandedIds: [], scrollTop: 0 };
}

function patchTreeState(stack: CatalogStackAPI, patch: Partial<TreeViewState>) {
  stack.setViewState((prev) => {
    if (prev.viewMode !== 'tree') return prev;
    return { ...prev, ...patch };
  });
}

export function TreeView({ frame, api: stack }: { frame: ModuleTreeFrame; api: CatalogStackAPI }) {
  const [nodes, setNodes] = useState<ModuleTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const tree = readTreeState(stack);
  const expanded = useMemo(() => new Set(tree.expandedIds), [tree.expandedIds]);
  // Stats keyed by module resource_id — recorded when a module-detail frame
  // opens (target_id = frame.moduleId). The module-tree frame itself records
  // null, so tree-level navigation isn't reflected here.
  const usageStats = useUsageStats('modules');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.moduleTree()
      .then((tr) => { if (!cancelled) setNodes(tr); })
      .catch(() => { /* leave empty */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const treeItems = useMemo(() => buildTree(nodes), [nodes]);
  const allIds = useMemo(() => collectAllIds(treeItems), [treeItems]);

  // Auto-expand root nodes the first time tree loads (only if user hasn't
  // expanded anything yet — empty expandedIds === fresh frame).
  useEffect(() => {
    if (treeItems.length > 0 && tree.expandedIds.length === 0) {
      patchTreeState(stack, { expandedIds: treeItems.map((r) => r.resource_id) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems]);

  const filteredTree = useMemo(() => {
    if (!search.trim()) return treeItems;
    const term = search.toLowerCase();
    function filterItems(items: TreeItem[]): TreeItem[] {
      return items.filter((item) => matchesSearch(item, term))
        .map((item) => ({ ...item, children: filterItems(item.children) }));
    }
    return filterItems(treeItems);
  }, [treeItems, search]);

  const effectiveExpanded = useMemo(() => {
    if (search.trim()) return allIds;
    return expanded;
  }, [search, expanded, allIds]);

  const visible = useMemo(
    () => flattenVisible(filteredTree, effectiveExpanded),
    [filteredTree, effectiveExpanded],
  );

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    patchTreeState(stack, { expandedIds: Array.from(next) });
  };

  const expandAll = () => patchTreeState(stack, { expandedIds: Array.from(allIds) });
  const collapseAll = () => patchTreeState(stack, { expandedIds: [] });

  const select = (id: string) => {
    stack.replace({ kind: 'module-tree', selectedModuleId: id });
    stack.setInspector({ kind: 'module', moduleId: id });
  };

  const selected = frame.selectedModuleId
    ? nodes.find((n) => n.resource_id === frame.selectedModuleId) ?? null
    : null;

  return (
    <div className="grid grid-cols-[320px_1fr] h-full gap-0">
      {/* ── Tree pane ── */}
      <div className="border-r border-slate-200 bg-white flex flex-col h-full">
        <div className="p-3 border-b border-slate-200 space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full border border-slate-200 rounded pl-9 pr-2 py-1.5 text-xs"
              placeholder="Search modules..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="tree-search"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 font-medium">{nodes.length} modules</span>
            <div className="flex gap-1">
              <button onClick={expandAll} className="p-1 rounded hover:bg-slate-100" title="Expand all">
                <ChevronsUpDown size={13} className="text-slate-400" />
              </button>
              <button onClick={collapseAll} className="p-1 rounded hover:bg-slate-100" title="Collapse all">
                <ChevronsDownUp size={13} className="text-slate-400" />
              </button>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="text-center py-8 text-slate-400 text-xs flex items-center justify-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : visible.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-xs">
              {search ? 'No modules match.' : 'No modules.'}
            </div>
          ) : (
            visible.map((item) => {
              const hasChildren = item.children.length > 0;
              const isExpanded = effectiveExpanded.has(item.resource_id);
              const isSelected = frame.selectedModuleId === item.resource_id;
              const indent = 12 + item.level * 24;
              return (
                <div
                  key={item.resource_id}
                  className={`group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer text-xs transition-colors ${
                    isSelected
                      ? 'bg-blue-50 border-l-2 border-blue-500 text-blue-900'
                      : 'border-l-2 border-transparent hover:bg-slate-50 text-slate-700'
                  }`}
                  style={{ paddingLeft: indent }}
                  onClick={() => select(item.resource_id)}
                  data-testid={`tree-row-${item.resource_id}`}
                >
                  <button
                    className={`shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 ${hasChildren ? '' : 'invisible'}`}
                    onClick={(e) => { e.stopPropagation(); toggle(item.resource_id); }}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <Boxes size={14} className={`shrink-0 ${isSelected ? 'text-blue-500' : 'text-slate-400'}`} />
                  <div className="flex-1 min-w-0 truncate font-medium">{item.display_name}</div>
                  <div className="shrink-0 flex items-center gap-1.5 text-[10px] text-slate-400">
                    {item.table_count > 0 && <span>{item.table_count}t</span>}
                    {item.child_module_count > 0 && <span>{item.child_module_count}m</span>}
                    <UsageBadge stat={usageStats.get(item.resource_id)} />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Detail pane (placeholder summary; full ModuleDetail lives in DetailView) ── */}
      <div className="overflow-y-auto p-6">
        {!selected ? (
          <div className="text-center text-slate-400 text-sm py-12">
            Select a module on the left to see a summary.
          </div>
        ) : (
          <div className="max-w-2xl space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">Module</div>
              <div className="text-lg font-semibold text-slate-900">{selected.display_name}</div>
              <div className="font-mono text-xs text-slate-500">{selected.resource_id}</div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-slate-50 rounded p-3">
                <div className="text-[11px] text-slate-400">Sub-modules</div>
                <div className="font-mono text-base text-slate-800">{selected.child_module_count}</div>
              </div>
              <div className="bg-slate-50 rounded p-3">
                <div className="text-[11px] text-slate-400">Tables</div>
                <div className="font-mono text-base text-slate-800">{selected.table_count}</div>
              </div>
              <div className="bg-slate-50 rounded p-3">
                <div className="text-[11px] text-slate-400">Columns</div>
                <div className="font-mono text-base text-slate-800">{selected.column_count}</div>
              </div>
            </div>
            <button
              onClick={() => stack.push({ kind: 'module-detail', moduleId: selected.resource_id })}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 inline-flex items-center gap-1.5"
              data-testid="tree-open-module"
            >
              <ExternalLink size={12} /> Open module
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
