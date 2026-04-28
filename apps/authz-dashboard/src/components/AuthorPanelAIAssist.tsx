// AuthorPanelAIAssist — AI helper strip mounted above the SQL textarea in
// DataQueryTab AuthorPanel. Three actions: Generate (NL → SQL),
// Refine (SQL + instruction → revised SQL), Explain (SQL → markdown).
//
// Constitution refs:
//   §11.3 — Generated SQL only fills the textarea; Deploy still requires the
//           user to click Deploy + window.confirm. No silent writes.
//   §11.6 — Prompts never persist client-side beyond the session; backend
//           hashes them before logging to authz_ai_usage.

import { useEffect, useState } from 'react';
import { Sparkles, Loader2, Wand2, BookOpen, ChevronDown, ChevronRight, X } from 'lucide-react';
import { api } from '../api';
import { useToast } from './Toast';

const COLLAPSE_KEY = 'authorPanel.aiAssist.collapsed';

export function AuthorPanelAIAssist({
  dsId,
  sql,
  onSqlChange,
}: {
  dsId: string;
  sql: string;
  onSqlChange: (next: string) => void;
}) {
  const toast = useToast();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
  }, [collapsed]);

  const [prompt, setPrompt] = useState('');
  const [refineInstruction, setRefineInstruction] = useState('');
  const [busy, setBusy] = useState<null | 'draft' | 'refine' | 'explain'>(null);
  const [explainMd, setExplainMd] = useState<string | null>(null);
  const [meta, setMeta] = useState<null | { provider_id: string; model_id: string; latency_ms: number; cost_usd: number | null; schema_tables?: number; schema_truncated?: boolean }>(null);

  const onError = (err: any) => {
    const msg = String(err?.message || err);
    if (msg.includes('No AI provider')) {
      toast.error('No AI provider with purpose "sql_authoring". Open AI Providers tab and add one.');
    } else if (msg.includes('blocked by safety guard')) {
      toast.error('AI output blocked: contained destructive keyword (Constitution §11.3).');
    } else {
      toast.error(msg);
    }
  };

  const handleDraft = async () => {
    if (!prompt.trim()) { toast.error('Describe what the function should do.'); return; }
    if (!dsId) { toast.error('Pick a data source first.'); return; }
    setBusy('draft');
    setExplainMd(null);
    try {
      const r = await api.aiAssistDraft(dsId, prompt.trim());
      onSqlChange(r.sql);
      setMeta({ provider_id: r.provider_id, model_id: r.model_id, latency_ms: r.usage.latency_ms, cost_usd: r.usage.cost_usd, schema_tables: r.schema_tables, schema_truncated: r.schema_truncated });
      toast.success(`Draft generated (${r.model_id}, ${r.usage.latency_ms}ms)`);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const handleRefine = async () => {
    if (!refineInstruction.trim()) { toast.error('Tell me what to change.'); return; }
    if (!sql.trim()) { toast.error('Refine needs existing SQL in the textarea.'); return; }
    if (!dsId) { toast.error('Pick a data source first.'); return; }
    setBusy('refine');
    setExplainMd(null);
    try {
      const r = await api.aiAssistRefine(dsId, sql, refineInstruction.trim());
      onSqlChange(r.sql);
      setMeta({ provider_id: r.provider_id, model_id: r.model_id, latency_ms: r.usage.latency_ms, cost_usd: r.usage.cost_usd });
      toast.success(`Refined (${r.model_id}, ${r.usage.latency_ms}ms)`);
      setRefineInstruction('');
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const handleExplain = async () => {
    if (!sql.trim()) { toast.error('Explain needs SQL in the textarea.'); return; }
    setBusy('explain');
    try {
      const r = await api.aiAssistExplain(sql);
      setExplainMd(r.markdown);
      setMeta({ provider_id: r.provider_id, model_id: r.model_id, latency_ms: r.usage.latency_ms, cost_usd: r.usage.cost_usd });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border border-violet-200 bg-violet-50/40 rounded-lg overflow-hidden" data-testid="author-panel-ai-assist">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full px-3 py-2 flex items-center gap-2 text-violet-700 hover:bg-violet-100/40 transition"
        title={collapsed ? 'Expand AI helper' : 'Collapse AI helper'}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <Sparkles size={14} />
        <span className="text-xs font-semibold tracking-wide uppercase">AI helper</span>
        {meta && !collapsed && (
          <span className="ml-auto text-[10px] text-violet-500 font-normal flex items-center gap-2">
            <span className="font-mono">{meta.model_id}</span>
            <span>{meta.latency_ms}ms</span>
            {meta.cost_usd != null && <span>${meta.cost_usd.toFixed(4)}</span>}
            {meta.schema_truncated && <span className="text-amber-600">schema truncated</span>}
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-violet-700 mb-1">Describe the function</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='e.g. "Given a material number, return the latest 5 shipments with date and qty."'
              rows={3}
              className="w-full text-xs border border-violet-200 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-violet-400 resize-y"
              data-testid="ai-assist-prompt"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <button
                onClick={handleDraft}
                disabled={busy !== null || !dsId}
                className="text-xs px-2.5 py-1 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
                data-testid="ai-assist-generate"
              >
                {busy === 'draft' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {busy === 'draft' ? 'Generating…' : 'Generate'}
              </button>
              <span className="text-[10px] text-violet-500">
                Output fills the SQL editor below; nothing is deployed automatically.
              </span>
            </div>
          </div>

          <div className="border-t border-violet-200/60 pt-2.5">
            <label className="block text-[11px] font-medium text-violet-700 mb-1">Refine current SQL</label>
            <div className="flex items-center gap-1.5">
              <input
                value={refineInstruction}
                onChange={(e) => setRefineInstruction(e.target.value)}
                placeholder='e.g. "limit to 10 rows and order by ship_date desc"'
                className="flex-1 text-xs border border-violet-200 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-violet-400"
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) handleRefine(); }}
                data-testid="ai-assist-refine-input"
              />
              <button
                onClick={handleRefine}
                disabled={busy !== null || !sql.trim()}
                className="text-xs px-2.5 py-1.5 rounded border border-violet-300 bg-white text-violet-700 hover:bg-violet-100 disabled:opacity-50 flex items-center gap-1.5"
                data-testid="ai-assist-refine"
                title="Apply instruction to the SQL above"
              >
                {busy === 'refine' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                Refine
              </button>
              <button
                onClick={handleExplain}
                disabled={busy !== null || !sql.trim()}
                className="text-xs px-2.5 py-1.5 rounded border border-violet-300 bg-white text-violet-700 hover:bg-violet-100 disabled:opacity-50 flex items-center gap-1.5"
                data-testid="ai-assist-explain"
                title="Explain the current SQL in Markdown"
              >
                {busy === 'explain' ? <Loader2 size={12} className="animate-spin" /> : <BookOpen size={12} />}
                Explain
              </button>
            </div>
          </div>

          {explainMd && (
            <div className="border border-violet-200 bg-white rounded p-2.5 relative" data-testid="ai-assist-explain-panel">
              <button
                onClick={() => setExplainMd(null)}
                className="absolute top-1.5 right-1.5 text-violet-400 hover:text-violet-700"
                title="Dismiss"
              >
                <X size={12} />
              </button>
              <pre className="text-[11px] text-slate-800 whitespace-pre-wrap leading-relaxed font-sans pr-5">
                {explainMd}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
