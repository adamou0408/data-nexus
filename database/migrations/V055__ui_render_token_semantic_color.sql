-- ============================================================
-- V055: Extend authz_ui_render_token with 'semantic_color' category
--       (RENDER-TOKEN-02, follow-up to V053)
--
-- Tier B Curator can now own DagTab handle / edge colors via SQL.
-- Was: hardcoded SEMANTIC_COLORS map in apps/authz-dashboard/src/
-- components/DagTab.tsx (~line 50). Now: same pattern as
-- status_color / phase_color / gate_color, but value is a hex
-- color string (used in inline style for xyflow Handle bg + edge
-- stroke), not a tailwind class.
--
-- Lookup contract:
--   semantic_color : token_key (semantic_type string) → "#RRGGBB"
-- ============================================================

ALTER TABLE authz_ui_render_token
    DROP CONSTRAINT authz_ui_render_token_category_check;

ALTER TABLE authz_ui_render_token
    ADD CONSTRAINT authz_ui_render_token_category_check
    CHECK (category IN ('icon', 'status_color', 'phase_color', 'gate_color', 'semantic_color'));

COMMENT ON COLUMN authz_ui_render_token.value IS
    'For category=icon: PascalCase lucide-react component name. For category=*_color (status/phase/gate): tailwind class string. For category=semantic_color: hex color string (#RRGGBB) used in inline styles.';

-- ─── Seed: semantic_color (was SEMANTIC_COLORS in DagTab.tsx) ───
INSERT INTO authz_ui_render_token (category, token_key, value) VALUES
    ('semantic_color', 'material_no',    '#2563eb'),
    ('semantic_color', 'product_family', '#9333ea'),
    ('semantic_color', 'make_buy_flag',  '#f59e0b'),
    ('semantic_color', 'wo_no',          '#059669'),
    ('semantic_color', 'shipment_no',    '#0ea5e9'),
    ('semantic_color', 'customer_code',  '#ec4899'),
    ('semantic_color', 'keyword',        '#64748b'),
    ('semantic_color', 'limit',          '#94a3b8'),
    ('semantic_color', 'date',           '#ea580c'),
    ('semantic_color', 'datetime',       '#ea580c'),
    ('semantic_color', 'count',          '#14b8a6'),
    ('semantic_color', 'quantity',       '#14b8a6'),
    ('semantic_color', 'status',         '#f43f5e'),
    ('semantic_color', 'unknown',        '#cbd5e1');
