import { useState, useEffect } from 'react';
import { api, PoolProfile, PoolAssignment, PoolCredential } from '../api';

type Section = 'profiles' | 'credentials' | 'sync';

export function PoolTab() {
  const [section, setSection] = useState<Section>('profiles');

  const sections: { id: Section; label: string }[] = [
    { id: 'profiles', label: 'Pool Profiles' },
    { id: 'credentials', label: 'Credentials' },
    { id: 'sync', label: 'Sync Operations' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              section === s.id ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border hover:bg-gray-50'
            }`}>
            {s.label}
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

  const load = async () => {
    setLoading(true);
    try { setProfiles(await api.poolProfiles()); } catch { /* ignore */ }
    setLoading(false);
  };

  const loadAssignments = async (profileId: string) => {
    setSelected(profileId);
    try { setAssignments(await api.poolAssignments(profileId)); } catch { /* ignore */ }
  };

  useEffect(() => { load(); }, []);

  const modeColor = (mode: string) =>
    mode === 'readonly' ? 'bg-green-100 text-green-700' :
    mode === 'readwrite' ? 'bg-amber-100 text-amber-700' :
    'bg-red-100 text-red-700';

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow">
        {loading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b text-left">
                <th className="p-3">Profile ID</th>
                <th className="p-3">PG Role</th>
                <th className="p-3">Mode</th>
                <th className="p-3">Max Conn</th>
                <th className="p-3">RLS</th>
                <th className="p-3">Schemas</th>
                <th className="p-3">Tables</th>
                <th className="p-3">Assignments</th>
                <th className="p-3">Description</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.profile_id} className={`border-t hover:bg-gray-50 cursor-pointer ${
                  selected === p.profile_id ? 'bg-blue-50' : ''
                }`} onClick={() => loadAssignments(p.profile_id)}>
                  <td className="p-3 font-mono text-xs font-bold">{p.profile_id}</td>
                  <td className="p-3 font-mono text-xs">{p.pg_role}</td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${modeColor(p.connection_mode)}`}>
                      {p.connection_mode}
                    </span>
                  </td>
                  <td className="p-3 text-center">{p.max_connections}</td>
                  <td className="p-3 text-center">
                    {p.rls_applies
                      ? <span className="text-green-600 font-bold text-xs">YES</span>
                      : <span className="text-gray-400 text-xs">NO</span>}
                  </td>
                  <td className="p-3 text-xs">{p.allowed_schemas?.join(', ')}</td>
                  <td className="p-3 text-xs max-w-[200px] truncate">
                    {p.allowed_tables ? p.allowed_tables.join(', ') : <span className="text-gray-400">ALL</span>}
                  </td>
                  <td className="p-3 text-center">{p.assignment_count ?? '-'}</td>
                  <td className="p-3 text-xs text-gray-500 max-w-[200px] truncate">{p.description ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold text-sm text-gray-600 mb-3">
            Assignments for <code className="bg-gray-100 px-2 py-0.5 rounded">{selected}</code>
          </h3>
          {assignments.length === 0 ? (
            <p className="text-gray-400 text-sm">No assignments</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-left">
                  <th className="p-2">Subject ID</th>
                  <th className="p-2">Display Name</th>
                  <th className="p-2">Granted By</th>
                  <th className="p-2">Active</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map(a => (
                  <tr key={a.id} className="border-t">
                    <td className="p-2 font-mono text-xs">{a.subject_id}</td>
                    <td className="p-2">{a.subject_name}</td>
                    <td className="p-2 text-xs text-gray-500">{a.granted_by}</td>
                    <td className="p-2">
                      {a.is_active
                        ? <span className="text-green-600 text-xs font-bold">Active</span>
                        : <span className="text-red-600 text-xs">Inactive</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Denied columns */}
          {profiles.find(p => p.profile_id === selected)?.denied_columns && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-gray-500 mb-2">Denied Columns</h4>
              <div className="flex gap-2 flex-wrap">
                {Object.entries(profiles.find(p => p.profile_id === selected)!.denied_columns!).map(([table, cols]) =>
                  cols.map(col => (
                    <span key={`${table}.${col}`} className="bg-red-50 text-red-700 px-2 py-0.5 rounded text-xs border border-red-200">
                      {table}.{col}
                    </span>
                  ))
                )}
              </div>
            </div>
          )}
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
    <div className="bg-white rounded-lg shadow">
      {loading ? (
        <div className="p-8 text-center text-gray-400">Loading...</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b text-left">
              <th className="p-3">PG Role</th>
              <th className="p-3">Active</th>
              <th className="p-3">Last Rotated</th>
              <th className="p-3">Rotate Interval</th>
            </tr>
          </thead>
          <tbody>
            {creds.map(c => (
              <tr key={c.pg_role} className="border-t hover:bg-gray-50">
                <td className="p-3 font-mono text-xs font-bold">{c.pg_role}</td>
                <td className="p-3">
                  {c.is_active
                    ? <span className="text-green-600 text-xs font-bold">Active</span>
                    : <span className="text-red-600 text-xs">Inactive</span>}
                </td>
                <td className="p-3 text-xs">{new Date(c.last_rotated).toLocaleString()}</td>
                <td className="p-3 text-xs">{c.rotate_interval}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SyncSection() {
  const [grantResult, setGrantResult] = useState<{ action: string; detail: string }[] | null>(null);
  const [pgbouncerConfig, setPgbouncerConfig] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const syncGrants = async () => {
    setLoading('grants');
    try {
      const r = await api.poolSyncGrants();
      setGrantResult(r.actions);
    } catch { /* ignore */ }
    setLoading(null);
  };

  const syncPgbouncer = async () => {
    setLoading('pgbouncer');
    try {
      const r = await api.poolSyncPgbouncer();
      setPgbouncerConfig(r.config);
    } catch { /* ignore */ }
    setLoading(null);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold mb-3">DB Grant Sync</h3>
        <p className="text-sm text-gray-500 mb-4">
          Run <code className="bg-gray-100 px-1 rounded">authz_sync_db_grants()</code> to create PG roles and apply GRANT statements based on pool profiles.
        </p>
        <button onClick={syncGrants} disabled={loading === 'grants'}
          className="bg-amber-600 text-white px-6 py-2 rounded-md hover:bg-amber-700 disabled:opacity-50">
          {loading === 'grants' ? 'Syncing...' : 'Sync DB Grants'}
        </button>
        {grantResult && (
          <div className="mt-4">
            {grantResult.length === 0 ? (
              <p className="text-gray-400 text-sm">No actions performed (already in sync)</p>
            ) : (
              <table className="w-full text-sm mt-2">
                <thead><tr className="bg-gray-50 border-b"><th className="p-2 text-left">Action</th><th className="p-2 text-left">Detail</th></tr></thead>
                <tbody>
                  {grantResult.map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2 font-mono text-xs">{r.action}</td>
                      <td className="p-2 text-xs">{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold mb-3">PgBouncer Config Generator</h3>
        <p className="text-sm text-gray-500 mb-4">
          Generate <code className="bg-gray-100 px-1 rounded">pgbouncer.ini</code> from active pool profiles.
        </p>
        <button onClick={syncPgbouncer} disabled={loading === 'pgbouncer'}
          className="bg-indigo-600 text-white px-6 py-2 rounded-md hover:bg-indigo-700 disabled:opacity-50">
          {loading === 'pgbouncer' ? 'Generating...' : 'Generate Config'}
        </button>
        {pgbouncerConfig && (
          <pre className="mt-4 bg-gray-900 text-green-300 p-4 rounded-lg text-xs overflow-auto max-h-64">
            {pgbouncerConfig}
          </pre>
        )}
      </div>
    </div>
  );
}
