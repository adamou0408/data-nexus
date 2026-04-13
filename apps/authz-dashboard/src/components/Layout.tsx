import { ReactNode, useState, useEffect } from 'react';
import { useAuthz } from '../AuthzContext';
import {
  Shield, Search, Grid3X3, Database, Table2,
  Server, List, FileText, LayoutDashboard,
  ChevronDown, LogOut, Loader2, User,
  Menu, X, Code2, Layers, BarChart3,
} from 'lucide-react';

export type TabId =
  | 'overview' | 'resolve' | 'check' | 'matrix'
  | 'tables' | 'raw-tables' | 'rls' | 'metabase'
  | 'functions' | 'browser' | 'pool' | 'audit';

type NavItem = {
  id: TabId;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    label: '',
    items: [
      { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} /> },
    ],
  },
  {
    label: 'My Access',
    items: [
      { id: 'resolve', label: 'My Permissions', icon: <Shield size={18} /> },
      { id: 'matrix', label: 'Permission Matrix', icon: <Grid3X3 size={18} /> },
    ],
  },
  {
    label: 'Data',
    items: [
      { id: 'tables', label: 'Data Explorer', icon: <Layers size={18} /> },
      { id: 'metabase', label: 'Metabase BI', icon: <BarChart3 size={18} /> },
    ],
  },
  {
    label: 'AuthZ Tools',
    items: [
      { id: 'check', label: 'Permission Tester', icon: <Search size={18} />, adminOnly: true },
      { id: 'rls', label: 'RLS Simulator', icon: <Database size={18} />, adminOnly: true },
      { id: 'functions', label: 'SQL Functions', icon: <Code2 size={18} />, adminOnly: true },
      { id: 'raw-tables', label: 'Raw Tables', icon: <Table2 size={18} />, adminOnly: true },
    ],
  },
  {
    label: 'Administration',
    items: [
      { id: 'browser', label: 'Entity Browser', icon: <List size={18} />, adminOnly: true },
      { id: 'pool', label: 'Connection Pools', icon: <Server size={18} />, adminOnly: true },
      { id: 'audit', label: 'Audit Log', icon: <FileText size={18} />, adminOnly: true },
    ],
  },
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
  const { user, config, loading, users, usersLoading, isAdmin, login, logout } = useAuthz();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close sidebar on route change (mobile)
  const handleTabChange = (tab: TabId) => {
    onTabChange(tab);
    setSidebarOpen(false);
  };

  // Close sidebar on ESC
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Lock body scroll when sidebar open on mobile
  useEffect(() => {
    if (sidebarOpen) {
      document.body.classList.add('overflow-hidden', 'lg:overflow-auto');
    } else {
      document.body.classList.remove('overflow-hidden', 'lg:overflow-auto');
    }
  }, [sidebarOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Mobile overlay ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <aside className={`
        fixed inset-y-0 left-0 z-40
        w-[260px] bg-slate-900 flex flex-col border-r border-slate-800
        transform transition-transform duration-200 ease-in-out
        lg:static lg:translate-x-0 lg:shrink-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Brand */}
        <div className="px-5 py-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Shield size={18} className="text-white" />
            </div>
            <div>
              <div className="text-white font-bold text-sm tracking-tight">Data Nexus</div>
              <div className="text-slate-500 text-[10px] font-medium tracking-wide uppercase">AuthZ Platform</div>
            </div>
          </div>
          {/* Mobile close button */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-slate-400 hover:text-white p-1"
          >
            <X size={20} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          {navGroups.map((group, gi) => {
            const visibleItems = group.items.filter(item => !item.adminOnly || isAdmin);
            if (visibleItems.length === 0) return null;
            return (
              <div key={gi}>
                {group.label && <div className="nav-group-label">{group.label}</div>}
                <div className="space-y-0.5">
                  {visibleItems.map(item => (
                    <button
                      key={item.id}
                      onClick={() => handleTabChange(item.id)}
                      className={`nav-item w-full ${
                        activeTab === item.id ? 'nav-item-active' : 'nav-item-inactive'
                      }`}
                    >
                      {item.icon}
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        {/* User selector (bottom of sidebar) */}
        <div className="border-t border-slate-800 p-4 space-y-3">
          <div className="relative">
            <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <select
              value={user?.id ?? ''}
              onChange={async (e) => {
                if (e.target.value === '') { logout(); return; }
                const u = users.find(u => u.id === e.target.value);
                if (u) await login(u);
              }}
              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg
                         pl-9 pr-8 py-2 text-xs appearance-none cursor-pointer
                         hover:border-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                         focus:outline-none transition-colors"
            >
              <option value="">{usersLoading ? 'Loading users...' : 'Select User...'}</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.label}</option>
              ))}
            </select>
          </div>

          {user && config && (
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <div className="text-white text-xs font-medium truncate">{user.label}</div>
                <div className="flex gap-1 flex-wrap mt-1">
                  {config.resolved_roles.slice(0, 3).map(r => (
                    <span key={r} className="bg-blue-600/20 text-blue-400 px-1.5 py-0.5 rounded text-[10px] font-medium">
                      {r}
                    </span>
                  ))}
                  {config.resolved_roles.length > 3 && (
                    <span className="text-slate-500 text-[10px]">+{config.resolved_roles.length - 3}</span>
                  )}
                </div>
              </div>
              <button onClick={logout} className="text-slate-500 hover:text-slate-300 p-1 shrink-0" title="Logout">
                <LogOut size={14} />
              </button>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-slate-500 text-xs">
              <Loader2 size={12} className="animate-spin" />
              Resolving permissions...
            </div>
          )}
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="lg:hidden bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-slate-600 hover:text-slate-900 p-1"
          >
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-blue-600" />
            <span className="font-bold text-sm text-slate-900">Data Nexus</span>
          </div>
          {user ? (
            <div className="flex items-center gap-1.5">
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">
                {user.label.charAt(0)}
              </div>
            </div>
          ) : (
            <div className="w-7" /> /* spacer */
          )}
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-[1400px] mx-auto p-4 sm:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
