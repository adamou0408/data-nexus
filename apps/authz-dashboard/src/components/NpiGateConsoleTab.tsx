// First Path A handler that drives a composite-action workflow.
// Lives on top of V075 (workflow_request + approval_record) and V076
// (npi_advance_g0..g4 composite_actions). The page's resource_id
// 'module:mrp.npi.gate_signoff' gates visibility from fn_ui_root, so
// only roles with read on that resource (PE/QA/VP via V078) see the card.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Send, ThumbsUp, ThumbsDown, RefreshCw, AlertTriangle } from 'lucide-react';
import { api, WorkflowPendingRow, WorkflowChainStep } from '../api';
import { useRenderTokens } from '../RenderTokensContext';

type PageConfig = { title?: string; subtitle?: string };

// V076 ships exactly four composite_actions; hardcoding the menu keeps the
// dogfood console deterministic. A discovery endpoint can replace this once
// a second vertical lands.
const POLICIES: { policy_name: string; label: string; from: string; to: string }[] = [
  { policy_name: 'npi_advance_g0_to_g1', label: 'G0 concept → G1 feasibility',     from: 'NPI_G0_concept',       to: 'NPI_G1_feasibility' },
  { policy_name: 'npi_advance_g1_to_g2', label: 'G1 feasibility → G2 dev',          from: 'NPI_G1_feasibility',   to: 'NPI_G2_dev' },
  { policy_name: 'npi_advance_g2_to_g3', label: 'G2 dev → G3 qualification',        from: 'NPI_G2_dev',           to: 'NPI_G3_qualification' },
  { policy_name: 'npi_advance_g3_to_g4', label: 'G3 qualification → G4 mass prod.', from: 'NPI_G3_qualification', to: 'NPI_G4_mass_production' },
];

