import React, { useState } from 'react';
import { LifecycleResponse, PhaseStatus } from '../../api';
import { ChevronRight, ChevronDown, Check, Zap, FolderSearch, Database, Server, Key, Play } from 'lucide-react';

/* ── Danger Confirm Modal (re-exported from shared) ── */
export type { ConfirmState } from '../shared/DangerConfirmModal';
export { DangerConfirmModal } from '../shared/DangerConfirmModal';

/* ── Reusable: Chip multi-select ── */
export function ChipSelect({ label, items, selected, onToggle, renderItem }: {
  label: string; items: { id: string; label: string }[]; selected: string[];
  onToggle: (id: string) => void; renderItem?: (item: { id: string; label: string }) => React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">{label}</label>
      <div className="flex flex-wrap gap-1.5 p-2 bg-white border border-slate-200 rounded-lg min-h-[38px]">
        {items.length === 0 && <span className="text-xs text-slate-400 italic">Loading...</span>}
        {items.map(item => {
          const on = selected.includes(item.id);
          return (
            <button key={item.id} type="button" onClick={() => onToggle(item.id)}
              className={`px-2 py-0.5 rounded-full text-xs font-mono transition-colors ${
                on ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-300' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}>
              {renderItem ? renderItem(item) : item.label}
              {on && <span className="ml-1 font-bold">&times;</span>}
            </button>
          );
        })}
      </div>
      {selected.length > 0 && <div className="text-[10px] text-slate-400 mt-0.5">{selected.length} selected</div>}
    </div>
  );
}

/* ── Lifecycle Dots (overview card) ── */
export function LifecycleDots({ phases }: { phases: LifecycleResponse['phases'] }) {
  const order: (keyof LifecycleResponse['phases'])[] = ['connection', 'discovery', 'organization', 'profiles', 'credentials', 'deployment'];
  return (
    <div className="lifecycle-bar">
      {order.map(k => {
        const s = phases[k].status;
        return <div key={k} className={`lifecycle-dot ${
          s === 'done' ? 'lifecycle-dot-done' : s === 'action_needed' ? 'lifecycle-dot-action' : 'lifecycle-dot-pending'
        }`} title={`${k}: ${s}`} />;
      })}
    </div>
  );
}

/* ── Lifecycle Stepper (detail view) ── */
export const phaseLabels: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: 'connection',   label: 'Connection',   icon: <Zap size={14} /> },
  { key: 'discovery',    label: 'Discovery',    icon: <FolderSearch size={14} /> },
  { key: 'organization', label: 'Organization', icon: <Database size={14} /> },
  { key: 'profiles',     label: 'Profiles',     icon: <Server size={14} /> },
  { key: 'credentials',  label: 'Credentials',  icon: <Key size={14} /> },
  { key: 'deployment',   label: 'Deployment',   icon: <Play size={14} /> },
];

export function LifecycleStepper({ phases }: { phases: LifecycleResponse['phases'] }) {
  const keys = phaseLabels.map(p => p.key) as (keyof LifecycleResponse['phases'])[];
  return (
    <div className="stepper">
      {phaseLabels.map((p, i) => {
        const status = phases[keys[i]].status;
        const isDone = status === 'done';
        const isAction = status === 'action_needed';
        return (
          <React.Fragment key={p.key}>
            {i > 0 && <div className={`step-line ${
              phases[keys[i - 1]].status === 'done' ? 'step-line-done' : ''
            }`} />}
            <div className="step">
              <div className={`step-circle ${
                isDone ? 'step-circle-done' : isAction ? 'step-circle-active' : 'step-circle-pending'
              }`}>
                {isDone ? <Check size={14} /> : p.icon}
              </div>
              <span className={`step-label ${
                isDone ? 'step-label-done' : isAction ? 'step-label-active' : ''
              }`}>{p.label}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ── Phase Card (expandable wrapper) ── */
export function PhaseCard({ phase, index, status, title, summary, expanded, onToggle, children }: {
  phase: string; index: number; status: PhaseStatus; title: string;
  summary: string; expanded: boolean; onToggle: () => void;
  children: React.ReactNode;
}) {
  const badgeClass = status === 'done' ? 'badge-green' : status === 'action_needed' ? 'badge-amber' : 'badge-slate';
  const badgeText = status === 'done' ? 'Done' : status === 'action_needed' ? 'Action Needed' : 'Not Started';
  const Icon = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="phase-card">
      <div className="phase-card-header" onClick={onToggle}>
        <div className="w-7 h-7 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs font-bold shrink-0">
          {index}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{title}</span>
            <span className={`badge text-[10px] ${badgeClass}`}>{badgeText}</span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5 truncate">{summary}</div>
        </div>
        <Icon size={16} className="text-slate-400 shrink-0" />
      </div>
      {expanded && <div className="phase-card-body">{children}</div>}
    </div>
  );
}

/* ── Phase Summary text helper ── */
export function phaseSummary(key: string, phases: LifecycleResponse['phases']): string {
  switch (key) {
    case 'connection':
      return phases.connection.status === 'done' ? 'Connection active' : 'Not connected';
    case 'discovery':
      return phases.discovery.status === 'done'
        ? `${phases.discovery.tables} tables, ${phases.discovery.views ?? 0} views, ${phases.discovery.columns} columns`
        : phases.discovery.status === 'not_started' ? 'Run discovery to scan schema' : '';
    case 'organization':
      return phases.organization.status === 'done'
        ? `All ${phases.organization.mapped} tables & views are under a Module`
        : phases.organization.unmapped > 0
          ? `${phases.organization.unmapped} of ${phases.organization.unmapped + phases.organization.mapped} tables & views still need to be assigned to a Module — non-admins can't access them via Path A/B until then`
          : 'No tables or views discovered yet';
    case 'profiles':
      return phases.profiles.status === 'done'
        ? `${phases.profiles.count} profile${phases.profiles.count !== 1 ? 's' : ''} configured`
        : 'No profiles created';
    case 'credentials':
      return phases.credentials.status === 'done'
        ? `${phases.credentials.credentialed} credential${phases.credentials.credentialed !== 1 ? 's' : ''} active`
        : phases.credentials.uncredentialed > 0
          ? `${phases.credentials.uncredentialed} role${phases.credentials.uncredentialed !== 1 ? 's' : ''} need credentials`
          : 'Create profiles first';
    case 'deployment':
      return phases.deployment.last_sync
        ? `Last sync: ${new Date(phases.deployment.last_sync).toLocaleString()}`
        : 'Never synced';
    default: return '';
  }
}

/* ── Lifecycle Summary Dots (overview cards) ── */
export function LifecycleSummaryDots({ done, total }: { done: number; total: number }) {
  return (
    <div className="lifecycle-bar">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className={`lifecycle-dot ${i < done ? 'lifecycle-dot-done' : 'lifecycle-dot-pending'}`} />
      ))}
    </div>
  );
}
