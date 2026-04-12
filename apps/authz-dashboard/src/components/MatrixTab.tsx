import { useState, useEffect } from 'react';
import { api } from '../api';
import { Grid3X3, Layers, Table2, Database, Globe, Columns3, ArrowLeft } from 'lucide-react';

type MatrixData = Awaited<ReturnType<typeof api.matrix>>;
type ViewMode = 'matrix' | 'role-detail';
type ResourceTypeFilter = '' | 'module' | 'table' | 'column' | 'web';

const RESOURCE_TYPE_TABS: { id: ResourceTypeFilter; label: string; icon: React.ReactNode }[] = [
  { id: '',       label: 'All',     icon: <Layers size={12} /> },
  { id: 'module', label: 'Modules', icon: <Database size={12} /> },
  { id: 'table',  label: 'Tables',  icon: <Table2 size={12} /> },
  { id: 'column', label: 'Columns', icon: <Columns3 size={12} /> },
  { id: 'web',    label: 'Web',     icon: <Globe size={12} /> },
];

const TYPE_ORDER = ['module', 'table', 'column', 'web_page', 'web_api'];
const TYPE_LABELS: Record<string, string> = {
  module: 'Modules', table: 'Tables', column: 'Columns',
  web_page: 'Web Pages', web_api: 'Web APIs',
};
const TYPE_COLORS: Record<string, string> = {
  module: 'bg-indigo-100 text-indigo-700', table: 'bg-emerald-100 text-emerald-700',
  column: 'bg-amber-100 text-amber-700', web_page: 'bg-blue-100 text-blue-700',
  web_api: 'bg-purple-100 text-purple-700',
};

