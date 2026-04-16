import { useState, useEffect, useMemo } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import { Plus, Pencil, Trash2, X, Check, ChevronDown, ChevronRight, Search, Copy } from 'lucide-react';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';

function RoleClearanceEditor({ role, onSaved }: { role: Record<string, unknown>; onSaved: () => void }) {
  const [clearance, setClearance] = useState(String(role.security_clearance || 'PUBLIC'));
  const [jobLevel, setJobLevel] = useState(Number(role.job_level) || 0);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const save = async () => {
    setSaving(true);
    try {
      await api.roleClearanceUpdate(String(role.role_id), { security_clearance: clearance, job_level: jobLevel });
      toast.success(`Clearance updated for "${role.role_id}"`);
      onSaved();
    } catch (e) { toast.error(String(e)); }
    setSaving(false);
  };

  const changed = clearance !== String(role.security_clearance || 'PUBLIC') || jobLevel !== (Number(role.job_level) || 0);

  return (
    <div className="mt-4 pt-3 border-t border-slate-200">
      <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Security Clearance</h4>
      <div className="flex gap-3 items-end">
        <div>
          <label className="block text-[10px] text-slate-400 mb-1">Clearance Level</label>
          <select value={clearance} onChange={e => setClearance(e.target.value)} className="select text-xs w-40">
            {['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-slate-400 mb-1">Job Level</label>
          <input type="number" min={0} max={15} value={jobLevel} onChange={e => setJobLevel(Number(e.target.value))}
            className="input text-xs w-20" />
        </div>
        {changed && (
          <button onClick={save} disabled={saving} className="btn-primary btn-sm">
            <Check size={12} /> {saving ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>
    </div>
  );
}

export function RolesSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ role_id: '', display_name: '', description: '', is_system: false });
  const [editId, setEditId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Record<string, unknown>[]>([]);
  const [permForm, setPermForm] = useState({ action_id: '', resource_id: '', effect: 'allow' });
  const [availableActions, setAvailableActions] = useState<Record<string, unknown>[]>([]);
  const [availableResources, setAvailableResources] = useState<Record<string, unknown>[]>([]);
  const [resourceFilter, setResourceFilter] = useState('');
  const { query, setQuery, filtered } = useSearch(data, ['role_id', 'display_name', 'description']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'role_id');
  const toast = useToast();
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const existingIds = useMemo(() => data.map(d => String(d.role_id)), [data]);
  const suggestedId = uniqueId(autoId.role(form.display_name), existingIds);

  useEffect(() => {
    api.actions().then(setAvailableActions).catch(() => {});
    api.resources().then(setAvailableResources).catch(() => {});
  }, []);

  const filteredResources = useMemo(() => {
    if (!resourceFilter) return availableResources;
    const q = resourceFilter.toLowerCase();
    return availableResources.filter(r => String(r.resource_id).toLowerCase().includes(q) || String(r.display_name).toLowerCase().includes(q));
  }, [availableResources, resourceFilter]);

  const save = async () => {
    try {
      if (editId) {
        await api.roleUpdate(editId, { display_name: form.display_name, description: form.description });
        toast.success(`Role "${editId}" updated`);
      } else {
        await api.roleCreate({ role_id: form.role_id, display_name: form.display_name, description: form.description, is_system: form.is_system });
        toast.success(`Role "${form.role_id}" created`);
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const clone = async (r: Record<string, unknown>) => {
    const sourceId = String(r.role_id);
    const newId = sourceId + '_COPY';
    try {
      await api.roleCreate({ role_id: newId, display_name: String(r.display_name) + ' (copy)', description: String(r.description || '') });
      // Copy permissions from source role
      const perms = await api.rolePermissions(sourceId);
      let copied = 0;
      for (const p of perms) {
        try {
          await api.roleAddPermission(newId, { action_id: String(p.action_id), resource_id: String(p.resource_id), effect: String(p.effect || 'allow') });
          copied++;
        } catch { /* skip duplicates */ }
      }
      toast.success(`Role cloned as "${newId}" with ${copied} permissions`);
      onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const expand = async (roleId: string) => {
    if (expandedId === roleId) { setExpandedId(null); return; }
    setExpandedId(roleId);
    const perms = await api.rolePermissions(roleId);
    setPermissions(perms);
  };

  const addPerm = async (roleId: string) => {
    if (!permForm.action_id || !permForm.resource_id) return;
    try {
      await api.roleAddPermission(roleId, permForm);
      toast.success(`Permission added to "${roleId}"`);
      setPermForm({ action_id: '', resource_id: '', effect: 'allow' });
      const perms = await api.rolePermissions(roleId);
      setPermissions(perms);
      onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const removePerm = async (roleId: string, permId: number) => {
    try {
      await api.roleRemovePermission(roleId, permId);
      toast.success('Permission removed');
      const perms = await api.rolePermissions(roleId);
      setPermissions(perms);
      onReload();
    } catch (e) { toast.error(String(e)); }
  };

  return (
    <div>
      <div className="card-header">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-sm font-semibold">Roles ({filtered.length}/{data.length})</span>
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search..." className="input pl-8 py-1.5 text-xs" />
          </div>
        </div>
        <button onClick={() => { setShowForm(true); setEditId(null); setForm({ role_id: '', display_name: '', description: '', is_system: false }); }}
          className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>

      {showForm && (
        <div className="card-body border-b bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                Role ID
                {!editId && form.role_id === suggestedId && form.role_id !== '' && (
                  <span className="text-emerald-500 text-[10px] ml-1">(auto)</span>
                )}
              </label>
              <input value={form.role_id} onChange={e => setForm(f => ({ ...f, role_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="NEW_ROLE" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => {
                const newName = e.target.value;
                setForm(f => {
                  const oldSuggested = uniqueId(autoId.role(f.display_name), existingIds);
                  const updated = { ...f, display_name: newName };
                  if (f.role_id === '' || f.role_id === oldSuggested) {
                    updated.role_id = uniqueId(autoId.role(newName), existingIds);
                  }
                  return updated;
                });
              }} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input" />
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
            <SortableHeader label="Role ID" sortKey="role_id" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Display Name" sortKey="display_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="System" sortKey="is_system" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Assignments" sortKey="assignment_count" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Permissions" sortKey="permission_count" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <th>Actions</th>
          </tr></thead>
          <tbody>
            {sorted.map((r) => {
              const rid = String(r.role_id);
              const expanded = expandedId === rid;
              return (<>
                <tr key={rid}>
                  <td className="w-8">
                    <button onClick={() => expand(rid)} className="text-slate-400 hover:text-slate-700">
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="font-mono text-xs font-bold text-slate-900">{rid}</td>
                  <td>{String(r.display_name)}</td>
                  <td>{r.is_system ? <span className="badge badge-amber">SYSTEM</span> : <span className="text-slate-300">-</span>}</td>
                  <td className="text-center font-medium">{String(r.assignment_count)}</td>
                  <td className="text-center font-medium">{String(r.permission_count)}</td>
                  <td>
                    <div className="flex gap-1">
                      <button onClick={() => { setForm({ role_id: rid, display_name: String(r.display_name), description: String(r.description || ''), is_system: !!r.is_system }); setEditId(rid); setShowForm(true); }}
                        className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                      <button onClick={() => clone(r)} className="btn-secondary btn-sm p-1" title="Clone with permissions"><Copy size={12} /></button>
                      <button onClick={() => setDangerConfirm({
                        title: 'Deactivate Role',
                        message: `This will deactivate role "${rid}".`,
                        impact: 'All users assigned this role will lose its permissions.',
                        onConfirm: async () => { try { await api.roleDelete(rid); toast.success(`Role "${rid}" deactivated`); onReload(); } catch (e) { toast.error(String(e)); } },
                      })} className="btn-secondary btn-sm p-1 text-red-500"><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
                {expanded && (
                  <tr key={`${rid}-perms`}>
                    <td colSpan={7} className="bg-slate-50 p-4">
                      <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Permissions for {rid}</h4>
                      <div className="flex gap-2 items-end mb-3 flex-wrap">
                        <select value={permForm.action_id} onChange={e => setPermForm(f => ({ ...f, action_id: e.target.value }))}
                          className="select text-xs w-32">
                          <option value="">Action...</option>
                          {availableActions.map(a => (
                            <option key={String(a.action_id)} value={String(a.action_id)}>{String(a.action_id)}</option>
                          ))}
                        </select>
                        <div className="flex-1 min-w-[200px]">
                          <input value={resourceFilter} onChange={e => { setResourceFilter(e.target.value); }} placeholder="Filter resources..." className="input text-xs mb-1" />
                          <select value={permForm.resource_id} onChange={e => setPermForm(f => ({ ...f, resource_id: e.target.value }))}
                            className="select text-xs w-full" size={Math.min(filteredResources.length + 1, 6)}>
                            <option value="">Resource...</option>
                            {filteredResources.map(r => (
                              <option key={String(r.resource_id)} value={String(r.resource_id)}>{String(r.resource_id)} — {String(r.display_name)}</option>
                            ))}
                          </select>
                        </div>
                        <select value={permForm.effect} onChange={e => setPermForm(f => ({ ...f, effect: e.target.value }))} className="select text-xs w-24">
                          <option value="allow">allow</option>
                          <option value="deny">deny</option>
                        </select>
                        <button onClick={() => addPerm(rid)} className="btn-primary btn-sm"><Plus size={12} /></button>
                      </div>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {permissions.map((p) => (
                          <div key={String(p.id)} className="flex items-center gap-2 text-xs bg-white rounded-lg border px-3 py-1.5">
                            <span className={`badge text-[10px] ${p.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{String(p.effect)}</span>
                            <span className="badge badge-slate text-[10px]">{String(p.action_id)}</span>
                            <span className="font-mono text-slate-600 flex-1">{String(p.resource_id)}</span>
                            <span className="text-slate-400">{String(p.resource_name || '')}</span>
                            <button onClick={() => removePerm(rid, Number(p.id))} className="text-red-400 hover:text-red-600"><X size={12} /></button>
                          </div>
                        ))}
                        {permissions.length === 0 && <p className="text-xs text-slate-400">No permissions assigned</p>}
                      </div>

                      <RoleClearanceEditor role={r} onSaved={onReload} />
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
