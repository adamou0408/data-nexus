import { useState, useEffect, useRef } from 'react';
import { AuthzProvider, useAuthz } from './AuthzContext';
import { RenderTokensProvider } from './RenderTokensContext';
import { ToastProvider } from './components/Toast';
import { Layout, TabId, navGroups } from './components/Layout';
import { OverviewTab } from './components/OverviewTab';
import { PermissionsTab } from './components/PermissionsTab';
import { PoolTab } from './components/pool';
import { AccessSectionPage, AccessSection } from './components/access-manager/AccessSectionPage';
import { ConfigEngine } from './components/ConfigEngine';
import { MetabaseTab } from './components/MetabaseTab';
import { DataQueryTab } from './components/DataQueryTab';
import { DagTab } from './components/DagTab';
import { CatalogWorkspace } from './components/catalog/CatalogWorkspace';
import { DiscoverTab } from './components/DiscoverTab';
import { AIProvidersTab } from './components/AIProvidersTab';
import { ActivityTab } from './components/ActivityTab';
import { FeedbackInboxTab } from './components/FeedbackInboxTab';
import { BusinessTermsTab } from './components/BusinessTermsTab';
import { ConfigToolsTab } from './components/ConfigToolsTab';
import { CommandPalette } from './components/CommandPalette';
import { X } from 'lucide-react';

// Map sidebar access-* TabIds to Access Manager sections.
// 'access-resources' is intentionally absent — it routes to <CatalogWorkspace preset="resources" /> below.
const accessTabMap: Record<string, AccessSection> = {
  'access-subjects': 'subjects',
  'access-roles': 'roles',
  'access-policies': 'policies',
  'access-actions': 'actions',
  'access-packs': 'packs',
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
  // Cross-tab Catalog open: DiscoverTab/DagTab dispatch `catalog-open-page`
  // with a page_id (auto:<source>:<schema>.<table> or admin row id). We switch
  // to the 'access-pages' tab and forward the id into <CatalogWorkspace> via
  // pendingPageId; the workspace pushes a page-detail frame and calls back to clear.
  const [catalogPendingPageId, setCatalogPendingPageId] = useState<string | null>(null);
  const { isAdmin, isAuthzAdmin, isSteward } = useAuthz();

  const navigate = (next: TabId | string) => {
    const redirect = legacyTabRedirect[next];
    setTab((redirect ?? next) as TabId);
  };

  // V083 tri-flag gate — mirrors Layout.tsx sidebar visibility. Admin and steward
  // are NOT the same: a steward must NOT land on Subjects/Roles/Actions/Policies
  // even though they pass the coarse isAdmin check (steward is in adminTabs set).
  useEffect(() => {
    if (!canAccessTab(tab, { isAuthzAdmin, isSteward, isAdmin })) {
      setTab('overview');
    }
  }, [isAuthzAdmin, isSteward, isAdmin, tab]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tab: string }>).detail;
      if (detail?.tab) navigate(detail.tab);
    };
    window.addEventListener('navigate-tab', handler);
    return () => window.removeEventListener('navigate-tab', handler);
  }, []);

  // Catalog cross-tab open: DiscoverTab Generate App / DagTab publish dispatch
  // 'catalog-open-page'. We switch to access-pages and forward the id to the
  // workspace via pendingPageId.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page_id: string }>).detail;
      if (!detail?.page_id) return;
      setCatalogPendingPageId(detail.page_id);
      setTab('access-pages');
    };
    window.addEventListener('catalog-open-page', handler);
    return () => window.removeEventListener('catalog-open-page', handler);
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
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
      // Don't fire g-prefix shortcuts while focus is inside a modal — even on a
      // button. Otherwise tab-cycling inside a wizard and pressing g+<letter>
      // would unmount the host tab and tear the modal down. Modals opt in by
      // setting role="dialog" on the wrapper (also good a11y).
      return el.closest('[role="dialog"]') !== null;
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
        if (target && canAccessTab(target, { isAuthzAdmin, isSteward, isAdmin })) {
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
  }, [isAuthzAdmin, isSteward, isAdmin, paletteOpen, configToolsOpen]);

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
      {tab === 'raw-tables' && <CatalogWorkspace preset="tables" />}
      {tab === 'pool' && <PoolTab />}
      {tab === 'modules' && <CatalogWorkspace preset="modules" />}
      {tab === 'access-pages' && (
        <CatalogWorkspace
          preset="pages"
          pendingPageId={catalogPendingPageId}
          onPendingConsumed={() => setCatalogPendingPageId(null)}
        />
      )}
      {tab === 'access-resources' && <CatalogWorkspace preset="resources" />}
      {tab === 'discover' && <DiscoverTab />}
      {accessSection && <AccessSectionPage key={accessSection} section={accessSection} />}
      {tab === 'ai-providers' && <AIProvidersTab />}
      {tab === 'audit' && <ConfigEngine initialPageId="audit_home" />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'feedback-inbox' && <FeedbackInboxTab />}
      {tab === 'business-terms' && <BusinessTermsTab />}

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

// V083 tri-flag gate — must mirror the visibility logic in Layout.tsx so that
// keyboard shortcuts and redirect-on-tab-change agree with what the sidebar
// shows. Tabs without `requires` are open to everyone (incl. anonymous BI).
function canAccessTab(
  tab: TabId,
  flags: { isAuthzAdmin: boolean; isSteward: boolean; isAdmin: boolean },
): boolean {
  for (const g of navGroups) {
    for (const item of g.items) {
      if (item.id !== tab) continue;
      if (!item.requires) return true;
      if (item.requires === 'authzAdmin') return flags.isAuthzAdmin;
      if (item.requires === 'steward')    return flags.isSteward;
      if (item.requires === 'admin')      return flags.isAdmin;
      return false;
    }
  }
  // Tabs not in any nav group (e.g. internal preview slots) — allow.
  return true;
}

function ConfigToolsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
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