export function NpiGateConsoleTab({ config }: { config?: PageConfig } = {}) {
  const title = config?.title ?? 'NPI Gate Sign-off';
  const subtitle = config?.subtitle ?? 'Advance NPI materials through G0 → G4 with PE → QA → VP chain approval';

  const [pending, setPending] = useState<WorkflowPendingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPending(await api.workflowPending());
    } catch (err) {
      setFeedback({ kind: 'err', text: `Failed to load pending: ${(err as Error).message}` });
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title flex items-center gap-2">
          <ShieldCheck size={20} className="text-emerald-600" />
          {title}
        </h1>
        <p className="page-desc">{subtitle}</p>
      </div>

      {feedback && (
        <div className={`card p-3 text-sm ${feedback.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
          {feedback.text}
        </div>
      )}

      <SubmitForm onSubmitted={(msg) => { setFeedback({ kind: 'ok', text: msg }); refresh(); }}
                  onError={(msg) => setFeedback({ kind: 'err', text: msg })} />

      <PendingTable rows={pending} loading={loading} onChanged={refresh}
                    onMessage={setFeedback} />
    </div>
  );
}

function SubmitForm({
  onSubmitted, onError,
}: {
  onSubmitted: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [policy, setPolicy] = useState(POLICIES[0].policy_name);
  const [subjectId, setSubjectId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!subjectId.trim()) {
      onError('Material number (subject_id) is required.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.workflowSubmit({
        policy_name: policy,
        subject_id: subjectId.trim(),
        request_reason: reason.trim() || undefined,
      });
      onSubmitted(`Request ${r.request_id.slice(0, 8)}… submitted (${r.composite_action}, status=${r.status}).`);
      setSubjectId('');
      setReason('');
    } catch (err) {
      onError(`Submit failed: ${(err as Error).message}`);
    }
    setBusy(false);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Send size={16} className="text-blue-600" />
          Submit a gate-advance request
        </h2>
      </div>
      <div className="card-body space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm">
            <span className="text-slate-600">Transition</span>
            <select className="form-select w-full mt-1" value={policy} onChange={e => setPolicy(e.target.value)}>
              {POLICIES.map(p => <option key={p.policy_name} value={p.policy_name}>{p.label}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Material number (subject_id)</span>
            <input className="form-input w-full mt-1" placeholder="e.g. MAT-DOGFOOD-001"
                   value={subjectId} onChange={e => setSubjectId(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Reason (optional)</span>
            <input className="form-input w-full mt-1" placeholder="why advance now?"
                   value={reason} onChange={e => setReason(e.target.value)} />
          </label>
        </div>
        <div className="flex justify-end">
          <button className="btn btn-primary btn-sm gap-1.5" disabled={busy} onClick={submit}>
            <Send size={14} /> {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PendingTable({
  rows, loading, onChanged, onMessage,
}: {
  rows: WorkflowPendingRow[];
  loading: boolean;
  onChanged: () => void;
  onMessage: (m: { kind: 'ok' | 'err'; text: string }) => void;
}) {
  return (
    <div className="card">
      <div className="card-header flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <ShieldCheck size={16} className="text-emerald-600" />
          Pending requests
        </h2>
        <button className="btn btn-sm gap-1.5 bg-white border border-slate-300 hover:bg-slate-50"
                onClick={onChanged} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="card-body text-sm text-slate-500">
          {loading ? 'Loading…' : 'No pending requests. Submit one above to start the dogfood chain.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Subject</th>
                <th className="px-3 py-2 text-left">Transition</th>
                <th className="px-3 py-2 text-left">Chain</th>
                <th className="px-3 py-2 text-left">Next step</th>
                <th className="px-3 py-2 text-left">Requester</th>
                <th className="px-3 py-2 text-right">Decide</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <RequestRow key={r.request_id} row={r} onChanged={onChanged} onMessage={onMessage} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RequestRow({
  row, onChanged, onMessage,
}: {
  row: WorkflowPendingRow;
  onChanged: () => void;
  onMessage: (m: { kind: 'ok' | 'err'; text: string }) => void;
}) {
  const tokens = useRenderTokens();
  const [busy, setBusy] = useState(false);

  const fromBadge = useMemo(() => row.preconditions.from_state ?? '—', [row.preconditions]);
  const toBadge   = useMemo(() => row.preconditions.to_state   ?? '—', [row.preconditions]);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const fn = decision === 'approve' ? api.workflowApprove : api.workflowReject;
      const result = await fn(row.request_id);
      const advanced = result.lifecycle_advanced
        ? ` Lifecycle advanced ${result.lifecycle_advanced.from} → ${result.lifecycle_advanced.to}.`
        : '';
      onMessage({
        kind: 'ok',
        text: `${decision} recorded (step ${result.chain_step}, role ${result.expected_role}, status=${result.request_status}).${advanced}`,
      });
      onChanged();
    } catch (err) {
      onMessage({ kind: 'err', text: `${decision} failed: ${(err as Error).message}` });
    }
    setBusy(false);
  };

  const fromCls = tokens.gate_color[fromBadge] ?? 'bg-slate-100 text-slate-700';
  const toCls   = tokens.gate_color[toBadge]   ?? 'bg-slate-100 text-slate-700';

  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 font-mono text-xs">{row.subject_id}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <span className={`px-1.5 py-0.5 rounded text-[11px] ${fromCls}`}>{fromBadge}</span>
          <span className="text-slate-400">→</span>
          <span className={`px-1.5 py-0.5 rounded text-[11px] ${toCls}`}>{toBadge}</span>
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5 font-mono">{row.policy_name}</div>
      </td>
      <td className="px-3 py-2">
        <ChainProgress chain={row.approval_chain} done={row.approvals_recorded} />
      </td>
      <td className="px-3 py-2">
        {row.next_step ? (
          <span className="text-xs">
            step {row.next_step.step} — <strong>{row.next_step.role}</strong>
          </span>
        ) : (
          <span className="text-xs text-slate-500 flex items-center gap-1">
            <AlertTriangle size={12} /> chain complete
          </span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-xs">{row.requested_by}</td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1.5">
          <button className="btn btn-sm gap-1 bg-emerald-600 text-white hover:bg-emerald-700"
                  disabled={busy || !row.next_step} onClick={() => decide('approve')}>
            <ThumbsUp size={14} /> Approve
          </button>
          <button className="btn btn-sm gap-1 bg-red-600 text-white hover:bg-red-700"
                  disabled={busy || !row.next_step} onClick={() => decide('reject')}>
            <ThumbsDown size={14} /> Reject
          </button>
        </div>
      </td>
    </tr>
  );
}

function ChainProgress({ chain, done }: { chain: WorkflowChainStep[]; done: number }) {
  return (
    <div className="flex items-center gap-1">
      {chain.map((step, idx) => {
        const state = idx < done ? 'done' : idx === done ? 'next' : 'todo';
        const cls =
          state === 'done' ? 'bg-emerald-500 text-white'
          : state === 'next' ? 'bg-amber-400 text-amber-900 ring-2 ring-amber-300'
          : 'bg-slate-200 text-slate-500';
        return (
          <span key={step.step} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>
            {step.role}
          </span>
        );
      })}
    </div>
  );
}
