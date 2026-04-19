import { useState, useEffect, useMemo } from 'react';
import { api, UIDescriptor } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { autoId, uniqueId } from '../../utils/slugify';
import { Plus, Pencil, Trash2, X, Check, Search, Copy } from 'lucide-react';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';
import { MetadataGrid } from '../shared/MetadataGrid';

export function ActionsSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ action_id: '', display_name: '', description: '', applicable_paths: 'A,B,C' });
  const [editId, setEditId] = useState<string | null>(null);
  const [descriptor, setDescriptor] = useState<UIDescriptor | null>(null);
  const { query, setQuery, filtered } = useSearch(data, ['action_id', 'display_name', 'description']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'action_id');
  const toast = useToast();
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const existingIds = useMemo(() => data.map(d => String(d.action_id)), [data]);
  const suggestedId = uniqueId(autoId.action(form.display_name), existingIds);

  // Fetch UI descriptor once on mount (L1: column/render metadata from DB)
  useEffect(() => {
    api.uiDescriptors('actions_home')
      .then(descs => setDescriptor(descs.find(d => d.section_key === 'grid') || null))
      .catch(err => console.warn('[ActionsSection] Failed to load descriptor:', err));
  }, []);

  const save = async () => {
    try {
      const paths = form.applicable_paths.split(',').map(s => s.trim());
      if (editId) {
        await api.actionUpdate(editId, { display_name: form.display_name, description: form.description, applicable_paths: paths });
        toast.success(`Action "${editId}" updated`);
      } else {
        await api.actionCreate({ action_id: form.action_id, display_name: form.display_name, description: form.description, applicable_paths: paths });
        toast.success(`Action "${form.action_id}" created`);
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const clone = (a: Record<string, unknown>) => {
    setForm({
      action_id: String(a.action_id) + '_copy', display_name: String(a.display_name) + ' (copy)',
      description: String(a.description || ''), applicable_paths: (a.applicable_paths as string[])?.join(',') || 'A,B,C',
    });
    setEditId(null); setShowForm(true);
  };

  const startEdit = (a: Record<string, unknown>) => {
    setForm({
      action_id: String(a.action_id),
      display_name: String(a.display_name),
      description: String(a.description || ''),
      applicable_paths: (a.applicable_paths as string[])?.join(',') || 'A,B,C',
    });
    setEditId(String(a.action_id));
    setShowForm(true);
  };

  const confirmDelete = (a: Record<string, unknown>) => setDangerConfirm({
    title: 'Deactivate Action',
    message: `This will deactivate action "${a.action_id}".`,
    impact: 'Permissions using this action will no longer be evaluable.',
    onConfirm: async () => {
      try {
        await api.actionDelete(String(a.action_id));
        toast.success(`Action "${a.action_id}" deactivated`);
        onReload();
      } catch (e) { toast.error(String(e)); }
    },
  });

  return (
    <div>
      <div className="card-header">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-sm font-semibold">Actions ({filtered.length}/{data.length})</span>
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search..." className="input pl-8 py-1.5 text-xs" />
          </div>
        </div>
        <button onClick={() => { setShowForm(true); setEditId(null); setForm({ action_id: '', display_name: '', description: '', applicable_paths: 'A,B,C' }); }}
          className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>

      {showForm && (
        <div className="card-body border-b bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                Action ID
                {!editId && form.action_id === suggestedId && form.action_id !== '' && (
                  <span className="text-emerald-500 text-[10px] ml-1">(auto)</span>
                )}
              </label>
              <input value={form.action_id} onChange={e => setForm(f => ({ ...f, action_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="new_action" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => {
                const newName = e.target.value;
                setForm(f => {
                  const oldSuggested = uniqueId(autoId.action(f.display_name), existingIds);
                  const updated = { ...f, display_name: newName };
                  if (f.action_id === '' || f.action_id === oldSuggested) {
                    updated.action_id = uniqueId(autoId.action(newName), existingIds);
                  }
                  return updated;
                });
              }} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Applicable Paths</label>
              <input value={form.applicable_paths} onChange={e => setForm(f => ({ ...f, applicable_paths: e.target.value }))} className="input" placeholder="A,B,C" />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={save} className="btn-primary btn-sm"><Check size={12} /> {editId ? 'Update' : 'Create'}</button>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
          </div>
        </div>
      )}

      {/* L1 Metadata-Driven grid — columns + render_hints from authz_ui_descriptor */}
      <div className="table-container max-h-[60vh]">
        {descriptor ? (
          <MetadataGrid
            descriptor={descriptor}
            data={sorted}
            rowKey="action_id"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            rowActions={{
              render: (a) => (
                <div className="flex gap-1">
                  <button onClick={() => startEdit(a)} className="btn-secondary btn-sm p-1" title="Edit">
                    <Pencil size={12} />
                  </button>
                  <button onClick={() => clone(a)} className="btn-secondary btn-sm p-1" title="Clone">
                    <Copy size={12} />
                  </button>
                  <button onClick={() => confirmDelete(a)} className="btn-secondary btn-sm p-1 text-red-500" title="Deactivate">
                    <Trash2 size={12} />
                  </button>
                </div>
              ),
            }}
          />
        ) : (
          <div className="p-4 text-center text-slate-400 text-sm">Loading descriptor...</div>
        )}
      </div>
      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}
