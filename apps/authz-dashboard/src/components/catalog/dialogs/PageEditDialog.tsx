// Catalog page edit dialog.
// Verbatim copy of PagesTab.PageEditDialog (lines 350-450 of original
// apps/authz-dashboard/src/components/PagesTab.tsx). Diff-only PATCH against
// api.pageUpdate; empty diff closes silently.
//
// Phase 2 deletes the original PagesTab.tsx after verifying this copy.

import { useEffect, useState } from 'react';
import { Pencil, Loader2, X, AlertTriangle } from 'lucide-react';
import { api, ModuleTreeNode, PagesAdminRow } from '../../../api';

export function PageEditDialog({
  row,
  modules,
  onClose,
  onSaved,
}: {
  row: PagesAdminRow;
  modules: ModuleTreeNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(row.title);
  const [parentId, setParentId] = useState<string>(row.parent_module_id || '');
  const [description, setDescription] = useState(row.description || '');
  const [displayOrder, setDisplayOrder] = useState<number>(row.display_order ?? 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    setError(null);
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!Number.isInteger(displayOrder)) { setError('Display order must be an integer.'); return; }
    setSubmitting(true);
    try {
      // Diff-only payload — empty body would 400.
      const patch: Parameters<typeof api.pageUpdate>[1] = {};
      if (title.trim() !== row.title) patch.display_name = title.trim();
      if ((parentId || null) !== row.parent_module_id) patch.parent_id = parentId || null;
      if (description !== (row.description || '')) patch.description = description;
      if (displayOrder !== (row.display_order ?? 0)) patch.display_order = displayOrder;
      if (Object.keys(patch).length === 0) { onClose(); return; }
      await api.pageUpdate(row.page_id, patch);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative w-full max-w-md bg-white rounded-lg shadow-xl border border-slate-200" onClick={(e) => e.stopPropagation()} data-testid="page-edit-dialog">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <Pencil size={14} /> Edit page metadata
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="px-4 py-3 space-y-3 text-xs">
          <div className="text-[10px] text-slate-500 font-mono bg-slate-50 rounded p-2">page_id: {row.page_id} (immutable)</div>
          <div>
            <label className="block text-slate-700 font-medium mb-1">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full border border-slate-200 rounded px-2 py-1" data-testid="page-edit-title" />
          </div>
          <div>
            <label className="block text-slate-700 font-medium mb-1">Module</label>
            <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="w-full border border-slate-200 rounded px-2 py-1 bg-white font-mono" data-testid="page-edit-module">
              <option value="">(root)</option>
              {modules.map(m => (
                <option key={m.resource_id} value={m.resource_id}>{m.resource_id} — {m.display_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-700 font-medium mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full border border-slate-200 rounded px-2 py-1" data-testid="page-edit-description" />
          </div>
          <div>
            <label className="block text-slate-700 font-medium mb-1">Display order <span className="text-slate-400 font-normal">(lower first; 0 = default)</span></label>
            <input type="number" step={1} value={displayOrder} onChange={(e) => setDisplayOrder(parseInt(e.target.value || '0', 10))} className="w-32 border border-slate-200 rounded px-2 py-1 font-mono" data-testid="page-edit-order" />
          </div>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded p-2 text-red-700 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-slate-200">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50">Cancel</button>
          <button
            onClick={() => void submit()}
            disabled={submitting}
            className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5"
            data-testid="page-edit-save"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
