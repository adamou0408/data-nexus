-- ============================================================
-- V053: UI render-token registry (RENDER-TOKEN-01)
--       Move ICON_MAP / STATUS_COLORS / PHASE_COLORS / GATE_COLORS
--       out of ConfigEngine.tsx into Tier A metadata.
--
-- Two-Tier split:
--   Tier A (platform): the lucide-react icon imports + LUCIDE_ICON_CATALOG
--     in ConfigEngine.tsx. Adding a brand-new lucide icon needs a
--     one-line import + catalog row.
--   Tier B (Curator): rows in this table. Curator can rename existing
--     icons, add aliases, change color classes, add new status/phase/gate
--     values — all via SQL, zero React code change.
--
-- Lookup contract (frontend):
--   icon         : token_key (kebab-case) → value (PascalCase lucide name)
--                  resolved against LUCIDE_ICON_CATALOG
--   status_color : token_key (raw status string) → tailwind class string
--   phase_color  : token_key (phase enum string) → tailwind class string
--   gate_color   : token_key (gate enum string)  → tailwind class string
-- ============================================================

CREATE TABLE authz_ui_render_token (
    category    TEXT NOT NULL,
    token_key   TEXT NOT NULL,
    value       TEXT NOT NULL,
    label       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (category, token_key),
    CONSTRAINT authz_ui_render_token_category_check
        CHECK (category IN ('icon', 'status_color', 'phase_color', 'gate_color'))
);

CREATE INDEX idx_render_token_active
    ON authz_ui_render_token (category)
    WHERE is_active = TRUE;

COMMENT ON TABLE  authz_ui_render_token IS
    'Tier B Curator-owned UI render tokens. icon rows resolve to LUCIDE_ICON_CATALOG entries (Tier A). color rows are tailwind class strings.';
COMMENT ON COLUMN authz_ui_render_token.value IS
    'For category=icon: PascalCase lucide-react component name (e.g. Package). For category=*_color: tailwind class string (e.g. bg-emerald-100 text-emerald-700).';

-- ─── Seed: icons (was ICON_MAP) ───
INSERT INTO authz_ui_render_token (category, token_key, value, sort_order) VALUES
    ('icon', 'package',         'Package',        10),
    ('icon', 'shopping-cart',   'ShoppingCart',   20),
    ('icon', 'shield-check',    'ShieldCheck',    30),
    ('icon', 'flask-conical',   'FlaskConical',   40),
    ('icon', 'undo-2',          'Undo2',          50),
    ('icon', 'dollar-sign',     'DollarSign',     60),
    ('icon', 'clipboard-check', 'ClipboardCheck', 70),
    ('icon', 'layers',          'Layers',         80),
    ('icon', 'database',        'Database',       90),
    ('icon', 'boxes',           'Boxes',         100);

-- ─── Seed: status_color (was STATUS_COLORS) ───
INSERT INTO authz_ui_render_token (category, token_key, value) VALUES
    ('status_color', 'active',       'bg-emerald-100 text-emerald-700'),
    ('status_color', 'in_progress',  'bg-blue-100 text-blue-700'),
    ('status_color', 'completed',    'bg-emerald-100 text-emerald-700'),
    ('status_color', 'pending',      'bg-amber-100 text-amber-700'),
    ('status_color', 'confirmed',    'bg-blue-100 text-blue-700'),
    ('status_color', 'shipped',      'bg-indigo-100 text-indigo-700'),
    ('status_color', 'closed',       'bg-slate-100 text-slate-600'),
    ('status_color', 'hold',         'bg-amber-100 text-amber-700'),
    ('status_color', 'on_hold',      'bg-amber-100 text-amber-700'),
    ('status_color', 'scrapped',     'bg-red-100 text-red-700'),
    ('status_color', 'failed',       'bg-red-100 text-red-700'),
    ('status_color', 'passed',       'bg-emerald-100 text-emerald-700'),
    ('status_color', 'waived',       'bg-purple-100 text-purple-700'),
    ('status_color', 'open',         'bg-amber-100 text-amber-700'),
    ('status_color', 'analyzing',    'bg-blue-100 text-blue-700'),
    ('status_color', 'resolved',     'bg-emerald-100 text-emerald-700'),
    ('status_color', 'A+',           'bg-emerald-100 text-emerald-700'),
    ('status_color', 'A',            'bg-green-100 text-green-700'),
    ('status_color', 'B',            'bg-amber-100 text-amber-700'),
    ('status_color', 'C',            'bg-orange-100 text-orange-700'),
    ('status_color', 'Reject',       'bg-red-100 text-red-700'),
    ('status_color', 'tier1',        'bg-emerald-100 text-emerald-700'),
    ('status_color', 'tier2',        'bg-blue-100 text-blue-700'),
    ('status_color', 'tier3',        'bg-amber-100 text-amber-700'),
    ('status_color', 'distributor',  'bg-purple-100 text-purple-700');

-- ─── Seed: phase_color (was PHASE_COLORS) ───
INSERT INTO authz_ui_render_token (category, token_key, value) VALUES
    ('phase_color', 'wafer_prep',  'bg-slate-100 text-slate-700'),
    ('phase_color', 'die_attach',  'bg-blue-100 text-blue-700'),
    ('phase_color', 'wire_bond',   'bg-indigo-100 text-indigo-700'),
    ('phase_color', 'molding',     'bg-purple-100 text-purple-700'),
    ('phase_color', 'cp_test',     'bg-cyan-100 text-cyan-700'),
    ('phase_color', 'ft_test',     'bg-teal-100 text-teal-700'),
    ('phase_color', 'packing',     'bg-emerald-100 text-emerald-700'),
    ('phase_color', 'CP',          'bg-cyan-100 text-cyan-700'),
    ('phase_color', 'FT',          'bg-teal-100 text-teal-700'),
    ('phase_color', 'HTOL',        'bg-red-100 text-red-700'),
    ('phase_color', 'TC',          'bg-orange-100 text-orange-700'),
    ('phase_color', 'UHAST',       'bg-amber-100 text-amber-700'),
    ('phase_color', 'ESD',         'bg-yellow-100 text-yellow-700'),
    ('phase_color', 'Latch-up',    'bg-pink-100 text-pink-700');

-- ─── Seed: gate_color (was GATE_COLORS) ───
INSERT INTO authz_ui_render_token (category, token_key, value) VALUES
    ('gate_color', 'G0_concept',         'bg-slate-100 text-slate-700'),
    ('gate_color', 'G1_feasibility',     'bg-blue-100 text-blue-700'),
    ('gate_color', 'G2_dev',             'bg-indigo-100 text-indigo-700'),
    ('gate_color', 'G3_qualification',   'bg-purple-100 text-purple-700'),
    ('gate_color', 'G4_mass_production', 'bg-emerald-100 text-emerald-700');
