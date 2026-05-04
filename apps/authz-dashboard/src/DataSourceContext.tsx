import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { api, DataSource } from './api';
import { useAuthz } from './AuthzContext';

// DS-PICKER-V01: global selected data source.
// Mirrors the AuthzContext + persisted X-User-Id picker pattern. The api.ts
// query-path helpers (tables / tableSchema / dataExplorer / rlsSimulate /
// rlsData) require an explicit data_source_id (ARCH-02 — no internal-pool
// fallback). This context is the SSOT for "which source is the user browsing
// right now"; consumer tabs read `activeDataSourceId` and either pass it to
// the API or render an empty state when null.
//
// NOTE: The Discover Tab manages its own per-source selection inline; it must
// not depend on this global picker.

const STORAGE_KEY = 'nx_active_ds_v1';

type DataSourceContextValue = {
  activeDataSourceId: string | null;
  setActiveDataSourceId: (id: string | null) => void;
  dataSources: DataSource[];
  loading: boolean;
  reload: () => Promise<void>;
};

const DataSourceContext = createContext<DataSourceContextValue | null>(null);

function readPersisted(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw && typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

function writePersisted(id: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage can throw on quota / privacy mode — best-effort.
  }
}

export function DataSourceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthz();
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(() => readPersisted());

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.datasources();
      setDataSources(list);
      // Drop persisted selection if it no longer matches a known source
      // (seed reset, source deleted, etc.).
      const persisted = readPersisted();
      if (persisted && !list.find(d => d.source_id === persisted)) {
        writePersisted(null);
        setActiveId(null);
      } else if (persisted) {
        // Re-sync state in case external code wrote localStorage.
        setActiveId(persisted);
      }
    } catch {
      setDataSources([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load on mount.
  useEffect(() => {
    void reload();
  }, [reload]);

  // Refetch when the authenticated user changes — `api.datasources()` requires
  // X-User-Id. On a fresh first-load (no persisted user) the mount-time call
  // races the user picker; this useEffect re-runs once the user resolves.
  useEffect(() => {
    if (user) void reload();
  }, [user, reload]);

  const setActiveDataSourceId = useCallback((id: string | null) => {
    writePersisted(id);
    setActiveId(id);
  }, []);

  return (
    <DataSourceContext.Provider value={{
      activeDataSourceId: activeId,
      setActiveDataSourceId,
      dataSources,
      loading,
      reload,
    }}>
      {children}
    </DataSourceContext.Provider>
  );
}

export function useDataSource() {
  const ctx = useContext(DataSourceContext);
  if (!ctx) throw new Error('useDataSource must be used within DataSourceProvider');
  return ctx;
}
