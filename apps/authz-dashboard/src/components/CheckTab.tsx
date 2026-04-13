import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuthz } from '../AuthzContext';
import { JsonView } from './JsonView';
import { Search, Play, CheckCircle2, XCircle, Shield, ChevronRight } from 'lucide-react';

type SubTab = 'resolve' | 'single' | 'batch';

export function CheckTab() {
  const { users } = useAuthz();
  const [subTab, setSubTab] = useState<SubTab>('resolve');
  const [userIdx, setUserIdx] = useState(0);

  const u = users[userIdx];

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Permission Tester</h1>
        <p className="page-desc">
          Test permissions for any user — resolve full config, single check, or batch check
        </p>
      </div>

      {/* User selector (shared across all sub-tabs) */}
      <div className="card">
        <div className="card-body">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Test User</label>
          <select value={userIdx} onChange={e => setUserIdx(Number(e.target.value))} className="select max-w-md">
            {users.map((u, i) => <option key={u.id} value={i}>{u.label} ({u.id})</option>)}
          </select>
          {u && (
            <div className="text-xs text-slate-500 mt-2 space-x-4">
              <span>Groups: <span className="code">{JSON.stringify(u.groups)}</span></span>
              <span>Attrs: <span className="code">{JSON.stringify(u.attrs)}</span></span>
            </div>
          )}
        </div>
      </div>

      {/* Sub-tab navigation */}
      <div className="flex gap-2">
        {([
          { id: 'resolve' as SubTab, label: 'Full Resolve', icon: <Shield size={14} /> },
          { id: 'single' as SubTab, label: 'Single Check', icon: <Search size={14} /> },
          { id: 'batch' as SubTab, label: 'Batch Check', icon: <Play size={14} /> },
        ]).map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)}
            className={`btn btn-sm gap-1.5 ${
              subTab === t.id
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
            }`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {subTab === 'resolve' && u && <ResolvePanel user={u} />}
      {subTab === 'single' && u && <SingleCheckPanel user={u} />}
      {subTab === 'batch' && u && <BatchCheckPanel user={u} />}
    </div>
  );
}

