import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { useToast } from '../Toast';
import { EmptyState } from '../shared/atoms/EmptyState';
import { StatCard } from '../shared/atoms/StatCard';
import {
  Inbox, Loader2, CheckCircle2, XCircle, Filter, RefreshCw, Shield, Sparkles, Database,
} from 'lucide-react';

type Suggestion = Awaited<ReturnType<typeof api.discoverSuggestions>>[number];

type Props = {
  dsList: { source_id: string; display_name: string }[];
};

const RULE_TYPE_LABEL: Record<string, { text: string; tone: string; icon: JSX.Element }> = {
  column_mask:    { text: 'Column Mask',    tone: 'bg-violet-50 text-violet-700 border-violet-200',   icon: <Shield size={11} /> },
  row_filter:     { text: 'Row Filter',     tone: 'bg-amber-50 text-amber-700 border-amber-200',     icon: <Filter size={11} /> },
  classification: { text: 'Classification', tone: 'bg-slate-100 text-slate-700 border-slate-200',    icon: <Sparkles size={11} /> },
};

export function PendingReviewPanel({ dsList }: Props) {
  const toast = useToast();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [dsFilter, setDsFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | 'column_mask' | 'row_filter'>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.discoverSuggestions({
        data_source_id: dsFilter || undefined,
        rule_type: typeFilter || undefined,
      });
      setItems(rows);
    } catch (err) {
      toast.error('Failed to load suggestions');
      console.warn(err);
    } finally {
      setLoading(false);
    }
  }, [dsFilter, typeFilter, toast]);

  useEffect(() => { load(); }, [load]);

  const onAct = async (s: Suggestion, action: 'approve' | 'reject') => {
    setBusyId(s.policy_id);
    try {
      await api.discoverSuggestionAct(s.policy_id, { action });
      toast.success(action === 'approve' ? 'Approved — now active' : 'Rejected');
      setItems(prev => prev.filter(x => x.policy_id !== s.policy_id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  };

  const onRunRules = async () => {
    setRunning(true);
    try {
      const r = await api.discoverRunRules(dsFilter || undefined);
      toast.success(
        `Engine: ${r.policies_created} created, ${r.policies_skipped} already existed, ${r.classifications_tagged} tags`,
      );
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Run failed';
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  };

  const totalMask = items.filter(i => i.rule_type === 'column_mask').length;
  const totalFilter = items.filter(i => i.rule_type === 'row_filter').length;

  return (
    <div className="space-y-4" data-testid="pending-review-panel">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard
          icon={<Inbox size={18} className="text-blue-500" />}
          iconBg="bg-blue-50"
          value={items.length}
          label="Pending suggestions"
          sub="awaiting admin review"
        />
        <StatCard
          icon={<Shield size={18} className="text-violet-500" />}
          iconBg="bg-violet-50"
          value={totalMask}
          label="Column masks"
        />
        <StatCard
          icon={<Filter size={18} className="text-amber-500" />}
          iconBg="bg-amber-50"
          value={totalFilter}
          label="Row filters"
        />
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Filter size={12} className="text-slate-400" />
          <select
            data-testid="pending-ds-filter"
            value={dsFilter}
            onChange={e => setDsFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded px-2 py-1.5 bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none max-w-[200px]"
          >
            <option value="">All data sources</option>
            {dsList.map(d => (
              <option key={d.source_id} value={d.source_id}>{d.display_name}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-1 bg-slate-100 rounded-md p-0.5">
          {(['', 'column_mask', 'row_filter'] as const).map(t => (
            <button
              key={t || 'all'}
              data-testid={`pending-type-${t || 'all'}`}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
                typeFilter === t ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t === '' ? 'All' : t === 'column_mask' ? 'Masks' : 'Filters'}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <button
          data-testid="pending-refresh"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          data-testid="pending-run-rules"
          onClick={onRunRules}
          disabled={running}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          title="Re-run discovery rule engine across all resources (or filtered data source)"
        >
          {running ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {running ? 'Running…' : 'Re-run rules'}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 text-sm">
          <Loader2 size={16} className="animate-spin mr-2" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Inbox size={32} />}
          message="Inbox zero"
          hint="No pending suggestions. Re-run rules to back-fill, or run discovery on a data source to generate new ones."
          size="lg"
        />
      ) : (
        <div className="space-y-2">
          {items.map(s => {
            const rt = RULE_TYPE_LABEL[s.rule_type] ?? RULE_TYPE_LABEL.classification;
            const masks = s.column_mask_rules ?? {};
            const maskCols = Object.keys(masks);
            return (
              <div
                key={s.policy_id}
                data-testid={`suggestion-${s.policy_id}`}
                className="bg-white border border-slate-200 rounded-lg p-4 hover:border-slate-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border ${rt.tone}`}>
                        {rt.icon}
                        {rt.text}
                      </span>
                      {s.suggested_label && (
                        <span className="text-[11px] text-slate-500 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                          {s.suggested_label}
                        </span>
                      )}
                      <span className="text-[11px] text-slate-400 font-mono">{s.policy_name}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-sm">
                      <Database size={13} className="text-slate-400" />
                      <span className="font-medium text-slate-900">
                        {s.target_display_name || s.target_resource_id || '—'}
                      </span>
                      <span className="text-[11px] text-slate-400 font-mono">{s.target_resource_id}</span>
                      {s.target_data_source_name && (
                        <span className="text-[11px] text-slate-500">· {s.target_data_source_name}</span>
                      )}
                    </div>

                    {s.suggested_reason && (
                      <div className="mt-1 text-xs text-slate-600">{s.suggested_reason}</div>
                    )}

                    {s.rule_type === 'column_mask' && maskCols.length > 0 && (
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        <span className="text-slate-500">Mask:</span>
                        {maskCols.map(c => (
                          <span key={c} className="inline-flex items-center gap-1 bg-violet-50 text-violet-700 px-2 py-0.5 rounded font-mono text-[11px] border border-violet-100">
                            {c} → {masks[c]}
                          </span>
                        ))}
                      </div>
                    )}

                    {s.rule_type === 'row_filter' && s.rls_expression && (
                      <div className="mt-2 flex items-start gap-2 text-xs">
                        <span className="text-slate-500 pt-0.5">Filter:</span>
                        <code className="bg-amber-50 text-amber-900 px-2 py-1 rounded text-[11px] font-mono border border-amber-100 break-all">
                          {s.rls_expression}
                        </code>
                      </div>
                    )}

                    {s.match_pattern && (
                      <div className="mt-1 text-[11px] text-slate-400">
                        Matched <code className="font-mono">{s.match_pattern}</code>
                        {s.suggested_at && <> · {new Date(s.suggested_at).toLocaleString()}</>}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      data-testid={`reject-${s.policy_id}`}
                      onClick={() => onAct(s, 'reject')}
                      disabled={busyId === s.policy_id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50"
                    >
                      {busyId === s.policy_id ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                      Reject
                    </button>
                    <button
                      data-testid={`approve-${s.policy_id}`}
                      onClick={() => onAct(s, 'approve')}
                      disabled={busyId === s.policy_id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded hover:bg-emerald-700 disabled:opacity-50"
                      title="Activate this policy — it will start enforcing immediately"
                    >
                      {busyId === s.policy_id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                      Approve
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
