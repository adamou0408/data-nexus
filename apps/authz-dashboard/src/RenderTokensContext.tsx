import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api } from './api';

export type RenderTokens = {
  icon: Record<string, string>;          // kebab-case key → PascalCase lucide name
  status_color: Record<string, string>;  // status string → tailwind class
  phase_color: Record<string, string>;
  gate_color: Record<string, string>;
};

// Tier A platform fallback. If /api/ui/render-tokens is unreachable the UI
// still works — these match the V053 seed exactly so behavior is identical.
// Curator overrides come in via the API merge.
const FALLBACK_TOKENS: RenderTokens = {
  icon: {
    'package':         'Package',
    'shopping-cart':   'ShoppingCart',
    'shield-check':    'ShieldCheck',
    'flask-conical':   'FlaskConical',
    'undo-2':          'Undo2',
    'dollar-sign':     'DollarSign',
    'clipboard-check': 'ClipboardCheck',
    'layers':          'Layers',
    'database':        'Database',
    'boxes':           'Boxes',
  },
  status_color: {
    active: 'bg-emerald-100 text-emerald-700',
    in_progress: 'bg-blue-100 text-blue-700',
    completed: 'bg-emerald-100 text-emerald-700',
    pending: 'bg-amber-100 text-amber-700',
    confirmed: 'bg-blue-100 text-blue-700',
    shipped: 'bg-indigo-100 text-indigo-700',
    closed: 'bg-slate-100 text-slate-600',
    hold: 'bg-amber-100 text-amber-700',
    on_hold: 'bg-amber-100 text-amber-700',
    scrapped: 'bg-red-100 text-red-700',
    failed: 'bg-red-100 text-red-700',
    passed: 'bg-emerald-100 text-emerald-700',
    waived: 'bg-purple-100 text-purple-700',
    open: 'bg-amber-100 text-amber-700',
    analyzing: 'bg-blue-100 text-blue-700',
    resolved: 'bg-emerald-100 text-emerald-700',
    'A+': 'bg-emerald-100 text-emerald-700',
    'A': 'bg-green-100 text-green-700',
    'B': 'bg-amber-100 text-amber-700',
    'C': 'bg-orange-100 text-orange-700',
    'Reject': 'bg-red-100 text-red-700',
    tier1: 'bg-emerald-100 text-emerald-700',
    tier2: 'bg-blue-100 text-blue-700',
    tier3: 'bg-amber-100 text-amber-700',
    distributor: 'bg-purple-100 text-purple-700',
  },
  phase_color: {
    wafer_prep: 'bg-slate-100 text-slate-700',
    die_attach: 'bg-blue-100 text-blue-700',
    wire_bond: 'bg-indigo-100 text-indigo-700',
    molding: 'bg-purple-100 text-purple-700',
    cp_test: 'bg-cyan-100 text-cyan-700',
    ft_test: 'bg-teal-100 text-teal-700',
    packing: 'bg-emerald-100 text-emerald-700',
    CP: 'bg-cyan-100 text-cyan-700',
    FT: 'bg-teal-100 text-teal-700',
    HTOL: 'bg-red-100 text-red-700',
    TC: 'bg-orange-100 text-orange-700',
    UHAST: 'bg-amber-100 text-amber-700',
    ESD: 'bg-yellow-100 text-yellow-700',
    'Latch-up': 'bg-pink-100 text-pink-700',
  },
  gate_color: {
    G0_concept: 'bg-slate-100 text-slate-700',
    G1_feasibility: 'bg-blue-100 text-blue-700',
    G2_dev: 'bg-indigo-100 text-indigo-700',
    G3_qualification: 'bg-purple-100 text-purple-700',
    G4_mass_production: 'bg-emerald-100 text-emerald-700',
  },
};

const RenderTokensContext = createContext<RenderTokens>(FALLBACK_TOKENS);

export function useRenderTokens(): RenderTokens {
  return useContext(RenderTokensContext);
}

export function RenderTokensProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<RenderTokens>(FALLBACK_TOKENS);

  useEffect(() => {
    api.renderTokens()
      .then(fetched => {
        setTokens({
          icon:         { ...FALLBACK_TOKENS.icon,         ...(fetched.icon         || {}) },
          status_color: { ...FALLBACK_TOKENS.status_color, ...(fetched.status_color || {}) },
          phase_color:  { ...FALLBACK_TOKENS.phase_color,  ...(fetched.phase_color  || {}) },
          gate_color:   { ...FALLBACK_TOKENS.gate_color,   ...(fetched.gate_color   || {}) },
        });
      })
      .catch(() => {
        // Keep fallback; UI must not break on registry fetch failure.
      });
  }, []);

  return (
    <RenderTokensContext.Provider value={tokens}>
      {children}
    </RenderTokensContext.Provider>
  );
}
