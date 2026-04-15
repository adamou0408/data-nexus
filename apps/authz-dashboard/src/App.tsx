import { useState, useEffect } from 'react';
import { AuthzProvider, useAuthz } from './AuthzContext';
import { ToastProvider } from './components/Toast';
import { Layout, TabId } from './components/Layout';
import { OverviewTab } from './components/OverviewTab';
import { ResolveTab } from './components/ResolveTab';
import { CheckTab } from './components/CheckTab';
import { MatrixTab } from './components/MatrixTab';
import { RlsTab } from './components/RlsTab';
import { PoolTab } from './components/pool';
import { BrowserTab, Section } from './components/BrowserTab';
import { AuditTab } from './components/AuditTab';
import { TablesTab } from './components/TablesTab';
import { FunctionsTab } from './components/FunctionsTab';
import { ConfigEngine } from './components/ConfigEngine';
import { MetabaseTab } from './components/MetabaseTab';

// Map sidebar access-* TabIds to Access Manager sections
const accessTabMap: Record<string, Section> = {
  'access-subjects': 'subjects',
  'access-roles': 'roles',
  'access-resources': 'resources',
  'access-policies': 'policies',
  'access-actions': 'actions',
};

function AppInner() {
  const [tab, setTab] = useState<TabId>('overview');
  const { isAdmin } = useAuthz();

  useEffect(() => {
    const adminTabs: TabId[] = [
      'pool', 'audit', 'check', 'rls', 'functions', 'raw-tables',
      'access-subjects', 'access-roles', 'access-resources', 'access-policies', 'access-actions',
    ];
    if (adminTabs.includes(tab) && !isAdmin) {
      setTab('overview');
    }
  }, [isAdmin, tab]);

  const accessSection = accessTabMap[tab];

  return (
    <Layout activeTab={tab} onTabChange={setTab}>
      {tab === 'overview' && <OverviewTab onNavigate={(t) => setTab(t as TabId)} />}
      {tab === 'resolve' && <ResolveTab />}
      {tab === 'check' && <CheckTab />}
      {tab === 'matrix' && <MatrixTab />}
      {tab === 'tables' && <ConfigEngine />}
      {tab === 'metabase' && <MetabaseTab />}
      {tab === 'raw-tables' && <TablesTab />}
      {tab === 'functions' && <FunctionsTab />}
      {tab === 'rls' && <RlsTab />}
      {tab === 'pool' && <PoolTab />}
      {accessSection && (
        <BrowserTab
          initialSection={accessSection}
          onSectionChange={(s) => {
            const newTab = Object.entries(accessTabMap).find(([, v]) => v === s)?.[0] as TabId | undefined;
            if (newTab) setTab(newTab);
          }}
        />
      )}
      {tab === 'audit' && <AuditTab />}
    </Layout>
  );
}

export default function App() {
  return (
    <AuthzProvider>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </AuthzProvider>
  );
}
