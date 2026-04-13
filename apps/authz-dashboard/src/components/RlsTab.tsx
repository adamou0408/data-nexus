import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuthz } from '../AuthzContext';
import { Database, Play, ArrowLeftRight, Lock, ShieldOff } from 'lucide-react';

type SimResult = {
  table: string;
  filter_clause: string;
  filtered_rows: Record<string, unknown>[];
  filtered_count: number;
  total_count: number;
  column_masks?: Record<string, string>;
  resolved_roles?: string[];
};

export function RlsTab() {
  const { users } = useAuthz();
  const [leftUser, setLeftUser] = useState(0);
  const [rightUser, setRightUser] = useState(3);
  const [tables, setTables] = useState<{ table_name: string; column_count: string }[]>([]);
  const [table, setTable] = useState('');
  const [leftResult, setLeftResult] = useState<SimResult | null>(null);
  const [rightResult, setRightResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch business tables from DB
  useEffect(() => {
    api.tables().then(t => {
      setTables(t);
      if (t.length > 0 && !t.find(x => x.table_name === table)) setTable(t[0].table_name);
    }).catch(() => {});
  }, []);

  const simulate = async () => {
    const lu = users[leftUser];
    const ru = users[rightUser];
    if (!lu || !ru) return;
    setLoading(true);
    try {
      const [l, r] = await Promise.all([
        api.rlsSimulate(lu.id, lu.groups, lu.attrs, table),
        api.rlsSimulate(ru.id, ru.groups, ru.attrs, table),
      ]);
      setLeftResult(l);
      setRightResult(r);
    } catch { /* ignore */ }
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">RLS Simulator</h1>
        <p className="page-desc">
          Compare what different users see when querying data with <span className="code">authz_filter()</span> applied
        </p>
      </div>

      {/* Config card */}
      <div className="card">
        <div className="card-body space-y-4">
          {/* Table selector */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Target Table</label>
            <div className="flex gap-2 flex-wrap">
              {tables.map(t => (
                <button key={t.table_name} onClick={() => setTable(t.table_name)}
                  className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                    table === t.table_name
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}>
                  <div>{t.table_name}</div>
                  <div className="text-[10px] opacity-75 mt-0.5">{t.column_count} cols</div>
                </button>
              ))}
            </div>
          </div>

          {/* User selectors */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-3 sm:gap-4 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                User A
              </label>
              <select value={leftUser} onChange={e => setLeftUser(Number(e.target.value))} className="select">
                {users.map((u, i) => <option key={u.id} value={i}>{u.label}</option>)}
              </select>
            </div>
            <div className="hidden sm:block pb-2">
              <ArrowLeftRight size={20} className="text-slate-300" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                User B
              </label>
              <select value={rightUser} onChange={e => setRightUser(Number(e.target.value))} className="select">
                {users.map((u, i) => <option key={u.id} value={i}>{u.label}</option>)}
              </select>
            </div>
          </div>

          <button onClick={simulate} disabled={loading} className="btn-primary w-full">
            <Play size={14} />
            {loading ? 'Simulating...' : 'Run RLS Simulation'}
          </button>
        </div>
      </div>

      {/* Results side-by-side */}
      {leftResult && rightResult && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ResultPanel result={leftResult} label={users[leftUser].label} />
          <ResultPanel result={rightResult} label={users[rightUser].label} />
        </div>
      )}
    </div>
  );
}

function ResultPanel({ result, label }: { result: SimResult; label: string }) {
  const cols = result.filtered_rows.length > 0
    ? Object.keys(result.filtered_rows[0]).filter(k => k !== 'created_at')
    : [];
  const masks = result.column_masks || {};

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
          {result.resolved_roles && (
            <div className="flex gap-1 mt-1">
              {result.resolved_roles.map(r => (
                <span key={r} className="badge badge-blue text-[10px]">{r}</span>
              ))}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-lg font-bold text-blue-600">{result.filtered_count}</div>
          <div className="text-[10px] text-slate-400">of {result.total_count} rows</div>
        </div>
      </div>

      <div className="px-5 py-3 bg-slate-50 border-b border-slate-100">
        <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">SQL WHERE</div>
        <code className="text-xs font-mono text-blue-700">{result.filter_clause || '(no filter)'}</code>
      </div>

      {/* Column mask legend */}
      {Object.keys(masks).length > 0 && (
        <div className="px-5 py-2.5 border-b border-slate-100 flex gap-2 flex-wrap">
          {Object.entries(masks).map(([col, desc]) => (
            <span key={col} className={`badge text-[10px] inline-flex items-center gap-1 ${
              desc.startsWith('DENIED') ? 'badge-red' : 'badge-amber'
            }`}>
              {desc.startsWith('DENIED') ? <ShieldOff size={10} /> : <Lock size={10} />}
              {col}: {desc}
            </span>
          ))}
        </div>
      )}

      {/* Data table */}
      <div className="overflow-auto max-h-80">
        <table className="w-full text-xs">
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c} className={`px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap border-b ${
                  masks[c]?.startsWith('DENIED')
                    ? 'bg-red-50 text-red-600'
                    : masks[c]
                    ? 'bg-amber-50 text-amber-600'
                    : 'bg-slate-50 text-slate-500'
                }`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.filtered_rows.map((row, i) => (
              <tr key={i} className="hover:bg-slate-50/50">
                {cols.map(c => {
                  const isDenied = masks[c]?.startsWith('DENIED');
                  const isMasked = !!masks[c] && !isDenied;
                  return (
                    <td key={c} className={`px-3 py-2 whitespace-nowrap border-b border-slate-50 ${
                      isDenied ? 'bg-red-50/50 text-red-400 italic' :
                      isMasked ? 'bg-amber-50/50 text-amber-700 italic' : 'text-slate-700'
                    }`}>
                      {c === 'status' ? (
                        <StatusBadge value={String(row[c])} />
                      ) : !isDenied && !isMasked && typeof row[c] === 'number' && (c.includes('price') || c.includes('cost') || c.includes('amount')) ? (
                        `$${Number(row[c]).toLocaleString()}`
                      ) : (
                        String(row[c] ?? '')
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const colors: Record<string, string> = {
    active: 'badge-green', confirmed: 'badge-green',
    hold: 'badge-amber', pending: 'badge-amber',
    shipped: 'badge-blue', closed: 'badge-blue',
  };
  return <span className={`badge ${colors[value] || 'badge-slate'} text-[10px]`}>{value}</span>;
}
