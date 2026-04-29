// ============================================================
// FeedbackInboxTab — Curator-side closure for FEEDBACK-V01
//
// Lists rows from /api/feedback/inbox with status / page_id filters.
// Triage actions (triaged / resolved / dismissed) call PATCH /:id/status.
//
// Plan: .claude/plans/v3-phase-1/tier-a-feedback-plan.md (FU commit)
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox, RefreshCw, Filter, MessageSquare } from 'lucide-react';
import { api, FeedbackRow, FeedbackStatus } from '../api';
import { EmptyState } from './shared/atoms/EmptyState';

type StatusFilter = FeedbackStatus | 'all';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'open',      label: 'Open' },
  { value: 'triaged',   label: 'Triaged' },
  { value: 'resolved',  label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all',       label: 'All' },
];

const KIND_LABEL: Record<FeedbackRow['kind'], string> = {
  data_wrong:      'Data wrong',
  feature_request: 'Feature',
  confusing:       'Confusing',
  other:           'Other',
};

const KIND_BADGE: Record<FeedbackRow['kind'], string> = {
  data_wrong:      'bg-red-50 text-red-700 ring-red-200',
  feature_request: 'bg-blue-50 text-blue-700 ring-blue-200',
  confusing:       'bg-amber-50 text-amber-700 ring-amber-200',
  other:           'bg-slate-50 text-slate-700 ring-slate-200',
};

const STATUS_BADGE: Record<FeedbackStatus, string> = {
  open:      'bg-blue-100 text-blue-800 ring-blue-200',
  triaged:   'bg-violet-100 text-violet-800 ring-violet-200',
  resolved:  'bg-emerald-100 text-emerald-800 ring-emerald-200',
  dismissed: 'bg-slate-200 text-slate-700 ring-slate-300',
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function FeedbackInboxTab() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [pageIdFilter, setPageIdFilter] = useState('');
  const [pageIdInput, setPageIdInput] = useState('');
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.feedbackInbox({
        status:  statusFilter === 'all' ? undefined : statusFilter,
        page_id: pageIdFilter || undefined,
      });
      setRows(r.feedback);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, pageIdFilter]);

  useEffect(() => { void reload(); }, [reload]);

  const onTriage = async (
    id: string,
    target: Exclude<FeedbackStatus, 'open'>
  ) => {
    setPendingId(id);
    try {
      await api.feedbackPatchStatus(id, target);
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingId(null);
    }
  };

  const counts = useMemo(() => {
    const c: Record<FeedbackStatus | 'all', number> = {
      open: 0, triaged: 0, resolved: 0, dismissed: 0, all: rows.length,
    };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
            <Inbox size={20} className="text-blue-600" />
            Feedback Inbox
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            User-submitted feedback on Tier B pages — triage, resolve, or dismiss.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          title="Reload"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Reload
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2">
        <Filter size={14} className="text-slate-400" />
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((f) => {
            const active = statusFilter === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`rounded px-2 py-1 text-xs font-medium transition ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            type="text"
            value={pageIdInput}
            onChange={(e) => setPageIdInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setPageIdFilter(pageIdInput.trim()); }}
            placeholder="filter by page_id…"
            className="w-56 rounded border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={() => setPageIdFilter(pageIdInput.trim())}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Apply
          </button>
          {pageIdFilter && (
            <button
              onClick={() => { setPageIdFilter(''); setPageIdInput(''); }}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-xs text-slate-500">
          <span>
            {rows.length} row{rows.length === 1 ? '' : 's'}
            {statusFilter !== 'all' && ` · status=${statusFilter}`}
            {pageIdFilter && ` · page_id=${pageIdFilter}`}
          </span>
          {statusFilter === 'all' && rows.length > 0 && (
            <span className="font-mono">
              open {counts.open} · triaged {counts.triaged} · resolved {counts.resolved} · dismissed {counts.dismissed}
            </span>
          )}
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={28} />}
            message={loading ? 'Loading…' : 'No feedback matches these filters.'}
            hint={
              !loading && statusFilter === 'open'
                ? 'No open feedback right now — all caught up.'
                : undefined
            }
            size="lg"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Submitted</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">From</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Page</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Target</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Body</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Status</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const busy = pendingId === r.feedback_id;
                  return (
                    <tr key={r.feedback_id} className="align-top hover:bg-slate-50">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-500">
                        {formatTime(r.created_at)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-700">{r.user_id}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">
                        {r.page_id}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">
                        {r.target_path}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${KIND_BADGE[r.kind]}`}>
                          {KIND_LABEL[r.kind]}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-xl whitespace-pre-wrap break-words text-slate-700">
                        {r.body}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_BADGE[r.status]}`}>
                          {r.status}
                        </span>
                        {r.curator_id && (
                          <div className="mt-1 text-[10px] text-slate-400">
                            by {r.curator_id}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <div className="inline-flex gap-1">
                          <button
                            onClick={() => void onTriage(r.feedback_id, 'triaged')}
                            disabled={busy || r.status === 'triaged'}
                            className="rounded border border-violet-300 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-40"
                            title="Mark as triaged"
                          >
                            Triage
                          </button>
                          <button
                            onClick={() => void onTriage(r.feedback_id, 'resolved')}
                            disabled={busy || r.status === 'resolved'}
                            className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                            title="Mark as resolved"
                          >
                            Resolve
                          </button>
                          <button
                            onClick={() => void onTriage(r.feedback_id, 'dismissed')}
                            disabled={busy || r.status === 'dismissed'}
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                            title="Dismiss"
                          >
                            Dismiss
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
