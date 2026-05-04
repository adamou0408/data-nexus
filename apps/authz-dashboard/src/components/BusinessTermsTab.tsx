// ============================================================
// BusinessTermsTab — Admin curator UI for V044 semantic layer
//
// Lists rows from /api/business-term and lets admins:
//   • Edit business_term / definition / formula / owner_subject_id
//   • Transition lifecycle (draft → under_review → blessed → deprecated)
//
// This is gate-prep tooling for §3.4 C primitive. C unlocks at
// blessed_term ≥ 10. Admin-only — mounted at requireRole at the API layer.
//
// Plan: .claude/plans/v3-phase-1/tier-a-business-term-admin-plan.md
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, RefreshCw, Filter, Pencil, X } from 'lucide-react';
import { api, BusinessTermRow, BusinessTermStatus } from '../api';
import { EmptyState } from './shared/atoms/EmptyState';

type StatusFilter = BusinessTermStatus | 'all';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all',          label: 'All' },
  { value: 'draft',        label: 'Draft' },
  { value: 'under_review', label: 'Under review' },
  { value: 'blessed',      label: 'Blessed' },
  { value: 'deprecated',   label: 'Deprecated' },
];

const STATUS_BADGE: Record<BusinessTermStatus, string> = {
  draft:        'bg-slate-100 text-slate-700 ring-slate-200',
  under_review: 'bg-amber-50 text-amber-700 ring-amber-200',
  blessed:      'bg-emerald-50 text-emerald-700 ring-emerald-200',
  deprecated:   'bg-rose-50 text-rose-700 ring-rose-200',
};

// Lifecycle → list of next-state transitions admin can pick.
// 'deprecated' rows can only restore to draft (audit history preserved).
const NEXT_STATES: Record<BusinessTermStatus | 'null', BusinessTermStatus[]> = {
  null:         ['draft'],
  draft:        ['under_review', 'blessed', 'deprecated'],
  under_review: ['draft', 'blessed', 'deprecated'],
  blessed:      ['deprecated'],
  deprecated:   ['draft'],
};

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function truncate(s: string | null, max = 80): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

export function BusinessTermsTab() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [rows, setRows] = useState<BusinessTermRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<BusinessTermRow | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.businessTermList(statusFilter === 'all' ? undefined : statusFilter);
      setRows(r.rows);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { void reload(); }, [reload]);

  const onTransition = async (row: BusinessTermRow, target: BusinessTermStatus) => {
    setPendingId(row.resource_id);
    setError(null);
    try {
      await api.businessTermTransition(row.resource_id, target);
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
            <BookOpen size={20} className="text-blue-600" />
            Business Terms
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Curate the semantic layer (V044). Bless ≥ 10 terms to unlock §3.4 C — column-mask automation.
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
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-3 py-2 text-xs text-slate-500">
          {rows.length} row{rows.length === 1 ? '' : 's'}
          {statusFilter !== 'all' && ` · status=${statusFilter}`}
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={28} />}
            message={loading ? 'Loading…' : 'No semantic-layer rows match this filter.'}
            hint={
              !loading && statusFilter === 'all'
                ? 'Create draft rows by setting business_term on an authz_resource (raw SQL or Discover Tab in v2).'
                : undefined
            }
            size="lg"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Resource</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Term</th>
                  <th className="px-3 py-2 text-left">Definition</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Owner</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Status</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left">Blessed</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const busy = pendingId === r.resource_id;
                  const stateKey = (r.status ?? 'null') as keyof typeof NEXT_STATES;
                  const next = NEXT_STATES[stateKey] ?? [];
                  return (
                    <tr key={r.resource_id} className="align-top hover:bg-slate-50">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">
                        {r.resource_id}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-800">
                        {r.business_term ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-2 max-w-md text-slate-700">
                        {truncate(r.definition, 120) || <span className="text-slate-400">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-700">
                        {r.owner_subject_id ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {r.status ? (
                          <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_BADGE[r.status]}`}>
                            {r.status}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                        {r.blessed_at ? (
                          <div>
                            <div className="font-mono">{fmtTime(r.blessed_at)}</div>
                            {r.blessed_by && <div className="text-[10px] text-slate-400">by {r.blessed_by}</div>}
                          </div>
                        ) : '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-1">
                          <button
                            onClick={() => setEditing(r)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                            title="Edit term/definition/formula/owner"
                          >
                            <Pencil size={12} />
                            Edit
                          </button>
                          {next.map((target) => (
                            <button
                              key={target}
                              onClick={() => void onTransition(r, target)}
                              disabled={busy}
                              className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40"
                              title={`Transition to ${target}`}
                            >
                              → {target}
                            </button>
                          ))}
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

      {editing && (
        <EditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      )}
    </div>
  );
}

function EditModal({
  row, onClose, onSaved,
}: {
  row: BusinessTermRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [term, setTerm] = useState(row.business_term ?? '');
  const [definition, setDefinition] = useState(row.definition ?? '');
  const [formula, setFormula] = useState(row.formula ?? '');
  const [owner, setOwner] = useState(row.owner_subject_id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const fields = {
        business_term:    term.trim()       || null,
        definition:       definition.trim() || null,
        formula:          formula.trim()    || null,
        owner_subject_id: owner.trim()      || null,
      };
      await api.businessTermPatch(row.resource_id, fields);
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Edit Business Term</h2>
            <div className="text-xs font-mono text-slate-500 mt-0.5">{row.resource_id}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Business term</label>
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              maxLength={200}
              placeholder="e.g. monthly_active_users"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-400 mt-0.5">1-200 chars. Unique among blessed rows.</div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Definition</label>
            <textarea
              value={definition}
              onChange={(e) => setDefinition(e.target.value)}
              maxLength={4000}
              rows={4}
              placeholder="Plain-English description of what this term means."
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Formula</label>
            <textarea
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              maxLength={4000}
              rows={3}
              placeholder="e.g. count(distinct user_id) where last_login &gt;= now() - interval '30 days'"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-400 mt-0.5">
              Descriptive only — not currently executed by any resolver.
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Owner subject</label>
            <input
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="subject_id (e.g. ldap.alice)"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-400 mt-0.5">Must reference an existing authz_subject.</div>
          </div>

          {error && (
            <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void onSave()}
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
