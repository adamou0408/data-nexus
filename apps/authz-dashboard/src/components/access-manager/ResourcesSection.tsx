import { useState, useMemo } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import { Plus, Pencil, Trash2, X, Check, Search, Copy } from 'lucide-react';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';

export function ResourcesSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ resource_id: '', resource_type: 'module', display_name: '', parent_id: '', attributes: '{}' });
  const [editId, setEditId] = useState<string | null>(null);
  const { query, setQuery, filtered } = useSearch(data, ['resource_id', 'display_name', 'resource_type', 'parent_id']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'resource_id');
  const toast = useToast();
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const existingIds = useMemo(() => data.map(d => String(d.resource_id)), [data]);
  const suggestedId = uniqueId(autoId.resource(form.display_name, form.resource_type), existingIds);
  const typeColor: Record<string, string> = {
    module: 'badge-indigo', table: 'badge-green', view: 'badge-green', column: 'badge-amber',
    web_page: 'badge-blue', web_api: 'badge-purple', db_pool: 'badge-red',
  };

  const save = async () => {
    try {
      const attrs = JSON.parse(form.attributes);
      if (editId) {
        await api.resourceUpdate(editId, { display_name: form.display_name, parent_id: form.parent_id || undefined, attributes: attrs });
        toast.success(`Resource "${editId}" updated`);
      } else {
        await api.resourceCreate({ resource_id: form.resource_id, resource_type: form.resource_type, display_name: form.display_name, parent_id: form.parent_id || undefined, attributes: attrs });
        toast.success(`Resource "${form.resource_id}" created`);
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const clone = (r: Record<string, unknown>) => {
    setForm({
      resource_id: String(r.resource_id) + '_copy', resource_type: String(r.resource_type),
      display_name: String(r.display_name) + ' (copy)', parent_id: String(r.parent_id || ''),
      attributes: JSON.stringify(r.attributes || {}, null, 2),
    });
    setEditId(null); setShowForm(true);
  };

  return (
    <div>
      <div className="card-header">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-sm font-semibold">Resources ({filtered.length}/{data.length})</span>
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search..." className="input pl-8 py-1.5 text-xs" />
          </div>
        </div>
        <button onClick={() => { setShowForm(true); setEditId(null); setForm({ resource_id: '', resource_type: 'module', display_name: '', parent_id: '', attributes: '{}' }); }}
          className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>

      {showForm && (
        <div className="card-body border-b bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                Resource ID
                {!editId && form.resource_id === suggestedId && form.resource_id !== '' && (
                  <span className="text-emerald-500 text-[10px] ml-1">(auto)</span>
                )}
              </label>
              <input value={form.resource_id} onChange={e => setForm(f => ({ ...f, resource_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="module:new.module" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Type</label>
              <select value={form.resource_type} onChange={e => {
                const newType = e.target.value;
                setForm(f => {
                  const oldSuggested = uniqueId(autoId.resource(f.display_name, f.resource_type), existingIds);
                  const updated = { ...f, resource_type: newType };
                  if (f.resource_id === '' || f.resource_id === oldSuggested) {
                    updated.resource_id = uniqueId(autoId.resource(f.display_name, newType), existingIds);
                  }
                  return updated;
                });
              }} disabled={!!editId} className="select">
                {['module','table','view','column','web_page','web_api','db_pool','function','page'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => {
                const newName = e.target.value;
                setForm(f => {
                  const oldSuggested = uniqueId(autoId.resource(f.display_name, f.resource_type), existingIds);
                  const updated = { ...f, display_name: newName };
                  if (f.resource_id === '' || f.resource_id === oldSuggested) {
                    updated.resource_id = uniqueId(autoId.resource(newName, f.resource_type), existingIds);
                  }
                  return updated;
                });
              }} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Parent Resource</label>
              <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} className="select text-xs">
                <option value="">(no parent)</option>
                {data.filter(r => String(r.resource_id) !== editId).map(r => (
                  <option key={String(r.resource_id)} value={String(r.resource_id)}>{String(r.resource_id)} — {String(r.display_name)}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-500 mb-1">Attributes (JSON)</label>
              <textarea value={form.attributes} onChange={e => setForm(f => ({ ...f, attributes: e.target.value }))}
                className="input font-mono text-xs" rows={2} />
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
            <SortableHeader label="Resource ID" sortKey="resource_id" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Type" sortKey="resource_type" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Display Name" sortKey="display_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Parent" sortKey="parent_id" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <th>Actions</th>
          </tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={String(r.resource_id)}>
                <td className="font-mono text-xs">{String(r.resource_id)}</td>
                <td>
                  <span className={`badge ${typeColor[String(r.resource_type)] || 'badge-slate'}`}>
                    {String(r.resource_type)}
                  </span>
                </td>
                <td className="text-slate-900 font-medium">{String(r.display_name)}</td>
                <td className="font-mono text-xs text-slate-400">{r.parent_id ? String(r.parent_id) : '-'}</td>
                <td>
                  <div className="flex gap-1">
                    <button onClick={() => {
                      setForm({ resource_id: String(r.resource_id), resource_type: String(r.resource_type), display_name: String(r.display_name), parent_id: String(r.parent_id || ''), attributes: JSON.stringify(r.attributes || {}, null, 2) });
                      setEditId(String(r.resource_id)); setShowForm(true);
                    }} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                    <button onClick={() => clone(r)} className="btn-secondary btn-sm p-1" title="Clone"><Copy size={12} /></button>
                    <button onClick={() => setDangerConfirm({
                      title: 'Deactivate Resource',
                      message: `This will deactivate resource "${r.resource_id}".`,
                      impact: 'Policies referencing this resource will no longer match.',
                      onConfirm: async () => { try { await api.resourceDelete(String(r.resource_id)); toast.success('Resource deactivated'); onReload(); } catch (e) { toast.error(String(e)); } },
                    })} className="btn-secondary btn-sm p-1 text-red-500"><Trash2 size={12} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}
