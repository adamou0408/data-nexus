-- @inputs: cimzr067(tc_ima001, tc_ima002, tc_ima004, tc_ima004c, tc_ima021)
-- @subtype: query
-- @semantic_key: make_buy_flag (tc_ima004)
-- @purpose: Filter materials by Make/Buy classification (P=自製, M=外購 etc).

CREATE OR REPLACE FUNCTION fn_material_by_type(
  p_make_buy text,
  p_limit    int DEFAULT 200
)
RETURNS TABLE (
  tc_ima001  text,   -- 料號
  tc_ima002  text,   -- 品名
  tc_ima021  text,   -- 規格
  tc_ima004  text,   -- 自製/外購 code
  tc_ima004c text    -- 自製/外購 label
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    tc_ima001::text,
    tc_ima002::text,
    tc_ima021::text,
    tc_ima004::text,
    tc_ima004c::text
  FROM tiptop.cimzr067
  WHERE tc_ima004 = p_make_buy
  ORDER BY tc_ima001
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;
