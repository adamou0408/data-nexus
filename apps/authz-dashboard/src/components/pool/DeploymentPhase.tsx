import { useState } from 'react';
import { api, SyncAction, DriftItem } from '../../api';
import { useToast } from '../Toast';
import { ConfirmState, DangerConfirmModal } from './shared';
import { Play, Search, RefreshCw } from 'lucide-react';

export function DeploymentPhase({ dsId, onMutate }: { dsId: string; onMutate: () => void }) {
  const toast = useToast();
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [extActions, setExtActions] = useState<SyncAction[] | null>(null);
  const [driftItems, setDriftItems] = useState<DriftItem[] | null>(null);
  const [grantResult, setGrantResult] = useState<{ action: string; detail: string }[] | null>(null);
  const [pgbouncerConfig, setPgbouncerConfig] = useState<string | null>(null);
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);

  const handleExternalSync = () => {
    setDangerConfirm({
      title: 'Sync External DB Grants',
      message: `This will sync roles and grants to the data source "${dsId}".`,
      impact: 'Roles will be created, passwords set, and GRANT/REVOKE executed on the remote database.',
      onConfirm: async () => {
        setLoading(prev => ({ ...prev, 'ext-sync': true }));
        try {
          const result = await api.poolSyncExternalGrants(dsId);
          setExtActions(result.actions);
          onMutate();
        } catch (e) {
          setExtActions([{ action: 'ERROR', detail: String(e), data_source_id: dsId, profile_id: '', status: 'error', error: String(e) }]);
        }
        setLoading(prev => ({ ...prev, 'ext-sync': false }));
      },
    });
  };

  const handleCheckDrift = async () => {
    setLoading(prev => ({ ...prev, 'ext-drift': true }));
    try {
      const report = await api.poolSyncExternalDrift(dsId);
      setDriftItems(report.items);
    } catch (e) {
      setDriftItems([{ pg_role: '-', type: 'role_missing', detail: `Error: ${String(e)}` }]);
    }
    setLoading(prev => ({ ...prev, 'ext-drift': false }));
  };

  const handleSyncGrants = () => {
    setDangerConfirm({
      title: 'Sync DB Grants',
      message: 'This will execute authz_sync_db_grants() to create/modify PG roles and GRANT/REVOKE permissions.',
      impact: 'Active database sessions may experience permission changes mid-query.',
      onConfirm: async () => {
        setLoading(prev => ({ ...prev, grants: true }));
        try { setGrantResult((await api.poolSyncGrants()).actions); onMutate(); } catch (err) { toast.error('Sync local grants failed'); console.warn(err); }
        setLoading(prev => ({ ...prev, grants: false }));
      },
    });
  };

  const handleApplyReload = () => {
    setDangerConfirm({
      title: 'Apply PgBouncer Config & Reload',
      message: 'This will overwrite pgbouncer.ini and send a HUP signal to reload.',
      impact: 'PgBouncer will close idle connections and re-read the config.',
      onConfirm: async () => {
        setLoading(prev => ({ ...prev, 'pgbouncer-apply': true }));
        try {
          const result = await api.poolSyncPgbouncerApply();
          setPgbouncerConfig(`Applied: ${result.config_path}\nReload: ${result.reload}`);
        } catch (e) { setPgbouncerConfig(`Error: ${String(e)}`); }
        setLoading(prev => ({ ...prev, 'pgbouncer-apply': false }));
      },
    });
  };

  return (
    <div className="space-y-4">
      {!extActions && !driftItems && !grantResult && !pgbouncerConfig && (
        <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 border border-slate-200">
          <span className="font-medium">Deploy permissions to external databases.</span> "Sync to Remote DB" pushes GRANT/REVOKE to the target. "Check Drift" compares remote state with SSOT. "Sync Local Grants" applies roles inside the AuthZ database. "PgBouncer" manages connection pool routing.
        </div>
      )}

      {/* External DB Sync (primary action) */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={handleExternalSync} disabled={loading['ext-sync']} className="btn-primary btn-sm gap-1">
          {loading['ext-sync'] ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />} {loading['ext-sync'] ? 'Syncing...' : 'Sync to Remote DB'}
        </button>
        <button onClick={handleCheckDrift} disabled={loading['ext-drift']}
          className="btn btn-sm bg-amber-600 text-white hover:bg-amber-700 gap-1">
          {loading['ext-drift'] ? <RefreshCw size={12} className="animate-spin" /> : <Search size={12} />} {loading['ext-drift'] ? 'Checking...' : 'Check Drift'}
        </button>
        <button onClick={handleSyncGrants} disabled={loading['grants']} className="btn-secondary btn-sm gap-1">
          {loading['grants'] ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />} {loading['grants'] ? 'Syncing...' : 'Sync Local Grants'}
        </button>
        <button onClick={async () => {
          setLoading(prev => ({ ...prev, pgbouncer: true }));
          try { setPgbouncerConfig((await api.poolSyncPgbouncer()).config); } catch (err) { toast.error('PgBouncer preview failed'); console.warn(err); }
          setLoading(prev => ({ ...prev, pgbouncer: false }));
        }} disabled={loading['pgbouncer']} className="btn-secondary btn-sm gap-1">
          <Play size={12} /> {loading['pgbouncer'] ? 'Generating...' : 'PgBouncer Preview'}
        </button>
        <button onClick={handleApplyReload} disabled={loading['pgbouncer-apply']}
          className="btn btn-sm bg-emerald-600 text-white hover:bg-emerald-700 gap-1">
          {loading['pgbouncer-apply'] ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />} {loading['pgbouncer-apply'] ? 'Applying...' : 'Apply & Reload PgBouncer'}
        </button>
      </div>

      {/* External sync results */}
      {extActions && (
        extActions.length === 0 ? (
          <div className="text-sm text-slate-400">No external profiles to sync</div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Action</th><th>Detail</th><th>Profile</th><th>Status</th></tr></thead>
              <tbody>
                {extActions.map((a, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs">{a.action}</td>
                    <td className="text-xs text-slate-600 max-w-xs truncate">{a.detail}</td>
                    <td className="text-xs">{a.profile_id}</td>
                    <td>
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        a.status === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                      }`}>{a.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Drift results */}
      {driftItems && (
        driftItems.length === 0 ? (
          <div className="text-sm text-emerald-600 font-medium">No drift detected — remote DB matches SSOT</div>
        ) : (
          <div className="table-container">
            <div className="text-xs font-semibold text-amber-700 mb-1">Drift Report ({driftItems.length} items)</div>
            <table className="table">
              <thead><tr><th>Role</th><th>Type</th><th>Detail</th></tr></thead>
              <tbody>
                {driftItems.map((d, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs">{d.pg_role}</td>
                    <td>
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        d.type === 'role_missing' ? 'bg-red-100 text-red-700' :
                        d.type === 'grant_missing' ? 'bg-amber-100 text-amber-700' :
                        'bg-blue-100 text-blue-700'
                      }`}>{d.type}</span>
                    </td>
                    <td className="text-xs text-slate-600">{d.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Local grant sync results */}
      {grantResult && (
        grantResult.length === 0 ? (
          <div className="text-sm text-slate-400">Already in sync</div>
        ) : (
          <div className="table-container">
            <div className="text-xs font-semibold text-slate-700 mb-1">Local Grant Sync</div>
            <table className="table">
              <thead><tr><th>Action</th><th>Detail</th></tr></thead>
              <tbody>
                {grantResult.map((r, i) => (
                  <tr key={i}><td className="font-mono text-xs">{r.action}</td><td className="text-xs text-slate-600">{r.detail}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* PgBouncer config */}
      {pgbouncerConfig && (
        <pre className="bg-slate-900 text-emerald-400 p-4 rounded-lg text-xs overflow-auto max-h-64 leading-relaxed">
          {pgbouncerConfig}
        </pre>
      )}

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}
