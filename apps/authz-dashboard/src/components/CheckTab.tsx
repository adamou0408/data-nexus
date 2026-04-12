import { useState } from 'react';
import { api } from '../api';

const TEST_USERS = [
  { id: 'wang_pe',      label: 'Wang (PE-SSD)',    groups: ['PE_SSD'] },
  { id: 'chen_pe',      label: 'Chen (PE-eMMC)',   groups: ['PE_EMMC'] },
  { id: 'lin_pm',       label: 'Lin (PM-SSD)',     groups: ['PM_SSD'] },
  { id: 'huang_qa',     label: 'Huang (QA)',       groups: ['QA_ALL'] },
  { id: 'lee_sales',    label: 'Lee (Sales-TW)',   groups: ['SALES_TW'] },
  { id: 'zhang_sales',  label: 'Zhang (Sales-CN)', groups: ['SALES_CN'] },
  { id: 'wu_fae',       label: 'Wu (FAE-TW)',      groups: ['FAE_TW'] },
  { id: 'liu_fw',       label: 'Liu (FW-SSD)',     groups: ['RD_FW'] },
  { id: 'hsu_op',       label: 'Hsu (OP-SSD)',     groups: ['OP_SSD'] },
  { id: 'yang_finance', label: 'Yang (Finance)',   groups: ['FINANCE_TEAM'] },
  { id: 'chang_vp',     label: 'Chang (VP)',       groups: ['VP_OFFICE'] },
  { id: 'tsai_bi',      label: 'Tsai (BI)',        groups: ['BI_TEAM'] },
  { id: 'sys_admin',    label: 'SysAdmin',         groups: [] as string[] },
];

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
      {/* Single Check */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">authz_check() — Single Permission Check</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">User</label>
            <select value={userIdx} onChange={e => setUserIdx(Number(e.target.value))} className="w-full border rounded-md px-3 py-2">
              {TEST_USERS.map((u, i) => <option key={u.id} value={i}>{u.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Action</label>
            <select value={action} onChange={e => setAction(e.target.value)} className="w-full border rounded-md px-3 py-2">
              {['read','write','delete','approve','export','hold','release','execute','connect'].map(a =>
                <option key={a} value={a}>{a}</option>
              )}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Resource</label>
            <input value={resource} onChange={e => setResource(e.target.value)}
              className="w-full border rounded-md px-3 py-2 font-mono text-sm" />
          </div>
          <button onClick={checkSingle} disabled={loading}
            className="bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50">
            Check
          </button>
        </div>

        {singleResult !== null && (
          <div className={`mt-4 p-4 rounded-lg text-center text-lg font-bold ${
            singleResult ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {singleResult ? 'ALLOW' : 'DENY'}
          </div>
        )}
      </div>

      {/* Batch Check */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Batch Check — All Permissions for User</h2>
        <div className="flex gap-4 items-end mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">User</label>
            <select value={userIdx} onChange={e => setUserIdx(Number(e.target.value))} className="border rounded-md px-3 py-2">
              {TEST_USERS.map((u, i) => <option key={u.id} value={i}>{u.label}</option>)}
            </select>
          </div>
          <button onClick={checkBatch} disabled={loading}
            className="bg-indigo-600 text-white px-6 py-2 rounded-md hover:bg-indigo-700 disabled:opacity-50">
            Run Batch Check
          </button>
        </div>

        {batchResults && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2">Action</th><th className="pb-2">Resource</th><th className="pb-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {batchResults.map((r, i) => (
                <tr key={i} className="border-t">
                  <td className="py-2">{r.action}</td>
                  <td className="py-2 font-mono text-xs">{r.resource}</td>
                  <td className="py-2">
                    <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                      r.allowed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                    }`}>
                      {r.allowed ? 'ALLOW' : 'DENY'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
