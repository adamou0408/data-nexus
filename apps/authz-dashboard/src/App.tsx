import { useState } from 'react';
import { Layout, TabId } from './components/Layout';
import { ResolveTab } from './components/ResolveTab';
import { CheckTab } from './components/CheckTab';
import { MatrixTab } from './components/MatrixTab';
import { RlsTab } from './components/RlsTab';
import { BrowserTab } from './components/BrowserTab';

export default function App() {
  const [tab, setTab] = useState<TabId>('resolve');

  return (
    <Layout activeTab={tab} onTabChange={setTab}>
      {tab === 'resolve' && <ResolveTab />}
      {tab === 'check' && <CheckTab />}
      {tab === 'matrix' && <MatrixTab />}
      {tab === 'rls' && <RlsTab />}
      {tab === 'browser' && <BrowserTab />}
    </Layout>
  );
}
