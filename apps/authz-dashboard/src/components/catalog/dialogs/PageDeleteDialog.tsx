// Catalog page delete dialog.
// Verbatim copy of PagesTab.PageDeleteDialog (lines 466-650 of original
// apps/authz-dashboard/src/components/PagesTab.tsx).
//
// State machine:
//   1. Open  → preflight `/embedders` →
//       - blocked (parents exist) — show list, "Cancel" only
//       - confirm (no parents)    — show two-step confirm
//   2. Confirm → DELETE → toast → close
//
// Embedder list rows include an "Open" button that dispatches navigate-tab +
// flow-composer-load-dag (deferred via setTimeout(0)) — Flow Composer lives
// outside Catalog and still consumes those events.
//
// Phase 2 deletes the original PagesTab.tsx after verifying this copy.

import { useEffect, useState } from 'react';
import { Trash2, Loader2, X, AlertTriangle, Workflow } from 'lucide-react';
import { api, PagesAdminRow } from '../../../api';

type DeleteState =
  | { kind: 'loading' }
  | { kind: 'blocked'; parents: Array<{ parent_page_id: string; parent_title: string; parent_dag_id: string; parent_published_dag_rid: string }> }
  | { kind: 'confirm' }
  | { kind: 'deleting' }
  | { kind: 'error'; msg: string };

export function PageDeleteDialog({
  row,
  onClose,
  onDeleted,
}: {
  row: PagesAdminRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [state, setState] = useState<DeleteState>({ kind: 'loading' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Embedder preflight uses /api/dag/published/:rid/embedders (V087).
  // Backend DELETE re-checks too, so this is purely a UX optimization.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dag/published/${encodeURIComponent(row.published_dag_rid)}/embedders`, { credentials: 'same-origin' })
      .then(r => r.json())
      .then((data: { parents: Array<{ parent_page_id: string; parent_title: string; parent_published_dag_id: string; parent_published_dag_rid: string }> }) => {
        if (cancelled) return;
        if (data.parents && data.parents.length > 0) {
          setState({
            kind: 'blocked',
            parents: data.parents.map(p => ({
              parent_page_id: p.parent_page_id,
              parent_title: p.parent_title,
              parent_dag_id: p.parent_published_dag_id,
              parent_published_dag_rid: p.parent_published_dag_rid,
            })),
          });
        } else {
          setState({ kind: 'confirm' });
        }
      })
      .catch(err => {
        if (cancelled) return;
        setState({ kind: 'error', msg: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [row.published_dag_rid]);

  const doDelete = async () => {
    setState({ kind: 'deleting' });
    try {
      await api.pageDelete(row.page_id);
      onDeleted();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Backend race: parent embed appeared between preflight and DELETE.
      try {
        const refresh = await fetch(`/api/dag/published/${encodeURIComponent(row.published_dag_rid)}/embedders`, { credentials: 'same-origin' }).then(r => r.json());
        if (refresh.parents && refresh.parents.length > 0) {
          setState({
            kind: 'blocked',
            parents: refresh.parents.map((p: { parent_page_id: string; parent_title: string; parent_published_dag_id: string; parent_published_dag_rid: string }) => ({
              parent_page_id: p.parent_page_id,
              parent_title: p.parent_title,
              parent_dag_id: p.parent_published_dag_id,
              parent_published_dag_rid: p.parent_published_dag_rid,
            })),
          });
          return;
        }
      } catch { /* fall through to error */ }
      setState({ kind: 'error', msg: raw });
    }
  };

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative w-full max-w-md bg-white rounded-lg shadow-xl border border-slate-200" onClick={(e) => e.stopPropagation()} data-testid="page-delete-dialog">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <Trash2 size={14} className="text-red-600" /> Delete page
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="px-4 py-3 space-y-3 text-xs">
          <div className="bg-slate-50 rounded p-2">
            <div className="text-slate-900 font-medium">{row.title}</div>
            <div className="text-[10px] text-slate-500 font-mono">{row.page_id} · {row.dag_id}</div>
          </div>

          {state.kind === 'loading' && (
            <div className="flex items-center gap-2 text-slate-500"><Loader2 size={12} className="animate-spin" /> Checking for embedders…</div>
          )}

          {state.kind === 'blocked' && (
            <>
              <div className="bg-amber-50 border border-amber-200 rounded p-2 text-amber-800 flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">Cannot delete — embedded in {state.parents.length} other published_dag(s)</div>
                  <div className="text-[10px] mt-0.5">Republish or delete the parent(s) first; they reference this page as a subdag.</div>
                </div>
              </div>
              <ul className="space-y-1">
                {state.parents.map(p => (
                  <li key={p.parent_page_id} className="border border-slate-200 rounded p-2 flex items-center justify-between" data-testid={`page-delete-blocker-${p.parent_page_id}`}>
                    <div>
                      <div className="text-slate-900">{p.parent_title}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{p.parent_page_id} · {p.parent_dag_id}</div>
                    </div>
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'flow-composer' } }));
                        setTimeout(() => {
                          window.dispatchEvent(new CustomEvent('flow-composer-load-dag', { detail: { dag_id: p.parent_dag_id } }));
                        }, 0);
                        onClose();
                      }}
                      className="text-blue-600 hover:underline text-[11px] flex items-center gap-1"
                      title="Open parent DAG in Flow Composer"
                    >
                      <Workflow size={11} /> Open
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {state.kind === 'confirm' && (
            <>
              <div className="bg-red-50 border border-red-200 rounded p-2 text-red-800">
                <div className="font-medium">Soft delete</div>
                <div className="text-[10px] mt-0.5">
                  Sets <span className="font-mono">is_active=FALSE</span> on the page mirror and authz_ui_page row.
                  BI users immediately lose access (authz_check denies inactive resources). Audit log is preserved.
                  No hard delete — ops can revive by flipping is_active back.
                </div>
              </div>
              {row.embedders_count > 0 && (
                <div className="text-[11px] text-amber-700">
                  Note: row showed {row.embedders_count} embedder(s) but live check returned 0 — proceeding.
                </div>
              )}
            </>
          )}

          {state.kind === 'deleting' && (
            <div className="flex items-center gap-2 text-slate-500"><Loader2 size={12} className="animate-spin" /> Deleting…</div>
          )}

          {state.kind === 'error' && (
            <div className="bg-red-50 border border-red-200 rounded p-2 text-red-700 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{state.msg}</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-slate-200">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50">
            {state.kind === 'blocked' ? 'Close' : 'Cancel'}
          </button>
          {state.kind === 'confirm' && (
            <button
              onClick={() => void doDelete()}
              className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 flex items-center gap-1.5"
              data-testid="page-delete-confirm"
            >
              <Trash2 size={12} /> Delete
            </button>
          )}
          {state.kind === 'error' && (
            <button
              onClick={() => setState({ kind: 'confirm' })}
              className="text-xs px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
