// Catalog GridView — renders page-grid / table-grid / resource-grid frames.
//
// Per design (catalog-workspace-unified-design.md §4 Agent C):
//   - page-grid     → api.pagesList(filter)  → pageColumns, 4-button actions
//   - table-grid    → api.tables()            → tableColumns
//   - resource-grid → api.resources()         → resourceColumns + parent-child nesting
//
// Search/sort/scroll lives in GridViewState (viewMode === 'grid'). Saved-view
// id (?view=…) is owned by useSavedView; URL writes go through
// api.replaceQueryParam — never window.history.* (single sync point with
// the stack URL serializer).
//
// Top of grid: <ModuleBreadcrumb moduleId={null} modules={[]} leaf={...} />
// Two-segment "Catalog › <preset>" header (ux-three-asks 案 2).

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Search, FileText, Loader2 } from 'lucide-react';
import {
  api,
  ModuleTreeNode,
  PagesAdminRow,
} from '../../api';
import { useSavedView } from '../../hooks/useSavedView';
import { useToast } from '../Toast';
import { ModuleBreadcrumb } from '../shared/atoms/ModuleBreadcrumb';
import type {
  CatalogStackAPI,
  PageGridFrame,
  TableGridFrame,
  ResourceGridFrame,
  GridViewState,
} from './types';
import { pageColumns, dispatchRepublish } from './columns/pageColumns';
import { tableColumns, type TableRow } from './columns/tableColumns';
import {
  resourceColumns,
  TYPE_META,
  TYPE_ORDER,
  typeMeta,
  sortByType,
  buildChildrenMap,
  autoExpandedParents,
  type ResourceRow,
} from './columns/resourceColumns';
import { PageEditDialog } from './dialogs/PageEditDialog';
import { PageDeleteDialog } from './dialogs/PageDeleteDialog';
import { UsageBadge, useUsageStats } from './UsageBadge';

type GridFrame = PageGridFrame | TableGridFrame | ResourceGridFrame;

