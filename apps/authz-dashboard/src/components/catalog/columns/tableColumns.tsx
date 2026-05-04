// Catalog table-grid column config.
// Source data: api.tables(userId, groups) → { table_name, table_type?, column_count }[]
// Replaces the button-list rendering in TablesTab.tsx (lines 71+).

import { Table2, ChevronRight } from 'lucide-react';

export type TableRow = {
  table_name: string;
  table_type?: string;
  column_count: string;
};

export type TableRowActions = {
  onOpen: (row: TableRow) => void;
};

export type TableColumn = {
  key: string;
  label: string;
  align?: 'left' | 'right';
  width?: string;
  cell: (row: TableRow, actions: TableRowActions) => React.ReactNode;
};

export const tableColumns: TableColumn[] = [
  {
    key: 'name',
    label: 'Schema.table',
    cell: (row) => (
      <div className="flex items-center gap-2">
        <Table2 size={13} className="text-emerald-600 shrink-0" />
        <span className="font-mono text-xs text-slate-800">{row.table_name}</span>
      </div>
    ),
  },
  {
    key: 'type',
    label: 'Type',
    cell: (row) => (
      <span className="badge badge-slate text-[10px]">{row.table_type ?? 'BASE TABLE'}</span>
    ),
  },
  {
    key: 'columns',
    label: 'Columns',
    align: 'right',
    cell: (row) => <span className="font-mono text-[11px] text-slate-600">{row.column_count}</span>,
  },
  {
    key: 'actions',
    label: '',
    align: 'right',
    cell: (row, actions) => (
      <button
        onClick={(e) => { e.stopPropagation(); actions.onOpen(row); }}
        className="inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-100 text-slate-700"
        title="Open schema"
        data-testid={`table-open-${row.table_name}`}
      >
        <ChevronRight size={12} />
      </button>
    ),
  },
];
