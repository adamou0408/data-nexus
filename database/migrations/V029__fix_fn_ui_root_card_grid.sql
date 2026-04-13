-- Fix fn_ui_root: remove the `layout != 'card_grid'` filter
-- that incorrectly hides module-level card_grid pages from root.
-- The root page is synthetic (not stored in authz_ui_page), so all
-- top-level pages (parent_page_id IS NULL) should appear regardless
-- of their layout type.

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
