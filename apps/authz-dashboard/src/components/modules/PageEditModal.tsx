// PageEditModal — TIER-B-PAGE-RENAME-V01
//
// Tier B page admin: rename the page (display_name) and/or move it to a
// different module in the catalog tree. The page_id stays put — external refs
// (URLs, drilldowns, embeds) all key off it, so we deliberately don't expose
// it as an editable field. Curators wanting a new ID should delete + recreate.
//
// Mirrors ModuleFormModal's shape so the two admin flows feel consistent.

import { useState } from 'react';
import { api, ModuleTreeNode } from '../../api';
import { useToast } from '../Toast';
import { X, Info } from 'lucide-react';

export interface PageEditTarget {
  page_id: string;
  display_name: string;
  current_parent_id: string;
}

export function PageEditModal({
  page,
  modules,
  onClose,
  onSaved,
}: {
  page: PageEditTarget;
  modules: ModuleTreeNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(page.display_name);
  const [parentId, setParentId] = useState(page.current_parent_id);
  const [saving, setSaving] = useState(false);

  const dirty =
    displayName.trim() !== page.display_name.trim() ||
    parentId !== page.current_parent_id;

  const handleSubmit = async () => {
    if (!displayName.trim()) {
      toast.error('Display name cannot be empty');
      return;
    }
    if (!dirty) return;
    setSaving(true);
    try {
      // Send only the fields that changed — backend treats parent_id===undefined
      // as "leave alone", null as "move to root", string as "move to module".
      const patch: { display_name?: string; parent_id?: string | null } = {};
      if (displayName.trim() !== page.display_name.trim()) patch.display_name = displayName.trim();
      if (parentId !== page.current_parent_id) patch.parent_id = parentId || null;
      await api.pageUpdate(page.page_id, patch);
      toast.success('Page updated');
      onSaved();
    } catch (err: any) {
      toast.error(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h3 className="font-bold text-slate-900">Edit Page</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-slate-600">Display Name *</label>
            <input
              className="input mt-1"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600">Parent Module</label>
            <select
              className="input mt-1"
              value={parentId}
              onChange={e => setParentId(e.target.value)}
            >
              <option value="">None (root)</option>
              {modules.map(m => (
                <option key={m.resource_id} value={m.resource_id}>
                  {m.display_name} ({m.resource_id})
                </option>
              ))}
            </select>
          </div>

          <div className="bg-slate-50 rounded-lg p-3 text-xs">
            <div className="flex items-start gap-1.5">
              <Info size={12} className="text-blue-400 shrink-0 mt-0.5" />
              <div className="text-slate-500">
                <span className="font-mono text-slate-700">page_id</span> stays{' '}
                <span className="font-mono text-slate-700">{page.page_id}</span> — external links
                and drilldowns pointing at this page won't break. Delete and recreate if you
                need a new ID.
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-2 justify-end p-4 border-t border-slate-200">
          <button onClick={onClose} className="btn btn-sm bg-white text-slate-600 border border-slate-300 hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !displayName.trim() || !dirty}
            className="btn btn-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
