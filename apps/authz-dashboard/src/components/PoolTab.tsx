import { useState, useEffect, useCallback } from 'react';
import { api, PoolProfile, PoolAssignment, PoolCredential } from '../api';
import { Server, Key, RefreshCw, Play, ChevronRight, Plus, Pencil, Trash2, X, RotateCw } from 'lucide-react';

type Section = 'profiles' | 'credentials' | 'sync';

const sectionDefs: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'profiles',    label: 'Pool Profiles', icon: <Server size={14} /> },
  { id: 'credentials', label: 'Credentials',   icon: <Key size={14} /> },
  { id: 'sync',        label: 'Sync Ops',      icon: <RefreshCw size={14} /> },
];

export function PoolTab() {
  const [section, setSection] = useState<Section>('profiles');

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Connection Pool Management</h1>
        <p className="page-desc">Manage Path C database connection pools, credentials, and sync operations</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {sectionDefs.map(s => (
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

      {section === 'profiles' && <ProfilesSection />}
      {section === 'credentials' && <CredentialsSection />}
      {section === 'sync' && <SyncSection />}
    </div>
  );
}

/* ── Profile Form ── */

type ProfileFormData = {
  profile_id: string;
  pg_role: string;
  connection_mode: 'readonly' | 'readwrite' | 'admin';
  max_connections: number;
  allowed_schemas: string;
  allowed_tables: string;
  rls_applies: boolean;
  description: string;
  is_active: boolean;
};

const emptyForm: ProfileFormData = {
  profile_id: '', pg_role: '', connection_mode: 'readonly',
  max_connections: 5, allowed_schemas: '', allowed_tables: '',
  rls_applies: true, description: '', is_active: true,
};

function profileToForm(p: PoolProfile): ProfileFormData {
  return {
    profile_id: p.profile_id,
    pg_role: p.pg_role,
    connection_mode: p.connection_mode,
    max_connections: p.max_connections,
    allowed_schemas: p.allowed_schemas?.join(', ') ?? '',
    allowed_tables: p.allowed_tables?.join(', ') ?? '',
    rls_applies: p.rls_applies,
    description: p.description ?? '',
    is_active: p.is_active,
  };
}

function formToPayload(f: ProfileFormData, isCreate: boolean) {
  const base: Record<string, unknown> = {
    connection_mode: f.connection_mode,
    max_connections: f.max_connections,
    allowed_schemas: f.allowed_schemas ? f.allowed_schemas.split(',').map(s => s.trim()).filter(Boolean) : [],
    allowed_tables: f.allowed_tables ? f.allowed_tables.split(',').map(s => s.trim()).filter(Boolean) : null,
    rls_applies: f.rls_applies,
    description: f.description || null,
  };
  if (isCreate) {
    base.profile_id = f.profile_id;
    base.pg_role = f.pg_role;
  } else {
    base.is_active = f.is_active;
  }
  return base;
}

function ProfileForm({ initial, isCreate, onSave, onCancel, saving, error }: {
  initial: ProfileFormData;
  isCreate: boolean;
  onSave: (data: ProfileFormData) => void;
  onCancel: () => void;
  saving: boolean;
  error: string;
}) {
  const [form, setForm] = useState(initial);
  const set = (k: keyof ProfileFormData, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <div className="card border-blue-200 bg-blue-50/30">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-slate-900">
          {isCreate ? 'Create New Profile' : `Edit: ${form.profile_id}`}
        </h3>
        <button onClick={onCancel} className="btn-ghost btn-sm"><X size={14} /></button>
      </div>
      <div className="card-body space-y-4">
        {error && (
          <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg p-3 text-sm">{error}</div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {isCreate && (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Profile ID</label>
                <input value={form.profile_id} onChange={e => set('profile_id', e.target.value)}
                  placeholder="pool:pe_readonly" className="input font-mono" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">PG Role</label>
                <input value={form.pg_role} onChange={e => set('pg_role', e.target.value)}
                  placeholder="nexus_pe_ro" className="input font-mono" />
              </div>
            </>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Connection Mode</label>
            <select value={form.connection_mode} onChange={e => set('connection_mode', e.target.value)} className="select">
              <option value="readonly">readonly</option>
              <option value="readwrite">readwrite</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Max Connections</label>
            <input type="number" value={form.max_connections} onChange={e => set('max_connections', Number(e.target.value))}
              min={1} max={100} className="input" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Allowed Schemas (comma-sep)</label>
            <input value={form.allowed_schemas} onChange={e => set('allowed_schemas', e.target.value)}
              placeholder="public, nexus" className="input font-mono" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Allowed Tables (comma-sep, empty=ALL)</label>
            <input value={form.allowed_tables} onChange={e => set('allowed_tables', e.target.value)}
              placeholder="lot_status, sales_order" className="input font-mono" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Description</label>
            <input value={form.description} onChange={e => set('description', e.target.value)}
              className="input" />
          </div>
          <div className="flex items-center gap-4 pt-5">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.rls_applies}
                onChange={e => set('rls_applies', e.target.checked)}
                className="rounded border-slate-300" />
              RLS Applies
            </label>
            {!isCreate && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.is_active}
                  onChange={e => set('is_active', e.target.checked)}
                  className="rounded border-slate-300" />
                Active
              </label>
            )}
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="btn-secondary btn-sm">Cancel</button>
          <button onClick={() => onSave(form)} disabled={saving} className="btn-primary btn-sm">
            {saving ? 'Saving...' : isCreate ? 'Create' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Profiles Section ── */

function ProfilesSection() {
  const [profiles, setProfiles] = useState<PoolProfile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<PoolAssignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<PoolProfile | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Assignment form
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [newSubjectId, setNewSubjectId] = useState('');

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setProfiles(await api.poolProfiles()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load profiles'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const loadAssignments = async (profileId: string) => {
    setSelected(profileId);
    try { setAssignments(await api.poolAssignments(profileId)); } catch { setAssignments([]); }
  };

  const handleSave = async (form: ProfileFormData) => {
    setSaving(true); setFormError('');
    try {
      const isCreate = !editingProfile;
      if (isCreate) {
        await api.poolProfileCreate(formToPayload(form, true) as Partial<PoolProfile>);
      } else {
        await api.poolProfileUpdate(editingProfile!.profile_id, formToPayload(form, false) as Partial<PoolProfile>);
      }
      setShowForm(false); setEditingProfile(null);
      await loadProfiles();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Save failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async (profileId: string) => {
    if (!confirm(`Delete profile "${profileId}"? This will soft-delete it.`)) return;
    try {
      await api.poolProfileDelete(profileId);
      if (selected === profileId) { setSelected(null); setAssignments([]); }
      await loadProfiles();
    } catch (e) { alert(e instanceof Error ? e.message : 'Delete failed'); }
  };

  const handleEdit = (p: PoolProfile) => {
    setEditingProfile(p); setShowForm(true); setFormError('');
  };

  const handleCreate = () => {
    setEditingProfile(null); setShowForm(true); setFormError('');
  };

  const handleAssign = async () => {
    if (!newSubjectId.trim() || !selected) return;
    try {
      await api.poolAssignmentCreate({ subject_id: newSubjectId.trim(), profile_id: selected });
      setNewSubjectId(''); setShowAssignForm(false);
      await loadAssignments(selected);
    } catch (e) { alert(e instanceof Error ? e.message : 'Assign failed'); }
  };

  const handleRemoveAssignment = async (assignmentId: number) => {
    if (!confirm('Remove this assignment?')) return;
    try {
      await api.poolAssignmentDelete(assignmentId);
      if (selected) await loadAssignments(selected);
    } catch (e) { alert(e instanceof Error ? e.message : 'Remove failed'); }
  };

  const modeStyle: Record<string, string> = {
    readonly: 'badge-green', readwrite: 'badge-amber', admin: 'badge-red',
  };

  return (
    <div className="space-y-4">
      {/* Create / Edit Form */}
      {showForm && (
        <ProfileForm
          initial={editingProfile ? profileToForm(editingProfile) : emptyForm}
          isCreate={!editingProfile}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingProfile(null); }}
          saving={saving}
          error={formError}
        />
      )}

      {/* Profiles Table */}
      <div className="card">
        <div className="card-header">
          <h3 className="text-sm font-semibold text-slate-900">Pool Profiles</h3>
          {!showForm && (
            <button onClick={handleCreate} className="btn-primary btn-sm gap-1">
              <Plus size={12} /> Create Profile
            </button>
          )}
        </div>
        {error && (
          <div className="card-body border-b border-slate-100">
            <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg p-3 text-sm">{error}</div>
          </div>
        )}
        {loading ? (
          <div className="card-body text-center py-12 text-slate-400">Loading profiles...</div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Profile ID</th><th>PG Role</th><th>Mode</th><th>Max Conn</th>
                  <th>RLS</th><th>Schemas</th><th>Tables</th><th>Assigned</th><th>Actions</th>
                </tr>
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
                      {p.rls_applies
                        ? <span className="badge badge-green text-[10px]">YES</span>
                        : <span className="text-slate-300">NO</span>}
                    </td>
                    <td className="text-xs">{p.allowed_schemas?.join(', ')}</td>
                    <td className="text-xs max-w-[180px] truncate">
                      {p.allowed_tables ? p.allowed_tables.join(', ') : <span className="text-slate-300">ALL</span>}
                    </td>
                    <td className="text-center font-medium">{p.assignment_count ?? '-'}</td>
                    <td className="text-center" onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1 justify-center">
                        <button onClick={() => handleEdit(p)} className="btn-ghost btn-sm p-1" title="Edit">
                          <Pencil size={13} className="text-slate-500 hover:text-blue-600" />
                        </button>
                        <button onClick={() => handleDelete(p.profile_id)} className="btn-ghost btn-sm p-1" title="Delete">
                          <Trash2 size={13} className="text-slate-500 hover:text-red-600" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Assignments for selected profile */}
      {selected && (
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              Assignments
              <ChevronRight size={14} className="text-slate-400" />
              <span className="code">{selected}</span>
            </h3>
            <button onClick={() => { setShowAssignForm(v => !v); setNewSubjectId(''); }}
              className="btn-primary btn-sm gap-1">
              <Plus size={12} /> Assign Subject
            </button>
          </div>
          <div className="card-body">
            {showAssignForm && (
              <div className="flex gap-2 items-end mb-4 pb-4 border-b border-slate-100">
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Subject ID</label>
                  <input value={newSubjectId} onChange={e => setNewSubjectId(e.target.value)}
                    placeholder="user:wang_pe" className="input font-mono"
                    onKeyDown={e => e.key === 'Enter' && handleAssign()} />
                </div>
                <button onClick={handleAssign} disabled={!newSubjectId.trim()} className="btn-primary btn-sm">Assign</button>
                <button onClick={() => setShowAssignForm(false)} className="btn-secondary btn-sm">Cancel</button>
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
                        <td>
                          <span className={`badge ${a.is_active ? 'badge-green' : 'badge-red'}`}>
                            {a.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="text-center">
                          <button onClick={() => handleRemoveAssignment(a.id)}
                            className="btn-ghost btn-sm p-1" title="Remove">
                            <Trash2 size={13} className="text-slate-500 hover:text-red-600" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Denied columns */}
            {profiles.find(p => p.profile_id === selected)?.denied_columns && (
              <div className="mt-4 pt-4 border-t border-slate-100">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Denied Columns</div>
                <div className="flex gap-2 flex-wrap">
                  {Object.entries(profiles.find(p => p.profile_id === selected)!.denied_columns!).map(([table, cols]) =>
                    (cols as string[]).map(col => (
                      <span key={`${table}.${col}`} className="badge badge-red text-[10px]">{table}.{col}</span>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Credentials Section ── */

function CredentialsSection() {
  const [creds, setCreds] = useState<PoolCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [rotatingRole, setRotatingRole] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [rotating, setRotating] = useState(false);

  const loadCreds = useCallback(async () => {
    setLoading(true);
    try { setCreds(await api.poolCredentials()); } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadCreds(); }, [loadCreds]);

  const handleRotate = async (pg_role: string) => {
    if (!newPassword.trim()) return;
    setRotating(true);
    try {
      await api.poolCredentialRotate(pg_role, newPassword);
      setRotatingRole(null); setNewPassword('');
      await loadCreds();
    } catch (e) { alert(e instanceof Error ? e.message : 'Rotate failed'); }
    finally { setRotating(false); }
  };

  return (
    <div className="card">
      {loading ? (
        <div className="card-body text-center py-12 text-slate-400">Loading...</div>
      ) : (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>PG Role</th><th>Status</th><th>Last Rotated</th><th>Rotate Interval</th><th>Actions</th></tr></thead>
            <tbody>
              {creds.map(c => (
                <tr key={c.pg_role}>
                  <td className="font-mono text-xs font-bold">{c.pg_role}</td>
                  <td>
                    <span className={`badge ${c.is_active ? 'badge-green' : 'badge-red'}`}>
                      {c.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="text-xs text-slate-500">{new Date(c.last_rotated).toLocaleString()}</td>
                  <td className="text-xs">
                    {typeof c.rotate_interval === 'object' && c.rotate_interval
                      ? `${(c.rotate_interval as Record<string, number>).days ?? 0} days`
                      : String(c.rotate_interval)}
                  </td>
                  <td>
                    {rotatingRole === c.pg_role ? (
                      <div className="flex gap-2 items-center">
                        <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                          placeholder="New password" className="input text-xs w-36"
                          onKeyDown={e => e.key === 'Enter' && handleRotate(c.pg_role)} />
                        <button onClick={() => handleRotate(c.pg_role)} disabled={rotating || !newPassword.trim()}
                          className="btn-primary btn-sm">
                          {rotating ? '...' : 'Confirm'}
                        </button>
                        <button onClick={() => { setRotatingRole(null); setNewPassword(''); }}
                          className="btn-ghost btn-sm"><X size={14} /></button>
                      </div>
                    ) : (
                      <button onClick={() => { setRotatingRole(c.pg_role); setNewPassword(''); }}
                        className="btn-secondary btn-sm gap-1">
                        <RotateCw size={12} /> Rotate
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
  );
}

/* ── Sync Section ── */

function SyncSection() {
  const [grantResult, setGrantResult] = useState<{ action: string; detail: string }[] | null>(null);
  const [pgbouncerConfig, setPgbouncerConfig] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">DB Grant Sync</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Run <span className="code">authz_sync_db_grants()</span> to sync PG roles and GRANT statements
            </p>
          </div>
          <button onClick={async () => {
            setLoading('grants');
            try { setGrantResult((await api.poolSyncGrants()).actions); } catch { /* ignore */ }
            setLoading(null);
          }} disabled={loading === 'grants'} className="btn-primary btn-sm">
            <Play size={12} /> {loading === 'grants' ? 'Syncing...' : 'Sync Grants'}
          </button>
        </div>
        {grantResult && (
          grantResult.length === 0 ? (
            <div className="card-body text-sm text-slate-400">Already in sync</div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead><tr><th>Action</th><th>Detail</th></tr></thead>
                <tbody>
                  {grantResult.map((r, i) => (
                    <tr key={i}>
                      <td className="font-mono text-xs">{r.action}</td>
                      <td className="text-xs text-slate-600">{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">PgBouncer Config</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Generate <span className="code">pgbouncer.ini</span> from active pool profiles
            </p>
          </div>
          <button onClick={async () => {
            setLoading('pgbouncer');
            try { setPgbouncerConfig((await api.poolSyncPgbouncer()).config); } catch { /* ignore */ }
            setLoading(null);
          }} disabled={loading === 'pgbouncer'} className="btn-primary btn-sm">
            <Play size={12} /> {loading === 'pgbouncer' ? 'Generating...' : 'Generate'}
          </button>
        </div>
        {pgbouncerConfig && (
          <div className="card-body">
            <pre className="bg-slate-900 text-emerald-400 p-4 rounded-lg text-xs overflow-auto max-h-64 leading-relaxed">
              {pgbouncerConfig}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
