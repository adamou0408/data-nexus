import { ReactNode } from 'react';
import { useAuthz, TEST_USERS } from '../AuthzContext';

export type TabId = 'resolve' | 'check' | 'matrix' | 'rls' | 'pool' | 'browser' | 'audit';

type TabDef = {
  id: TabId;
  label: string;
  adminOnly?: boolean;  // requires ADMIN or AUTHZ_ADMIN role
};

const allTabs: TabDef[] = [
  { id: 'resolve', label: 'Permission Resolver' },
  { id: 'check', label: 'Permission Checker' },
  { id: 'matrix', label: 'Permission Matrix' },
  { id: 'rls', label: 'RLS Simulator' },
  { id: 'pool', label: 'Pool Management', adminOnly: true },
  { id: 'browser', label: 'Data Browser' },
  { id: 'audit', label: 'Audit Log', adminOnly: true },
];

export function Layout({
  activeTab,
  onTabChange,
  children,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  children: ReactNode;
}) {
  const { user, config, loading, login, logout } = useAuthz();

  const isAdmin = config?.resolved_roles?.some(r => r === 'ADMIN' || r === 'AUTHZ_ADMIN') ?? false;

  // Filter tabs based on role
  const visibleTabs = allTabs.filter(t => !t.adminOnly || isAdmin);

  return (
    <div className="min-h-screen">
      <header className="bg-slate-800 text-white px-6 py-4">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold">Phison Data Nexus — AuthZ Dashboard</h1>
            <p className="text-slate-400 text-sm mt-1">SSOT Authorization Service</p>
          </div>
          <div className="flex items-center gap-3">
            {user && config && (
              <div className="text-right text-sm">
                <div className="text-slate-300">{user.label}</div>
                <div className="flex gap-1 justify-end mt-0.5">
                  {config.resolved_roles.map(r => (
                    <span key={r} className="bg-blue-600 px-1.5 py-0.5 rounded text-[10px]">{r}</span>
                  ))}
                </div>
              </div>
            )}
            <select
              value={user?.id ?? ''}
              onChange={async (e) => {
                if (e.target.value === '') { logout(); return; }
                const u = TEST_USERS.find(u => u.id === e.target.value);
                if (u) await login(u);
              }}
              className="bg-slate-700 text-white border border-slate-600 rounded px-3 py-1.5 text-sm"
            >
              <option value="">Select User...</option>
              {TEST_USERS.map(u => (
                <option key={u.id} value={u.id}>{u.label}</option>
              ))}
            </select>
            {loading && <span className="text-slate-400 text-xs animate-pulse">resolving...</span>}
          </div>
        </div>
      </header>
      <nav className="bg-white border-b shadow-sm">
        <div className="flex px-6 gap-1">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
      <main className="p-6 max-w-7xl mx-auto">{children}</main>
    </div>
  );
}
