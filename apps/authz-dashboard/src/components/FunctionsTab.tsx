import { useState, useEffect } from 'react';
import { api, SqlFunction } from '../api';
import { Code2 } from 'lucide-react';

export function FunctionsTab() {
  const [functions, setFunctions] = useState<SqlFunction[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.functions().then(setFunctions).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const nameColor = (name: string) => {
    if (name.startsWith('fn_mask_')) return 'badge-amber';
    return 'badge-blue';
  };

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">SQL Functions</h1>
        <p className="page-desc">Available SQL functions for data queries and column masking</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Code2 size={16} className="text-blue-600" />
            Function List
          </h3>
          <span className="text-xs text-slate-400">{functions.length} functions</span>
        </div>
        {loading ? (
          <div className="card-body text-center py-8 text-slate-400">Loading...</div>
        ) : (
          <div className="table-container max-h-[70vh]">
            <table className="table">
              <thead>
                <tr><th>Function</th><th>Arguments</th><th>Returns</th><th>Volatility</th><th>Description</th></tr>
              </thead>
              <tbody>
                {functions.map((f, i) => (
                  <tr key={`${f.function_name}-${i}`}>
                    <td>
                      <span className={`badge text-[10px] ${nameColor(f.function_name)}`}>
                        {f.function_name}
                      </span>
                    </td>
                    <td className="font-mono text-[11px] text-slate-600 max-w-[300px]">
                      {f.arguments || '-'}
                    </td>
                    <td className="font-mono text-xs text-slate-500">{f.return_type}</td>
                    <td>
                      <span className={`badge text-[10px] ${
                        f.volatility === 'STABLE' ? 'badge-green' :
                        f.volatility === 'IMMUTABLE' ? 'badge-blue' : 'badge-slate'
                      }`}>
                        {f.volatility}
                      </span>
                    </td>
                    <td className="text-xs text-slate-400 max-w-[200px] truncate">
                      {f.description ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
