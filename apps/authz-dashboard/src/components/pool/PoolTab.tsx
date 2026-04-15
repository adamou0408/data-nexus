import { useState } from 'react';
import { DataSourceOverview } from './DataSourceOverview';
import { DataSourceLifecycle } from './DataSourceLifecycle';

export function PoolTab() {
  const [selectedDs, setSelectedDs] = useState<string | null>(null);

  return selectedDs
    ? <DataSourceLifecycle dsId={selectedDs} onBack={() => setSelectedDs(null)} />
    : <DataSourceOverview onSelect={setSelectedDs} />;
}
