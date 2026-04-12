import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { FileText, Search, CheckCircle2, XCircle, ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE = 50;

export function AuditTab() {
  const [logs, setLogs] = useState<Record<string, unknown>[]>([]);
  const [subjectFilter, setSubjectFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [pathFilter, setPathFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const result = await api.auditLogs({
        subject: subjectFilter || undefined,
        action: actionFilter || undefined,
        path: pathFilter || undefined,
        limit: PAGE_SIZE + 1,
        offset: p * PAGE_SIZE,
      });
      setHasMore(result.length > PAGE_SIZE);
      setLogs(result.slice(0, PAGE_SIZE));
    } catch { setLogs([]); }
    setLoading(false);
  }, [subjectFilter, actionFilter, pathFilter]);

  useEffect(() => { load(page); }, [page, load]);

  const handleSearch = () => {
    setPage(0);
    load(0);
  };

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Audit Log</h1>
        <p className="page-desc">All authorization decisions are recorded here for compliance and debugging</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <FileText size={16} className="text-blue-600" />
            Access Decisions
          </h2>
        </div>
        <div className="card-body border-b border-slate-100 space-y-3">
          <div className="flex gap-1.5">
            {[{ value: '', label: 'All' }, { value: 'A', label: 'Path A (Data)' }, { value: 'B', label: 'Path B (Admin)' }, { value: 'C', label: 'Path C (DB)' }].map(opt => (
              <button key={opt.value} onClick={() => { setPathFilter(opt.value); setPage(0); }}
                className={`btn btn-xs gap-1 ${pathFilter === opt.value ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'}`}>
                {opt.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Subject ID</label>
              <input value={subjectFilter} onChange={e => setSubjectFilter(e.target.value)}
                placeholder="e.g. user:wang_pe" className="input"
                onKeyDown={e => e.key === 'Enter' && handleSearch()} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Action</label>
              <input value={actionFilter} onChange={e => setActionFilter(e.target.value)}
                placeholder="e.g. read" className="input"
                onKeyDown={e => e.key === 'Enter' && handleSearch()} />
            </div>
            <button onClick={handleSearch} disabled={loading} className="btn-primary btn-sm w-full sm:w-auto">
              <Search size={12} /> {loading ? 'Searching...' : 'Search'}
            </button>
          </div>
        </div>

        {logs.length === 0 && !loading ? (
          <div className="card-body text-center py-16">
            <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <FileText size={24} className="text-slate-400" />
            </div>
            <p className="text-slate-500 text-sm mb-1">No audit logs found</p>
            <p className="text-slate-400 text-xs">Entries will appear after AuthZ operations are logged</p>
          </div>
        ) : (
          <>
            <div className="table-container max-h-[60vh]">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th><th>Path</th><th>Subject</th>
                    <th>Action</th><th>Resource</th><th>Decision</th><th>Context</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log, i) => (
                    <tr key={i}>
                      <td className="text-xs text-slate-500">
                        {log.timestamp ? new Date(String(log.timestamp)).toLocaleString() : '-'}
                      </td>
                      <td>
                        {log.access_path ? (
                          <span className={`badge text-[10px] ${
                            String(log.access_path) === 'A' ? 'badge-blue' :
                            String(log.access_path) === 'B' ? 'badge-green' :
                            'badge-purple'
                          }`}>
                            Path {String(log.access_path)}
                          </span>
                        ) : null}
                      </td>
                      <td className="font-mono text-xs">{String(log.subject_id ?? '-')}</td>
                      <td><span className="badge badge-slate text-[10px]">{String(log.action_id ?? '-')}</span></td>
                      <td className="font-mono text-xs text-slate-500">{String(log.resource_id ?? '-')}</td>
                      <td>
                        {log.decision === 'allow' ? (
                          <span className="badge badge-green inline-flex items-center gap-1">
                            <CheckCircle2 size={10} /> ALLOW
                          </span>
                        ) : log.decision === 'deny' ? (
                          <span className="badge badge-red inline-flex items-center gap-1">
                            <XCircle size={10} /> DENY
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs">{String(log.decision ?? '-')}</span>
                        )}
                      </td>
                      <td className="text-xs text-slate-400 max-w-[200px] truncate">
                        {log.context ? JSON.stringify(log.context) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="card-body border-t border-slate-100 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                Showing {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + logs.length}
              </span>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => p - 1)} disabled={page === 0}
                  className="btn-secondary btn-sm gap-1">
                  <ChevronLeft size={14} /> Previous
                </button>
                <button onClick={() => setPage(p => p + 1)} disabled={!hasMore}
                  className="btn-secondary btn-sm gap-1">
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
