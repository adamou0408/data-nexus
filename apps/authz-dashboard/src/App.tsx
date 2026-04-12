import { useState } from 'react';
import { Layout, TabId } from './components/Layout';
import { ResolveTab } from './components/ResolveTab';
import { CheckTab } from './components/CheckTab';
import { MatrixTab } from './components/MatrixTab';
import { RlsTab } from './components/RlsTab';
import { PoolTab } from './components/PoolTab';
import { BrowserTab } from './components/BrowserTab';
import { AuditTab } from './components/AuditTab';

export default function App() {
  const [tab, setTab] = useState<TabId>('resolve');

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
