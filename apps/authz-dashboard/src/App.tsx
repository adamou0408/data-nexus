import { useState, useEffect, useRef } from 'react';
import { AuthzProvider, useAuthz } from './AuthzContext';
import { RenderTokensProvider } from './RenderTokensContext';
import { ToastProvider } from './components/Toast';
import { Layout, TabId, navGroups } from './components/Layout';
import { OverviewTab } from './components/OverviewTab';
import { PermissionsTab } from './components/PermissionsTab';
import { PoolTab } from './components/pool';
import { AccessSectionPage, AccessSection } from './components/access-manager/AccessSectionPage';
import { TablesTab } from './components/TablesTab';
import { ConfigEngine } from './components/ConfigEngine';
import { MetabaseTab } from './components/MetabaseTab';
import { DataQueryTab } from './components/DataQueryTab';
import { DagTab } from './components/DagTab';
import { DiscoverTab } from './components/DiscoverTab';
import { AIProvidersTab } from './components/AIProvidersTab';
import { ConfigToolsTab } from './components/ConfigToolsTab';
import { CommandPalette } from './components/CommandPalette';
import { X } from 'lucide-react';

// Map sidebar access-* TabIds to Access Manager sections
const accessTabMap: Record<string, AccessSection> = {
  'access-subjects': 'subjects',
  'access-roles': 'roles',
  'access-resources': 'resources',
  'access-policies': 'policies',
  'access-actions': 'actions',
};

// Legacy → consolidated tab mapping (UX-04)
const legacyTabRedirect: Partial<Record<string, TabId>> = {
  'resolve': 'permissions',
  'matrix': 'permissions',
  'check': 'permissions',
  'rls': 'permissions',
};

function AppInner() {
  const [tab, setTab] = useState<TabId>('overview');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [configToolsOpen, setConfigToolsOpen] = useState(false);
  // BU-08: auto-generated page preview slot. When set, the 'auto-page' tab
  // renders ConfigEngine for the auto page_id (auto:<source>:<schema>.<table>).
  const [autoPagePreview, setAutoPagePreview] = useState<string | null>(null);
  const { isAdmin } = useAuthz();

  const navigate = (next: TabId | string) => {
    const redirect = legacyTabRedirect[next];
    setTab((redirect ?? next) as TabId);
  };

  useEffect(() => {
    const adminTabs: TabId[] = [
      'pool', 'audit', 'raw-tables', 'discover',
      'access-subjects', 'access-roles', 'access-resources', 'access-policies', 'access-actions',
      'ai-providers',
      'config-tools',
    ];
    if (adminTabs.includes(tab) && !isAdmin) {
      setTab('overview');
    }
  }, [isAdmin, tab]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tab: string }>).detail;
      if (detail?.tab) navigate(detail.tab);
    };
    window.addEventListener('navigate-tab', handler);
    return () => window.removeEventListener('navigate-tab', handler);
  }, []);

  // BU-08: open-auto-page event from GenerateAppButton → switch to preview tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page_id: string }>).detail;
      if (detail?.page_id) {
        setAutoPagePreview(detail.page_id);
        setTab('auto-page' as TabId);
      }
    };
    window.addEventListener('open-auto-page', handler);
    return () => window.removeEventListener('open-auto-page', handler);
  }, []);

  // Cmd/Ctrl+K palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // g-prefix nav (g + letter within 800ms)
  const goPending = useRef<number | null>(null);
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };

    const shortcutMap: Record<string, TabId> = {};
    for (const g of navGroups) {
      for (const item of g.items) {
        if (item.shortcut?.startsWith('g ')) {
          shortcutMap[item.shortcut.slice(2)] = item.id;
        }
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (paletteOpen || configToolsOpen) return;
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (goPending.current !== null) {
        const target = shortcutMap[k];
        clearTimeout(goPending.current);
        goPending.current = null;
        if (target && (!isAdminOnly(target) || isAdmin)) {
          e.preventDefault();
          setTab(target);
        }
        return;
      }
      if (k === 'g') {
        goPending.current = window.setTimeout(() => { goPending.current = null; }, 800);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAdmin, paletteOpen, configToolsOpen]);

  const accessSection = accessTabMap[tab];

  return (
    <Layout
      activeTab={tab}
      onTabChange={(t) => navigate(t)}
      onOpenPalette={() => setPaletteOpen(true)}
      onOpenConfigTools={isAdmin ? () => setConfigToolsOpen(true) : undefined}
    >
      {tab === 'overview' && <OverviewTab onNavigate={(t) => navigate(t)} />}
      {tab === 'permissions' && <PermissionsTab />}
      {tab === 'tables' && <ConfigEngine />}
      {tab === 'metabase' && <MetabaseTab />}
      {tab === 'data-query' && <DataQueryTab />}
      {tab === 'flow-composer' && <DagTab />}
      {tab === 'raw-tables' && <TablesTab />}
      {tab === 'pool' && <PoolTab />}
      {tab === 'modules' && <ConfigEngine initialPageId="modules_home" />}
      {tab === 'discover' && <DiscoverTab />}
      {tab === 'auto-page' && autoPagePreview && (
        <ConfigEngine key={autoPagePreview} initialPageId={autoPagePreview} />
      )}
      {tab === 'auto-page' && !autoPagePreview && (
        <div className="p-8 text-center text-slate-500">
          <p>No auto-generated page selected.</p>
          <p className="text-sm mt-2">Go to <button onClick={() => setTab('discover' as TabId)} className="text-blue-600 hover:underline">Discover</button> and use Generate App on a table.</p>
        </div>
      )}
      {accessSection && <AccessSectionPage key={accessSection} section={accessSection} />}
      {tab === 'ai-providers' && <AIProvidersTab />}
      {tab === 'audit' && <ConfigEngine initialPageId="audit_home" />}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(t) => navigate(t)}
        onOpenConfigTools={() => { setConfigToolsOpen(true); }}
      />

      {configToolsOpen && isAdmin && (
        <ConfigToolsModal onClose={() => setConfigToolsOpen(false)} />
      )}
    </Layout>
  );
}

function isAdminOnly(tab: TabId): boolean {
  for (const g of navGroups) {
    for (const item of g.items) {
      if (item.id === tab) return !!item.adminOnly;
    }
  }
  return false;
}

function ConfigToolsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative w-full max-w-5xl max-h-[90vh] bg-white rounded-xl shadow-2xl border border-slate-200 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Config Tools</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto p-5">
          <ConfigToolsTab />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthzProvider>
      <RenderTokensProvider>
        <ToastProvider>
          <AppInner />
        </ToastProvider>
      </RenderTokensProvider>
    </AuthzProvider>
  );
}
