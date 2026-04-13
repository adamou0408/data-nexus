import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api';
import { Users, Shield, Database, FileText, Zap, Plus, Pencil, Trash2, X, Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { ReactNode } from 'react';

// Shared search filter hook — client-side, SSOT from API data
function useSearch(data: Record<string, unknown>[], keys: string[]) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    if (!query.trim()) return data;
    const q = query.toLowerCase();
    return data.filter(row => keys.some(k => String(row[k] ?? '').toLowerCase().includes(q)));
  }, [data, query, keys]);
  return { query, setQuery, filtered };
}

type Section = 'subjects' | 'roles' | 'resources' | 'policies' | 'actions';

const sections: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'subjects',  label: 'Subjects',  icon: <Users size={14} /> },
  { id: 'roles',     label: 'Roles',     icon: <Shield size={14} /> },
  { id: 'resources', label: 'Resources', icon: <Database size={14} /> },
  { id: 'policies',  label: 'Policies',  icon: <FileText size={14} /> },
  { id: 'actions',   label: 'Actions',   icon: <Zap size={14} /> },
];

export function BrowserTab() {
  const [section, setSection] = useState<Section>('subjects');
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    const fetchers = { subjects: api.subjects, roles: api.roles, resources: api.resources, policies: api.policies, actions: api.actions };
    setLoading(true);
    fetchers[section]().then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [section]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Entity Browser</h1>
        <p className="page-desc">Manage AuthZ entities — subjects, roles, resources, policies, and actions</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`btn btn-sm gap-1.5 ${
              section === s.id
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
            }`}>
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <div className="card-body text-center py-12 text-slate-400">Loading...</div>
        ) : (
          <>
            {section === 'subjects' && <SubjectsSection data={data} onReload={reload} />}
            {section === 'roles' && <RolesSection data={data} onReload={reload} />}
            {section === 'resources' && <ResourcesSection data={data} onReload={reload} />}
            {section === 'policies' && <PoliciesSection data={data} onReload={reload} />}
            {section === 'actions' && <ActionsSection data={data} onReload={reload} />}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Subjects Section
// ============================================================
function SubjectsSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ subject_id: '', subject_type: 'user', display_name: '', ldap_dn: '', attributes: '{}' });
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [roleForm, setRoleForm] = useState({ role_id: '', valid_until: '' });
  const [groupForm, setGroupForm] = useState('');
  // SSOT: load available roles and groups from DB
  const [availableRoles, setAvailableRoles] = useState<Record<string, unknown>[]>([]);
  const [availableGroups, setAvailableGroups] = useState<Record<string, unknown>[]>([]);
  const { query, setQuery, filtered } = useSearch(data, ['subject_id', 'display_name', 'subject_type']);

  useEffect(() => {
    api.roles().then(setAvailableRoles).catch(() => {});
    api.subjects().then(all => setAvailableGroups(all.filter(s => s.subject_type === 'ldap_group'))).catch(() => {});
  }, []);

  const save = async () => {
    setError('');
    try {
      const attrs = JSON.parse(form.attributes);
      if (editId) {
        await api.subjectUpdate(editId, { display_name: form.display_name, ldap_dn: form.ldap_dn || undefined, attributes: attrs });
      } else {
        await api.subjectCreate({ subject_id: form.subject_id, subject_type: form.subject_type, display_name: form.display_name, ldap_dn: form.ldap_dn || undefined, attributes: attrs });
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { setError(String(e)); }
  };

  const startEdit = (s: Record<string, unknown>) => {
    setForm({
      subject_id: String(s.subject_id), subject_type: String(s.subject_type),
      display_name: String(s.display_name), ldap_dn: String(s.ldap_dn || ''),
      attributes: JSON.stringify(s.attributes || {}, null, 2),
    });
    setEditId(String(s.subject_id)); setShowForm(true);
  };

  const remove = async (id: string) => {
    if (!confirm(`Deactivate subject ${id}?`)) return;
    await api.subjectDelete(id); onReload();
  };

  const addRole = async (subjectId: string) => {
    if (!roleForm.role_id) return;
    await api.subjectAddRole(subjectId, { role_id: roleForm.role_id, valid_until: roleForm.valid_until || undefined });
    setRoleForm({ role_id: '', valid_until: '' }); onReload();
  };

  const removeRole = async (subjectId: string, roleId: string) => {
    await api.subjectRemoveRole(subjectId, roleId); onReload();
  };

  const addGroup = async (subjectId: string) => {
    if (!groupForm) return;
    await api.subjectAddGroup(subjectId, groupForm);
    setGroupForm(''); onReload();
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
              <label className="block text-xs font-semibold text-slate-500 mb-1">Subject ID</label>
              <input value={form.subject_id} onChange={e => setForm(f => ({ ...f, subject_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="user:new_user" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Type</label>
              <select value={form.subject_type} onChange={e => setForm(f => ({ ...f, subject_type: e.target.value }))}
                disabled={!!editId} className="select">
                <option value="user">user</option>
                <option value="ldap_group">ldap_group</option>
                <option value="service_account">service_account</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} className="input" />
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
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={save} className="btn-primary btn-sm"><Check size={12} /> {editId ? 'Update' : 'Create'}</button>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
          </div>
        </div>
      )}

      <div className="table-container max-h-[60vh]">
        <table className="table">
          <thead><tr><th></th><th>Subject ID</th><th>Type</th><th>Display Name</th><th>Roles</th><th>Attributes</th><th>Actions</th></tr></thead>
          <tbody>
            {filtered.map((s) => {
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
                      <button onClick={() => remove(sid)} className="btn-secondary btn-sm p-1 text-red-500 hover:text-red-700" title="Deactivate"><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
                {expanded && (
                  <tr key={`${sid}-detail`}>
                    <td colSpan={7} className="bg-slate-50 p-4">
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {/* Role management */}
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
                        {/* Group management (for users only) */}
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
    </div>
  );
}

// ============================================================
// Roles Section
// ============================================================
function RolesSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ role_id: '', display_name: '', description: '', is_system: false });
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Record<string, unknown>[]>([]);
  const [permForm, setPermForm] = useState({ action_id: '', resource_id: '', effect: 'allow' });
  // SSOT: load available actions and resources from DB
  const [availableActions, setAvailableActions] = useState<Record<string, unknown>[]>([]);
  const [availableResources, setAvailableResources] = useState<Record<string, unknown>[]>([]);
  const [resourceFilter, setResourceFilter] = useState('');
  const { query, setQuery, filtered } = useSearch(data, ['role_id', 'display_name', 'description']);

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
    setError('');
    try {
      if (editId) {
        await api.roleUpdate(editId, { display_name: form.display_name, description: form.description });
      } else {
        await api.roleCreate({ role_id: form.role_id, display_name: form.display_name, description: form.description, is_system: form.is_system });
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { setError(String(e)); }
  };

  const expand = async (roleId: string) => {
    if (expandedId === roleId) { setExpandedId(null); return; }
    setExpandedId(roleId);
    const perms = await api.rolePermissions(roleId);
    setPermissions(perms);
  };

  const addPerm = async (roleId: string) => {
    if (!permForm.action_id || !permForm.resource_id) return;
    await api.roleAddPermission(roleId, permForm);
    setPermForm({ action_id: '', resource_id: '', effect: 'allow' });
    const perms = await api.rolePermissions(roleId);
    setPermissions(perms);
    onReload();
  };

  const removePerm = async (roleId: string, permId: number) => {
    await api.roleRemovePermission(roleId, permId);
    const perms = await api.rolePermissions(roleId);
    setPermissions(perms);
    onReload();
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
              <label className="block text-xs font-semibold text-slate-500 mb-1">Role ID</label>
              <input value={form.role_id} onChange={e => setForm(f => ({ ...f, role_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="NEW_ROLE" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input" />
            </div>
          </div>
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={save} className="btn-primary btn-sm"><Check size={12} /> {editId ? 'Update' : 'Create'}</button>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
          </div>
        </div>
      )}

      <div className="table-container max-h-[60vh]">
        <table className="table">
          <thead><tr><th></th><th>Role ID</th><th>Display Name</th><th>System</th><th>Assignments</th><th>Permissions</th><th>Actions</th></tr></thead>
          <tbody>
            {filtered.map((r) => {
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
                        className="btn-secondary btn-sm p-1"><Pencil size={12} /></button>
                      <button onClick={async () => { if (confirm(`Deactivate role ${rid}?`)) { await api.roleDelete(rid); onReload(); }}}
                        className="btn-secondary btn-sm p-1 text-red-500"><Trash2 size={12} /></button>
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
                    </td>
                  </tr>
                )}
              </>);
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// Resources Section
// ============================================================
function ResourcesSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ resource_id: '', resource_type: 'module', display_name: '', parent_id: '', attributes: '{}' });
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { query, setQuery, filtered } = useSearch(data, ['resource_id', 'display_name', 'resource_type', 'parent_id']);
  const typeColor: Record<string, string> = {
    module: 'badge-indigo', table: 'badge-green', column: 'badge-amber',
    web_page: 'badge-blue', web_api: 'badge-purple', db_pool: 'badge-red',
  };

  const save = async () => {
    setError('');
    try {
      const attrs = JSON.parse(form.attributes);
      if (editId) {
        await api.resourceUpdate(editId, { display_name: form.display_name, parent_id: form.parent_id || undefined, attributes: attrs });
      } else {
        await api.resourceCreate({ resource_id: form.resource_id, resource_type: form.resource_type, display_name: form.display_name, parent_id: form.parent_id || undefined, attributes: attrs });
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { setError(String(e)); }
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
              <label className="block text-xs font-semibold text-slate-500 mb-1">Resource ID</label>
              <input value={form.resource_id} onChange={e => setForm(f => ({ ...f, resource_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="module:new.module" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Type</label>
              <select value={form.resource_type} onChange={e => setForm(f => ({ ...f, resource_type: e.target.value }))}
                disabled={!!editId} className="select">
                {['module','table','column','web_page','web_api','db_pool','function','page'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} className="input" />
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
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={save} className="btn-primary btn-sm"><Check size={12} /> {editId ? 'Update' : 'Create'}</button>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
          </div>
        </div>
      )}

      <div className="table-container max-h-[60vh]">
        <table className="table">
          <thead><tr><th>Resource ID</th><th>Type</th><th>Display Name</th><th>Parent</th><th>Actions</th></tr></thead>
          <tbody>
            {filtered.map((r) => (
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
                    }} className="btn-secondary btn-sm p-1"><Pencil size={12} /></button>
                    <button onClick={async () => { if (confirm(`Deactivate resource ${r.resource_id}?`)) { await api.resourceDelete(String(r.resource_id)); onReload(); }}}
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

// ============================================================
// Policies Section
// ============================================================
function PoliciesSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    policy_name: '', description: '', granularity: 'L1', priority: '100', effect: 'allow',
    applicable_paths: 'A,B,C', rls_expression: '',
    subject_condition: '{}', resource_condition: '{}',
  });
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const { query, setQuery, filtered } = useSearch(data, ['policy_name', 'description', 'granularity', 'effect', 'status']);

  const save = async () => {
    setError('');
    try {
      const payload = {
        policy_name: form.policy_name, description: form.description,
        granularity: form.granularity, priority: Number(form.priority), effect: form.effect,
        applicable_paths: form.applicable_paths.split(',').map(s => s.trim()),
        rls_expression: form.rls_expression || null,
        subject_condition: JSON.parse(form.subject_condition),
        resource_condition: JSON.parse(form.resource_condition),
        created_by: 'admin_ui',
      };
      if (editId) {
        await api.policyUpdate(editId, payload);
      } else {
        await api.policyCreate(payload);
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { setError(String(e)); }
  };

  return (
    <div>
      <div className="card-header">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-sm font-semibold">Policies ({filtered.length}/{data.length})</span>
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search..." className="input pl-8 py-1.5 text-xs" />
          </div>
        </div>
        <button onClick={() => { setShowForm(true); setEditId(null);
          setForm({ policy_name: '', description: '', granularity: 'L1', priority: '100', effect: 'allow', applicable_paths: 'A,B,C', rls_expression: '', subject_condition: '{}', resource_condition: '{}' }); }}
          className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>

      {showForm && (
        <div className="card-body border-b bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Policy Name</label>
              <input value={form.policy_name} onChange={e => setForm(f => ({ ...f, policy_name: e.target.value }))}
                disabled={!!editId} className="input font-mono" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Granularity</label>
              <select value={form.granularity} onChange={e => setForm(f => ({ ...f, granularity: e.target.value }))} className="select">
                <option value="L1">L1 (Data Scope)</option>
                <option value="L2">L2 (Column Mask)</option>
                <option value="L3">L3 (Composite)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Effect</label>
              <select value={form.effect} onChange={e => setForm(f => ({ ...f, effect: e.target.value }))} className="select">
                <option value="allow">allow</option><option value="deny">deny</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Priority</label>
              <input type="number" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Applicable Paths</label>
              <input value={form.applicable_paths} onChange={e => setForm(f => ({ ...f, applicable_paths: e.target.value }))} className="input" placeholder="A,B,C" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input" />
            </div>
            <div className="sm:col-span-3">
              <label className="block text-xs font-semibold text-slate-500 mb-1">RLS Expression</label>
              <input value={form.rls_expression} onChange={e => setForm(f => ({ ...f, rls_expression: e.target.value }))}
                className="input font-mono text-xs" placeholder="e.g. product_line = ANY(attr_product_lines)" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Subject Condition (JSON)</label>
              <textarea value={form.subject_condition} onChange={e => setForm(f => ({ ...f, subject_condition: e.target.value }))}
                className="input font-mono text-xs" rows={2} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Resource Condition (JSON)</label>
              <textarea value={form.resource_condition} onChange={e => setForm(f => ({ ...f, resource_condition: e.target.value }))}
                className="input font-mono text-xs" rows={2} />
            </div>
          </div>
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={save} className="btn-primary btn-sm"><Check size={12} /> {editId ? 'Update' : 'Create'}</button>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
          </div>
        </div>
      )}

      <div className="table-container max-h-[60vh]">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Granularity</th><th>Effect</th><th>Status</th><th>RLS Expression</th><th>Paths</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={String(p.policy_id)}>
                <td className="font-medium text-slate-900">{String(p.policy_name)}</td>
                <td><span className="badge badge-slate text-[10px]">{String(p.granularity)}</span></td>
                <td><span className={`badge ${p.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{String(p.effect)}</span></td>
                <td><span className={`badge ${p.status === 'active' ? 'badge-green' : 'badge-slate'}`}>{String(p.status)}</span></td>
                <td className="font-mono text-xs text-slate-500 max-w-[200px] truncate">{p.rls_expression ? String(p.rls_expression) : '-'}</td>
                <td>
                  <div className="flex gap-1">
                    {(p.applicable_paths as string[] || []).map((path: string) => (
                      <span key={path} className="badge badge-slate text-[10px]">{path}</span>
                    ))}
                  </div>
                </td>
                <td>
                  <div className="flex gap-1">
                    <button onClick={() => {
                      setForm({
                        policy_name: String(p.policy_name), description: String(p.description || ''),
                        granularity: String(p.granularity), priority: String(p.priority), effect: String(p.effect),
                        applicable_paths: (p.applicable_paths as string[])?.join(',') || 'A,B,C',
                        rls_expression: String(p.rls_expression || ''),
                        subject_condition: JSON.stringify(p.subject_condition || {}, null, 2),
                        resource_condition: JSON.stringify(p.resource_condition || {}, null, 2),
                      });
                      setEditId(Number(p.policy_id)); setShowForm(true);
                    }} className="btn-secondary btn-sm p-1"><Pencil size={12} /></button>
                    <button onClick={async () => { if (confirm(`Deactivate policy?`)) { await api.policyDelete(Number(p.policy_id)); onReload(); }}}
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

// ============================================================
// Actions Section
// ============================================================
function ActionsSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ action_id: '', display_name: '', description: '', applicable_paths: 'A,B,C' });
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { query, setQuery, filtered } = useSearch(data, ['action_id', 'display_name', 'description']);
  const pathColor: Record<string, string> = { A: 'badge-blue', B: 'badge-green', C: 'badge-purple' };

  const save = async () => {
    setError('');
    try {
      const paths = form.applicable_paths.split(',').map(s => s.trim());
      if (editId) {
        await api.actionUpdate(editId, { display_name: form.display_name, description: form.description, applicable_paths: paths });
      } else {
        await api.actionCreate({ action_id: form.action_id, display_name: form.display_name, description: form.description, applicable_paths: paths });
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { setError(String(e)); }
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
              <label className="block text-xs font-semibold text-slate-500 mb-1">Action ID</label>
              <input value={form.action_id} onChange={e => setForm(f => ({ ...f, action_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="new_action" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} className="input" />
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
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={save} className="btn-primary btn-sm"><Check size={12} /> {editId ? 'Update' : 'Create'}</button>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
          </div>
        </div>
      )}

      <div className="table-container max-h-[60vh]">
        <table className="table">
          <thead><tr><th>Action ID</th><th>Display Name</th><th>Description</th><th>Paths</th><th>Active</th><th>Actions</th></tr></thead>
          <tbody>
            {filtered.map((a) => (
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
                    }} className="btn-secondary btn-sm p-1"><Pencil size={12} /></button>
                    <button onClick={async () => { if (confirm(`Deactivate action ${a.action_id}?`)) { await api.actionDelete(String(a.action_id)); onReload(); }}}
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
