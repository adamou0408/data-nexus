import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuthz } from '../AuthzContext';
import {
  BarChart3, ExternalLink, Database, Shield, Loader2,
  CheckCircle2, XCircle, RefreshCw, Copy, Check,
} from 'lucide-react';

type MetabaseInfo = {
  metabase_url: string;
  pgbouncer: { host: string; port: number };
  connections: {
    profile_id: string;
    pg_role: string;
    description: string;
    data_source: string;
    database: string;
    metabase_config: { engine: string; host: string; port: number; dbname: string; user: string };
    access_scope: { allowed_tables: string[] | null; denied_columns: unknown; connection_mode: string };
  }[];
};

// ============================================================
// MetabaseTab — BI integration hub
// SSOT: connection info from authz_db_pool_profile + authz_data_source
// Metabase URL from env (METABASE_URL)
// ============================================================

export function MetabaseTab() {
  const { user, config } = useAuthz();
  const [info, setInfo] = useState<MetabaseInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [metabaseStatus, setMetabaseStatus] = useState<'checking' | 'ok' | 'down'>('checking');
  const [copied, setCopied] = useState<string | null>(null);

  const isAdmin = config?.resolved_roles?.some(r => r === 'ADMIN' || r === 'AUTHZ_ADMIN') ?? false;

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    api.poolMetabaseConnections()
      .then(setInfo)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isAdmin]);

  // Check Metabase health
  useEffect(() => {
    if (!info) return;
    setMetabaseStatus('checking');
    fetch(`${info.metabase_url}/api/health`)
      .then(r => r.json())
      .then(d => setMetabaseStatus(d.status === 'ok' ? 'ok' : 'down'))
      .catch(() => setMetabaseStatus('down'));
  }, [info]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  // Determine which pool role the current user maps to (SSOT from roles)
  const userRoles = config?.resolved_roles || [];
  const rolePoolMap: Record<string, string> = {
    PE: 'nexus_pe_ro', OP: 'nexus_pe_ro',
    SALES: 'nexus_sales_ro', FAE: 'nexus_sales_ro',
    QA: 'nexus_bi_ro', PM: 'nexus_bi_ro', RD: 'nexus_bi_ro', FW: 'nexus_bi_ro',
    ADMIN: 'nexus_admin_full', AUTHZ_ADMIN: 'nexus_admin_full',
  };
  const userPoolRole = userRoles.map(r => rolePoolMap[r]).find(Boolean) || 'nexus_bi_ro';

  if (!user) {
    return (
      <div className="text-center py-16 text-slate-400">
        <BarChart3 size={48} className="mx-auto mb-4 opacity-50" />
        <p className="text-lg font-medium">Metabase BI</p>
        <p className="text-sm mt-1">Select a user to view BI integration</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Metabase BI</h1>
        <p className="page-desc">
          Self-service analytics — dashboards, ad-hoc queries, and scheduled reports.
          Permissions enforced by PG native GRANT + RLS (SSOT).
        </p>
      </div>

      {/* Quick Access Card */}
      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold">Quick Access</h2>
          <div className="flex items-center gap-2">
            {metabaseStatus === 'checking' && <Loader2 size={14} className="animate-spin text-slate-400" />}
            {metabaseStatus === 'ok' && <CheckCircle2 size={14} className="text-emerald-500" />}
            {metabaseStatus === 'down' && <XCircle size={14} className="text-red-500" />}
            <span className="text-xs text-slate-500">
              {metabaseStatus === 'ok' ? 'Metabase Online' : metabaseStatus === 'down' ? 'Metabase Offline' : 'Checking...'}
            </span>
          </div>
        </div>
        <div className="card-body">
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <div className="flex-1">
              <p className="text-sm text-slate-600 mb-3">
                You are logged in as <span className="font-semibold">{user.label}</span> with roles{' '}
                {userRoles.map(r => (
                  <span key={r} className="badge badge-blue text-[10px] mx-0.5">{r}</span>
                ))}
              </p>
              <p className="text-xs text-slate-500">
                Your Metabase connection uses pool role <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{userPoolRole}</code> —
                data is automatically filtered and masked by PG RLS + column REVOKE (SSOT from AuthZ).
              </p>
            </div>
            <a
              href={info?.metabase_url || 'http://localhost:3100'}
              target="_blank"
              rel="noopener noreferrer"
              className={`btn-primary flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium shrink-0
                ${metabaseStatus === 'down' ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <BarChart3 size={16} />
              Open Metabase
              <ExternalLink size={14} />
            </a>
          </div>
        </div>
      </div>

      {/* Path C Security */}
      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold">Path C Security (SSOT)</h2>
          <Shield size={14} className="text-blue-500" />
        </div>
        <div className="card-body">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="bg-emerald-50 rounded-lg p-3 border border-emerald-200">
              <div className="font-semibold text-emerald-700 mb-1">L0 Table Access</div>
              <p className="text-emerald-600">PG GRANT controls which tables each role can SELECT. No Metabase permission layer — PG is SSOT.</p>
            </div>
            <div className="bg-amber-50 rounded-lg p-3 border border-amber-200">
              <div className="font-semibold text-amber-700 mb-1">L0 Column Deny</div>
              <p className="text-amber-600">Column-level REVOKE hides sensitive columns (cost, margin). Query blocked at PG level.</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
              <div className="font-semibold text-blue-700 mb-1">L1 Row Filter</div>
              <p className="text-blue-600">RLS policies filter rows by role identity. Application-layer authz_filter() for advanced rules.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Admin: Connection Templates (SSOT from pool profiles) */}
      {isAdmin && info && (
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold">Connection Templates (from Pool Profiles)</h2>
            <button
              onClick={() => { setLoading(true); api.poolMetabaseConnections().then(setInfo).finally(() => setLoading(false)); }}
              className="btn-secondary btn-sm"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {loading ? (
            <div className="card-body text-center py-8 text-slate-400">
              <Loader2 size={20} className="animate-spin mx-auto mb-2" /> Loading...
            </div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Pool Profile</th>
                    <th>PG Role</th>
                    <th>Mode</th>
                    <th>Metabase DB Config</th>
                    <th>Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {info.connections.map((c) => {
                    const configJson = JSON.stringify(c.metabase_config, null, 2);
                    const isCopied = copied === c.profile_id;
                    return (
                      <tr key={c.profile_id}>
                        <td>
                          <div className="font-mono text-xs font-bold text-slate-900">{c.profile_id}</div>
                          <div className="text-xs text-slate-500">{c.description}</div>
                        </td>
                        <td className="font-mono text-xs">{c.pg_role}</td>
                        <td><span className="badge badge-slate text-[10px]">{c.access_scope.connection_mode}</span></td>
                        <td>
                          <div className="flex items-start gap-2">
                            <pre className="text-[10px] bg-slate-50 rounded p-2 border max-w-xs overflow-auto">
                              {`host: ${c.metabase_config.host}\nport: ${c.metabase_config.port}\ndb:   ${c.metabase_config.dbname}\nuser: ${c.metabase_config.user}`}
                            </pre>
                            <button
                              onClick={() => copyToClipboard(configJson, c.profile_id)}
                              className="btn-secondary p-1 shrink-0"
                              title="Copy JSON config"
                            >
                              {isCopied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                            </button>
                          </div>
                        </td>
                        <td>
                          {c.access_scope.denied_columns && typeof c.access_scope.denied_columns === 'object' && Object.keys(c.access_scope.denied_columns as Record<string, unknown>).length > 0 ? (
                            <div className="text-[10px] text-amber-600">
                              {Object.entries(c.access_scope.denied_columns as Record<string, string[]>).map(([table, cols]) => (
                                <div key={table}>{table}: {Array.isArray(cols) ? cols.join(', ') : String(cols)}</div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Full access</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-body border-t bg-slate-50">
            <p className="text-xs text-slate-500">
              <Database size={12} className="inline mr-1" />
              pgbouncer: <code className="bg-white px-1 rounded">{info.pgbouncer.host}:{info.pgbouncer.port}</code>
              {' | '}
              Metabase: <code className="bg-white px-1 rounded">{info.metabase_url}</code>
              {' | '}
              Passwords: see <code className="bg-white px-1 rounded">pgbouncer/userlist.txt</code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
