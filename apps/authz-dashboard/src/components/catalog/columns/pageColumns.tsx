// Catalog page-grid column config.
// Lifted from PagesTab.tsx row-rendering (lines 216-303). Row actions match
// the original 4-button set: Open / Edit / Republish / Delete. The Republish
// action dispatches navigate-tab + flow-composer-load-dag (deferred via
// setTimeout(0)) so Flow Composer (which mounts on tab switch) catches the
// event AFTER its mount-time useEffect registers the listener.
//
// Phase 2 deletes the original PagesTab.tsx after verifying this copy.

import { Workflow, AlertTriangle, ExternalLink, Pencil, Upload, Trash2 } from 'lucide-react';
import { PagesAdminRow } from '../../../api';

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export type PageRowActions = {
  onOpen: (row: PagesAdminRow) => void;
  onEdit: (row: PagesAdminRow) => void;
  onRepublish: (row: PagesAdminRow) => void;
  onDelete: (row: PagesAdminRow) => void;
};

/** Republish dispatcher used by both row button + the dag_id link.
 *  setTimeout(0) defers until after the tab-switch useEffect mounts on
 *  DagTab — without this, the event fires before the listener exists. */
export function dispatchRepublish(row: PagesAdminRow) {
  window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'flow-composer' } }));
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('flow-composer-load-dag', { detail: { dag_id: row.dag_id } }));
  }, 0);
}

export type PageColumn = {
  key: string;
  label: string;
  align?: 'left' | 'right';
  width?: string;
  cell: (row: PagesAdminRow, actions: PageRowActions) => React.ReactNode;
};

export const pageColumns: PageColumn[] = [
  {
    key: 'page',
    label: 'Page',
    cell: (row) => (
      <>
        <div className="text-slate-900 font-medium">{row.title}</div>
        <div className="text-[10px] text-slate-500 font-mono">{row.page_id}</div>
      </>
    ),
  },
  {
    key: 'module',
    label: 'Module',
    cell: (row) => (
      <div className="text-slate-700">
        {row.parent_module_name || <span className="text-slate-400">—</span>}
        {row.parent_module_id && (
          <div className="text-[10px] text-slate-400 font-mono">{row.parent_module_id}</div>
        )}
      </div>
    ),
  },
  {
    key: 'dag',
    label: 'Backing DAG',
    cell: (row) => (
      <>
        <button
          onClick={(e) => { e.stopPropagation(); dispatchRepublish(row); }}
          className="text-blue-700 hover:underline font-mono text-[11px] flex items-center gap-1"
          title="Open in Flow Composer"
        >
          <Workflow size={11} /> {row.dag_id}
        </button>
        {row.data_source_id && (
          <div className="text-[10px] text-slate-400 font-mono">{row.data_source_id}</div>
        )}
      </>
    ),
  },
  {
    key: 'last_published',
    label: 'Last published',
    cell: (row) => (
      <>
        <div>{formatRelative(row.last_published_at)}</div>
        {row.last_published_by && (
          <div className="text-[10px] text-slate-500 font-mono">by {row.last_published_by}</div>
        )}
      </>
    ),
  },
  {
    key: 'embedders',
    label: 'Embedders',
    align: 'right',
    cell: (row) =>
      row.embedders_count > 0 ? (
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[10px]"
          title="This page is embedded in other published_dags — delete will be blocked."
        >
          <AlertTriangle size={10} /> {row.embedders_count}
        </span>
      ) : (
        <span className="text-slate-400">0</span>
      ),
  },
  {
    key: 'order',
    label: 'Order',
    align: 'right',
    cell: (row) => <span className="text-slate-600 font-mono">{row.display_order}</span>,
  },
  {
    key: 'actions',
    label: 'Actions',
    align: 'right',
    cell: (row, actions) => (
      <span className="whitespace-nowrap">
        <button
          onClick={(e) => { e.stopPropagation(); actions.onOpen(row); }}
          className="inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-100 text-slate-700"
          title="Open page"
          data-testid={`pages-open-${row.page_id}`}
        >
          <ExternalLink size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); actions.onEdit(row); }}
          className="inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-100 text-slate-700"
          title="Edit metadata"
          data-testid={`pages-edit-${row.page_id}`}
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); actions.onRepublish(row); }}
          className="inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-emerald-50 text-emerald-700"
          title="Republish (open in Flow Composer)"
          data-testid={`pages-republish-${row.page_id}`}
        >
          <Upload size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); actions.onDelete(row); }}
          className="inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-red-50 text-red-700"
          title="Delete (soft)"
          data-testid={`pages-delete-${row.page_id}`}
        >
          <Trash2 size={12} />
        </button>
      </span>
    ),
  },
];