export function GridView({ frame, api: stack }: { frame: GridFrame; api: CatalogStackAPI }) {
  switch (frame.kind) {
    case 'page-grid':
      return <PageGrid frame={frame} stack={stack} />;
    case 'table-grid':
      return <TableGrid frame={frame} stack={stack} />;
    case 'resource-grid':
      return <ResourceGrid frame={frame} stack={stack} />;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Narrow viewState to GridViewState; emit defaults if the stack ever served
 *  an off-mode state (defensive — useStack initializes correctly). */
function readGridState(stack: CatalogStackAPI): GridViewState {
  if (stack.viewState.viewMode === 'grid') return stack.viewState;
  return { viewMode: 'grid', scrollTop: 0 };
}

function patchGridState(stack: CatalogStackAPI, patch: Partial<GridViewState>) {
  stack.setViewState((prev) => {
    if (prev.viewMode !== 'grid') return prev;
    return { ...prev, ...patch };
  });
}

/** ?view=<id> sync — uses CatalogStackAPI helper (single history-mutation
 *  path; avoids races with the stack URL serializer). */
function useSavedViewUrlSync(stack: CatalogStackAPI, activeViewId: string | null) {
  useEffect(() => {
    stack.replaceQueryParam('view', activeViewId);
  }, [stack, activeViewId]);
}

/** Two-segment breadcrumb header — null moduleId so the atom only renders
 *  "Catalog › <leaf>" (no module chain). */
function GridHeader({ leaf }: { leaf: string }) {
  return (
    <div className="px-4 pt-3 pb-2">
      <ModuleBreadcrumb moduleId={null} modules={[]} leaf={{ label: leaf }} />
    </div>
  );
}

// ── page-grid ────────────────────────────────────────────────────────────

function PageGrid({ frame, stack }: { frame: PageGridFrame; stack: CatalogStackAPI }) {
  const toast = useToast();
  const grid = readGridState(stack);
  const [rows, setRows] = useState<PagesAdminRow[]>([]);
  const [modules, setModules] = useState<ModuleTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PagesAdminRow | null>(null);
  const [deleting, setDeleting] = useState<PagesAdminRow | null>(null);
  const usageStats = useUsageStats('pages');

  const filterModule = frame.filter?.module_id ?? '';
  const search = grid.search ?? '';

  // ?view= bootstrap — read the URL param once on first mount (parent stack
  // never overwrites it; useSavedView treats it as a hint, not state).
  const initialViewId = useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    return new URLSearchParams(window.location.search).get('view') || undefined;
  }, []);
  const sv = useSavedView({ pageId: '__catalog_pages', initialViewId });
  useSavedViewUrlSync(stack, sv.activeView?.view_id ?? null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [pages, tree] = await Promise.all([
        api.pagesList({
          parent_module_id: filterModule || undefined,
          q: search.trim() || undefined,
        }),
        modules.length === 0 ? api.moduleTree() : Promise.resolve(modules),
      ]);
      setRows(pages.pages);
      if (modules.length === 0) setModules(tree);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const id = setTimeout(() => { void refresh(); }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterModule, search]);

  const moduleOptions = useMemo(
    () => modules.filter((m) => m.is_active).sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [modules],
  );

  return (
    <div className="space-y-2">
      <GridHeader leaf="Pages" />

      <div className="px-4 flex items-center gap-2 text-xs">
        <select
          value={filterModule}
          onChange={(e) => stack.replace({
            kind: 'page-grid',
            filter: { ...(frame.filter ?? {}), module_id: e.target.value || undefined },
          })}
          className="border border-slate-200 rounded px-2 py-1.5 bg-white font-mono"
          data-testid="pages-filter-module"
        >
          <option value="">All modules</option>
          {moduleOptions.map((m) => (
            <option key={m.resource_id} value={m.resource_id}>
              {m.resource_id} — {m.display_name}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => patchGridState(stack, { search: e.target.value })}
            placeholder="Search title or page_id"
            className="border border-slate-200 rounded pl-6 pr-2 py-1.5 w-56"
            data-testid="pages-filter-search"
          />
        </div>
        <div className="text-[11px] text-slate-500 ml-auto">
          {loading ? '…' : `${rows.length} page${rows.length === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className="px-4">
        {loading ? (
          <div className="py-12 flex items-center justify-center text-slate-400 text-xs">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading pages…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-12 flex flex-col items-center text-slate-400 text-xs gap-2">
            <FileText size={32} />
            <div>No published pages match.</div>
          </div>
        ) : (
          <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-2 py-2 font-medium text-left w-10" />
                  {pageColumns.map((c) => (
                    <th
                      key={c.key}
                      className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.page_id}
                    className="border-t border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                    onClick={() => stack.setInspector({ kind: 'page', pageId: row.page_id })}
                    data-testid={`pages-row-${row.page_id}`}
                  >
                    <td className="px-2 py-2 align-top">
                      <UsageBadge stat={usageStats.get(row.page_id)} />
                    </td>
                    {pageColumns.map((c) => (
                      <td
                        key={c.key}
                        className={`px-3 py-2 align-top ${c.align === 'right' ? 'text-right' : ''}`}
                      >
                        {c.cell(row, {
                          onOpen: (r) => stack.push({ kind: 'page-detail', pageId: r.page_id, params: {} }),
                          onEdit: (r) => setEditing(r),
                          onRepublish: (r) => dispatchRepublish(r),
                          onDelete: (r) => setDeleting(r),
                        })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <PageEditDialog
          row={editing}
          modules={moduleOptions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
            toast.success('Page updated.');
          }}
        />
      )}
      {deleting && (
        <PageDeleteDialog
          row={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const title = deleting.title;
            setDeleting(null);
            void refresh();
            toast.success(`Deleted "${title}".`);
          }}
        />
      )}
    </div>
  );
}

// ── table-grid ───────────────────────────────────────────────────────────

function TableGrid({ frame: _frame, stack }: { frame: TableGridFrame; stack: CatalogStackAPI }) {
  const grid = readGridState(stack);
  const [rows, setRows] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const search = grid.search ?? '';
  const usageStats = useUsageStats('tables');

  useEffect(() => {
    setLoading(true);
    api.tables()
      .then((data) => { setRows(data); })
      .catch(() => { setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.table_name.toLowerCase().includes(q));
  }, [rows, search]);

  return (
    <div className="space-y-2">
      <GridHeader leaf="Raw Tables" />
      <div className="px-4 flex items-center gap-2 text-xs">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => patchGridState(stack, { search: e.target.value })}
            placeholder="Search schema.table"
            className="border border-slate-200 rounded pl-6 pr-2 py-1.5 w-56"
            data-testid="tables-filter-search"
          />
        </div>
        <div className="text-[11px] text-slate-500 ml-auto">
          {loading ? '…' : `${filtered.length} table${filtered.length === 1 ? '' : 's'}`}
        </div>
      </div>
      <div className="px-4">
        {loading ? (
          <div className="py-12 flex items-center justify-center text-slate-400 text-xs">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading tables…
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-slate-400 text-xs">No tables match.</div>
        ) : (
          <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-2 py-2 font-medium text-left w-10" />
                  {tableColumns.map((c) => (
                    <th
                      key={c.key}
                      className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={row.table_name}
                    className="border-t border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                    onClick={() => stack.setInspector({ kind: 'table', table: row.table_name })}
                    data-testid={`tables-row-${row.table_name}`}
                  >
                    <td className="px-2 py-2 align-top">
                      <UsageBadge stat={usageStats.get(row.table_name)} />
                    </td>
                    {tableColumns.map((c) => (
                      <td
                        key={c.key}
                        className={`px-3 py-2 align-top ${c.align === 'right' ? 'text-right' : ''}`}
                      >
                        {c.cell(row, {
                          onOpen: (r) => stack.push({ kind: 'table-schema', table: r.table_name }),
                        })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── resource-grid ────────────────────────────────────────────────────────

function ResourceGrid({ frame, stack }: { frame: ResourceGridFrame; stack: CatalogStackAPI }) {
  const grid = readGridState(stack);
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set(['column']));
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const search = grid.search ?? '';
  const typeFilter = frame.resourceType ?? null;
  const usageStats = useUsageStats('resources');

  useEffect(() => {
    setLoading(true);
    api.resources()
      .then((data) => { setRows(data); })
      .catch(() => { setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  // Apply text + type filter.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter && String(r.resource_type) !== typeFilter) return false;
      if (!q) return true;
      const fields = ['resource_id', 'display_name', 'resource_type', 'parent_id'];
      return fields.some((f) => String(r[f] ?? '').toLowerCase().includes(q));
    });
  }, [rows, search, typeFilter]);

  const totalCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) {
      const t = String(r.resource_type || 'other');
      m[t] = (m[t] || 0) + 1;
    }
    return m;
  }, [rows]);

  const grouped = useMemo(() => {
    const searching = search.trim() !== '';
    const g = new Map<string, ResourceRow[]>();
    for (const r of filtered) {
      const t = String(r.resource_type || 'other');
      if (!g.has(t)) g.set(t, []);
      g.get(t)!.push(r);
    }
    const types = Array.from(g.keys()).sort(sortByType);
    return { g, types, searching };
  }, [filtered, search]);

  const childrenMap = useMemo(() => buildChildrenMap(filtered), [filtered]);
  const autoExpanded = useMemo(
    () => autoExpandedParents(filtered, expandedParents, grouped.searching),
    [filtered, expandedParents, grouped.searching],
  );

  // When browsing 'all', hide the 'column' group header — columns nest
  // under their parent table. Explicit type-filter to 'column' shows them flat.
  const visibleTypes = typeFilter === null
    ? grouped.types.filter((t) => !(t === 'column' && grouped.types.includes('table')))
    : grouped.types.filter((t) => t === typeFilter);

  const toggleType = (t: string) =>
    setCollapsedTypes((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t); else n.add(t);
      return n;
    });
  const toggleParent = (pid: string) =>
    setExpandedParents((s) => {
      const n = new Set(s);
      if (n.has(pid)) n.delete(pid); else n.add(pid);
      return n;
    });

  /** Type chip change uses stack.replace — not push — so the chip behaves
   *  like a filter swap, not a navigation step. */
  const setChip = (t: ResourceGridFrame['resourceType']) => {
    stack.replace({ kind: 'resource-grid', resourceType: t ?? null });
  };

  return (
    <div className="space-y-2">
      <GridHeader leaf="Resources" />

      <div className="px-4 flex items-center gap-2 flex-wrap text-xs">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => patchGridState(stack, { search: e.target.value })}
            placeholder="Search id / name / parent..."
            className="border border-slate-200 rounded pl-6 pr-2 py-1.5 w-56"
            data-testid="resources-filter-search"
          />
        </div>
        <span className="text-[11px] text-slate-500 ml-auto">
          {loading ? '…' : `${filtered.length} of ${rows.length}`}
        </span>
      </div>

      <div className="px-4 py-1 flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide text-slate-400 mr-1">Filter:</span>
        <TypePill
          active={typeFilter === null}
          onClick={() => setChip(null)}
          label="All"
          count={rows.length}
        />
        {Object.keys(TYPE_META)
          .filter((t) => (totalCounts[t] ?? 0) > 0)
          .sort(sortByType)
          .map((t) => (
            <TypePill
              key={t}
              active={typeFilter === t}
              onClick={() => setChip(t as ResourceGridFrame['resourceType'])}
              label={typeMeta(t).label}
              count={totalCounts[t] || 0}
              icon={typeMeta(t).icon}
              color={typeMeta(t).color}
            />
          ))
        }
      </div>

      <div className="px-4">
        {loading ? (
          <div className="py-12 flex items-center justify-center text-slate-400 text-xs">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading resources…
          </div>
        ) : (
          <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 sticky top-0 z-10">
                <tr>
                  <th className="px-2 py-2 font-medium text-left w-10" />
                  {resourceColumns.map((c) => (
                    <th
                      key={c.key}
                      className={`px-3 py-2 font-medium ${c.width ?? ''} ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'}`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleTypes.length === 0 && (
                  <tr>
                    <td colSpan={resourceColumns.length + 1} className="text-center text-slate-400 py-8">
                      No resources match.
                    </td>
                  </tr>
                )}
                {visibleTypes.map((t) => {
                  const groupRows = grouped.g.get(t) || [];
                  const collapsed = collapsedTypes.has(t);
                  const meta = typeMeta(t);
                  // 'column' type — when 'table' is also visible we render column rows
                  // nested under their parent table, so skip them at the group level.
                  const renderedRows = t === 'column' && visibleTypes.includes('table') ? [] : groupRows;
                  return (
                    <Fragment key={`group_${t}`}>
                      <tr
                        className="bg-slate-50 hover:bg-slate-100 cursor-pointer border-t-2 border-slate-200"
                        onClick={() => toggleType(t)}
                      >
                        <td colSpan={resourceColumns.length + 1} className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            <span className={meta.color}>{meta.icon}</span>
                            <span className="text-xs font-semibold text-slate-800">{meta.label}</span>
                            <span className="text-[11px] text-slate-400">·</span>
                            <span className="text-[11px] text-slate-500">
                              {groupRows.length.toLocaleString()} {groupRows.length === 1 ? 'row' : 'rows'}
                            </span>
                            <span className="text-[11px] text-slate-400 ml-auto">
                              {collapsed ? 'collapsed' : 'expanded'}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {!collapsed && renderedRows.map((r) => {
                        const rid = String(r.resource_id);
                        const children = childrenMap.get(rid) || [];
                        const hasChildren = children.length > 0;
                        const isExpanded = autoExpanded.has(rid);
                        return (
                          <Fragment key={rid}>
                            <ResourceTableRow
                              row={r}
                              depth={0}
                              hasChildren={hasChildren}
                              isExpanded={isExpanded}
                              onToggleExpand={() => toggleParent(rid)}
                              usageStat={usageStats.get(rid)}
                              onPeek={(rr) =>
                                stack.setInspector({
                                  kind: 'resource',
                                  rid: String(rr.resource_id),
                                  resource_type: String(rr.resource_type),
                                })
                              }
                            />
                            {hasChildren && isExpanded && children.map((c) => (
                              <ResourceTableRow
                                key={`${rid}>>${String(c.resource_id)}`}
                                row={c}
                                depth={1}
                                hasChildren={false}
                                isExpanded={false}
                                onToggleExpand={() => {}}
                                usageStat={usageStats.get(String(c.resource_id))}
                                onPeek={(rr) =>
                                  stack.setInspector({
                                    kind: 'resource',
                                    rid: String(rr.resource_id),
                                    resource_type: String(rr.resource_type),
                                  })
                                }
                              />
                            ))}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ResourceTableRow({
  row, depth, hasChildren, isExpanded, onToggleExpand, onPeek, usageStat,
}: {
  row: ResourceRow;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onPeek: (row: ResourceRow) => void;
  usageStat?: import('./UsageBadge').UsageStat;
}) {
  return (
    <tr
      className={`${depth > 0 ? 'bg-slate-50/50 hover:bg-slate-100/50' : 'hover:bg-slate-50'} cursor-pointer`}
      onClick={() => onPeek(row)}
      data-testid={`resource-row-${String(row.resource_id)}`}
    >
      <td className="px-2 py-1.5 align-top">
        <UsageBadge stat={usageStat} />
      </td>
      {resourceColumns.map((c) => (
        <td
          key={c.key}
          className={`px-3 py-1.5 align-top ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`}
        >
          {c.cell({ row, depth, hasChildren, isExpanded, onToggleExpand })}
        </td>
      ))}
    </tr>
  );
}

function TypePill({ active, onClick, label, count, icon, color }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon?: React.ReactNode;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition ${
        active
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
      }`}
    >
      {icon && <span className={active ? 'text-white' : color}>{icon}</span>}
      {label}
      <span className={`text-[10px] ${active ? 'text-blue-100' : 'text-slate-400'}`}>
        {count.toLocaleString()}
      </span>
    </button>
  );
}

// Re-export saved-view types if a future caller needs them.
export type { GridFrame };
