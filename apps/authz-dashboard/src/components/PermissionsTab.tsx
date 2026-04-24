import { useState, useMemo } from 'react';
import { useAuthz } from '../AuthzContext';
import { ResolveTab } from './ResolveTab';
import { MatrixTab } from './MatrixTab';
import { CheckTab } from './CheckTab';
import { RlsTab } from './RlsTab';
import { Shield, Grid3X3, Search, Database } from 'lucide-react';

type Sub = 'mine' | 'matrix' | 'test' | 'rls';

const ALL_SUBS: { id: Sub; label: string; icon: JSX.Element; adminOnly?: boolean; desc: string }[] = [
  { id: 'mine',   label: 'My View',   icon: <Shield size={14} />,    desc: 'Your own L0–L3 resolved permissions.' },
  { id: 'matrix', label: 'Matrix',    icon: <Grid3X3 size={14} />,   desc: 'Role × resource grid for any action.' },
  { id: 'test',   label: 'Test',      icon: <Search size={14} />,    adminOnly: true, desc: 'Try any user / action / resource combination.' },
  { id: 'rls',    label: 'RLS',       icon: <Database size={14} />,  adminOnly: true, desc: 'Preview the WHERE clause and filtered rows.' },
];

export function PermissionsTab() {
  const { isAdmin } = useAuthz();
  const subs = useMemo(() => ALL_SUBS.filter(s => !s.adminOnly || isAdmin), [isAdmin]);
  const [active, setActive] = useState<Sub>('mine');

  // Reset to a visible sub if isAdmin flips off while on an admin sub
  const visibleIds = subs.map(s => s.id);
  const safeActive = visibleIds.includes(active) ? active : 'mine';

  return (
    <div className="space-y-4">
      <div className="page-header">
        <h1 className="page-title">Permissions</h1>
        <p className="page-desc">{subs.find(s => s.id === safeActive)?.desc}</p>
      </div>

      {/* Sub-tabs */}
      <div className="border-b border-slate-200 flex gap-1 overflow-x-auto">
        {subs.map(s => {
          const isActive = s.id === safeActive;
          return (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap
                ${isActive
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300'}`}
            >
              {s.icon}
              {s.label}
              {s.adminOnly && <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 ml-1">ADMIN</span>}
            </button>
          );
        })}
      </div>

      <div>
        {safeActive === 'mine'   && <ResolveTab />}
        {safeActive === 'matrix' && <MatrixTab />}
        {safeActive === 'test'   && isAdmin && <CheckTab />}
        {safeActive === 'rls'    && isAdmin && <RlsTab />}
      </div>
    </div>
  );
}
