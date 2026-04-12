import { useState, useEffect } from 'react';
import { api } from '../api';

type MatrixData = Awaited<ReturnType<typeof api.matrix>>;

export function MatrixTab() {
  const [data, setData] = useState<MatrixData | null>(null);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.matrix(actionFilter || undefined);
      setData(d);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, [actionFilter]);

  if (!data) return <div className="text-gray-500">Loading...</div>;

  // Build lookup: role -> resource -> effect
  const permMap = new Map<string, Map<string, string>>();
  for (const p of data.permissions) {
    if (!permMap.has(p.role_id)) permMap.set(p.role_id, new Map());
    const key = actionFilter ? p.resource_id : `${p.resource_id}:${p.action_id}`;
    permMap.get(p.role_id)!.set(key, p.effect);
  }

  // Filter resources to those that have at least one permission
  const resourcesWithPerms = data.resources.filter(r =>
    data.permissions.some(p => p.resource_id === r.resource_id)
  );

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Permission Matrix — Role x Resource</h2>
          <div className="flex gap-2 items-center">
            <label className="text-sm text-gray-600">Action Filter:</label>
            <select value={actionFilter} onChange={e => setActionFilter(e.target.value)}
              className="border rounded-md px-3 py-1.5 text-sm">
              <option value="">All Actions</option>
              {data.actions.map(a => <option key={a.action_id} value={a.action_id}>{a.display_name}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="sticky left-0 bg-gray-100 border p-2 text-left min-w-[100px]">Role</th>
                {resourcesWithPerms.map(r => (
                  <th key={r.resource_id} className="border p-2 text-center whitespace-nowrap bg-gray-50">
                    <div className="font-medium">{r.display_name}</div>
                    <div className="text-gray-400 font-normal">{r.resource_id}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.roles.map(role => {
                const rolePerms = permMap.get(role.role_id);
                const hasAnyPerm = rolePerms && rolePerms.size > 0;
                if (!hasAnyPerm) return null;
                return (
                  <tr key={role.role_id}>
                    <td className="sticky left-0 bg-white border p-2 font-medium">{role.role_id}</td>
                    {resourcesWithPerms.map(r => {
                      if (actionFilter) {
                        const effect = rolePerms?.get(r.resource_id);
                        return (
                          <td key={r.resource_id} className="border p-2 text-center">
                            {effect === 'allow' && <span className="inline-block w-4 h-4 bg-green-500 rounded" title="Allow" />}
                            {effect === 'deny' && <span className="inline-block w-4 h-4 bg-red-500 rounded" title="Deny" />}
                            {!effect && <span className="text-gray-300">-</span>}
                          </td>
                        );
                      }
                      // Show all actions for this role+resource
                      const actions = data.permissions.filter(p => p.role_id === role.role_id && p.resource_id === r.resource_id);
                      return (
                        <td key={r.resource_id} className="border p-1 text-center">
                          <div className="flex flex-wrap gap-0.5 justify-center">
                            {actions.map(a => (
                              <span key={a.action_id} className={`px-1 py-0.5 rounded text-[10px] font-bold ${
                                a.effect === 'allow' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                              }`}>
                                {a.action_id[0].toUpperCase()}
                              </span>
                            ))}
                            {actions.length === 0 && <span className="text-gray-300">-</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex gap-4 text-xs text-gray-500">
          <span><span className="inline-block w-3 h-3 bg-green-500 rounded mr-1" />Allow</span>
          <span><span className="inline-block w-3 h-3 bg-red-500 rounded mr-1" />Deny</span>
          <span className="ml-2">R=Read W=Write D=Delete A=Approve E=Export H=Hold</span>
        </div>
      </div>
    </div>
  );
}
