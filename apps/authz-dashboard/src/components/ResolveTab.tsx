import { useState } from 'react';
import { api } from '../api';
import { JsonView } from './JsonView';

const TEST_USERS = [
  { id: 'wang_pe',      label: 'Wang (PE-SSD)',       groups: ['PE_SSD'],   attrs: { product_line: 'SSD', site: 'HQ' } },
  { id: 'chen_pe',      label: 'Chen (PE-eMMC)',      groups: ['PE_EMMC'],  attrs: { product_line: 'eMMC', site: 'HQ' } },
  { id: 'lin_pm',       label: 'Lin (PM-SSD)',        groups: ['PM_SSD'],   attrs: { product_line: 'SSD' } },
  { id: 'huang_qa',     label: 'Huang (QA)',          groups: ['QA_ALL'],   attrs: {} },
  { id: 'lee_sales',    label: 'Lee (Sales-TW)',      groups: ['SALES_TW'], attrs: { region: 'TW' } },
  { id: 'zhang_sales',  label: 'Zhang (Sales-CN)',    groups: ['SALES_CN'], attrs: { region: 'CN' } },
  { id: 'wu_fae',       label: 'Wu (FAE-TW)',         groups: ['FAE_TW'],   attrs: { region: 'TW' } },
  { id: 'liu_fw',       label: 'Liu (FW-SSD)',        groups: ['RD_FW'],    attrs: { product_line: 'SSD' } },
  { id: 'hsu_op',       label: 'Hsu (OP-SSD)',        groups: ['OP_SSD'],   attrs: { product_line: 'SSD', site: 'HQ' } },
  { id: 'yang_finance', label: 'Yang (Finance)',      groups: ['FINANCE_TEAM'], attrs: {} },
  { id: 'chang_vp',     label: 'Chang (VP)',          groups: ['VP_OFFICE'],attrs: {} },
  { id: 'tsai_bi',      label: 'Tsai (BI)',           groups: ['BI_TEAM'],  attrs: {} },
  { id: 'sys_admin',    label: 'SysAdmin',            groups: [],           attrs: {} },
];

export function ResolveTab() {
  const [selectedUser, setSelectedUser] = useState(0);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  const resolve = async () => {
    const u = TEST_USERS[selectedUser];
    setLoading(true);
    try {
      const data = await api.resolve(u.id, u.groups, u.attrs);
      setResult(data as Record<string, unknown>);
    } catch (err) {
      setResult({ error: String(err) });
    }
    setLoading(false);
  };

  const r = result as Record<string, unknown> | null;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">authz_resolve() — Full Permission Config</h2>
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Test User</label>
            <select
              value={selectedUser}
              onChange={(e) => setSelectedUser(Number(e.target.value))}
              className="w-full border rounded-md px-3 py-2"
            >
              {TEST_USERS.map((u, i) => (
                <option key={u.id} value={i}>{u.label} ({u.id})</option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-sm text-gray-500 mb-1">
              Groups: <code className="bg-gray-100 px-1 rounded">{JSON.stringify(TEST_USERS[selectedUser].groups)}</code>
            </div>
            <div className="text-sm text-gray-500">
              Attrs: <code className="bg-gray-100 px-1 rounded">{JSON.stringify(TEST_USERS[selectedUser].attrs)}</code>
            </div>
          </div>
          <button
            onClick={resolve}
            disabled={loading}
            className="bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Resolving...' : 'Resolve'}
          </button>
        </div>
      </div>

      {r && !r.error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Resolved Roles */}
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold text-sm text-gray-600 mb-2">Resolved Roles</h3>
            <div className="flex gap-2 flex-wrap">
              {(r.resolved_roles as string[] || []).map((role: string) => (
                <span key={role} className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium">
                  {role}
                </span>
              ))}
            </div>
          </div>

          {/* L0 Functional */}
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold text-sm text-gray-600 mb-2">L0: Functional Access</h3>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500"><th className="pb-1">Resource</th><th className="pb-1">Action</th></tr></thead>
              <tbody>
                {(r.L0_functional as { resource: string; action: string }[] || []).map((p, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1 font-mono text-xs">{p.resource}</td>
                    <td className="py-1">
                      <span className="bg-green-100 text-green-800 px-2 py-0.5 rounded text-xs">{p.action}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* L1 Data Scope */}
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold text-sm text-gray-600 mb-2">L1: Data Domain Scope (RLS)</h3>
            {Object.keys(r.L1_data_scope as Record<string, unknown> || {}).length === 0 ? (
              <p className="text-gray-400 text-sm">No data scope policies</p>
            ) : (
              Object.entries(r.L1_data_scope as Record<string, { rls_expression: string; subject_condition: unknown; resource_condition: unknown }>).map(([name, policy]) => (
                <div key={name} className="mb-3 p-3 bg-amber-50 rounded border border-amber-200">
                  <div className="font-medium text-sm">{name}</div>
                  <div className="mt-1 font-mono text-xs bg-white px-2 py-1 rounded border">
                    WHERE {policy.rls_expression}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* L2 Column Masks */}
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold text-sm text-gray-600 mb-2">L2: Column Masks</h3>
            {Object.keys(r.L2_column_masks as Record<string, unknown> || {}).length === 0 ? (
              <p className="text-gray-400 text-sm">No column mask rules</p>
            ) : (
              <pre className="text-xs bg-gray-50 p-2 rounded">{JSON.stringify(r.L2_column_masks, null, 2)}</pre>
            )}
          </div>

          {/* L3 Actions */}
          <div className="bg-white rounded-lg shadow p-4 lg:col-span-2">
            <h3 className="font-semibold text-sm text-gray-600 mb-2">L3: Composite Actions (Approval Workflows)</h3>
            {(r.L3_actions as unknown[] || []).length === 0 ? (
              <p className="text-gray-400 text-sm">No composite action policies</p>
            ) : (
              (r.L3_actions as { action: string; resource: string; approval_chain: { step: number; required_role: string; min_approvers: number }[]; preconditions: Record<string, string> }[]).map((a, i) => (
                <div key={i} className="p-3 bg-purple-50 rounded border border-purple-200 mb-2">
                  <span className="font-medium">{a.action}</span> on <code className="text-xs">{a.resource}</code>
                  <div className="mt-1 text-xs text-gray-600">
                    Chain: {a.approval_chain.map(s => `Step ${s.step}: ${s.required_role} (min ${s.min_approvers})`).join(' -> ')}
                  </div>
                  {Object.keys(a.preconditions).length > 0 && (
                    <div className="text-xs text-gray-500">Preconditions: {JSON.stringify(a.preconditions)}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {r && r.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg">{String(r.error)}</div>
      )}

      {r && <JsonView data={r} />}
    </div>
  );
}