// ── Full Resolve Panel ──
function ResolvePanel({ user }: { user: { id: string; groups: string[]; attrs: Record<string, string> } }) {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  const resolve = async () => {
    setLoading(true);
    try {
      const data = await api.resolve(user.id, user.groups, user.attrs, true); // admin tab: request detailed config
      setResult(data as Record<string, unknown>);
    } catch (err) { setResult({ error: String(err) }); }
    setLoading(false);
  };

  // Auto-resolve on user change
  useEffect(() => { resolve(); }, [user.id]);

  const r = result;
  if (!r || 'error' in r) {
    return (
      <div className="card">
        <div className="card-body text-center py-8">
          {loading ? <p className="text-slate-400">Resolving...</p>
            : r && 'error' in r ? <p className="text-red-600 text-sm">{String(r.error)}</p>
            : <button onClick={resolve} className="btn-primary"><Play size={14} /> Resolve</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Resolved Roles */}
      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Shield size={16} className="text-blue-600" /> Resolved Roles
          </h2>
          <button onClick={resolve} disabled={loading} className="btn-secondary btn-sm">
            <Play size={12} /> {loading ? 'Resolving...' : 'Re-resolve'}
          </button>
        </div>
        <div className="card-body">
          <div className="flex gap-2 flex-wrap">
            {(r.resolved_roles as string[] || []).map((role: string) => (
              <span key={role} className="badge badge-blue">{role}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* L0 */}
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900">L0: Functional Access</h3>
            <span className="badge badge-green">{(r.L0_functional as unknown[])?.length ?? 0}</span>
          </div>
          <div className="table-container max-h-80">
            <table className="table">
              <thead><tr><th>Resource</th><th>Action</th></tr></thead>
              <tbody>
                {(r.L0_functional as { resource: string; action: string }[] || []).map((p, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs text-slate-700">{p.resource}</td>
                    <td><span className="badge badge-green">{p.action}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* L1 */}
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900">L1: Data Domain Scope</h3>
            <span className="badge badge-amber">{Object.keys(r.L1_data_scope as Record<string, unknown> || {}).length}</span>
          </div>
          <div className="card-body">
            {Object.keys(r.L1_data_scope as Record<string, unknown> || {}).length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">No data scope policies</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(r.L1_data_scope as Record<string, { rls_expression: string }>).map(([name, policy]) => (
                  <div key={name} className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                    <div className="text-sm font-medium text-slate-900 mb-1.5">{name}</div>
                    <div className="font-mono text-xs bg-white px-3 py-2 rounded border border-amber-200 text-amber-800">
                      WHERE {policy.rls_expression}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* L2 */}
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900">L2: Column Masks</h3>
            <span className="badge badge-purple">{Object.keys(r.L2_column_masks as Record<string, unknown> || {}).length}</span>
          </div>
          <div className="card-body">
            {Object.keys(r.L2_column_masks as Record<string, unknown> || {}).length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">No column mask rules</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(r.L2_column_masks as Record<string, Record<string, { mask_type: string; function: string }>>).map(([policy, cols]) => (
                  <div key={policy} className="rounded-lg border border-purple-200 bg-purple-50/50 p-3">
                    <div className="text-sm font-medium text-slate-900 mb-2">{policy}</div>
                    <div className="space-y-1">
                      {Object.entries(cols).map(([col, rule]) => (
                        <div key={col} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-slate-700">{col}</span>
                          <ChevronRight size={12} className="text-slate-400" />
                          <span className="badge badge-purple">{rule.mask_type}</span>
                          <span className="text-slate-500">{rule.function}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* L3 */}
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900">L3: Composite Actions</h3>
            <span className="badge badge-indigo">{(r.L3_actions as unknown[] || []).length}</span>
          </div>
          <div className="card-body">
            {(r.L3_actions as unknown[] || []).length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">No composite action policies</p>
            ) : (
              <div className="space-y-3">
                {(r.L3_actions as { action: string; resource: string; approval_chain: { step: number; required_role: string }[] }[]).map((a, i) => (
                  <div key={i} className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="badge badge-indigo">{a.action}</span>
                      <span className="text-xs text-slate-500">on</span>
                      <span className="code">{a.resource}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-600">
                      {a.approval_chain.map((s, si) => (
                        <span key={si} className="flex items-center gap-1">
                          {si > 0 && <ChevronRight size={12} className="text-slate-400" />}
                          <span className="bg-white border border-indigo-200 rounded px-2 py-0.5">Step {s.step}: {s.required_role}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <JsonView data={r} />
    </div>
  );
}

// ── Single Check Panel ──
function SingleCheckPanel({ user }: { user: { id: string; groups: string[] } }) {
  const [action, setAction] = useState('read');
  const [resource, setResource] = useState('');
  const [result, setResult] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionList, setActionList] = useState<string[]>([]);

  useEffect(() => {
    api.actions().then(list => {
      const ids = list.map((a: any) => a.action_id);
      setActionList(ids);
      if (ids.length > 0 && !ids.includes(action)) setAction(ids[0]);
    }).catch(() => {});
  }, []);

  const check = async () => {
    setLoading(true);
    try {
      const r = await api.check(user.id, user.groups, action, resource);
      setResult(r.allowed);
    } catch { setResult(null); }
    setLoading(false);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Search size={16} className="text-blue-600" /> Single Check
        </h2>
      </div>
      <div className="card-body">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Action</label>
            <select value={action} onChange={e => setAction(e.target.value)} className="select">
              {actionList.map(a =>
                <option key={a} value={a}>{a}</option>
              )}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Resource</label>
            <input value={resource} onChange={e => setResource(e.target.value)} className="input font-mono" />
          </div>
          <button onClick={check} disabled={loading} className="btn-primary">
            <Play size={14} /> Check
          </button>
        </div>

        {result !== null && (
          <div className={`mt-4 p-4 rounded-lg flex items-center justify-center gap-3 text-lg font-bold ${
            result ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                   : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {result ? <CheckCircle2 size={24} /> : <XCircle size={24} />}
            {result ? 'ALLOW' : 'DENY'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Batch Check Panel ──
function BatchCheckPanel({ user }: { user: { id: string; groups: string[] } }) {
  const [batchChecks, setBatchChecks] = useState<{ action: string; resource: string }[]>([]);
  const [results, setResults] = useState<{ action: string; resource: string; allowed: boolean }[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.batchChecks().then(setBatchChecks).catch(() => setBatchChecks([]));
  }, []);

  const run = async () => {
    if (batchChecks.length === 0) return;
    setLoading(true);
    try {
      const r = await api.checkBatch(user.id, user.groups, batchChecks);
      setResults(r);
    } catch { setResults(null); }
    setLoading(false);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="text-sm font-semibold text-slate-900">Batch Check ({batchChecks.length} checks)</h2>
        <button onClick={run} disabled={loading || batchChecks.length === 0} className="btn-primary btn-sm">
          <Play size={12} /> {loading ? 'Running...' : 'Run All'}
        </button>
      </div>
      {results && (
        <div className="table-container max-h-[60vh]">
          <table className="table">
            <thead><tr><th>Action</th><th>Resource</th><th>Result</th></tr></thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td><span className="badge badge-slate">{r.action}</span></td>
                  <td className="font-mono text-xs text-slate-700">{r.resource}</td>
                  <td>
                    <span className={`badge ${r.allowed ? 'badge-green' : 'badge-red'} inline-flex items-center gap-1`}>
                      {r.allowed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                      {r.allowed ? 'ALLOW' : 'DENY'}
                    </span>
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
