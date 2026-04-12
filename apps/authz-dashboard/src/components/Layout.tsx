import { ReactNode } from 'react';

const tabs = [
  { id: 'resolve', label: 'Permission Resolver' },
  { id: 'check', label: 'Permission Checker' },
  { id: 'matrix', label: 'Permission Matrix' },
  { id: 'rls', label: 'RLS Simulator' },
  { id: 'browser', label: 'Data Browser' },
] as const;

export type TabId = (typeof tabs)[number]['id'];

export function Layout({
  activeTab,
  onTabChange,
  children,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="bg-slate-800 text-white px-6 py-4">
        <h1 className="text-xl font-bold">Phison Data Nexus — AuthZ Verification Dashboard</h1>
        <p className="text-slate-400 text-sm mt-1">Milestone 1 POC</p>
      </header>
      <nav className="bg-white border-b shadow-sm">
        <div className="flex px-6 gap-1">
          {tabs.map((t) => (
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
