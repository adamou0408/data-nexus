// ActivityTab — ACTIVITY-V01
//
// First consumer of V030's continuous aggregates (audit_hourly_summary,
// audit_daily_by_subject). Three panels:
//
//   1. Totals strip — allow / deny / deny% over the selected window.
//   2. Path × decision heatmap — last N hours, one column per hour bucket,
//      one row per (path, decision). Color intensity scales with event_count
//      so spikes pop visually without needing a chart library.
//   3. Top subjects (last 7d) and Top denied resources (last 24h) — plain
//      tables; click handler stub for future drill-through to AuditTab filter.
//
// We deliberately don't pull in a charting lib for v1 — Tailwind cells +
// inline-styled bg-opacity is enough for a heatmap of 24-168 buckets and
// keeps the bundle small. If we later need real time-series (line charts,
// stacking), revisit.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import { PageHeader } from './shared/atoms/PageHeader';
import { EmptyState } from './shared/atoms/EmptyState';
import { Activity, AlertTriangle, ShieldCheck, Loader2, Siren, CheckCircle2 } from 'lucide-react';

// pg bigint comes through as a string; we parseInt at the cell-render boundary.
type HourlyRow = { bucket: string; access_path: 'A'|'B'|'C'; decision: string; event_count: string; avg_duration_ms: number | null };
type SubjectRow = { subject_id: string; allow_count: string | null; deny_count: string | null; total_count: string };
type DeniedResourceRow = { resource_id: string; access_path: 'A'|'B'|'C'; deny_count: string; distinct_subjects: string };

const PATHS: Array<{ id: 'A'|'B'|'C'; label: string; hint: string }> = [
  { id: 'A', label: 'Path A', hint: 'Config-SM UI (metadata-driven)' },
  { id: 'B', label: 'Path B', hint: 'Web pages (API/SQL)' },
  { id: 'C', label: 'Path C', hint: 'Direct DB connection' },
];

