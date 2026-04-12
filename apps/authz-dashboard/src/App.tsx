import { useState, useEffect } from 'react';
import { AuthzProvider, useAuthz } from './AuthzContext';
import { Layout, TabId } from './components/Layout';
import { ResolveTab } from './components/ResolveTab';
import { CheckTab } from './components/CheckTab';
import { MatrixTab } from './components/MatrixTab';
import { RlsTab } from './components/RlsTab';
import { PoolTab } from './components/PoolTab';
import { BrowserTab } from './components/BrowserTab';
import { AuditTab } from './components/AuditTab';

function AppInner() {
  const [tab, setTab] = useState<TabId>('resolve');
  const { config } = useAuthz();

  const isAdmin = config?.resolved_roles?.some(r => r === 'ADMIN' || r === 'AUTHZ_ADMIN') ?? false;

  // If current tab requires admin and user is not admin, switch to resolve
  useEffect(() => {
    if ((tab === 'pool' || tab === 'audit') && !isAdmin) {
      setTab('resolve');
    }
  }, [isAdmin, tab]);

  return (
    <Layout activeTab={tab} onTabChange={setTab}>
      {tab === 'resolve' && <ResolveTab />}
      {tab === 'check' && <CheckTab />}
      {tab === 'matrix' && <MatrixTab />}
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
