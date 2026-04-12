import { useState, useEffect } from 'react';
import { api } from '../api';
import { Grid3X3 } from 'lucide-react';

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

  if (!data) return (
    <div className="flex items-center justify-center h-64 text-slate-400">Loading matrix...</div>
  );

  const permMap = new Map<string, Map<string, string>>();
  for (const p of data.permissions) {
    if (!permMap.has(p.role_id)) permMap.set(p.role_id, new Map());
    const key = actionFilter ? p.resource_id : `${p.resource_id}:${p.action_id}`;
    permMap.get(p.role_id)!.set(key, p.effect);
  }

  const resourcesWithPerms = data.resources.filter(r =>
    data.permissions.some(p => p.resource_id === r.resource_id)
  );

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Permission Matrix</h1>
        <p className="page-desc">Role x Resource access grid — RBAC permission overview</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Grid3X3 size={16} className="text-blue-600" />
            Role Permissions
          </h2>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <label className="text-xs text-slate-500 font-medium whitespace-nowrap">Filter by action:</label>
            <select value={actionFilter} onChange={e => setActionFilter(e.target.value)} className="select w-full sm:w-auto text-xs">
              <option value="">All Actions</option>
              {data.actions.map(a => <option key={a.action_id} value={a.action_id}>{a.display_name}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-slate-100 border-b border-r border-slate-200 px-4 py-3 text-left font-semibold text-slate-600 min-w-[120px]">
                  Role
                </th>
                {resourcesWithPerms.map(r => (
                  <th key={r.resource_id} className="bg-slate-50 border-b border-slate-200 px-3 py-3 text-center whitespace-nowrap">
                    <div className="font-semibold text-slate-700 text-[11px]">{r.display_name}</div>
                    <div className="text-slate-400 font-normal text-[9px] mt-0.5">{r.resource_id}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.roles.map(role => {
                const rolePerms = permMap.get(role.role_id);
                if (!rolePerms || rolePerms.size === 0) return null;
                return (
                  <tr key={role.role_id} className="hover:bg-blue-50/30">
                    <td className="sticky left-0 z-10 bg-white border-b border-r border-slate-200 px-4 py-2.5">
                      <span className="font-semibold text-slate-900">{role.role_id}</span>
                    </td>
                    {resourcesWithPerms.map(r => {
                      if (actionFilter) {
                        const effect = rolePerms?.get(r.resource_id);
                        return (
                          <td key={r.resource_id} className="border-b border-slate-100 px-3 py-2.5 text-center">
                            {effect === 'allow' && (
                              <span className="inline-block w-5 h-5 rounded bg-emerald-500 shadow-sm shadow-emerald-200" title="Allow" />
                            )}
                            {effect === 'deny' && (
                              <span className="inline-block w-5 h-5 rounded bg-red-500 shadow-sm shadow-red-200" title="Deny" />
                            )}
                            {!effect && <span className="text-slate-200">-</span>}
                          </td>
                        );
                      }
                      const actions = data.permissions.filter(p => p.role_id === role.role_id && p.resource_id === r.resource_id);
                      return (
                        <td key={r.resource_id} className="border-b border-slate-100 px-2 py-2 text-center">
                          <div className="flex flex-wrap gap-0.5 justify-center">
                            {actions.map(a => (
                              <span key={a.action_id} className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold ${
                                a.effect === 'allow'
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-red-100 text-red-700'
                              }`}>
                                {a.action_id[0].toUpperCase()}
                              </span>
                            ))}
                            {actions.length === 0 && <span className="text-slate-200">-</span>}
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

        <div className="px-5 py-3 border-t border-slate-100 flex gap-5 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-emerald-500" /> Allow
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-red-500" /> Deny
          </span>
          <span className="text-slate-400 ml-2">R=Read W=Write D=Delete A=Approve E=Export H=Hold</span>
        </div>
      </div>
    </div>
  );
}
