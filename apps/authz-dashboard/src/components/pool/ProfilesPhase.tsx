import React, { useState, useEffect, useCallback } from 'react';
import { api, PoolProfile, PoolAssignment, DataSource, LifecycleResponse } from '../../api';
import { useToast } from '../Toast';
import { autoId } from '../../utils/slugify';
import { ConfirmState, DangerConfirmModal, ChipSelect } from './shared';
import { Plus, X, Pencil, Trash2, Undo2, RefreshCw, Server, Search, ChevronRight } from 'lucide-react';

/* Profile form helpers (kept from original) */
type ProfileFormData = {
  profile_id: string;
  pg_role: string;
  connection_mode: 'readonly' | 'readwrite' | 'admin';
  max_connections: number;
  allowed_schemas: string;
  allowed_tables: string;
  allowed_modules: string;
  rls_applies: boolean;
  description: string;
  is_active: boolean;
  data_source_id: string;
};

const emptyForm: ProfileFormData = {
  profile_id: '', pg_role: '', connection_mode: 'readonly',
  max_connections: 5, allowed_schemas: '', allowed_tables: '',
  allowed_modules: '',
  rls_applies: true, description: '', is_active: true,
  data_source_id: '',
};

function profileToForm(p: PoolProfile): ProfileFormData {
  return {
    profile_id: p.profile_id, pg_role: p.pg_role, connection_mode: p.connection_mode,
    max_connections: p.max_connections,
    allowed_schemas: p.allowed_schemas?.join(', ') ?? '',
    allowed_tables: p.allowed_tables?.join(', ') ?? '',
    rls_applies: p.rls_applies, description: p.description ?? '', is_active: p.is_active,
    data_source_id: p.data_source_id ?? '',
    allowed_modules: p.allowed_modules?.join(', ') ?? '',
  };
}

function formToPayload(f: ProfileFormData, isCreate: boolean) {
  const base: Record<string, unknown> = {
    connection_mode: f.connection_mode, max_connections: f.max_connections,
    allowed_schemas: f.allowed_schemas ? f.allowed_schemas.split(',').map(s => s.trim()).filter(Boolean) : [],
    allowed_tables: f.allowed_tables ? f.allowed_tables.split(',').map(s => s.trim()).filter(Boolean) : null,
    rls_applies: f.rls_applies, description: f.description || null,
    data_source_id: f.data_source_id || null,
    allowed_modules: f.allowed_modules ? f.allowed_modules.split(',').map(s => s.trim()).filter(Boolean) : null,
  };
  if (isCreate) { base.profile_id = f.profile_id; base.pg_role = f.pg_role; }
  else { base.is_active = f.is_active; }
  return base;
}

