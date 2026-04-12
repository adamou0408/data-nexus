import { useState, useEffect } from 'react';
import { api, PoolProfile, PoolAssignment, PoolCredential } from '../api';
import { Server, Key, RefreshCw, Play, ChevronRight } from 'lucide-react';

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

function ProfilesSection() {
  const [profiles, setProfiles] = useState<PoolProfile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<PoolAssignment[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.poolProfiles().then(setProfiles).finally(() => setLoading(false));
  }, []);

  const loadAssignments = async (profileId: string) => {
    setSelected(profileId);
    try { setAssignments(await api.poolAssignments(profileId)); } catch { /* ignore */ }
  };

  const modeStyle: Record<string, string> = {
    readonly: 'badge-green', readwrite: 'badge-amber', admin: 'badge-red',
  };

  return (
    <div className="space-y-4">
      <div className="card">
        {loading ? (
          <div className="card-body text-center py-12 text-slate-400">Loading profiles...</div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Profile ID</th><th>PG Role</th><th>Mode</th><th>Max Conn</th>
                  <th>RLS</th><th>Schemas</th><th>Tables</th><th>Assigned</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map(p => (
                  <tr key={p.profile_id}
                    className={`cursor-pointer ${selected === p.profile_id ? '!bg-blue-50' : ''}`}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              Assignments
              <ChevronRight size={14} className="text-slate-400" />
              <span className="code">{selected}</span>
            </h3>
          </div>
          <div className="card-body">
            {assignments.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">No assignments</p>
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead><tr><th>Subject ID</th><th>Name</th><th>Granted By</th><th>Status</th></tr></thead>
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

function CredentialsSection() {
  const [creds, setCreds] = useState<PoolCredential[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.poolCredentials().then(setCreds).finally(() => setLoading(false));
  }, []);

  return (
    <div className="card">
      {loading ? (
        <div className="card-body text-center py-12 text-slate-400">Loading...</div>
      ) : (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>PG Role</th><th>Status</th><th>Last Rotated</th><th>Rotate Interval</th></tr></thead>
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
                  <td className="text-xs">{c.rotate_interval}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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
