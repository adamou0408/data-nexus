import { useState, useEffect, useMemo } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import {
  Plus, Pencil, Trash2, X, Check, Search, Copy,
  Shield, Users, KeySquare, ArrowLeft,
} from 'lucide-react';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';
import { PermissionsStudio } from './roles/PermissionsStudio';

type DetailTab = 'permissions' | 'security' | 'assignments';

export function RolesSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ role_id: '', display_name: '', description: '', is_system: false });
  const [editId, setEditId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('permissions');
  const { query, setQuery, filtered } = useSearch(data, ['role_id', 'display_name', 'description']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'role_id');
  const toast = useToast();
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const existingIds = useMemo(() => data.map(d => String(d.role_id)), [data]);
  const suggestedId = uniqueId(autoId.role(form.display_name), existingIds);

  const selectedRole = useMemo(
    () => data.find(r => String(r.role_id) === selectedId) || null,
    [data, selectedId]
  );

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

  const startEdit = (r: Record<string, unknown>) => {
    setForm({ role_id: String(r.role_id), display_name: String(r.display_name), description: String(r.description || ''), is_system: !!r.is_system });
    setEditId(String(r.role_id));
    setShowForm(true);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-[calc(100vh-240px)] min-h-[560px]">
      <div className={`flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden ${selectedId ? 'lg:w-[55%] hidden lg:flex' : 'w-full'}`}>
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

        <div className="flex-1 overflow-auto">
          <table className="table">
            <thead className="sticky top-0 bg-white z-10"><tr>
              <SortableHeader label="Role ID" sortKey="role_id" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Display Name" sortKey="display_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Subjects" sortKey="assignment_count" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Perms" sortKey="permission_count" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <th className="w-24">Actions</th>
            </tr></thead>
            <tbody>
              {sorted.map((r) => {
                const rid = String(r.role_id);
                const active = rid === selectedId;
                return (
                  <tr key={rid}
                    onClick={() => { setSelectedId(rid); setDetailTab('permissions'); }}
                    className={`cursor-pointer ${active ? 'bg-blue-50 hover:bg-blue-50' : 'hover:bg-slate-50'}`}>
                    <td className="font-mono text-xs font-bold text-slate-900">
                      <div className="flex items-center gap-1.5">
                        {rid}
                        {r.is_system ? <span className="badge badge-amber text-[9px]">SYS</span> : null}
                      </div>
                    </td>
                    <td className="text-slate-700">{String(r.display_name)}</td>
                    <td className="text-center font-medium text-xs">{String(r.assignment_count)}</td>
                    <td className="text-center font-medium text-xs">{String(r.permission_count)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <button onClick={() => startEdit(r)} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                        <button onClick={() => clone(r)} className="btn-secondary btn-sm p-1" title="Clone with permissions"><Copy size={12} /></button>
                        <button onClick={() => setDangerConfirm({
                          title: 'Deactivate Role',
                          message: `This will deactivate role "${rid}".`,
                          impact: 'All users assigned this role will lose its permissions.',
                          onConfirm: async () => {
                            try {
                              await api.roleDelete(rid);
                              toast.success(`Role "${rid}" deactivated`);
                              if (rid === selectedId) setSelectedId(null);
                              onReload();
                            } catch (e) { toast.error(String(e)); }
                          },
                        })} className="btn-secondary btn-sm p-1 text-red-500"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={5} className="text-center text-slate-400 py-8 text-sm">No roles match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden ${selectedId ? 'lg:w-[45%] w-full flex' : 'hidden lg:flex lg:w-[45%]'}`}>
        {selectedRole ? (
          <RoleDetailPanel
            role={selectedRole}
            activeTab={detailTab}
            onTabChange={setDetailTab}
            onClose={() => setSelectedId(null)}
            onReload={onReload}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400 p-8 text-center">
            <div>
              <Shield size={32} className="mx-auto mb-3 text-slate-300" />
              <p className="text-sm">Select a role to view permissions, security, and assignments</p>
            </div>
          </div>
        )}
      </div>

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}

function RoleDetailPanel({ role, activeTab, onTabChange, onClose, onReload }: {
  role: Record<string, unknown>;
  activeTab: DetailTab;
  onTabChange: (t: DetailTab) => void;
  onClose: () => void;
  onReload: () => void;
}) {
  const rid = String(role.role_id);
  const tabs: { id: DetailTab; label: string; icon: JSX.Element }[] = [
    { id: 'permissions', label: 'Permissions', icon: <KeySquare size={13} /> },
    { id: 'security',    label: 'Security',    icon: <Shield size={13} /> },
    { id: 'assignments', label: 'Subjects',    icon: <Users size={13} /> },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-200 flex items-start gap-2">
        <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-slate-700 mt-0.5" title="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs font-bold text-slate-900">{rid}</code>
            {role.is_system ? <span className="badge badge-amber text-[9px]">SYSTEM</span> : null}
          </div>
          <div className="text-sm text-slate-700 mt-0.5 truncate">{String(role.display_name)}</div>
          {role.description ? <div className="text-xs text-slate-500 mt-0.5 truncate">{String(role.description)}</div> : null}
        </div>
      </div>

      <div className="flex border-b border-slate-200 bg-slate-50">
        {tabs.map(t => (
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
        {activeTab === 'permissions' && <PermissionsStudio roleId={rid} onReload={onReload} />}
        {activeTab === 'security' && <SecurityTab role={role} onReload={onReload} />}
        {activeTab === 'assignments' && <AssignmentsTab roleId={rid} />}
      </div>
    </div>
  );
}


function SecurityTab({ role, onReload }: { role: Record<string, unknown>; onReload: () => void }) {
  const [clearance, setClearance] = useState(String(role.security_clearance || 'PUBLIC'));
  const [jobLevel, setJobLevel] = useState(Number(role.job_level) || 0);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setClearance(String(role.security_clearance || 'PUBLIC'));
    setJobLevel(Number(role.job_level) || 0);
  }, [role]);

  const save = async () => {
    setSaving(true);
    try {
      await api.roleClearanceUpdate(String(role.role_id), { security_clearance: clearance, job_level: jobLevel });
      toast.success('Security settings updated');
      onReload();
    } catch (e) { toast.error(String(e)); }
    setSaving(false);
  };

  const changed = clearance !== String(role.security_clearance || 'PUBLIC') || jobLevel !== (Number(role.job_level) || 0);

  return (
    <div className="p-4 space-y-4">
      <div>
        <label className="block text-xs font-semibold text-slate-600 mb-1">Clearance Level</label>
        <div className="flex gap-1.5 flex-wrap">
          {['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].map(c => (
            <button key={c} onClick={() => setClearance(c)}
              className={`text-xs px-3 py-1.5 rounded border font-medium ${clearance === c ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>
              {c}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400 mt-1.5">Highest data sensitivity this role can access.</p>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-600 mb-1">Job Level</label>
        <input type="number" min={0} max={15} value={jobLevel} onChange={e => setJobLevel(Number(e.target.value))}
          className="input w-24 text-sm" />
        <p className="text-[11px] text-slate-400 mt-1.5">Seniority used by policies for approval thresholds (0-15).</p>
      </div>

      {changed && (
        <div className="pt-2 border-t border-slate-200">
          <button onClick={save} disabled={saving} className="btn-primary btn-sm">
            <Check size={12} /> {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}

function AssignmentsTab({ roleId }: { roleId: string }) {
  const [subjects, setSubjects] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.subjects()
      .then(all => setSubjects(all.filter(s => Array.isArray(s.roles) && (s.roles as string[]).includes(roleId))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [roleId]);

  const goToSubject = (sid: string) => {
    window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'access-subjects', focus: sid } }));
  };

  if (loading) return <div className="p-4 text-center text-xs text-slate-400">Loading...</div>;

  if (subjects.length === 0) {
    return (
      <div className="p-8 text-center text-slate-400">
        <Users size={24} className="mx-auto mb-2 text-slate-300" />
        <p className="text-xs">No subjects assigned to this role yet.</p>
        <p className="text-[11px] mt-1">Assign this role to a subject in the <b>Subjects</b> tab.</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="text-[11px] text-slate-500 mb-2">{subjects.length} subject{subjects.length === 1 ? '' : 's'} assigned</div>
      <div className="space-y-1">
        {subjects.map(s => {
          const sid = String(s.subject_id);
          return (
            <button key={sid} onClick={() => goToSubject(sid)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded border border-slate-200 hover:border-blue-400 hover:bg-blue-50 text-left transition-colors">
              <span className={`badge text-[10px] ${s.subject_type === 'user' ? 'badge-blue' : s.subject_type === 'service_account' ? 'badge-amber' : 'badge-purple'}`}>
                {String(s.subject_type)}
              </span>
              <span className="font-mono text-xs text-slate-700 flex-1 truncate">{sid}</span>
              <span className="text-xs text-slate-500 truncate">{String(s.display_name)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

