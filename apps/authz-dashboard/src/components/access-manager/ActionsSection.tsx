import { useState, useMemo } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import { Plus, Pencil, Trash2, X, Check, Search, Copy } from 'lucide-react';

export function ActionsSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ action_id: '', display_name: '', description: '', applicable_paths: 'A,B,C' });
  const [editId, setEditId] = useState<string | null>(null);
  const { query, setQuery, filtered } = useSearch(data, ['action_id', 'display_name', 'description']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'action_id');
  const toast = useToast();
  const existingIds = useMemo(() => data.map(d => String(d.action_id)), [data]);
  const suggestedId = uniqueId(autoId.action(form.display_name), existingIds);
  const pathColor: Record<string, string> = { A: 'badge-blue', B: 'badge-green', C: 'badge-purple' };

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

      <div className="table-container max-h-[60vh]">
        <table className="table">
          <thead><tr>
            <SortableHeader label="Action ID" sortKey="action_id" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Display Name" sortKey="display_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <th>Description</th>
            <th>Paths</th>
            <SortableHeader label="Active" sortKey="is_active" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <th>Actions</th>
          </tr></thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={String(a.action_id)}>
                <td className="font-mono text-xs font-bold text-slate-900">{String(a.action_id)}</td>
                <td className="font-medium">{String(a.display_name)}</td>
                <td className="text-xs text-slate-500">{a.description ? String(a.description) : '-'}</td>
                <td>
                  <div className="flex gap-1">
                    {(a.applicable_paths as string[] || []).map((p: string) => (
                      <span key={p} className={`badge text-[10px] ${pathColor[p] || 'badge-slate'}`}>Path {p}</span>
                    ))}
                  </div>
                </td>
                <td>{a.is_active ? <span className="badge badge-green text-[10px]">YES</span> : <span className="badge badge-red text-[10px]">NO</span>}</td>
                <td>
                  <div className="flex gap-1">
                    <button onClick={() => {
                      setForm({ action_id: String(a.action_id), display_name: String(a.display_name), description: String(a.description || ''), applicable_paths: (a.applicable_paths as string[])?.join(',') || 'A,B,C' });
                      setEditId(String(a.action_id)); setShowForm(true);
                    }} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                    <button onClick={() => clone(a)} className="btn-secondary btn-sm p-1" title="Clone"><Copy size={12} /></button>
                    <button onClick={async () => { if (confirm(`Deactivate action ${a.action_id}?`)) { try { await api.actionDelete(String(a.action_id)); toast.success(`Action "${a.action_id}" deactivated`); onReload(); } catch (e) { toast.error(String(e)); } }}}
                      className="btn-secondary btn-sm p-1 text-red-500"><Trash2 size={12} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
