import { ReactNode } from 'react';
import { UIDescriptor } from '../../api';
import { Eye, Table2, Inbox, ChevronUp, ChevronDown } from 'lucide-react';
import { EmptyState } from './atoms/EmptyState';

type ColumnDef = UIDescriptor['columns'][number];

// Path badge color mapping (Path A/B/C from the architecture doc)
const PATH_COLORS: Record<string, string> = {
  A: 'badge-blue',
  B: 'badge-green',
  C: 'badge-purple',
};

// ─── Cell renderers by render_hint ─────────────────────────
function renderCell(value: unknown, col: ColumnDef, row: Record<string, unknown>): ReactNode {
  // Handle null/undefined early
  if (value == null) {
    return col.render_hint === 'active_badge'
      ? <span className="badge badge-slate text-[10px]">—</span>
      : <span className="text-slate-300">—</span>;
  }

  const strVal = String(value);

  // ─── Special render hints (priority over type) ──────────

  // bold_mono: monospace bold (for IDs)
  if (col.render_hint === 'bold_mono') {
    return <span className="font-mono text-xs font-bold text-slate-900">{strVal}</span>;
  }

  // muted_text: slate-500 (for descriptions, secondary info)
  if (col.render_hint === 'muted_text') {
    return <span className="text-xs text-slate-500">{strVal || '-'}</span>;
  }

  // path_badges: array → Path A/B/C colored badges
  if (col.render_hint === 'path_badges') {
    const arr = Array.isArray(value) ? value : [];
    if (arr.length === 0) return <span className="text-slate-300">—</span>;
    return (
      <div className="flex gap-1 flex-wrap">
        {arr.map((p: string) => (
          <span key={p} className={`badge text-[10px] ${PATH_COLORS[p] || 'badge-slate'}`}>
            Path {p}
          </span>
        ))}
      </div>
    );
  }

  // active_badge: boolean → YES/NO badge
  if (col.render_hint === 'active_badge') {
    const isActive = value === true || value === 'true' || value === 't';
    return (
      <span className={`badge text-[10px] ${isActive ? 'badge-green' : 'badge-red'}`}>
        {isActive ? 'YES' : 'NO'}
      </span>
    );
  }

  // mono_icon: icon prefix based on resource_type + mono text
  if (col.render_hint === 'mono_icon') {
    const rtype = row['resource_type'];
    const icon = rtype === 'view'
      ? <Eye size={13} className="text-violet-400 shrink-0" />
      : <Table2 size={13} className="text-emerald-400 shrink-0" />;
    return (
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="font-mono truncate max-w-[200px]">{strVal}</span>
      </div>
    );
  }

  // mono / mono_truncate
  if (col.render_hint === 'mono' || col.render_hint === 'mono_truncate') {
    return (
      <span className={`font-mono text-slate-400 ${col.render_hint === 'mono_truncate' ? 'truncate max-w-[120px] block' : ''}`}>
        {strVal}
      </span>
    );
  }

  // type_badge (same as badge but uses resource_type)
  if (col.render_hint === 'type_badge') {
    const colorMap: Record<string, string> = {
      table: 'badge-blue', view: 'badge-purple', function: 'badge-green',
    };
    return (
      <span className={`badge text-[10px] ${colorMap[strVal.toLowerCase()] || 'badge-slate'}`}>
        {strVal.toUpperCase()}
      </span>
    );
  }

  // ─── Fallback by type ───────────────────────────────────

  if (col.type === 'badge') {
    const colorMap: Record<string, string> = {
      table: 'badge-blue', view: 'badge-purple', function: 'badge-green',
      readonly: 'badge-blue', readwrite: 'badge-green', admin: 'badge-red',
    };
    return (
      <span className={`badge text-[10px] ${colorMap[strVal.toLowerCase()] || 'badge-slate'}`}>
        {strVal.toUpperCase()}
      </span>
    );
  }

  if (col.type === 'number') {
    return <span className="text-slate-500">{strVal}</span>;
  }

  return <span>{strVal}</span>;
}

// ─── Props ─────────────────────────────────────────────────
export type MetadataGridProps = {
  descriptor: UIDescriptor;
  data: Record<string, unknown>[];
  /** Key field for React key prop (default: first column key) */
  rowKey?: string;
  /** Extra column at the end (e.g. reassign dropdown) — legacy */
  extraColumn?: {
    header: string;
    render: (row: Record<string, unknown>) => ReactNode;
  };
  /** Row actions slot (edit/delete/clone buttons). Renders as trailing column. */
  rowActions?: {
    header?: string;
    render: (row: Record<string, unknown>) => ReactNode;
  };
  /** Current sort state (controlled from parent) */
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  /** Called when user clicks a sortable column header */
  onSort?: (key: string) => void;
};

export function MetadataGrid({
  descriptor, data, rowKey, extraColumn, rowActions, sortKey, sortDir, onSort,
}: MetadataGridProps) {
  const { columns, render_hints } = descriptor;
  const keyField = rowKey || columns[0]?.key || 'id';

  // Empty state from descriptor's render_hints (L1 metadata)
  if (data.length === 0) {
    const emptyMsg = (render_hints as any)?.empty_message || 'No data';
    return <EmptyState icon={<Inbox size={32} />} message={emptyMsg} />;
  }

  const handleHeaderClick = (col: ColumnDef) => {
    if (col.sortable && onSort) onSort(col.key);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            {columns.map(col => {
              const isSortable = col.sortable && onSort;
              const isActiveSort = sortKey === col.key;
              return (
                <th
                  key={col.key}
                  className={`pb-2 font-medium ${isSortable ? 'cursor-pointer hover:text-slate-700 select-none' : ''}`}
                  onClick={() => handleHeaderClick(col)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {isActiveSort && (
                      sortDir === 'asc'
                        ? <ChevronUp size={12} />
                        : <ChevronDown size={12} />
                    )}
                  </span>
                </th>
              );
            })}
            {extraColumn && <th className="pb-2 font-medium">{extraColumn.header}</th>}
            {rowActions && <th className="pb-2 font-medium">{rowActions.header ?? 'Actions'}</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr key={String(row[keyField] ?? idx)} className="border-b border-slate-100 hover:bg-slate-50/50">
              {columns.map(col => (
                <td key={col.key} className="py-2 pr-3">
                  {renderCell(row[col.key], col, row)}
                </td>
              ))}
              {extraColumn && (
                <td className="py-2">{extraColumn.render(row)}</td>
              )}
              {rowActions && (
                <td className="py-2">{rowActions.render(row)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
