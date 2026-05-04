import { Database, ChevronDown } from 'lucide-react';
import { useDataSource } from '../DataSourceContext';

// DS-PICKER-V01: compact dropdown rendered in the sidebar bottom block.
// Two empty states:
//   1. dataSources.length === 0  → "No data sources" + Discover shortcut
//   2. activeDataSourceId === null → "Select…" placeholder (initial state)
// Visual style mirrors the X-User-Id <select> right above it in Layout.tsx.
//
// `collapsed` shrinks the picker to icon-only when the sidebar is collapsed,
// matching the user-avatar treatment in the same slot.
export function DataSourcePicker({ collapsed = false }: { collapsed?: boolean }) {
  const { activeDataSourceId, setActiveDataSourceId, dataSources, loading } = useDataSource();

  const goDiscover = () => {
    window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'discover' } }));
  };

  if (collapsed) {
    const active = dataSources.find(d => d.source_id === activeDataSourceId);
    return (
      <button
        onClick={goDiscover}
        title={active ? `Data Source: ${active.display_name}` : 'No data source selected'}
        className="w-7 h-7 rounded-md flex items-center justify-center bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
      >
        <Database size={14} />
      </button>
    );
  }

  if (!loading && dataSources.length === 0) {
    return (
      <button
        onClick={goDiscover}
        className="w-full flex items-center gap-2 bg-slate-800 text-slate-300 border border-slate-700 rounded-lg
                   px-3 py-2 text-xs hover:border-slate-600 hover:text-white transition-colors"
        title="No data sources registered — open Discover"
      >
        <Database size={14} className="text-slate-500 shrink-0" />
        <span className="flex-1 text-left truncate">No data sources — Discover</span>
      </button>
    );
  }

  return (
    <div className="relative">
      <Database size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
      <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
      <select
        value={activeDataSourceId ?? ''}
        onChange={e => setActiveDataSourceId(e.target.value === '' ? null : e.target.value)}
        className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg
                   pl-9 pr-8 py-2 text-xs appearance-none cursor-pointer
                   hover:border-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                   focus:outline-none transition-colors"
        title={activeDataSourceId ?? 'No data source selected'}
      >
        <option value="">{loading ? 'Loading sources...' : 'Select Data Source...'}</option>
        {dataSources.map(d => (
          <option key={d.source_id} value={d.source_id}>
            {d.display_name} ({d.source_id})
          </option>
        ))}
      </select>
    </div>
  );
}
