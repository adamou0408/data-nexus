// QualityRulesHelp — FN-QUALITY-LINT-V01-FU5
//
// Shared "?" trigger that opens a small modal listing the 4 FQL rules. Mounted
// next to every "Quality advisor" header (editor, AI assist output, fn detail
// panel) so curators can answer "what is this rule and why does it matter?"
// without leaving the spot they're working in.
//
// Rules are duplicated client-side rather than fetched: the set is small
// (4 entries), changes rarely, and avoiding a network round-trip for a help
// popover keeps the affordance feel-instant. If/when the rule list grows past
// a handful, swap to GET /functions/lint-rules.

import { useState } from 'react';
import { HelpCircle, X, AlertTriangle, Info } from 'lucide-react';

type Rule = {
  code: 'FQL-01' | 'FQL-02' | 'FQL-03' | 'FQL-04';
  severity: 'warn' | 'info';
  title: string;
  why: string;
};

const RULES: Rule[] = [
  {
    code: 'FQL-01',
    severity: 'warn',
    title: 'VOLATILE on a read-only fn',
    why:
      'No DML detected, but volatility is VOLATILE (the PG default). Mark the fn STABLE so the planner can fold it ' +
      'across rows. Without STABLE, a LATERAL driver re-executes per row — order-of-magnitude slower on 1k+ row inputs.',
  },
  {
    code: 'FQL-02',
    severity: 'warn',
    title: 'SELECT * — list columns explicitly',
    why:
      'Functions with SELECT * change return shape silently when an upstream table gains columns. Downstream Composer/DAG ' +
      'nodes that bind by column name will break or pick up unintended fields. List columns explicitly so the contract is ' +
      'visible at the call site.',
  },
  {
    code: 'FQL-03',
    severity: 'info',
    title: 'Parameters should use p_ prefix',
    why:
      'Use p_<snake> for parameters so they cannot collide with column names inside the SQL body. A parameter named ' +
      'material_no quietly resolves to the column material_no when it is in scope, producing always-true predicates with ' +
      'no error.',
  },
  {
    code: 'FQL-04',
    severity: 'info',
    title: 'Function name should match house patterns',
    why:
      'Names like fn_search_<entity> / fn_<entity>_summary / fn_<entity>_<aspect> / fn_keyword_<entity>_<aspect> make the ' +
      'catalog scannable by layer (search → summary → aspect → keyword-driven). Renaming is optional but strongly preferred ' +
      'for new fns.',
  },
];

export function QualityRulesHelp({ size = 11 }: { size?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="text-slate-400 hover:text-slate-700 transition-colors"
        title="What are the quality rules?"
        type="button"
      >
        <HelpCircle size={size} />
      </button>
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <h3 className="font-bold text-slate-900">Quality advisor — rules</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
              <p className="text-xs text-slate-500">
                These checks run on every Validate/Save. They are <span className="font-medium">advisory</span> —
                Deploy stays enabled even when issues are flagged. Warnings prompt a confirm; info notes pass through.
              </p>
              {RULES.map((r) => {
                const isWarn = r.severity === 'warn';
                return (
                  <div
                    key={r.code}
                    className={`border rounded-lg p-3 ${isWarn ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-slate-50/60'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {isWarn ? <AlertTriangle size={12} className="text-amber-600" /> : <Info size={12} className="text-slate-500" />}
                      <span className="font-mono text-[11px] font-semibold text-slate-800">{r.code}</span>
                      <span className={`text-[10px] uppercase tracking-wide font-medium ${isWarn ? 'text-amber-700' : 'text-slate-500'}`}>
                        {r.severity}
                      </span>
                      <span className="text-xs font-medium text-slate-700">{r.title}</span>
                    </div>
                    <div className="text-[11px] text-slate-600 leading-relaxed">{r.why}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
