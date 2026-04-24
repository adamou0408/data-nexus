import { useState, useEffect, useMemo, useCallback } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import {
  Plus, Pencil, Trash2, X, Check, Search, Copy,
  Users, KeyRound, UserCircle, ArrowLeft, Info,
} from 'lucide-react';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';
import { Combobox } from '../shared/Combobox';

type DetailTab = 'roles' | 'groups' | 'profile';

export function SubjectsSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ subject_id: '', subject_type: 'user', display_name: '', ldap_dn: '', attributes: '{}' });
  const [editId, setEditId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('roles');
  const { query, setQuery, filtered } = useSearch(data, ['subject_id', 'display_name', 'subject_type', 'ldap_dn']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'display_name');
  const toast = useToast();
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const existingIds = useMemo(() => data.map(d => String(d.subject_id)), [data]);
  const suggestedId = uniqueId(autoId.subject(form.display_name, form.subject_type), existingIds);

  const selected = useMemo(
    () => data.find(s => String(s.subject_id) === selectedId) || null,
    [data, selectedId]
  );

  // Listen for navigate-tab events with focus — select the subject when jumped from Roles → Subjects
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string; focus?: string }>).detail;
      if (detail?.focus) {
        setSelectedId(detail.focus);
        setDetailTab('roles');
      }
    };
    window.addEventListener('navigate-tab', handler);
    return () => window.removeEventListener('navigate-tab', handler);
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

  const typeBadge = (t: string) =>
    t === 'user' ? 'badge-blue' : t === 'service_account' ? 'badge-amber' : 'badge-purple';

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-[calc(100vh-240px)] min-h-[560px]">
      <div className={`flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden ${selectedId ? 'lg:w-[55%] hidden lg:flex' : 'w-full'}`}>
        <div className="card-header">
          <div className="flex items-center gap-3 flex-1">
            <span className="text-sm font-semibold">Subjects ({filtered.length}/{data.length})</span>
            <div className="relative flex-1 max-w-xs">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search id / name / LDAP DN..." className="input pl-8 py-1.5 text-xs" />
            </div>
          </div>
          <button onClick={() => { setShowForm(true); setEditId(null); setForm({ subject_id: '', subject_type: 'user', display_name: '', ldap_dn: '', attributes: '{}' }); }}
            className="btn-primary btn-sm"><Plus size={12} /> Add</button>
        </div>

        {showForm && (
          <div className="card-body border-b bg-slate-50">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

        <div className="flex-1 overflow-auto">
          <table className="table">
            <thead className="sticky top-0 bg-white z-10"><tr>
              <SortableHeader label="Subject ID" sortKey="subject_id" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Type" sortKey="subject_type" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Display Name" sortKey="display_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <th>Roles</th>
              <th className="w-24">Actions</th>
            </tr></thead>
            <tbody>
              {sorted.map((s) => {
                const sid = String(s.subject_id);
                const active = sid === selectedId;
                const roles = (s.roles as string[] | null) || [];
                const ldap = String(s.ldap_dn || '');
                return (
                  <tr key={sid}
                    onClick={() => { setSelectedId(sid); setDetailTab('roles'); }}
                    className={`cursor-pointer ${active ? 'bg-blue-50 hover:bg-blue-50' : 'hover:bg-slate-50'}`}>
                    <td className="font-mono text-xs" title={ldap ? `LDAP DN: ${ldap}` : ''}>{sid}</td>
                    <td>
                      <span className={`badge ${typeBadge(String(s.subject_type))}`} title={`Subject type: ${s.subject_type}`}>
                        {String(s.subject_type)}
                      </span>
                    </td>
                    <td className="text-slate-900 font-medium truncate max-w-[200px]" title={String(s.display_name)}>{String(s.display_name)}</td>
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        {roles.slice(0, 3).map((r: string) => (
                          <span key={r} className="badge badge-slate text-[10px]" title={r}>{r}</span>
                        ))}
                        {roles.length > 3 && (
                          <span className="badge badge-slate text-[10px]" title={roles.slice(3).join(', ')}>+{roles.length - 3}</span>
                        )}
                        {roles.length === 0 && <span className="text-slate-300 text-xs">—</span>}
                      </div>
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <button onClick={() => startEdit(s)} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                        <button onClick={() => clone(s)} className="btn-secondary btn-sm p-1" title="Clone"><Copy size={12} /></button>
                        <button onClick={() => setDangerConfirm({
                          title: 'Deactivate Subject',
                          message: `This will deactivate subject "${sid}".`,
                          impact: 'The subject will lose all role assignments and resource access.',
                          onConfirm: async () => {
                            try {
                              await api.subjectDelete(sid);
                              toast.success(`Subject "${sid}" deactivated`);
                              if (sid === selectedId) setSelectedId(null);
                              onReload();
                            } catch (e) { toast.error(String(e)); }
                          },
                        })} className="btn-secondary btn-sm p-1 text-red-500" title="Deactivate"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={5} className="text-center text-slate-400 py-8 text-sm">No subjects match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden ${selectedId ? 'lg:w-[45%] w-full flex' : 'hidden lg:flex lg:w-[45%]'}`}>
        {selected ? (
          <SubjectDetailPanel
            subject={selected}
            activeTab={detailTab}
            onTabChange={setDetailTab}
            onClose={() => setSelectedId(null)}
            onReload={onReload}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400 p-8 text-center">
            <div>
              <UserCircle size={32} className="mx-auto mb-3 text-slate-300" />
              <p className="text-sm">Select a subject to manage roles, groups, and attributes</p>
            </div>
          </div>
        )}
      </div>

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}

function SubjectDetailPanel({ subject, activeTab, onTabChange, onClose, onReload }: {
  subject: Record<string, unknown>;
  activeTab: DetailTab;
  onTabChange: (t: DetailTab) => void;
  onClose: () => void;
  onReload: () => void;
}) {
  const sid = String(subject.subject_id);
  const isUser = subject.subject_type === 'user';

  const tabs: { id: DetailTab; label: string; icon: JSX.Element; show: boolean }[] = [
    { id: 'roles',    label: 'Roles',       icon: <KeyRound size={13} />, show: true },
    { id: 'groups',   label: 'Groups',      icon: <Users size={13} />,    show: isUser },
    { id: 'profile',  label: 'Profile',     icon: <Info size={13} />,     show: true },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-200 flex items-start gap-2">
        <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-slate-700 mt-0.5" title="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs font-bold text-slate-900">{sid}</code>
            <span className={`badge text-[9px] ${subject.subject_type === 'user' ? 'badge-blue' : subject.subject_type === 'service_account' ? 'badge-amber' : 'badge-purple'}`}>
              {String(subject.subject_type)}
            </span>
          </div>
          <div className="text-sm text-slate-700 mt-0.5 truncate">{String(subject.display_name)}</div>
          {subject.ldap_dn ? <div className="text-[11px] text-slate-500 mt-0.5 font-mono truncate" title={String(subject.ldap_dn)}>{String(subject.ldap_dn)}</div> : null}
        </div>
      </div>

      <div className="flex border-b border-slate-200 bg-slate-50">
        {tabs.filter(t => t.show).map(t => (
          <button key={t.id} onClick={() => onTabChange(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
              activeTab === t.id
                ? 'border-blue-600 text-blue-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {activeTab === 'roles'   && <RolesTab subject={subject} onReload={onReload} />}
        {activeTab === 'groups'  && isUser && <GroupsTab subject={subject} onReload={onReload} />}
        {activeTab === 'profile' && <ProfileTab subject={subject} />}
      </div>
    </div>
  );
}

function RolesTab({ subject, onReload }: { subject: Record<string, unknown>; onReload: () => void }) {
  const sid = String(subject.subject_id);
  const assigned = useMemo(() => ((subject.roles as string[] | null) || []), [subject]);
  const [availableRoles, setAvailableRoles] = useState<Record<string, unknown>[]>([]);
  const [roleId, setRoleId] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const toast = useToast();

  useEffect(() => { api.roles().then(setAvailableRoles).catch(() => {}); }, []);

  const addRole = async () => {
    if (!roleId) { toast.error('Select a role'); return; }
    try {
      await api.subjectAddRole(sid, { role_id: roleId, valid_until: validUntil || undefined });
      toast.success(`Role "${roleId}" assigned`);
      setRoleId(''); setValidUntil('');
      onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const removeRole = async (r: string) => {
    try {
      await api.subjectRemoveRole(sid, r);
      toast.success(`Role "${r}" removed`);
      onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const roleMeta = (rid: string) => availableRoles.find(r => r.role_id === rid);
  const roleOptions = useMemo(
    () => availableRoles
      .filter(r => !assigned.includes(String(r.role_id)))
      .map(r => ({ value: String(r.role_id), label: String(r.role_id), hint: String(r.display_name || '') })),
    [availableRoles, assigned]
  );

  return (
    <div className="p-4 space-y-4">
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
        <div className="text-[11px] font-semibold uppercase text-slate-500 mb-2">Assign role</div>
        <div className="grid grid-cols-12 gap-2 items-stretch">
          <div className="col-span-7"><Combobox value={roleId} onChange={setRoleId} options={roleOptions} placeholder="Role..." /></div>
          <input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)}
            className="input text-xs col-span-4" title="Valid Until (optional)" />
          <button onClick={addRole} className="btn-primary btn-sm p-1.5 col-span-1" title="Assign"><Plus size={14} /></button>
        </div>
      </div>

      {assigned.length === 0 ? (
        <div className="text-center py-10 text-slate-400">
          <KeyRound size={24} className="mx-auto mb-2 text-slate-300" />
          <p className="text-xs">No roles assigned.</p>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="text-[11px] text-slate-500 px-1">{assigned.length} role{assigned.length === 1 ? '' : 's'} assigned</div>
          {assigned.map(r => {
            const meta = roleMeta(r);
            return (
              <div key={r} className="flex items-center gap-2 px-3 py-2 rounded border border-slate-200 text-xs hover:border-blue-400 hover:bg-blue-50 group">
                <KeyRound size={12} className="text-slate-400 shrink-0" />
                <span className="font-mono font-bold text-slate-800 truncate" title={meta ? `${r} — ${meta.display_name}\nClearance: ${meta.security_clearance || '—'}` : r}>{r}</span>
                {meta ? <span className="text-slate-500 truncate flex-1">{String(meta.display_name)}</span> : <span className="flex-1" />}
                {meta?.security_clearance ? <span className="badge badge-slate text-[9px]" title="Security clearance">{String(meta.security_clearance)}</span> : null}
                <button onClick={() => removeRole(r)} className="text-slate-300 hover:text-red-600 opacity-0 group-hover:opacity-100" title="Remove"><X size={12} /></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GroupsTab({ subject, onReload }: { subject: Record<string, unknown>; onReload: () => void }) {
  const sid = String(subject.subject_id);
  const [allSubjects, setAllSubjects] = useState<Record<string, unknown>[]>([]);
  const [groupId, setGroupId] = useState('');
  const toast = useToast();

  const loadAll = useCallback(() => {
    api.subjects().then(setAllSubjects).catch(() => {});
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  const ldapGroups = useMemo(
    () => allSubjects.filter(s => s.subject_type === 'ldap_group'),
    [allSubjects]
  );

  const myGroups = useMemo(() => {
    // Find groups where this user is present via subject->group relation. We infer via DN suffix match or API pattern.
    // Simplification: our API returns `roles` but not `groups` on the subject. Fall back to "none shown" if we can't infer.
    // (The POST /subjects/:id/groups endpoint writes to ldap_subject_group. We don't have a matching GET.)
    // Best-effort: show nothing assigned until we add a GET endpoint. For now show the add form.
    return [] as Record<string, unknown>[];
  }, []);

  const options = useMemo(
    () => ldapGroups.map(g => ({ value: String(g.subject_id), label: String(g.subject_id), hint: String(g.display_name || '') })),
    [ldapGroups]
  );

  const addGroup = async () => {
    if (!groupId) { toast.error('Select a group'); return; }
    try {
      await api.subjectAddGroup(sid, groupId);
      toast.success(`Group "${groupId}" assigned`);
      setGroupId('');
      onReload();
    } catch (e) { toast.error(String(e)); }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
        <div className="text-[11px] font-semibold uppercase text-slate-500 mb-2">Assign LDAP group</div>
        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-11"><Combobox value={groupId} onChange={setGroupId} options={options} placeholder="LDAP group..." /></div>
          <button onClick={addGroup} className="btn-primary btn-sm p-1.5 col-span-1" title="Assign"><Plus size={14} /></button>
        </div>
      </div>

      {myGroups.length === 0 ? (
        <div className="text-center py-6 text-slate-400">
          <Users size={22} className="mx-auto mb-2 text-slate-300" />
          <p className="text-xs">Current group memberships not available in this view.</p>
          <p className="text-[11px] mt-1">Group → user membership is maintained via LDAP. Use the assign form above to add.</p>
        </div>
      ) : null}
    </div>
  );
}

function ProfileTab({ subject }: { subject: Record<string, unknown> }) {
  const attrs = subject.attributes as Record<string, unknown> | null;
  const created = subject.created_at ? new Date(String(subject.created_at)).toLocaleString() : '—';
  const updated = subject.updated_at ? new Date(String(subject.updated_at)).toLocaleString() : '—';

  return (
    <div className="p-4 space-y-4 text-xs">
      <DetailRow label="Subject ID" value={<code className="font-mono">{String(subject.subject_id)}</code>} />
      <DetailRow label="Type" value={String(subject.subject_type)} />
      <DetailRow label="Display Name" value={String(subject.display_name)} />
      <DetailRow label="LDAP DN" value={subject.ldap_dn ? <code className="font-mono text-[11px] break-all">{String(subject.ldap_dn)}</code> : <span className="text-slate-400">—</span>} />
      <DetailRow label="Status" value={
        <span className={`badge text-[10px] ${subject.is_active ? 'badge-green' : 'badge-slate'}`}>
          {subject.is_active ? 'active' : 'inactive'}
        </span>
      } />
      <DetailRow label="Created" value={<span className="text-slate-600">{created}</span>} />
      <DetailRow label="Updated" value={<span className="text-slate-600">{updated}</span>} />

      <div>
        <div className="text-[11px] font-semibold text-slate-500 uppercase mb-1">Attributes</div>
        {attrs && Object.keys(attrs).length > 0 ? (
          <pre className="bg-slate-50 border border-slate-200 rounded p-2 text-[11px] font-mono overflow-auto max-h-48">{JSON.stringify(attrs, null, 2)}</pre>
        ) : (
          <p className="text-slate-400 text-[11px]">No custom attributes.</p>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-28 text-[11px] font-semibold text-slate-500 uppercase shrink-0">{label}</div>
      <div className="flex-1 min-w-0 text-slate-800">{value}</div>
    </div>
  );
}
