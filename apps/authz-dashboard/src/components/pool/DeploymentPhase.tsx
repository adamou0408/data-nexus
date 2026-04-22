import { useState } from 'react';
import { api, SyncAction, DriftItem, LifecycleResponse } from '../../api';
import { useToast } from '../Toast';
import { ConfirmState, DangerConfirmModal } from './shared';
import { Play, Search, RefreshCw, Check, Eye, ChevronDown, ChevronRight, Clock, AlertTriangle } from 'lucide-react';

type StepId = 'local-grants' | 'ext-sync' | 'drift' | 'pgbouncer';

function RelativeTime({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-slate-400">Never</span>;
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  let text: string;
  if (mins < 1) text = 'just now';
  else if (mins < 60) text = `${mins}m ago`;
  else if (hrs < 24) text = `${hrs}h ago`;
  else text = `${days}d ago`;
  return <span className="text-slate-500" title={d.toLocaleString()}>{text}</span>;
}

export function DeploymentPhase({ dsId, lifecycle, onMutate }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void }) {
  const toast = useToast();
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [extActions, setExtActions] = useState<SyncAction[] | null>(null);
  const [driftItems, setDriftItems] = useState<DriftItem[] | null>(null);
  const [grantResult, setGrantResult] = useState<{ action: string; detail: string }[] | null>(null);
  const [pgbouncerConfig, setPgbouncerConfig] = useState<string | null>(null);
  const [pgbouncerApplyResult, setPgbouncerApplyResult] = useState<string | null>(null);
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const [expandedStep, setExpandedStep] = useState<StepId | null>(null);

  const lastSync = lifecycle.phases.deployment.last_sync;
  // Step 1 (Sync Local Grants) is a GLOBAL operation: it processes every local profile
  // (data_source_id IS NULL or 'ds:local') regardless of which DS lifecycle the user is
  // viewing. From an external DS like ds:pg_k8 it's still safe to click — the action just
  // won't touch this DS's profile (Step 2 does that). We surface a banner instead of
  // hiding/disabling so users can re-run from any lifecycle page.
  const stepLocalGrantsTouchesThisDs = dsId === 'ds:local';

  const handleSyncGrants = () => {
    setDangerConfirm({
      title: 'Sync Local DB Grants',
      message: 'This will execute authz_sync_db_grants() to create/modify PG roles and GRANT/REVOKE permissions inside the AuthZ database.',
      impact: 'Active database sessions may experience permission changes mid-query.',
      onConfirm: async () => {
        setLoading(prev => ({ ...prev, 'local-grants': true }));
        try { setGrantResult((await api.poolSyncGrants()).actions); onMutate(); } catch (err) { toast.error('Sync local grants failed'); console.warn(err); }
        setLoading(prev => ({ ...prev, 'local-grants': false }));
      },
    });
  };

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
    setLoading(prev => ({ ...prev, drift: true }));
    try {
      const report = await api.poolSyncExternalDrift(dsId);
      setDriftItems(report.items);
    } catch (e) {
      setDriftItems([{ pg_role: '-', type: 'role_missing', detail: `Error: ${String(e)}` }]);
    }
    setLoading(prev => ({ ...prev, drift: false }));
  };

  const handlePgbouncerPreview = async () => {
    setLoading(prev => ({ ...prev, pgbouncer: true }));
    try { setPgbouncerConfig((await api.poolSyncPgbouncer()).config); } catch (err) { toast.error('PgBouncer preview failed'); console.warn(err); }
    setLoading(prev => ({ ...prev, pgbouncer: false }));
  };

  const handleApplyReload = () => {
    setDangerConfirm({
      title: 'Apply PgBouncer Config & Reload',
      message: 'This will overwrite pgbouncer.ini and send a HUP signal to reload.',
      impact: 'PgBouncer will close idle connections and re-read the config. Active queries may be interrupted.',
      onConfirm: async () => {
        setLoading(prev => ({ ...prev, 'pgbouncer-apply': true }));
        try {
          const result = await api.poolSyncPgbouncerApply();
          setPgbouncerApplyResult(`Applied: ${result.config_path}\nReload: ${result.reload}`);
        } catch (e) { setPgbouncerApplyResult(`Error: ${String(e)}`); }
        setLoading(prev => ({ ...prev, 'pgbouncer-apply': false }));
      },
    });
  };

  const toggleStep = (id: StepId) => setExpandedStep(expandedStep === id ? null : id);

  /* ── Step definitions ── */
  const steps: {
    id: StepId;
    num: number;
    title: string;
    desc: string;
    optional?: boolean;
    status: 'pending' | 'done' | 'warning';
    statusText: string;
  }[] = [
    {
      id: 'local-grants',
      num: 1,
      title: 'Sync Local Grants',
      desc: 'Create PG roles and apply GRANT/REVOKE inside the AuthZ database.',
      status: grantResult ? 'done' : 'pending',
      statusText: grantResult ? `${grantResult.length} actions applied` : 'Not run this session',
    },
    {
      id: 'ext-sync',
      num: 2,
      title: 'Sync Grants to Remote DB',
      desc: 'Push roles, passwords, GRANT/REVOKE to the external data source.',
      status: extActions ? (extActions.some(a => a.status === 'error') ? 'warning' : 'done') : lastSync ? 'done' : 'pending',
      statusText: extActions
        ? `${extActions.filter(a => a.status === 'ok').length} ok, ${extActions.filter(a => a.status === 'error').length} errors`
        : lastSync ? 'Last sync: ' : 'Never synced',
    },
    {
      id: 'drift',
      num: 3,
      title: 'Check Drift',
      desc: 'Compare remote DB state with SSOT to detect manual changes.',
      optional: true,
      status: driftItems ? (driftItems.length === 0 ? 'done' : 'warning') : 'pending',
      statusText: driftItems
        ? driftItems.length === 0 ? 'No drift — remote matches SSOT' : `${driftItems.length} drift(s) detected`
        : 'Not checked',
    },
    {
      id: 'pgbouncer',
      num: 4,
      title: 'Apply PgBouncer Config',
      desc: 'Generate pgbouncer.ini from SSOT and reload the connection pooler.',
      status: pgbouncerApplyResult ? 'done' : 'pending',
      statusText: pgbouncerApplyResult ? 'Config applied & reloaded' : 'Not applied this session',
    },
  ];

  return (
    <div className="space-y-3">
      {/* Overall status bar */}
      <div className="flex items-center gap-3 text-xs bg-slate-50 rounded-lg px-4 py-2.5 border border-slate-200">
        <Clock size={14} className="text-slate-400 shrink-0" />
        <span className="text-slate-500">Last external sync:</span>
        <RelativeTime iso={lastSync} />
        <span className="text-slate-300 mx-1">|</span>
        <span className="text-slate-500">Follow steps 1→4 in order for a clean deployment.</span>
      </div>

      {/* Ordered steps */}
      <div className="space-y-2">
        {steps.map(step => {
          const isExpanded = expandedStep === step.id;
          const StepIcon = isExpanded ? ChevronDown : ChevronRight;
          const statusColor = step.status === 'done' ? 'bg-emerald-500' : step.status === 'warning' ? 'bg-amber-500' : 'bg-slate-300';
          const statusBadge = step.status === 'done' ? 'badge-green' : step.status === 'warning' ? 'badge-amber' : 'badge-slate';

          return (
            <div key={step.id} className="border border-slate-200 rounded-lg overflow-hidden">
              {/* Step header */}
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors"
                onClick={() => toggleStep(step.id)}
              >
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  step.status === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}>
                  {step.status === 'done' ? <Check size={14} /> : step.num}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{step.title}</span>
                    {step.optional && <span className="text-[10px] text-slate-400 italic">optional</span>}
                    <span className={`badge text-[10px] ${statusBadge}`}>
                      {step.status === 'done' ? 'Done' : step.status === 'warning' ? 'Warning' : 'Pending'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${statusColor} shrink-0`} />
                    {step.statusText}
                    {step.id === 'ext-sync' && lastSync && !extActions && <RelativeTime iso={lastSync} />}
                  </div>
                </div>
                <StepIcon size={16} className="text-slate-400 shrink-0" />
              </div>

              {/* Step body */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-3">
                  <div className="text-xs text-slate-500">{step.desc}</div>

                  {/* Step 1: Local grants */}
                  {step.id === 'local-grants' && (
                    <>
                      {!stepLocalGrantsTouchesThisDs && (
                        <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
                          <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                          <div>
                            <strong>Global operation.</strong> This processes all profiles bound to <code className="font-mono bg-amber-100 px-1 rounded">ds:local</code> (the AuthZ DB itself). Profiles on the current data source <code className="font-mono bg-amber-100 px-1 rounded">{dsId}</code> are <strong>not</strong> affected — they're handled by Step 2 below. Re-running here is safe (idempotent) but won't change anything for this DS.
                          </div>
                        </div>
                      )}
                      <button onClick={handleSyncGrants} disabled={loading['local-grants']} className="btn-primary btn-sm gap-1">
                        {loading['local-grants'] ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
                        {loading['local-grants'] ? 'Syncing...' : 'Run Local Grant Sync'}
                      </button>
                      {grantResult && (
                        grantResult.length === 0 ? (
                          <div className="text-sm text-emerald-600 font-medium">Already in sync — no changes needed</div>
                        ) : (
                          <div className="table-container">
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
                    </>
                  )}

                  {/* Step 2: External sync */}
                  {step.id === 'ext-sync' && (
                    <>
                      <button onClick={handleExternalSync} disabled={loading['ext-sync']} className="btn-primary btn-sm gap-1">
                        {loading['ext-sync'] ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
                        {loading['ext-sync'] ? 'Syncing...' : 'Sync to Remote DB'}
                      </button>
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
                                    <td className="text-xs text-slate-600 max-w-sm truncate" title={a.detail}>{a.detail}</td>
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
                    </>
                  )}

                  {/* Step 3: Drift check */}
                  {step.id === 'drift' && (
                    <>
                      <button onClick={handleCheckDrift} disabled={loading['drift']}
                        className="btn btn-sm bg-amber-600 text-white hover:bg-amber-700 gap-1">
                        {loading['drift'] ? <RefreshCw size={12} className="animate-spin" /> : <Search size={12} />}
                        {loading['drift'] ? 'Checking...' : 'Check Drift'}
                      </button>
                      {driftItems && (
                        driftItems.length === 0 ? (
                          <div className="flex items-center gap-2 text-sm text-emerald-600 font-medium">
                            <Check size={14} /> No drift detected — remote DB matches SSOT
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {/* Drift summary */}
                            <div className="flex gap-2 flex-wrap text-xs">
                              {Object.entries(
                                driftItems.reduce<Record<string, number>>((acc, d) => { acc[d.type] = (acc[d.type] || 0) + 1; return acc; }, {})
                              ).map(([type, count]) => (
                                <span key={type} className={`inline-flex items-center gap-1 px-2 py-1 rounded-full font-medium ${
                                  type === 'role_missing' ? 'bg-red-50 text-red-700' :
                                  type === 'grant_missing' ? 'bg-amber-50 text-amber-700' :
                                  'bg-blue-50 text-blue-700'
                                }`}>
                                  <AlertTriangle size={10} /> {count} {type.replace(/_/g, ' ')}
                                </span>
                              ))}
                            </div>
                            <div className="table-container">
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
                          </div>
                        )
                      )}
                    </>
                  )}

                  {/* Step 4: PgBouncer */}
                  {step.id === 'pgbouncer' && (
                    <>
                      <div className="flex gap-2 flex-wrap">
                        <button onClick={handlePgbouncerPreview} disabled={loading['pgbouncer']} className="btn-secondary btn-sm gap-1">
                          {loading['pgbouncer'] ? <RefreshCw size={12} className="animate-spin" /> : <Eye size={12} />}
                          {loading['pgbouncer'] ? 'Generating...' : 'Preview Config'}
                        </button>
                        <button onClick={handleApplyReload} disabled={loading['pgbouncer-apply']}
                          className="btn btn-sm bg-emerald-600 text-white hover:bg-emerald-700 gap-1">
                          {loading['pgbouncer-apply'] ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
                          {loading['pgbouncer-apply'] ? 'Applying...' : 'Apply & Reload'}
                        </button>
                      </div>
                      {pgbouncerConfig && (
                        <pre className="bg-slate-900 text-emerald-400 p-4 rounded-lg text-xs overflow-auto max-h-64 leading-relaxed">
                          {pgbouncerConfig}
                        </pre>
                      )}
                      {pgbouncerApplyResult && (
                        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-sm text-emerald-800">
                          <pre className="whitespace-pre-wrap text-xs">{pgbouncerApplyResult}</pre>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}
