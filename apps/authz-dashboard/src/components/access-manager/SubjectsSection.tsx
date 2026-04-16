import { useState, useEffect, useMemo } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import { Plus, Pencil, Trash2, X, Check, ChevronDown, ChevronRight, Search, Copy } from 'lucide-react';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';

export function SubjectsSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ subject_id: '', subject_type: 'user', display_name: '', ldap_dn: '', attributes: '{}' });
  const [editId, setEditId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [roleForm, setRoleForm] = useState({ role_id: '', valid_until: '' });
  const [groupForm, setGroupForm] = useState('');
  const [availableRoles, setAvailableRoles] = useState<Record<string, unknown>[]>([]);
  const [availableGroups, setAvailableGroups] = useState<Record<string, unknown>[]>([]);
  const { query, setQuery, filtered } = useSearch(data, ['subject_id', 'display_name', 'subject_type']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'display_name');
  const toast = useToast();
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const existingIds = useMemo(() => data.map(d => String(d.subject_id)), [data]);
  const suggestedId = uniqueId(autoId.subject(form.display_name, form.subject_type), existingIds);

  useEffect(() => {
    api.roles().then(setAvailableRoles).catch(() => {});
    api.subjects().then(all => setAvailableGroups(all.filter(s => s.subject_type === 'ldap_group'))).catch(() => {});
  }, []);

  const save = async () => {
    try {
      const attrs = JSON.parse(form.attributes);
      if (editId) {
        await api.subjectUpdate(editId, { display_name: form.display_name, ldap_dn: form.ldap_dn || undefined, attributes: attrs });
        toast.success(`Subject "${editId}" updated`);
      } else {
        await api.subjectCreate({ subject_id: form.subject_id, subject_type: form.subject_type, display_name: form.display_name, ldap_dn: form.ldap_dn || undefined, attributes: attrs });
        toast.success(`Subject "${form.subject_id}" created`);
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const startEdit = (s: Record<string, unknown>) => {
    setForm({
      subject_id: String(s.subject_id), subject_type: String(s.subject_type),
      display_name: String(s.display_name), ldap_dn: String(s.ldap_dn || ''),
      attributes: JSON.stringify(s.attributes || {}, null, 2),
    });
    setEditId(String(s.subject_id)); setShowForm(true);
  };

  const clone = (s: Record<string, unknown>) => {
    setForm({
      subject_id: String(s.subject_id) + '_copy', subject_type: String(s.subject_type),
      display_name: String(s.display_name) + ' (copy)', ldap_dn: String(s.ldap_dn || ''),
      attributes: JSON.stringify(s.attributes || {}, null, 2),
    });
    setEditId(null); setShowForm(true);
  };

  const remove = (id: string) => {
    setDangerConfirm({
      title: 'Deactivate Subject',
      message: `This will deactivate subject "${id}".`,
      impact: 'The subject will lose all role assignments and resource access.',
      onConfirm: async () => {
        try {
          await api.subjectDelete(id);
          toast.success(`Subject "${id}" deactivated`);
          onReload();
        } catch (e) { toast.error(String(e)); }
      },
    });
  };

  const addRole = async (subjectId: string) => {
    if (!roleForm.role_id) return;
    try {
      await api.subjectAddRole(subjectId, { role_id: roleForm.role_id, valid_until: roleForm.valid_until || undefined });
      toast.success(`Role "${roleForm.role_id}" assigned to ${subjectId}`);
      setRoleForm({ role_id: '', valid_until: '' }); onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const removeRole = async (subjectId: string, roleId: string) => {
    try {
      await api.subjectRemoveRole(subjectId, roleId);
      toast.success(`Role "${roleId}" removed from ${subjectId}`);
      onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const addGroup = async (subjectId: string) => {
    if (!groupForm) return;
    try {
      await api.subjectAddGroup(subjectId, groupForm);
      toast.success(`Group assigned to ${subjectId}`);
      setGroupForm(''); onReload();
    } catch (e) { toast.error(String(e)); }
  };

  return (
    <div>
      <div className="card-header">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-sm font-semibold">Subjects ({filtered.length}/{data.length})</span>
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search..." className="input pl-8 py-1.5 text-xs" />
          </div>
        </div>
        <button onClick={() => { setShowForm(true); setEditId(null); setForm({ subject_id: '', subject_type: 'user', display_name: '', ldap_dn: '', attributes: '{}' }); }}
          className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>

      {showForm && (
        <div className="card-body border-b bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                Subject ID
                {!editId && form.subject_id === suggestedId && form.subject_id !== '' && (
                  <span className="text-emerald-500 text-[10px] ml-1">(auto)</span>
                )}
              </label>
              <input value={form.subject_id} onChange={e => setForm(f => ({ ...f, subject_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="user:new_user" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Type</label>
              <select value={form.subject_type} onChange={e => {
                const newType = e.target.value;
                setForm(f => {
                  const oldSuggested = uniqueId(autoId.subject(f.display_name, f.subject_type), existingIds);
                  const updated = { ...f, subject_type: newType };
                  if (f.subject_id === '' || f.subject_id === oldSuggested) {
                    updated.subject_id = uniqueId(autoId.subject(f.display_name, newType), existingIds);
                  }
                  return updated;
                });
              }} disabled={!!editId} className="select">
                <option value="user">user</option>
                <option value="ldap_group">ldap_group</option>
                <option value="service_account">service_account</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => {
                const newName = e.target.value;
                setForm(f => {
                  const oldSuggested = uniqueId(autoId.subject(f.display_name, f.subject_type), existingIds);
                  const updated = { ...f, display_name: newName };
                  if (f.subject_id === '' || f.subject_id === oldSuggested) {
                    updated.subject_id = uniqueId(autoId.subject(newName, f.subject_type), existingIds);
                  }
                  return updated;
                });
              }} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">LDAP DN</label>
              <input value={form.ldap_dn} onChange={e => setForm(f => ({ ...f, ldap_dn: e.target.value }))} className="input font-mono text-xs" />
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
            <th></th>
            <SortableHeader label="Subject ID" sortKey="subject_id" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Type" sortKey="subject_type" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Display Name" sortKey="display_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <th>Roles</th>
            <th>Attributes</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>
            {sorted.map((s) => {
              const sid = String(s.subject_id);
              const expanded = expandedId === sid;
              return (<>
                <tr key={sid}>
                  <td className="w-8">
                    <button onClick={() => setExpandedId(expanded ? null : sid)} className="text-slate-400 hover:text-slate-700">
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="font-mono text-xs">{sid}</td>
                  <td>
                    <span className={`badge ${s.subject_type === 'user' ? 'badge-blue' : s.subject_type === 'service_account' ? 'badge-amber' : 'badge-purple'}`}>
                      {String(s.subject_type)}
                    </span>
                  </td>
                  <td className="text-slate-900 font-medium">{String(s.display_name)}</td>
                  <td>
                    <div className="flex gap-1 flex-wrap">
                      {(s.roles as string[] || []).map((r: string) => (
                        <span key={r} className="badge badge-slate text-[10px]">{r}</span>
                      ))}
                    </div>
                  </td>
                  <td className="font-mono text-xs text-slate-400 max-w-[200px] truncate">{JSON.stringify(s.attributes)}</td>
                  <td>
                    <div className="flex gap-1">
                      <button onClick={() => startEdit(s)} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                      <button onClick={() => clone(s)} className="btn-secondary btn-sm p-1" title="Clone"><Copy size={12} /></button>
                      <button onClick={() => remove(sid)} className="btn-secondary btn-sm p-1 text-red-500 hover:text-red-700" title="Deactivate"><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
                {expanded && (
                  <tr key={`${sid}-detail`}>
                    <td colSpan={7} className="bg-slate-50 p-4">
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div>
                          <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Assign Role</h4>
                          <div className="flex gap-2 items-end">
                            <select value={roleForm.role_id} onChange={e => setRoleForm(f => ({ ...f, role_id: e.target.value }))}
                              className="select text-xs flex-1">
                              <option value="">Select role...</option>
                              {availableRoles.map(r => (
                                <option key={String(r.role_id)} value={String(r.role_id)}>{String(r.role_id)} — {String(r.display_name)}</option>
                              ))}
                            </select>
                            <input type="date" value={roleForm.valid_until} onChange={e => setRoleForm(f => ({ ...f, valid_until: e.target.value }))}
                              className="input text-xs w-36" title="Valid Until (optional)" />
                            <button onClick={() => addRole(sid)} className="btn-primary btn-sm"><Plus size={12} /></button>
                          </div>
                          <div className="flex gap-1 flex-wrap mt-2">
                            {(s.roles as string[] || []).map((r: string) => (
                              <span key={r} className="badge badge-blue text-[10px] cursor-pointer hover:bg-red-100 group" onClick={() => removeRole(sid, r)}>
                                {r} <X size={10} className="opacity-0 group-hover:opacity-100 text-red-500" />
                              </span>
                            ))}
                          </div>
                        </div>
                        {s.subject_type === 'user' && (
                          <div>
                            <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Assign Group</h4>
                            <div className="flex gap-2 items-end">
                              <select value={groupForm} onChange={e => setGroupForm(e.target.value)}
                                className="select text-xs flex-1">
                                <option value="">Select group...</option>
                                {availableGroups.map(g => (
                                  <option key={String(g.subject_id)} value={String(g.subject_id)}>{String(g.subject_id)} — {String(g.display_name)}</option>
                                ))}
                              </select>
                              <button onClick={() => addGroup(sid)} className="btn-primary btn-sm"><Plus size={12} /></button>
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>);
            })}
          </tbody>
        </table>
      </div>
      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}