function ProfileForm({ initial, isCreate, onSave, onCancel, saving, error, lockedDsId }: {
  initial: ProfileFormData; isCreate: boolean;
  onSave: (data: ProfileFormData) => void; onCancel: () => void;
  saving: boolean; error: string; lockedDsId?: string;
}) {
  const [form, setForm] = useState(initial);
  const set = (k: keyof ProfileFormData, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));
  const [dsList, setDsList] = useState<DataSource[]>([]);
  const [dsSchemas, setDsSchemas] = useState<string[]>([]);
  const [moduleList, setModuleList] = useState<{ resource_id: string; display_name: string }[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);

  useEffect(() => {
    if (lockedDsId) {
      set('data_source_id', lockedDsId);
    }
    api.datasources().then(ds => setDsList(ds.filter(d => d.is_active))).catch(e => console.warn('Failed to load datasources:', e));
  }, []);
  useEffect(() => { api.resourceModules().then(setModuleList).catch(e => console.warn('Failed to load modules:', e)); }, []);
  useEffect(() => {
    const dsId = lockedDsId || form.data_source_id;
    if (dsId) {
      setSchemasLoading(true);
      api.datasourceSchemas(dsId).then(s => setDsSchemas(s)).catch(e => { console.warn('Failed to load schemas:', e); setDsSchemas([]); }).finally(() => setSchemasLoading(false));
    } else { setDsSchemas(['public']); }
  }, [form.data_source_id, lockedDsId]);

  const suggestPgRole = autoId.pgRole;

  const modeDefaults: Record<string, number> = { readonly: 20, readwrite: 10, admin: 5 };

  const selectedSchemas = form.allowed_schemas ? form.allowed_schemas.split(',').map(s => s.trim()).filter(Boolean) : [];
  const toggleSchema = (s: string) => {
    const next = selectedSchemas.includes(s) ? selectedSchemas.filter(x => x !== s) : [...selectedSchemas, s];
    set('allowed_schemas', next.join(', '));
  };

  const selectedModules = form.allowed_modules ? form.allowed_modules.split(',').map(s => s.trim()).filter(Boolean) : [];
  const toggleModule = (m: string) => {
    const next = selectedModules.includes(m) ? selectedModules.filter(x => x !== m) : [...selectedModules, m];
    set('allowed_modules', next.join(', '));
  };

  return (
    <div className="card border-blue-200 bg-blue-50/30">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-slate-900">
          {isCreate ? 'Create New Profile' : `Edit: ${form.profile_id}`}
        </h3>
        <button onClick={onCancel} className="btn-ghost btn-sm"><X size={14} /></button>
      </div>
      <div className="card-body space-y-4">
        {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg p-3 text-sm">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {isCreate && (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Profile ID</label>
                <input value={form.profile_id} onChange={e => {
                  const v = e.target.value; set('profile_id', v);
                  if (!form.pg_role || form.pg_role === suggestPgRole(form.profile_id)) set('pg_role', suggestPgRole(v));
                }} placeholder="pool:pe_readonly" className="input font-mono" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  PG Role
                  {form.pg_role === suggestPgRole(form.profile_id) && form.pg_role && (
                    <span className="text-green-500 normal-case font-normal ml-1">(auto)</span>
                  )}
                </label>
                <input value={form.pg_role} onChange={e => set('pg_role', e.target.value)} placeholder="nexus_pe_ro" className="input font-mono" />
              </div>
            </>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Connection Mode</label>
            <select value={form.connection_mode} onChange={e => {
              const mode = e.target.value; set('connection_mode', mode);
              if (Object.values(modeDefaults).includes(form.max_connections)) set('max_connections', modeDefaults[mode] ?? 5);
            }} className="select">
              <option value="readonly">readonly (suggest: 20 conn)</option>
              <option value="readwrite">readwrite (suggest: 10 conn)</option>
              <option value="admin">admin (suggest: 5 conn)</option>
            </select>
          </div>
          {!lockedDsId && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Data Source</label>
              <select value={form.data_source_id} onChange={e => {
                const dsId = e.target.value; set('data_source_id', dsId);
                const ds = dsList.find(d => d.source_id === dsId);
                if (ds) set('allowed_schemas', ds.schemas.join(', '));
              }} className="select">
                <option value="">Local (authz DB)</option>
                {dsList.map(ds => (
                  <option key={ds.source_id} value={ds.source_id}>
                    {ds.display_name} ({ds.host}:{ds.port}/{ds.database_name})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
              Max Connections <span className="text-slate-400 normal-case font-normal ml-1">(suggested: {modeDefaults[form.connection_mode] ?? 5})</span>
            </label>
            <input type="number" value={form.max_connections} onChange={e => set('max_connections', Number(e.target.value))}
              min={1} max={100} className="input" />
            {(form.max_connections < 1 || form.max_connections > 100) && (
              <div className="text-xs text-red-500 mt-0.5">Must be 1–100</div>
            )}
          </div>
          <ChipSelect
            label={`Allowed Schemas${schemasLoading ? ' (loading...)' : form.data_source_id || lockedDsId ? ' (from data source)' : ''}`}
            items={dsSchemas.map(s => ({ id: s, label: s }))}
            selected={selectedSchemas} onToggle={toggleSchema}
          />
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
              Allowed Tables (comma-sep, empty=ALL)
              {selectedModules.length > 0 && <span className="text-purple-500 normal-case font-normal ml-1">(+ tables from modules)</span>}
            </label>
            <input value={form.allowed_tables} onChange={e => set('allowed_tables', e.target.value)}
              placeholder="leave empty to use modules or ALL" className="input font-mono text-xs" />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <ChipSelect
              label="Allowed Modules (tables auto-resolved at sync time)"
              items={moduleList.map(m => ({ id: m.resource_id, label: `${m.display_name} (${m.resource_id})` }))}
              selected={selectedModules} onToggle={toggleModule}
              renderItem={item => {
                const mod = moduleList.find(m => m.resource_id === item.id);
                return <>{mod?.display_name ?? item.id}</>;
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Description</label>
            <input value={form.description} onChange={e => set('description', e.target.value)} className="input" />
          </div>
          <div className="flex items-center gap-4 pt-5">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.rls_applies} onChange={e => set('rls_applies', e.target.checked)} className="rounded border-slate-300" />
              RLS Applies
            </label>
            {!isCreate && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} className="rounded border-slate-300" />
                Active
              </label>
            )}
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="btn-secondary btn-sm">Cancel</button>
          <button onClick={() => onSave(form)} disabled={saving || form.max_connections < 1 || form.max_connections > 100} className="btn-primary btn-sm">
            {saving ? 'Saving...' : isCreate ? 'Create' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProfilesPhase({ dsId, lifecycle, onMutate }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void }) {
  const toast = useToast();
  const [profiles, setProfiles] = useState<PoolProfile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<PoolAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<PoolProfile | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [newSubjectId, setNewSubjectId] = useState('');
  const [subjectSearch, setSubjectSearch] = useState('');
  const [subjectDropdownOpen, setSubjectDropdownOpen] = useState(false);
  const [subjectOptions, setSubjectOptions] = useState<{ subject_id: string; display_name: string }[]>([]);
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api.poolProfiles();
      setProfiles(all.filter(p => p.data_source_id === dsId));
    } catch (err) { toast.error('Failed to load profiles'); console.warn(err); }
    finally { setLoading(false); }
  }, [dsId]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);
  useEffect(() => {
    api.subjects().then((s: any[]) => setSubjectOptions(s.map(x => ({ subject_id: x.subject_id, display_name: x.display_name })))).catch(e => console.warn('Failed to load subjects:', e));
  }, []);

  const loadAssignments = async (profileId: string) => {
    setSelected(profileId);
    try { setAssignments(await api.poolAssignments(profileId)); } catch (err) { console.warn('Failed to load assignments:', err); setAssignments([]); }
  };

  const handleSave = async (form: ProfileFormData) => {
    setSaving(true); setFormError('');
    try {
      if (!editingProfile) {
        await api.poolProfileCreate(formToPayload(form, true) as Partial<PoolProfile>);
      } else {
        await api.poolProfileUpdate(editingProfile.profile_id, formToPayload(form, false) as Partial<PoolProfile>);
      }
      setShowForm(false); setEditingProfile(null);
      await loadProfiles();
      onMutate();
    } catch (e) { setFormError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = (profileId: string) => {
    setDangerConfirm({
      title: `Delete Pool Profile "${profileId}"`,
      message: 'This will deactivate the pool profile and all its subject assignments.',
      impact: 'Users assigned to this profile will immediately lose their Path C database access.',
      onConfirm: async () => {
        try {
          await api.poolProfileDelete(profileId);
          if (selected === profileId) { setSelected(null); setAssignments([]); }
          await loadProfiles(); onMutate();
        } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed'); }
      },
    });
  };

  const handleReactivate = (profileId: string) => {
    setDangerConfirm({
      title: `Reactivate Profile "${profileId}"`,
      message: 'This will restore the pool profile and its subject assignments.',
      impact: 'Assigned users will regain Path C database access through this profile.',
      onConfirm: async () => {
        try { await api.poolProfileUpdate(profileId, { is_active: true } as Partial<PoolProfile>); await loadProfiles(); onMutate(); }
        catch (e) { toast.error(e instanceof Error ? e.message : 'Reactivate failed'); }
      },
    });
  };

  const handleAssign = async () => {
    if (!newSubjectId.trim() || !selected) return;
    try {
      await api.poolAssignmentCreate({ subject_id: newSubjectId.trim(), profile_id: selected });
      setNewSubjectId(''); setShowAssignForm(false);
      await loadAssignments(selected);
      await loadProfiles();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Assign failed'); }
  };

  const handleRemoveAssignment = (assignmentId: number) => {
    setDangerConfirm({
      title: 'Remove Assignment',
      message: 'This will revoke the subject\'s access through this pool profile.',
      impact: 'The user will lose Path C database access for this profile immediately.',
      onConfirm: async () => {
        try { await api.poolAssignmentDelete(assignmentId); if (selected) await loadAssignments(selected); await loadProfiles(); }
        catch (e) { toast.error(e instanceof Error ? e.message : 'Remove failed'); }
      },
    });
  };

  const handleReactivateAssignment = (assignmentId: number) => {
    setDangerConfirm({
      title: 'Reactivate Assignment',
      message: 'This will restore the subject\'s access through this pool profile.',
      impact: 'The user will regain Path C database access for this profile.',
      onConfirm: async () => {
        try { await api.poolAssignmentReactivate(assignmentId); if (selected) await loadAssignments(selected); await loadProfiles(); }
        catch (e) { toast.error(e instanceof Error ? e.message : 'Reactivate failed'); }
      },
    });
  };

  const modeStyle: Record<string, string> = { readonly: 'badge-green', readwrite: 'badge-amber', admin: 'badge-red' };

  if (loading) return <div className="text-slate-400 text-sm">Loading profiles...</div>;

  return (
    <div className="space-y-4">
      {showForm && (
        <ProfileForm
          initial={editingProfile ? profileToForm(editingProfile) : { ...emptyForm, data_source_id: dsId }}
          isCreate={!editingProfile}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingProfile(null); }}
          saving={saving} error={formError} lockedDsId={dsId}
        />
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">{profiles.length} profile{profiles.length !== 1 ? 's' : ''} for this data source</div>
        {!showForm && (
          <button onClick={() => { setEditingProfile(null); setShowForm(true); setFormError(''); }}
            className="btn-primary btn-sm gap-1"><Plus size={12} /> Create Profile</button>
        )}
      </div>

      {profiles.length === 0 && !showForm && (
        <div className="text-center py-6 bg-slate-50 rounded-lg border border-dashed border-slate-300">
          <Server size={28} className="mx-auto text-slate-400 mb-2" />
          <div className="text-sm font-medium text-slate-600">No pool profiles yet</div>
          <div className="text-xs text-slate-400 mt-1">Profiles define PG role + access scope (schemas, tables, modules). Create one to start assigning users.</div>
        </div>
      )}

      {profiles.length > 0 && (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr><th>Profile ID</th><th>PG Role</th><th>Mode</th><th>Max Conn</th><th>RLS</th><th>Schemas</th><th>Modules</th><th>Assigned</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.profile_id}
                  className={`cursor-pointer ${selected === p.profile_id ? '!bg-blue-50' : ''} ${!p.is_active ? 'opacity-50' : ''}`}
                  onClick={() => loadAssignments(p.profile_id)}>
                  <td className="font-mono text-xs font-bold text-slate-900">{p.profile_id}</td>
                  <td className="font-mono text-xs">{p.pg_role}</td>
                  <td><span className={`badge ${modeStyle[p.connection_mode]}`}>{p.connection_mode}</span></td>
                  <td className="text-center">{p.max_connections}</td>
                  <td className="text-center">
                    {p.rls_applies ? <span className="badge badge-green text-[10px]">YES</span> : <span className="text-slate-300">NO</span>}
                  </td>
                  <td className="text-xs">{p.allowed_schemas?.join(', ')}</td>
                  <td className="text-xs max-w-[150px] truncate">
                    {p.allowed_modules && p.allowed_modules.length > 0
                      ? p.allowed_modules.map(m => m.replace(/^module:/, '')).join(', ')
                      : <span className="text-slate-300">--</span>}
                  </td>
                  <td className="text-center font-medium">{p.assignment_count ?? '-'}</td>
                  <td className="text-center" onClick={e => e.stopPropagation()}>
                    <div className="flex gap-1 justify-center">
                      {p.is_active ? (
                        <>
                          <button onClick={() => { setEditingProfile(p); setShowForm(true); setFormError(''); }} className="btn-ghost btn-sm p-1" title="Edit">
                            <Pencil size={13} className="text-slate-500 hover:text-blue-600" />
                          </button>
                          <button onClick={() => handleDelete(p.profile_id)} className="btn-ghost btn-sm p-1" title="Delete">
                            <Trash2 size={13} className="text-slate-500 hover:text-red-600" />
                          </button>
                        </>
                      ) : (
                        <button onClick={() => handleReactivate(p.profile_id)} className="btn btn-xs bg-white border border-green-400 hover:bg-green-50 text-green-700 gap-1" title="Reactivate">
                          <Undo2 size={12} /> Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Assignments for selected profile */}
      {selected && (
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              Assignments <ChevronRight size={14} className="text-slate-400" /> <span className="code">{selected}</span>
            </h3>
            <button onClick={() => { setShowAssignForm(v => !v); setNewSubjectId(''); }} className="btn-primary btn-sm gap-1">
              <Plus size={12} /> Assign Subject
            </button>
          </div>
          <div className="card-body">
            {showAssignForm && (
              <div className="flex gap-2 items-end mb-4 pb-4 border-b border-slate-100">
                <div className="flex-1 relative">
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Subject</label>
                  <div className="relative">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input className="input font-mono text-xs pl-7"
                      placeholder="Search subjects..."
                      value={subjectSearch}
                      onChange={e => { setSubjectSearch(e.target.value); setSubjectDropdownOpen(true); setNewSubjectId(''); }}
                      onFocus={() => setSubjectDropdownOpen(true)}
                    />
                    {newSubjectId && (
                      <button onClick={() => { setNewSubjectId(''); setSubjectSearch(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  {subjectDropdownOpen && !newSubjectId && (
                    <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-auto">
                      {subjectOptions
                        .filter(s => {
                          if (!subjectSearch.trim()) return true;
                          const q = subjectSearch.toLowerCase();
                          return s.subject_id.toLowerCase().includes(q) || s.display_name.toLowerCase().includes(q);
                        })
                        .map(s => (
                          <button key={s.subject_id} type="button"
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 font-mono"
                            onClick={() => { setNewSubjectId(s.subject_id); setSubjectSearch(`${s.subject_id} — ${s.display_name}`); setSubjectDropdownOpen(false); }}>
                            <span className="font-semibold">{s.subject_id}</span> <span className="text-slate-400">— {s.display_name}</span>
                          </button>
                        ))}
                      {subjectOptions.filter(s => {
                        if (!subjectSearch.trim()) return true;
                        const q = subjectSearch.toLowerCase();
                        return s.subject_id.toLowerCase().includes(q) || s.display_name.toLowerCase().includes(q);
                      }).length === 0 && (
                        <div className="px-3 py-2 text-xs text-slate-400">No matching subjects</div>
                      )}
                    </div>
                  )}
                </div>
                <button onClick={handleAssign} disabled={!newSubjectId.trim()} className="btn-primary btn-sm">Assign</button>
                <button onClick={() => { setShowAssignForm(false); setSubjectSearch(''); setNewSubjectId(''); setSubjectDropdownOpen(false); }} className="btn-secondary btn-sm">Cancel</button>
              </div>
            )}
            {assignments.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">No assignments</p>
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead><tr><th>Subject ID</th><th>Name</th><th>Granted By</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {assignments.map(a => (
                      <tr key={a.id}>
                        <td className="font-mono text-xs">{a.subject_id}</td>
                        <td className="font-medium">{a.subject_name}</td>
                        <td className="text-xs text-slate-500">{a.granted_by}</td>
                        <td><span className={`badge ${a.is_active ? 'badge-green' : 'badge-red'}`}>{a.is_active ? 'Active' : 'Inactive'}</span></td>
                        <td className="text-center">
                          {a.is_active ? (
                            <button onClick={() => handleRemoveAssignment(a.id)} className="btn-ghost btn-sm p-1" title="Remove">
                              <Trash2 size={13} className="text-slate-500 hover:text-red-600" />
                            </button>
                          ) : (
                            <button onClick={() => handleReactivateAssignment(a.id)}
                              className="btn btn-xs bg-white border border-green-400 hover:bg-green-50 text-green-700 gap-1" title="Reactivate">
                              <Undo2 size={12} /> Reactivate
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}
