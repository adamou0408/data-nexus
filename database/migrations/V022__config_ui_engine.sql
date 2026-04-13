-- ============================================================
-- V022: Config-Driven UI Engine
-- Creates authz_ui_page table (SSOT for UI page definitions)
-- and generic PG functions fn_ui_page() / fn_ui_root()
-- ============================================================

-- ─── 1. Config table ───────────────────────────────────────
CREATE TABLE authz_ui_page (
    page_id         TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    subtitle        TEXT,
    layout          TEXT NOT NULL CHECK (layout IN (
        'card_grid', 'table', 'agg_table', 'split', 'timeline', 'context_panel'
    )),
    resource_id     TEXT REFERENCES authz_resource(resource_id),
    data_table      TEXT,                 -- nexus_data table name (NULL = no-data page)
    order_by        TEXT DEFAULT 'created_at DESC',
    row_limit       INT DEFAULT 1000,
    row_drilldown   JSONB,               -- { "page_id": "x", "param_mapping": { "k": "$row.col" } }
    columns_override JSONB DEFAULT '{}'::jsonb,  -- override per column: { "col": { "render": "...", "hidden": true } }
    filters_config  JSONB DEFAULT '[]'::jsonb,   -- [{ "field": "col", "type": "select" }]
    parent_page_id  TEXT REFERENCES authz_ui_page(page_id),
    icon            TEXT,                 -- lucide icon name
    description     TEXT,
    display_order   INT DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Generic page config function ───────────────────────
CREATE OR REPLACE FUNCTION fn_ui_page(p_page_id TEXT)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
    SELECT jsonb_build_object(
        'config', jsonb_build_object(
            'page_id',          p.page_id,
            'title',            p.title,
            'subtitle',         p.subtitle,
            'layout',           p.layout,
            'resource_id',      p.resource_id,
            'data_table',       p.data_table,
            'order_by',         p.order_by,
            'row_limit',        p.row_limit,
            'row_drilldown',    p.row_drilldown,
            'columns_override', p.columns_override,
            'filters_config',   p.filters_config,
            'icon',             p.icon,
            'description',      p.description
        )
    )
    FROM authz_ui_page p
    WHERE p.page_id = p_page_id AND p.is_active;
$$;

-- ─── 3. Root card_grid — dynamic from authz_ui_page + authz_check ─
CREATE OR REPLACE FUNCTION fn_ui_root(p_user_id TEXT, p_groups TEXT[])
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_cards JSONB;
BEGIN
    SELECT jsonb_agg(card ORDER BY card->>'display_order')
    INTO v_cards
    FROM (
        SELECT jsonb_build_object(
            'type',        'metric_card',
            'page_id',     p.page_id,
            'label',       p.title,
            'description', p.description,
            'icon',        p.icon,
            'display_order', p.display_order,
            'drilldown',   jsonb_build_object('page_id', p.page_id)
        ) AS card
        FROM authz_ui_page p
        WHERE p.parent_page_id IS NULL
          AND p.is_active
          AND p.layout != 'card_grid'
          AND (
              p.resource_id IS NULL
              OR authz_check(p_user_id, p_groups, 'read', p.resource_id)
          )
        ORDER BY p.display_order
    ) sub;

    RETURN jsonb_build_object(
        'config', jsonb_build_object(
            'page_id',    'root',
            'title',      'Data Nexus',
            'subtitle',   'Select a data module to explore',
            'layout',     'card_grid',
            'components', COALESCE(v_cards, '[]'::jsonb)
        )
    );
END;
$$;

-- Seed data is in database/seed/config-ui-seed.sql
-- (runs after dev-seed.sql populates authz_resource)
