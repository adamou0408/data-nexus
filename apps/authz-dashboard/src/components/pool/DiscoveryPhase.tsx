import { useState } from 'react';
import { api, LifecycleResponse } from '../../api';
import { useToast } from '../Toast';
import { RefreshCw, Search, Database, FolderSearch } from 'lucide-react';

export function DiscoveryPhase({ dsId, lifecycle, onMutate }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void }) {
  const toast = useToast();
  const [discovering, setDiscovering] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<{ tables_found: number; views_found: number; functions_found: number; resources_created: number } | null>(null);
  const [tablesData, setTablesData] = useState<{ table_schema: string; table_name: string; table_type: string; column_count: string }[] | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);
  const [functionsData, setFunctionsData] = useState<{ resource_id: string; display_name: string; attributes: Record<string, unknown> }[] | null>(null);
  const [loadingFunctions, setLoadingFunctions] = useState(false);

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const result = await api.datasourceDiscover(dsId);
      setDiscoverResult({ tables_found: result.tables_found, views_found: result.views_found, functions_found: result.functions_found, resources_created: result.resources_created });
      onMutate();
    } catch (err) { toast.error(String(err)); }
    finally { setDiscovering(false); }
  };

  const handleViewTables = async () => {
    if (tablesData) { setTablesData(null); return; }
    setLoadingTables(true);
    try {
      const result = await api.datasourceTables(dsId);
      setTablesData(result.tables);
    } catch (err) { toast.error(String(err)); }
    finally { setLoadingTables(false); }
  };

  const handleViewFunctions = async () => {
    if (functionsData) { setFunctionsData(null); return; }
    setLoadingFunctions(true);
    try {
      const result = await api.resourcesFunctions(dsId);
      setFunctionsData(result);
    } catch (err) { toast.error(String(err)); }
    finally { setLoadingFunctions(false); }
  };

  const disc = lifecycle.phases.discovery;

  return (
    <div className="space-y-4">
      {disc.status === 'done' && (
        <div className="grid grid-cols-5 gap-3 text-center">
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-xl font-bold text-slate-900">{disc.tables}</div>
            <div className="text-xs text-slate-500">Tables</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-xl font-bold text-slate-900">{disc.views || 0}</div>
            <div className="text-xs text-slate-500">Views</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-xl font-bold text-slate-900">{disc.columns}</div>
            <div className="text-xs text-slate-500">Columns</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-xl font-bold text-slate-900">{disc.functions || 0}</div>
            <div className="text-xs text-slate-500">Functions</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-xs text-slate-500">Last Discovered</div>
            <div className="text-sm font-medium text-slate-700 mt-1">
              {disc.last_discovered ? new Date(disc.last_discovered).toLocaleString() : 'Never'}
            </div>
          </div>
        </div>
      )}

      {disc.status === 'not_started' && !discoverResult && (
        <div className="text-center py-6 bg-slate-50 rounded-lg border border-dashed border-slate-300">
          <FolderSearch size={28} className="mx-auto text-slate-400 mb-2" />
          <div className="text-sm font-medium text-slate-600">Schema not yet discovered</div>
          <div className="text-xs text-slate-400 mt-1">Click "Discover Schema" to scan tables, views, columns, and functions from the connected database.</div>
        </div>
      )}

      {discovering && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-6 text-center animate-pulse">
          <RefreshCw size={24} className="mx-auto text-blue-500 animate-spin mb-2" />
          <div className="text-sm font-medium text-blue-700">Scanning database schemas...</div>
          <div className="text-xs text-blue-400 mt-1">Discovering tables, views, columns, and functions — this may take a minute for large databases</div>
        </div>
      )}

      {discoverResult && !discovering && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800">
          Found {discoverResult.tables_found} tables, {discoverResult.views_found} views, {discoverResult.functions_found} functions — created {discoverResult.resources_created} new resources
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <button onClick={handleDiscover} disabled={discovering} className="btn-primary btn-sm gap-1">
          {discovering ? <RefreshCw size={12} className="animate-spin" /> : <Search size={12} />}
          {discovering ? 'Discovering...' : disc.status === 'done' ? 'Re-discover' : 'Discover Schema'}
        </button>
        {disc.status === 'done' && (
          <>
            <button onClick={handleViewTables} disabled={loadingTables} className="btn-secondary btn-sm gap-1">
              {loadingTables ? <RefreshCw size={12} className="animate-spin" /> : <Database size={12} />}
              {tablesData ? 'Hide Tables' : 'View Tables'}
            </button>
            <button onClick={handleViewFunctions} disabled={loadingFunctions} className="btn-secondary btn-sm gap-1">
              {loadingFunctions ? <RefreshCw size={12} className="animate-spin" /> : <Database size={12} />}
              {functionsData ? 'Hide Functions' : 'View Functions'}
            </button>
          </>
        )}
      </div>

      {tablesData && (
        <div className="grid grid-cols-3 gap-1 mt-2">
          {tablesData.map(t => (
            <div key={`${t.table_schema}.${t.table_name}`} className="font-mono text-xs text-slate-700">
              {t.table_schema}.<span className="font-bold">{t.table_name}</span>
              <span className={`text-xs ml-1 ${t.table_type === 'VIEW' ? 'text-blue-500' : 'text-slate-400'}`}>
                ({t.table_type === 'VIEW' ? 'view' : `${t.column_count} cols`})
              </span>
            </div>
          ))}
        </div>
      )}

      {functionsData && (
        <div className="mt-2">
          {functionsData.length === 0 ? (
            <div className="text-xs text-slate-400">No functions discovered.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left text-slate-500 border-b">
                    <th className="py-1 pr-4 font-medium">Function</th>
                    <th className="py-1 pr-4 font-medium">Arguments</th>
                    <th className="py-1 pr-4 font-medium">Returns</th>
                    <th className="py-1 font-medium">Volatility</th>
                  </tr>
                </thead>
                <tbody>
                  {functionsData.map(fn => (
                    <tr key={fn.resource_id} className="border-b border-slate-100">
                      <td className="py-1.5 pr-4 font-mono font-bold text-slate-800">{fn.resource_id.replace('function:', '')}</td>
                      <td className="py-1.5 pr-4 font-mono text-slate-600">{(fn.attributes.arguments as string) || '-'}</td>
                      <td className="py-1.5 pr-4 font-mono text-slate-600">{(fn.attributes.return_type as string) || '-'}</td>
                      <td className="py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                          fn.attributes.volatility === 'STABLE' ? 'bg-emerald-100 text-emerald-700' :
                          fn.attributes.volatility === 'IMMUTABLE' ? 'bg-blue-100 text-blue-700' :
                          'bg-amber-100 text-amber-700'
                        }`}>{(fn.attributes.volatility as string) || 'VOLATILE'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
