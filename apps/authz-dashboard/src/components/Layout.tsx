import { ReactNode, useState, useEffect } from 'react';
import { useAuthz } from '../AuthzContext';
import { DataSourcePicker } from './DataSourcePicker';
import {
  Shield, Database, Table2,
  Server, FileText, LayoutDashboard,
  ChevronDown, ChevronsLeft, ChevronsRight, LogOut, Loader2, User,
  Menu, X, Code2, Layers, BarChart3,
  Users, ShieldCheck, KeyRound, FolderTree,
  Settings2, Boxes, Workflow, Search, Zap, Sparkles, Inbox, BookOpen, Activity,
  Package,
} from 'lucide-react';

export type TabId =
  | 'overview' | 'permissions'
  | 'tables' | 'raw-tables' | 'metabase' | 'data-query' | 'flow-composer'
  | 'access-resources' | 'access-policies' | 'pool' | 'modules' | 'access-pages' | 'discover'
  | 'access-subjects' | 'access-roles' | 'access-actions' | 'access-packs' | 'audit'
  | 'activity'
  | 'feedback-inbox'
  | 'business-terms'
  | 'ai-providers'
  | 'config-tools';

type NavItem = {
  id: TabId;
  label: string;
  icon: ReactNode;
  shortcut?: string;        // e.g. 'g p' (display only — wired via useGoToShortcuts)
  // V083 sidebar gate. SYSADMIN passes everything via god-mode.
  //   'authzAdmin' — Govern stage (Subjects/Roles/Actions/Policies/Audit write)
  //   'steward'    — Ingest + Catalog + curator surfaces (BizTerms/AI/Feedback)
  //   'admin'      — either of the above (e.g. Resources, Audit read)
  requires?: 'authzAdmin' | 'steward' | 'admin';
  countKey?: 'subjects' | 'roles' | 'resources' | 'policies'; // pulls from adminStats
  alertKey?: 'audit';        // shows red dot when condition matches
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

// Sidebar IA follows the bottom-up data-flow:
//   Ingest (data lands) → Catalog (auto-organized) → Govern (humans + policies) → Consume (users) → Observe (audit)
// Each stage is a stage in the pipeline, NOT a role. Admin and user navigate the same map.
const navGroups: NavGroup[] = [
  {
    label: '',
    items: [
      { id: 'overview',    label: 'Overview',    icon: <LayoutDashboard size={18} />, shortcut: 'g o' },
    ],
  },
  {
    label: 'Ingest',
    items: [
      { id: 'pool',     label: 'Sources',  icon: <Server size={18} />, requires: 'steward', shortcut: 'g s' },
      { id: 'discover', label: 'Discover', icon: <Search size={18} />, requires: 'steward', shortcut: 'g d' },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { id: 'access-resources', label: 'Resources',  icon: <FolderTree size={18} />, requires: 'admin', countKey: 'resources' },
      { id: 'modules',          label: 'Modules',    icon: <Boxes size={18} />,      shortcut: 'g m' },
      { id: 'access-pages',     label: 'Pages',      icon: <FileText size={18} />,   requires: 'steward' },
      { id: 'raw-tables',       label: 'Raw Tables', icon: <Table2 size={18} />,     requires: 'steward' },
    ],
  },
  {
    label: 'Govern',
    items: [
      { id: 'access-subjects', label: 'Subjects', icon: <Users size={18} />,       requires: 'authzAdmin', countKey: 'subjects' },
      { id: 'access-roles',    label: 'Roles',    icon: <KeyRound size={18} />,    requires: 'authzAdmin', countKey: 'roles' },
      { id: 'access-packs',    label: 'Permission Packs', icon: <Package size={18} />, requires: 'authzAdmin' },
      { id: 'access-actions',  label: 'Actions',  icon: <Zap size={18} />,         requires: 'authzAdmin' },
      { id: 'access-policies', label: 'Policies', icon: <ShieldCheck size={18} />, requires: 'authzAdmin', countKey: 'policies' },
      { id: 'business-terms',  label: 'Business Terms', icon: <BookOpen size={18} />, shortcut: 'g t' },
      { id: 'ai-providers',    label: 'AI Providers',   icon: <Sparkles size={18} />, requires: 'steward', shortcut: 'g a' },
    ],
  },
  {
    label: 'Consume',
    items: [
      { id: 'permissions',   label: 'My Permissions', icon: <Shield size={18} />,    shortcut: 'g p' },
      { id: 'tables',        label: 'Data Explorer',  icon: <Layers size={18} />,    shortcut: 'g e' },
      { id: 'data-query',    label: 'Query Tool',     icon: <Code2 size={18} />,     shortcut: 'g q' },
      { id: 'flow-composer', label: 'Flow Composer',  icon: <Workflow size={18} />,  shortcut: 'g f' },
      { id: 'metabase',      label: 'Metabase BI',    icon: <BarChart3 size={18} />, shortcut: 'g b' },
    ],
  },
  {
    label: 'Observe',
    items: [
      { id: 'activity',       label: 'Activity',       icon: <Activity size={18} />, requires: 'admin' },
      { id: 'audit',          label: 'Audit Log',      icon: <FileText size={18} />, requires: 'admin',   alertKey: 'audit' },
      { id: 'feedback-inbox', label: 'Feedback Inbox', icon: <Inbox size={18} />,    requires: 'steward', shortcut: 'g i' },
    ],
  },
];

const COLLAPSED_W = 64;
const EXPANDED_W = 260;

export function Layout({
  activeTab,
  onTabChange,
  onOpenPalette,
  onOpenConfigTools,
  children,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  onOpenPalette?: () => void;
  onOpenConfigTools?: () => void;
  children: ReactNode;
}) {
  const { user, config, loading, users, usersLoading, isAdmin, isAuthzAdmin, isSteward, adminStats, login, logout } = useAuthz();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('nexus.sidebar.collapsed') === '1';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('nexus.sidebar.collapsed', collapsed ? '1' : '0');
    }
  }, [collapsed]);

  const handleTabChange = (tab: TabId) => {
    onTabChange(tab);
    setSidebarOpen(false);
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    if (sidebarOpen) {
      document.body.classList.add('overflow-hidden', 'lg:overflow-auto');
    } else {
      document.body.classList.remove('overflow-hidden', 'lg:overflow-auto');
    }
  }, [sidebarOpen]);

  const sidebarWidth = collapsed ? COLLAPSED_W : EXPANDED_W;

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
      <aside
        style={{ width: sidebarWidth }}
        className={`
          fixed inset-y-0 left-0 z-40
          bg-slate-900 flex flex-col border-r border-slate-800
          transform transition-[transform,width] duration-200 ease-in-out
          lg:static lg:translate-x-0 lg:shrink-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {/* Brand */}
        <div className="px-3 py-5 border-b border-slate-800 flex items-center gap-2 min-h-[68px]">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0 ml-1">
            <Shield size={18} className="text-white" />
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="text-white font-bold text-sm tracking-tight truncate">Data Nexus</div>
              <div className="text-slate-500 text-[10px] font-medium tracking-wide uppercase">AuthZ Platform</div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-slate-400 hover:text-white p-1 ml-auto"
            aria-label="Close sidebar"
          >
            <X size={20} />
          </button>
        </div>

        {/* Search trigger (Cmd+K) */}
        {onOpenPalette && (
          <div className="px-3 pt-3">
            {collapsed ? (
              <button
                onClick={onOpenPalette}
                className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                title="Search (Ctrl+K)"
              >
                <Search size={16} />
              </button>
            ) : (
              <button
                onClick={onOpenPalette}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/60 text-slate-400 hover:text-white hover:bg-slate-800 text-xs transition-colors"
              >
                <Search size={14} />
                <span className="flex-1 text-left">Search…</span>
                <kbd className="text-[10px] bg-slate-700 px-1.5 py-0.5 rounded text-slate-300 font-mono">Ctrl K</kbd>
              </button>
            )}
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          {navGroups.map((group, gi) => {
            const visibleItems = group.items.filter(item => {
              if (!item.requires) return true;
              if (item.requires === 'authzAdmin') return isAuthzAdmin;
              if (item.requires === 'steward')    return isSteward;
              if (item.requires === 'admin')      return isAdmin;
              return false;
            });
            if (visibleItems.length === 0) return null;
            return (
              <div key={gi}>
                {group.label && !collapsed && <div className="nav-group-label">{group.label}</div>}
                {group.label && collapsed && gi > 0 && <div className="my-2 mx-2 border-t border-slate-800" />}
                <div className="space-y-0.5">
                  {visibleItems.map(item => {
                    const count = item.countKey && adminStats ? adminStats[item.countKey] : undefined;
                    const alert = item.alertKey === 'audit' && (adminStats?.auditErrors24h ?? 0) > 0;
                    const active = activeTab === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleTabChange(item.id)}
                        className={`nav-item w-full ${active ? 'nav-item-active' : 'nav-item-inactive'} ${collapsed ? 'justify-center px-2' : ''}`}
                        title={collapsed ? item.label : undefined}
                      >
                        <span className="relative shrink-0">
                          {item.icon}
                          {alert && (
                            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-slate-900" />
                          )}
                        </span>
                        {!collapsed && (
                          <>
                            <span className="flex-1 text-left truncate">{item.label}</span>
                            {typeof count === 'number' && (
                              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${active ? 'bg-white/20 text-white' : 'bg-slate-800 text-slate-400'}`}>
                                {count}
                              </span>
                            )}
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Collapse toggle (desktop only) */}
        <div className="hidden lg:flex justify-end px-2 py-1 border-t border-slate-800">
          <button
            onClick={() => setCollapsed(c => !c)}
            className="text-slate-500 hover:text-white p-1.5 rounded transition-colors"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>

        {/* User selector + data source picker + settings (bottom of sidebar) */}
        <div className="border-t border-slate-800 p-3 space-y-2">
          {!collapsed && (
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
          )}

          {/* DS-PICKER-V01: global data-source picker. Drives api.tables /
              api.tableSchema / api.dataExplorer / api.rlsSimulate. Discover Tab
              has its own per-source selection and is intentionally decoupled. */}
          <DataSourcePicker collapsed={collapsed} />

          {user && config && !collapsed && (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
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
              <div className="flex flex-col gap-1 shrink-0">
                {isAdmin && onOpenConfigTools && (
                  <button onClick={onOpenConfigTools} className="text-slate-500 hover:text-slate-200 p-1" title="Config Tools (admin)">
                    <Settings2 size={14} />
                  </button>
                )}
                <button onClick={logout} className="text-slate-500 hover:text-slate-300 p-1" title="Logout">
                  <LogOut size={14} />
                </button>
              </div>
            </div>
          )}

          {collapsed && user && (
            <div className="flex flex-col items-center gap-1">
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-[11px] font-bold" title={user.label}>
                {user.label.charAt(0).toUpperCase()}
              </div>
              {isAdmin && onOpenConfigTools && (
                <button onClick={onOpenConfigTools} className="text-slate-500 hover:text-slate-200 p-1" title="Config Tools">
                  <Settings2 size={14} />
                </button>
              )}
              <button onClick={logout} className="text-slate-500 hover:text-slate-300 p-1" title="Logout">
                <LogOut size={14} />
              </button>
            </div>
          )}

          {loading && !collapsed && (
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
            aria-label="Open sidebar"
          >
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-blue-600" />
            <span className="font-bold text-sm text-slate-900">Data Nexus</span>
          </div>
          {user ? (
            <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">
              {user.label.charAt(0)}
            </div>
          ) : (
            <div className="w-7" />
          )}
        </header>

        {/* Main content — Flow Composer opts out of the 1400px cap so its canvas
            can use the full viewport width (collapsible panels then drive the
            actual canvas-vs-chrome ratio). */}
        <main className="flex-1 overflow-y-auto">
          <div className={`${activeTab === 'flow-composer' ? 'w-full' : 'max-w-[1400px] mx-auto'} p-4 sm:p-6 lg:p-8`}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

// Export navGroups for command palette
export { navGroups };
export type { NavGroup, NavItem };