export function ActivityTab() {
  const toast = useToast();
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [hourly, setHourly] = useState<HourlyRow[]>([]);
  const [totals, setTotals] = useState<{ allow_count: string; deny_count: string; total_count: string } | null>(null);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [denied, setDenied] = useState<DeniedResourceRow[]>([]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.activityHourlySummary(hours),
      api.activityTotals(hours),
      api.activityTopSubjects(7, 10),
      api.activityTopDeniedResources(hours, 10),
    ])
      .then(([h, t, s, d]) => {
        setHourly(h.rows);
        setTotals({ allow_count: t.allow_count, deny_count: t.deny_count, total_count: t.total_count });
        setSubjects(s.rows);
        setDenied(d.rows);
      })
      .catch((err) => toast.error(err.message || 'Failed to load activity'))
      .finally(() => setLoading(false));
  }, [hours]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pivot hourly rows into a [path][decision][bucketIso]→count grid for the
  // heatmap. We compute the bucket axis from the data (rather than walking
  // hours backward from now) so missing buckets show as zero cells without
  // having to bother the backend with empty slots.
  const heatmap = useMemo(() => buildHeatmap(hourly), [hourly]);

  const total = totals ? parseInt(totals.total_count) : 0;
  const denyCount = totals ? parseInt(totals.deny_count) : 0;
  const allowCount = totals ? parseInt(totals.allow_count) : 0;
  const denyPct = total > 0 ? ((denyCount / total) * 100).toFixed(1) : '0.0';

  return (
    <div className="space-y-4">
      <PageHeader
        title={<span className="flex items-center gap-2"><Activity size={20} /> Activity</span>}
        subtitle="Stats over the audit log — pre-aggregated for snappy reads."
        action={
          <select
            value={hours}
            onChange={(e) => setHours(parseInt(e.target.value))}
            className="text-xs border border-slate-300 rounded px-2 py-1 bg-white"
          >
            <option value={1}>Last 1 hour</option>
            <option value={6}>Last 6 hours</option>
            <option value={24}>Last 24 hours</option>
            <option value={72}>Last 3 days</option>
            <option value={168}>Last 7 days</option>
          </select>
        }
      />

      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-500 p-8 justify-center">
          <Loader2 size={16} className="animate-spin" /> Loading activity…
        </div>
      )}

      {!loading && total === 0 && (
        <EmptyState
          icon={<Activity size={32} />}
          message="No audit events in this window"
          hint="Either the window is too narrow or no authz decisions have been logged yet. Continuous aggregates refresh every 30 minutes."
        />
      )}

      {/* ─── Anomaly alerts (above totals so curators see incidents first) ─── */}
      <AnomalyPanel />

      {!loading && total > 0 && (
        <>
          {/* ─── Totals strip ─── */}
          <div className="grid grid-cols-3 gap-3">
            <Tile label="Total decisions" value={total.toLocaleString()} icon={<Activity size={14} className="text-slate-500" />} />
            <Tile label="Allowed" value={allowCount.toLocaleString()} icon={<ShieldCheck size={14} className="text-emerald-600" />} accent="emerald" />
            <Tile
              label="Denied"
              value={denyCount.toLocaleString()}
              sub={`${denyPct}% of total`}
              icon={<AlertTriangle size={14} className="text-amber-600" />}
              accent={parseFloat(denyPct) > 10 ? 'amber' : 'slate'}
            />
          </div>

          {/* ─── Heatmap ─── */}
          <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-200 flex items-center gap-2">
              <span className="text-sm font-medium text-slate-700">Hourly heatmap</span>
              <span className="text-[11px] text-slate-500">Path × decision over the last {hours}h. Darker = more events.</span>
            </div>
            <div className="overflow-x-auto p-3">
              <Heatmap heatmap={heatmap} />
            </div>
          </div>

          {/* ─── Two side-by-side leaderboards ─── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border border-slate-200 rounded-xl bg-white">
              <div className="px-4 py-2.5 border-b border-slate-200 text-sm font-medium text-slate-700">
                Top subjects <span className="text-[11px] text-slate-500 font-normal ml-1">(last 7 days)</span>
              </div>
              {subjects.length === 0 ? (
                <div className="p-6 text-xs text-slate-500 text-center">No subjects in window.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="text-left px-3 py-2">subject_id</th>
                      <th className="text-right px-3 py-2">allow</th>
                      <th className="text-right px-3 py-2">deny</th>
                      <th className="text-right px-3 py-2">total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subjects.map((r) => {
                      const allow = parseInt(r.allow_count || '0');
                      const deny = parseInt(r.deny_count || '0');
                      const total = parseInt(r.total_count);
                      const denyHi = total > 0 && deny / total > 0.2;
                      return (
                        <tr key={r.subject_id} className="border-t border-slate-100">
                          <td className="px-3 py-1.5 font-mono text-slate-800">{r.subject_id}</td>
                          <td className="px-3 py-1.5 text-right text-slate-600">{allow.toLocaleString()}</td>
                          <td className={`px-3 py-1.5 text-right ${denyHi ? 'text-amber-700 font-semibold' : 'text-slate-600'}`}>
                            {deny.toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right text-slate-700 font-medium">{total.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="border border-slate-200 rounded-xl bg-white">
              <div className="px-4 py-2.5 border-b border-slate-200 text-sm font-medium text-slate-700">
                Top denied resources <span className="text-[11px] text-slate-500 font-normal ml-1">(last {hours}h)</span>
              </div>
              {denied.length === 0 ? (
                <div className="p-6 text-xs text-slate-500 text-center">No denied access in window — clean.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="text-left px-3 py-2">resource_id</th>
                      <th className="text-center px-3 py-2">path</th>
                      <th className="text-right px-3 py-2">deny</th>
                      <th className="text-right px-3 py-2">distinct subjects</th>
                    </tr>
                  </thead>
                  <tbody>
                    {denied.map((r, i) => (
                      <tr key={`${r.resource_id}-${r.access_path}-${i}`} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 font-mono text-slate-800 break-all">{r.resource_id}</td>
                        <td className="px-3 py-1.5 text-center">
                          <span className="inline-block px-1.5 py-0.5 text-[10px] rounded bg-slate-100 text-slate-700 font-mono">
                            {r.access_path}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-amber-700 font-semibold">
                          {parseInt(r.deny_count).toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-600">{r.distinct_subjects}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, icon, accent = 'slate' }: { label: string; value: string; sub?: string; icon?: React.ReactNode; accent?: 'slate' | 'emerald' | 'amber' }) {
  const accents: Record<string, string> = {
    slate: 'border-slate-200 bg-white',
    emerald: 'border-emerald-200 bg-emerald-50/30',
    amber: 'border-amber-200 bg-amber-50/40',
  };
  return (
    <div className={`border rounded-xl p-3 ${accents[accent]}`}>
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 uppercase tracking-wide mb-1">
        {icon} {label}
      </div>
      <div className="text-xl font-bold text-slate-900">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

interface HeatmapData {
  buckets: string[];
  cells: Map<string, number>;
  maxCount: number;
}

function buildHeatmap(rows: HourlyRow[]): HeatmapData {
  const bucketSet = new Set<string>();
  const cells = new Map<string, number>();
  let maxCount = 0;
  for (const r of rows) {
    bucketSet.add(r.bucket);
    const key = `${r.access_path}|${r.decision}|${r.bucket}`;
    const count = parseInt(r.event_count) || 0;
    cells.set(key, count);
    if (count > maxCount) maxCount = count;
  }
  // Ascending by time so the heatmap reads left→right oldest→newest.
  const buckets = Array.from(bucketSet).sort();
  return { buckets, cells, maxCount };
}

function Heatmap({ heatmap }: { heatmap: HeatmapData }) {
  if (heatmap.buckets.length === 0) {
    return <div className="text-xs text-slate-500 text-center py-4">No buckets in window.</div>;
  }
  const decisions = ['allow', 'deny'] as const;
  return (
    <div className="inline-block min-w-full">
      <div className="text-[10px] text-slate-500 mb-1 px-1">
        {fmtBucket(heatmap.buckets[0])} → {fmtBucket(heatmap.buckets[heatmap.buckets.length - 1])}
      </div>
      <table className="text-[10px]">
        <tbody>
          {PATHS.map((p) =>
            decisions.map((d) => (
              <tr key={`${p.id}-${d}`}>
                <td className="pr-2 py-0.5 text-right text-slate-600 whitespace-nowrap">
                  <span className="font-mono">{p.id}</span> · <span className={d === 'allow' ? 'text-emerald-700' : 'text-amber-700'}>{d}</span>
                </td>
                {heatmap.buckets.map((b) => {
                  const count = heatmap.cells.get(`${p.id}|${d}|${b}`) ?? 0;
                  const intensity = heatmap.maxCount > 0 ? count / heatmap.maxCount : 0;
                  // deny uses amber, allow uses emerald
                  const baseColor = d === 'deny' ? '245, 158, 11' : '16, 185, 129';
                  return (
                    <td
                      key={b}
                      title={`${fmtBucket(b)} — ${p.label} ${d}: ${count}`}
                      className="border border-white"
                      style={{
                        width: 14,
                        height: 18,
                        backgroundColor: count === 0 ? '#f1f5f9' : `rgba(${baseColor}, ${0.15 + intensity * 0.85})`,
                      }}
                    />
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function fmtBucket(iso: string): string {
  // Compact "MM-DD HH:00" — full date only on first/last cell of the row legend.
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:00`;
}

// ─── Anomaly panel ──────────────────────────────────────────────
// Shows open events grouped by severity with a one-click ack flow. Hidden
// entirely when total_open=0 so the tab stays clean during quiet periods.
//
// Self-contained (own fetch + state) because the tick rate is different from
// the activity refresh rate and the panel needs to reload after each ack.

type AnomalyEvent = {
  event_id: string;
  detected_at: string;
  rule_id: string;
  severity: 'P1' | 'P2' | 'P3';
  subject_id: string | null;
  details: Record<string, unknown>;
  acked_at: string | null;
  acked_by: string | null;
  ack_note: string | null;
};

const RULE_LABEL: Record<string, string> = {
  DENY_SPIKE:            'Deny spike',
  OFF_HOURS_ADMIN:       'Off-hours admin write',
  UNAUTHORIZED_AI_AGENT: 'Unauthorized AI agent',
  RECON_PATTERN:         'Recon pattern',
  AI_COST_SPIKE:         'AI cost spike',
};

function AnomalyPanel() {
  const toast = useToast();
  const [events, setEvents] = useState<AnomalyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api.anomalyEvents({ status: 'open', limit: 50 });
      setEvents(r.rows);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load anomalies');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { reload(); }, [reload]);

  const ack = async (event_id: string) => {
    setAcking(event_id);
    try {
      await api.anomalyAck(event_id);
      toast.success('Acknowledged');
      await reload();
    } catch (err: any) {
      toast.error(err.message || 'Ack failed');
    } finally {
      setAcking(null);
    }
  };

  if (loading) return null;
  if (events.length === 0) return null;

  // Group by severity for visual hierarchy: P1 first.
  const grouped: Record<'P1' | 'P2' | 'P3', AnomalyEvent[]> = { P1: [], P2: [], P3: [] };
  for (const e of events) grouped[e.severity].push(e);

  return (
    <div className="border border-rose-200 bg-rose-50/40 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-rose-200 flex items-center gap-2 bg-rose-50">
        <Siren size={16} className="text-rose-600" />
        <span className="text-sm font-semibold text-rose-900">
          {events.length} open {events.length === 1 ? 'anomaly' : 'anomalies'}
        </span>
        <span className="text-[11px] text-rose-700/70">
          Detected by rule-based scanner. Ack closes the event without changing the underlying audit row.
        </span>
      </div>
      <div className="divide-y divide-rose-100">
        {(['P1', 'P2', 'P3'] as const).flatMap((sev) =>
          grouped[sev].map((ev) => (
            <AnomalyRow key={ev.event_id} ev={ev} acking={acking === ev.event_id} onAck={() => ack(ev.event_id)} />
          ))
        )}
      </div>
    </div>
  );
}

function AnomalyRow({ ev, acking, onAck }: { ev: AnomalyEvent; acking: boolean; onAck: () => void }) {
  const sevColor = ev.severity === 'P1'
    ? 'bg-rose-600 text-white'
    : ev.severity === 'P2'
      ? 'bg-amber-500 text-white'
      : 'bg-slate-400 text-white';
  const detailLine = summarizeDetails(ev.rule_id, ev.details);
  return (
    <div className="px-4 py-2.5 flex items-center gap-3">
      <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${sevColor}`}>{ev.severity}</span>
      <span className="text-xs font-semibold text-slate-800 min-w-[160px]">
        {RULE_LABEL[ev.rule_id] ?? ev.rule_id}
      </span>
      {ev.subject_id && (
        <span className="text-[11px] font-mono text-slate-600 bg-white border border-slate-200 px-1.5 py-0.5 rounded">
          {ev.subject_id}
        </span>
      )}
      <span className="text-[11px] text-slate-600 flex-1 truncate">{detailLine}</span>
      <span className="text-[10px] text-slate-500 whitespace-nowrap">
        {new Date(ev.detected_at).toLocaleString()}
      </span>
      <button
        onClick={onAck}
        disabled={acking}
        className="text-[11px] flex items-center gap-1 px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
      >
        {acking ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
        Ack
      </button>
    </div>
  );
}

function summarizeDetails(rule_id: string, d: Record<string, unknown>): string {
  switch (rule_id) {
    case 'DENY_SPIKE':
      return `Path ${d.access_path}: ${d.deny_count}/${d.total_count} (${d.deny_pct}%) at ${fmtBucket(String(d.bucket))}`;
    case 'OFF_HOURS_ADMIN':
      return `${d.action} on ${d.resource_type}${d.resource_id ? `:${d.resource_id}` : ''} (window ${d.window})`;
    case 'UNAUTHORIZED_AI_AGENT':
      return `${d.action} via ${d.agent_id}${d.model_id ? ` / ${d.model_id}` : ''} — Constitution §${d.constitution_section}`;
    case 'RECON_PATTERN':
      return `${d.distinct_resources} distinct resources in 5min (threshold ${d.threshold})`;
    case 'AI_COST_SPIKE':
      return `Provider ${d.provider_id}: $${d.cost_24h_usd} / 24h (${d.pct_of_budget}% of monthly budget $${d.monthly_budget_usd})`;
    default:
      return JSON.stringify(d);
  }
}