export function MatrixTab() {
  const [data, setData] = useState<MatrixData | null>(null);
  const [actionFilter, setActionFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<ResourceTypeFilter>('');
  const [viewMode, setViewMode] = useState<ViewMode>('matrix');
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.matrix(actionFilter || undefined).then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [actionFilter]);

  if (!data || loading) return (
    <div className="flex items-center justify-center h-64 text-slate-400">Loading matrix...</div>
  );

  // Build permission lookup
  const permMap = new Map<string, Map<string, { action: string; effect: string }[]>>();
  for (const p of data.permissions) {
    if (!permMap.has(p.role_id)) permMap.set(p.role_id, new Map());
    const rm = permMap.get(p.role_id)!;
    if (!rm.has(p.resource_id)) rm.set(p.resource_id, []);
    rm.get(p.resource_id)!.push({ action: p.action_id, effect: p.effect });
  }

  // Filter & group resources
  const filteredResources = data.resources
    .filter(r => {
      if (!data.permissions.some(p => p.resource_id === r.resource_id)) return false;
      if (!typeFilter) return true;
      if (typeFilter === 'web') return r.resource_type === 'web_page' || r.resource_type === 'web_api';
      return r.resource_type === typeFilter;
    });

  const groupedResources = TYPE_ORDER
    .map(type => ({
      type,
      label: TYPE_LABELS[type],
      resources: filteredResources.filter(r => r.resource_type === type),
    }))
    .filter(g => g.resources.length > 0);

  const rolesWithPerms = data.roles.filter(r => permMap.has(r.role_id) && (permMap.get(r.role_id)?.size ?? 0) > 0);

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Permission Matrix</h1>
        <p className="page-desc">Role x Resource access grid — RBAC permission overview</p>
      </div>

      {viewMode === 'role-detail' && selectedRole ? (
        <RoleDetailView
          role={selectedRole}
          data={data}
          permMap={permMap}
          groupedResources={groupedResources}
          onBack={() => { setViewMode('matrix'); setSelectedRole(null); }}
        />
      ) : (
        <div className="card">
          {/* Toolbar */}
          <div className="card-header flex-col sm:flex-row gap-3">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Grid3X3 size={16} className="text-blue-600" />
              Role Permissions
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              {/* Resource type filter */}
              <div className="flex gap-1">
                {RESOURCE_TYPE_TABS.map(t => (
                  <button key={t.id} onClick={() => setTypeFilter(t.id)}
                    className={`btn btn-sm text-[11px] gap-1 ${
                      typeFilter === t.id
                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                        : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'
                    }`}>
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
              {/* Action filter */}
              <select value={actionFilter} onChange={e => setActionFilter(e.target.value)}
                className="select text-xs">
                <option value="">All Actions</option>
                {data.actions.map(a => <option key={a.action_id} value={a.action_id}>{a.display_name}</option>)}
              </select>
            </div>
          </div>

          {/* Matrix table with group headers */}
          <div className="overflow-auto max-h-[70vh]">
            <table className="w-full text-xs border-collapse">
              <thead>
                {/* Group header row */}
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-100 border-b border-r border-slate-200 px-4 py-1 min-w-[120px]" />
                  {groupedResources.map(g => (
                    <th key={g.type} colSpan={g.resources.length}
                      className={`border-b border-x border-slate-200 px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-wider ${TYPE_COLORS[g.type] || 'bg-slate-100 text-slate-600'}`}>
                      {g.label}
                    </th>
                  ))}
                </tr>
                {/* Resource name row */}
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-100 border-b border-r border-slate-200 px-4 py-2 text-left font-semibold text-slate-600 min-w-[120px]">
                    Role
                  </th>
                  {groupedResources.flatMap(g =>
                    g.resources.map((r, ri) => (
                      <th key={r.resource_id}
                        className={`bg-slate-50 border-b border-slate-200 px-2 py-2 text-center whitespace-nowrap ${ri === 0 ? 'border-l border-slate-300' : ''}`}>
                        <div className="font-semibold text-slate-700 text-[10px] leading-tight">{r.display_name}</div>
                        <div className="text-slate-400 font-normal text-[8px] mt-0.5">{r.resource_id.split(':').pop()}</div>
                      </th>
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {rolesWithPerms.map(role => {
                  const rolePerms = permMap.get(role.role_id);
                  return (
                    <tr key={role.role_id} className="hover:bg-blue-50/30 group">
                      <td className="sticky left-0 z-10 bg-white group-hover:bg-blue-50/30 border-b border-r border-slate-200 px-4 py-2">
                        <button onClick={() => { setSelectedRole(role.role_id); setViewMode('role-detail'); }}
                          className="font-semibold text-blue-600 hover:text-blue-800 hover:underline">
                          {role.role_id}
                        </button>
                      </td>
                      {groupedResources.flatMap(g =>
                        g.resources.map((r, ri) => {
                          const perms = rolePerms?.get(r.resource_id) || [];
                          return (
                            <td key={r.resource_id}
                              className={`border-b border-slate-100 px-1.5 py-2 text-center ${ri === 0 ? 'border-l border-slate-200' : ''}`}>
                              {perms.length > 0 ? (
                                <div className="flex flex-wrap gap-0.5 justify-center">
                                  {perms.map(a => (
                                    <span key={a.action} title={`${a.action} (${a.effect})`}
                                      className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[9px] font-bold ${
                                        a.effect === 'allow' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                                      }`}>
                                      {a.action[0].toUpperCase()}
                                    </span>
                                  ))}
                                </div>
                              ) : <span className="text-slate-200">-</span>}
                            </td>
                          );
                        })
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="px-5 py-3 border-t border-slate-100 flex gap-5 text-xs text-slate-500 flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-emerald-500" /> Allow
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-red-500" /> Deny
            </span>
            <span className="text-slate-400 ml-2">R=Read W=Write D=Delete A=Approve E=Export H=Hold</span>
            <span className="text-slate-400 ml-auto">Click a role name for detail view</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Role Detail View ── */

function RoleDetailView({ role, data, permMap, groupedResources, onBack }: {
  role: string;
  data: MatrixData;
  permMap: Map<string, Map<string, { action: string; effect: string }[]>>;
  groupedResources: { type: string; label: string; resources: MatrixData['resources'] }[];
  onBack: () => void;
}) {
  const rolePerms = permMap.get(role) || new Map();
  const roleInfo = data.roles.find(r => r.role_id === role);

  // Count stats
  let allowCount = 0, denyCount = 0;
  for (const perms of rolePerms.values()) {
    for (const p of perms) {
      if (p.effect === 'allow') allowCount++;
      else denyCount++;
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="card">
        <div className="card-body">
          <div className="flex items-center gap-4">
            <button onClick={onBack} className="btn-secondary btn-sm gap-1">
              <ArrowLeft size={14} /> Back to Matrix
            </button>
            <div className="flex-1">
              <h2 className="text-lg font-bold text-slate-900">{role}</h2>
              <p className="text-xs text-slate-500">{roleInfo?.display_name}</p>
            </div>
            <div className="flex gap-3">
              <div className="text-center">
                <div className="text-xl font-bold text-emerald-600">{allowCount}</div>
                <div className="text-[10px] text-slate-500">Allow</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold text-red-600">{denyCount}</div>
                <div className="text-[10px] text-slate-500">Deny</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Permission cards by category */}
      {groupedResources.map(g => {
        const resourcesWithPerms = g.resources.filter(r => rolePerms.has(r.resource_id));
        if (resourcesWithPerms.length === 0) return null;
        return (
          <div key={g.type} className="card">
            <div className="card-header">
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${TYPE_COLORS[g.type] || ''}`}>
                  {g.label}
                </span>
                <span className="text-xs text-slate-400">{resourcesWithPerms.length} resources</span>
              </h3>
            </div>
            <div className="card-body">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {resourcesWithPerms.map(r => {
                  const perms = rolePerms.get(r.resource_id) || [];
                  return (
                    <div key={r.resource_id} className="rounded-lg border border-slate-200 p-3">
                      <div className="font-medium text-sm text-slate-900">{r.display_name}</div>
                      <div className="font-mono text-[10px] text-slate-400 mt-0.5">{r.resource_id}</div>
                      <div className="flex gap-1.5 mt-2 flex-wrap">
                        {perms.map(p => (
                          <span key={p.action}
                            className={`badge text-[10px] ${p.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>
                            {p.action}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
