import { useState, useEffect } from 'react';
import { AuthzProvider, useAuthz } from './AuthzContext';
import { Layout, TabId } from './components/Layout';
import { OverviewTab } from './components/OverviewTab';
import { ResolveTab } from './components/ResolveTab';
import { CheckTab } from './components/CheckTab';
import { MatrixTab } from './components/MatrixTab';
import { RlsTab } from './components/RlsTab';
import { PoolTab } from './components/PoolTab';
import { BrowserTab } from './components/BrowserTab';
import { AuditTab } from './components/AuditTab';
import { TablesTab } from './components/TablesTab';
import { FunctionsTab } from './components/FunctionsTab';
import { ConfigEngine } from './components/ConfigEngine';

function AppInner() {
  const [tab, setTab] = useState<TabId>('overview');
  const { config } = useAuthz();

  const isAdmin = config?.resolved_roles?.some(r => r === 'ADMIN' || r === 'AUTHZ_ADMIN') ?? false;

  useEffect(() => {
    const adminTabs: TabId[] = ['pool', 'audit', 'browser', 'check', 'rls', 'functions', 'raw-tables'];
    if (adminTabs.includes(tab) && !isAdmin) {
      setTab('overview');
    }
  }, [isAdmin, tab]);

  return (
    <Layout activeTab={tab} onTabChange={setTab}>
      {tab === 'overview' && <OverviewTab onNavigate={(t) => setTab(t as TabId)} />}
      {tab === 'resolve' && <ResolveTab />}
      {tab === 'check' && <CheckTab />}
      {tab === 'matrix' && <MatrixTab />}
      {tab === 'tables' && <ConfigEngine />}
      {tab === 'raw-tables' && <TablesTab />}
      {tab === 'functions' && <FunctionsTab />}
      {tab === 'rls' && <RlsTab />}
      {tab === 'pool' && <PoolTab />}
      {tab === 'browser' && <BrowserTab />}
      {tab === 'audit' && <AuditTab />}
    </Layout>
  );
}

export default function App() {
  return (
    <AuthzProvider>
      <AppInner />
    </AuthzProvider>
  );
}
