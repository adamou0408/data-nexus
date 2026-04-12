import { useState, useEffect } from 'react';
import { api } from '../api';

export function AuditTab() {
  const [logs, setLogs] = useState<Record<string, unknown>[]>([]);
  const [subjectFilter, setSubjectFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.auditLogs({
        subject: subjectFilter || undefined,
        action: actionFilter || undefined,
        limit: 100,
      });
      setLogs(data);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Audit Log</h2>
        <div className="flex gap-4 items-end mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject ID</label>
            <input value={subjectFilter} onChange={e => setSubjectFilter(e.target.value)}
              placeholder="e.g. user:wang_pe"
              className="border rounded-md px-3 py-2 text-sm w-56" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Action</label>
            <input value={actionFilter} onChange={e => setActionFilter(e.target.value)}
              placeholder="e.g. read"
              className="border rounded-md px-3 py-2 text-sm w-40" />
          </div>
          <button onClick={load} disabled={loading}
            className="bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'Loading...' : 'Search'}
          </button>
        </div>

        {logs.length === 0 && !loading ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-lg mb-2">No audit logs found</p>
            <p className="text-sm">Audit entries will appear here once AuthZ operations are logged.</p>
          </div>
        ) : (
          <div className="overflow-auto max-h-[600px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-left sticky top-0">
                  <th className="p-3">Time</th>
                  <th className="p-3">Subject</th>
                  <th className="p-3">Action</th>
                  <th className="p-3">Resource</th>
                  <th className="p-3">Decision</th>
                  <th className="p-3">Context</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, i) => (
                  <tr key={i} className="border-t hover:bg-gray-50">
                    <td className="p-3 text-xs whitespace-nowrap">
                      {log.timestamp ? new Date(String(log.timestamp)).toLocaleString() : '-'}
                    </td>
                    <td className="p-3 font-mono text-xs">{String(log.subject_id ?? '-')}</td>
                    <td className="p-3 text-xs">{String(log.action_id ?? '-')}</td>
                    <td className="p-3 font-mono text-xs">{String(log.resource_id ?? '-')}</td>
                    <td className="p-3">
                      {log.decision === 'allow' ? (
                        <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs font-bold">ALLOW</span>
                      ) : log.decision === 'deny' ? (
                        <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-bold">DENY</span>
                      ) : (
                        <span className="text-gray-400 text-xs">{String(log.decision ?? '-')}</span>
                      )}
                    </td>
                    <td className="p-3 text-xs text-gray-500 max-w-[300px] truncate">
                      {log.context ? JSON.stringify(log.context) : '-'}
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
