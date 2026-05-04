// Catalog resource-grid column config + parent-child nesting helpers.
// TYPE_META, TYPE_ORDER, sortByType, typeMeta lifted VERBATIM from
// apps/authz-dashboard/src/components/access-manager/ResourcesSection.tsx
// (lines 15-33 of original). Do not reword — Phase 2 ships a single canonical
// copy by deleting the original.
//
// Parent-child mechanic: column rows nest under their parent table row.
// `buildChildrenMap` keyed by parent_id; `autoExpandedParents` auto-opens
// any table whose column children match the search query.

import {
  Boxes, Table2, Columns3, FunctionSquare, Workflow, Globe, Eye, Server, FileCode2,
  ChevronDown, ChevronRight,
} from 'lucide-react';

export type ResourceRow = Record<string, unknown>;

export const TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string; badge: string }> = {
  module:   { label: 'Modules',    icon: <Boxes size={13} />,          color: 'text-indigo-600', badge: 'badge-indigo' },
  table:    { label: 'Tables',     icon: <Table2 size={13} />,         color: 'text-emerald-700', badge: 'badge-green' },
  view:     { label: 'Views',      icon: <Eye size={13} />,            color: 'text-emerald-700', badge: 'badge-green' },
  column:   { label: 'Columns',    icon: <Columns3 size={13} />,       color: 'text-amber-700',  badge: 'badge-amber' },
  function: { label: 'Functions',  icon: <FunctionSquare size={13} />, color: 'text-slate-700',  badge: 'badge-slate' },
  dag:      { label: 'DAGs',       icon: <Workflow size={13} />,       color: 'text-violet-700', badge: 'badge-purple' },
  web_page: { label: 'Pages',      icon: <FileCode2 size={13} />,      color: 'text-blue-700',   badge: 'badge-blue' },
  web_api:  { label: 'APIs',       icon: <Globe size={13} />,          color: 'text-purple-700', badge: 'badge-purple' },
  db_pool:  { label: 'DB Pools',   icon: <Server size={13} />,         color: 'text-red-700',    badge: 'badge-red' },
  page:     { label: 'Pages',      icon: <FileCode2 size={13} />,      color: 'text-blue-700',   badge: 'badge-blue' },
};

export const typeMeta = (t: string) =>
  TYPE_META[t] ?? { label: t, icon: <Boxes size={13} />, color: 'text-slate-500', badge: 'badge-slate' };

export const TYPE_ORDER = ['module', 'table', 'view', 'web_page', 'web_api', 'function', 'dag', 'db_pool', 'column'];

export const sortByType = (a: string, b: string) => {
  const ia = TYPE_ORDER.indexOf(a);
  const ib = TYPE_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
};

/** Map parent_id → child rows (sorted by resource_id). */
export function buildChildrenMap(rows: ResourceRow[]): Map<string, ResourceRow[]> {
  const m = new Map<string, ResourceRow[]>();
  for (const r of rows) {
    const pid = r.parent_id ? String(r.parent_id) : '';
    if (!pid) continue;
    if (!m.has(pid)) m.set(pid, []);
    m.get(pid)!.push(r);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => String(a.resource_id).localeCompare(String(b.resource_id)));
  }
  return m;
}

/** When searching, auto-expand parents whose 'column' children matched. */
export function autoExpandedParents(
  rows: ResourceRow[],
  manualExpanded: Set<string>,
  searching: boolean,
): Set<string> {
  if (!searching) return manualExpanded;
  const next = new Set(manualExpanded);
  for (const r of rows) {
    if (String(r.resource_type) === 'column' && r.parent_id) next.add(String(r.parent_id));
  }
  return next;
}

export type ResourceCellProps = {
  row: ResourceRow;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
};

export type ResourceColumn = {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  cell: (props: ResourceCellProps) => React.ReactNode;
};

export const resourceColumns: ResourceColumn[] = [
  {
    key: 'expand',
    label: '',
    width: 'w-6',
    cell: ({ hasChildren, isExpanded, onToggleExpand }) =>
      hasChildren ? (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="text-slate-400 hover:text-slate-700 p-1"
          title={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      ) : null,
  },
  {
    key: 'type',
    label: 'Type',
    width: 'w-28',
    cell: ({ row }) => {
      const meta = typeMeta(String(row.resource_type));
      return (
        <span className={`badge ${meta.badge} inline-flex items-center gap-1`}>
          <span className="opacity-80">{meta.icon}</span>
          {String(row.resource_type)}
        </span>
      );
    },
  },
  {
    key: 'rid',
    label: 'Resource ID / Display Name',
    cell: ({ row, depth }) => {
      const indent = depth * 20;
      return (
        <div style={{ paddingLeft: indent ? `${indent + 12}px` : undefined }} className="flex flex-col">
          <span className="font-mono text-xs text-slate-800">{String(row.resource_id)}</span>
          <span
            className="text-[11px] text-slate-500 truncate max-w-[420px]"
            title={String(row.display_name)}
          >
            {String(row.display_name)}
          </span>
        </div>
      );
    },
  },
  {
    key: 'parent',
    label: 'Parent',
    width: 'w-56',
    cell: ({ row }) => (
      <span
        className="font-mono text-[11px] text-slate-400 truncate max-w-[220px]"
        title={String(row.parent_id || '')}
      >
        {row.parent_id ? String(row.parent_id) : <span className="text-slate-300">—</span>}
      </span>
    ),
  },
];
