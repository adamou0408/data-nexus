import { useState } from 'react';
import { api } from '../api';

const TEST_USERS: { id: string; label: string; groups: string[]; attrs: Record<string, string> }[] = [
  { id: 'wang_pe',      label: 'Wang PE-SSD (SSD only)',    groups: ['PE_SSD'],      attrs: { product_line: 'SSD', site: 'HQ' } },
  { id: 'chen_pe',      label: 'Chen PE-eMMC (eMMC only)',  groups: ['PE_EMMC'],     attrs: { product_line: 'eMMC', site: 'HQ' } },
  { id: 'lin_pm',       label: 'Lin PM-SSD (SSD only)',     groups: ['PM_SSD'],      attrs: { product_line: 'SSD' } },
  { id: 'huang_qa',     label: 'Huang QA (all lines)',      groups: ['QA_ALL'],      attrs: {} },
  { id: 'hsu_op',       label: 'Hsu OP-SSD (SSD only)',     groups: ['OP_SSD'],      attrs: { product_line: 'SSD', site: 'HQ' } },
  { id: 'liu_fw',       label: 'Liu FW-SSD (SSD only)',     groups: ['RD_FW'],       attrs: { product_line: 'SSD' } },
  { id: 'lee_sales',    label: 'Lee Sales-TW (TW orders)',  groups: ['SALES_TW'],    attrs: { region: 'TW' } },
  { id: 'zhang_sales',  label: 'Zhang Sales-CN (CN orders)',groups: ['SALES_CN'],    attrs: { region: 'CN' } },
  { id: 'smith_sales',  label: 'Smith Sales-US (US orders)',groups: ['SALES_US'],    attrs: { region: 'US' } },
  { id: 'wu_fae',       label: 'Wu FAE-TW (TW data)',       groups: ['FAE_TW'],      attrs: { region: 'TW' } },
  { id: 'yang_finance', label: 'Yang Finance (all data)',   groups: ['FINANCE_TEAM'],attrs: {} },
  { id: 'chang_vp',     label: 'Chang VP (all data)',       groups: ['VP_OFFICE'],   attrs: {} },
  { id: 'tsai_bi',      label: 'Tsai BI (all data)',        groups: ['BI_TEAM'],     attrs: {} },
  { id: 'sys_admin',    label: 'SysAdmin (all data)',       groups: [],              attrs: {} },
];

const TABLES = [
  { id: 'lot_status', label: 'lot_status (Lot Tracking)', hint: 'Filtered by product_line' },
  { id: 'sales_order', label: 'sales_order (Sales Orders)', hint: 'Filtered by region' },
];

type SimResult = {
  table: string;
  filter_clause: string;
  filtered_rows: Record<string, unknown>[];
  filtered_count: number;
  total_count: number;
};

export function RlsTab() {
  const [leftUser, setLeftUser] = useState(0);
  const [rightUser, setRightUser] = useState(3); // QA by default
  const [table, setTable] = useState('lot_status');
  const [leftResult, setLeftResult] = useState<SimResult | null>(null);
  const [rightResult, setRightResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);

  const simulate = async () => {
    setLoading(true);
    try {
      const [l, r] = await Promise.all([
        api.rlsSimulate(TEST_USERS[leftUser].id, TEST_USERS[leftUser].groups, TEST_USERS[leftUser].attrs, table),
        api.rlsSimulate(TEST_USERS[rightUser].id, TEST_USERS[rightUser].groups, TEST_USERS[rightUser].attrs, table),
      ]);
      setLeftResult(l);
      setRightResult(r);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const renderTable = (result: SimResult, label: string) => {
    const cols = result.filtered_rows.length > 0
      ? Object.keys(result.filtered_rows[0]).filter(k => k !== 'created_at')
      : [];

    return (
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="font-semibold text-sm mb-2">{label}</h3>
        <div className="mb-2 p-2 bg-gray-50 rounded border">
          <div className="text-xs text-gray-500">SQL WHERE clause:</div>
          <code className="text-xs font-mono text-blue-700">{result.filter_clause}</code>
        </div>
        <div className="text-sm text-gray-600 mb-2">
          Showing <span className="font-bold text-blue-600">{result.filtered_count}</span> of {result.total_count} rows
        </div>
        <div className="overflow-auto max-h-80">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100">
                {cols.map(c => (
                  <th key={c} className="border p-1.5 text-left whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.filtered_rows.map((row, i) => (
                <tr key={i} className="hover:bg-blue-50">
                  {cols.map(c => (
                    <td key={c} className="border p-1.5 whitespace-nowrap">
                      {c === 'status' ? (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          row[c] === 'active' || row[c] === 'confirmed' ? 'bg-green-100 text-green-700' :
                          row[c] === 'hold' || row[c] === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                          row[c] === 'shipped' || row[c] === 'closed' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>{String(row[c])}</span>
                      ) : typeof row[c] === 'number' && (c.includes('price') || c.includes('cost') || c.includes('amount')) ? (
                        `$${Number(row[c]).toLocaleString()}`
                      ) : (
                        String(row[c] ?? '')
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">RLS Simulator — Side-by-Side Comparison</h2>
        <p className="text-sm text-gray-500 mb-4">
          Compare what different Phison employees see when querying data with RLS filtering applied via <code className="bg-gray-100 px-1 rounded">authz_filter()</code>.
        </p>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Target Table</label>
          <div className="flex gap-2">
            {TABLES.map(t => (
              <button key={t.id} onClick={() => setTable(t.id)}
                className={`px-4 py-2 rounded-md text-sm ${
                  table === t.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}>
                {t.label}
                <span className="block text-[10px] opacity-75">{t.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Left: User A</label>
            <select value={leftUser} onChange={e => setLeftUser(Number(e.target.value))} className="w-full border rounded-md px-3 py-2 text-sm">
              {TEST_USERS.map((u, i) => <option key={u.id} value={i}>{u.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Right: User B</label>
            <select value={rightUser} onChange={e => setRightUser(Number(e.target.value))} className="w-full border rounded-md px-3 py-2 text-sm">
              {TEST_USERS.map((u, i) => <option key={u.id} value={i}>{u.label}</option>)}
            </select>
          </div>
        </div>
        <button onClick={simulate} disabled={loading}
          className="bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50 w-full">
          {loading ? 'Simulating...' : 'Run RLS Simulation'}
        </button>
      </div>

      {leftResult && rightResult && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {renderTable(leftResult, TEST_USERS[leftUser].label)}
          {renderTable(rightResult, TEST_USERS[rightUser].label)}
        </div>
      )}
    </div>
  );
}
