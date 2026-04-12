import { useState } from 'react';
import { api } from '../api';
import { TEST_USERS } from '../AuthzContext';
import { Search, Play, CheckCircle2, XCircle } from 'lucide-react';

const BATCH_CHECKS = [
  { action: 'read', resource: 'module:mrp.lot_tracking' },
  { action: 'write', resource: 'module:mrp.lot_tracking' },
  { action: 'read', resource: 'module:mrp.yield_analysis' },
  { action: 'read', resource: 'module:mrp.npi' },
  { action: 'read', resource: 'module:quality' },
  { action: 'read', resource: 'module:sales.order_mgmt' },
  { action: 'read', resource: 'module:sales.pricing' },
  { action: 'read', resource: 'module:engineering' },
  { action: 'write', resource: 'module:engineering.firmware' },
  { action: 'read', resource: 'module:analytics.dashboard' },
  { action: 'read', resource: 'column:lot_status.unit_price' },
  { action: 'read', resource: 'column:lot_status.cost' },
  { action: 'read', resource: 'column:price_book.margin' },
];

export function CheckTab() {
  const [userIdx, setUserIdx] = useState(0);
  const [action, setAction] = useState('read');
  const [resource, setResource] = useState('module:mrp.lot_tracking');
  const [singleResult, setSingleResult] = useState<boolean | null>(null);
  const [batchResults, setBatchResults] = useState<{ action: string; resource: string; allowed: boolean }[] | null>(null);
  const [loading, setLoading] = useState(false);

  const u = TEST_USERS[userIdx];

  const checkSingle = async () => {
    setLoading(true);
    try {
      const r = await api.check(u.id, u.groups, action, resource);
      setSingleResult(r.allowed);
    } catch { setSingleResult(null); }
    setLoading(false);
  };

  const checkBatch = async () => {
    setLoading(true);
    try {
      const r = await api.checkBatch(u.id, u.groups, BATCH_CHECKS);
      setBatchResults(r);
    } catch { setBatchResults(null); }
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Permission Checker</h1>
        <p className="page-desc">
          Call <span className="code">authz_check()</span> to verify a single permission or run batch checks
        </p>
      </div>

      {/* Single Check */}
      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Search size={16} className="text-blue-600" />
            Single Check
          </h2>
        </div>
        <div className="card-body">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">User</label>
              <select value={userIdx} onChange={e => setUserIdx(Number(e.target.value))} className="select">
                {TEST_USERS.map((u, i) => <option key={u.id} value={i}>{u.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Action</label>
              <select value={action} onChange={e => setAction(e.target.value)} className="select">
                {['read','write','delete','approve','export','hold','release','execute','connect'].map(a =>
                  <option key={a} value={a}>{a}</option>
                )}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Resource</label>
              <input value={resource} onChange={e => setResource(e.target.value)} className="input font-mono" />
            </div>
            <button onClick={checkSingle} disabled={loading} className="btn-primary">
              <Play size={14} /> Check
            </button>
          </div>

          {singleResult !== null && (
            <div className={`mt-4 p-4 rounded-lg flex items-center justify-center gap-3 text-lg font-bold ${
              singleResult
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-red-50 text-red-700 border border-red-200'
            }`}>
              {singleResult ? <CheckCircle2 size={24} /> : <XCircle size={24} />}
              {singleResult ? 'ALLOW' : 'DENY'}
            </div>
          )}
        </div>
      </div>

      {/* Batch Check */}
      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Batch Check</h2>
          <button onClick={checkBatch} disabled={loading} className="btn-primary btn-sm">
            <Play size={12} /> Run {BATCH_CHECKS.length} Checks
          </button>
        </div>
        {batchResults && (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr><th>Action</th><th>Resource</th><th>Result</th></tr>
              </thead>
              <tbody>
                {batchResults.map((r, i) => (
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
    </div>
  );
}
