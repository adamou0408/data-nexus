-- @inputs: cimzr067(tc_ima001, tc_ima002, tc_ima007, tc_ima007c, tc_ima021)
-- @subtype: query
-- @semantic_key: product_family (tc_ima007)
-- @purpose: List all materials belonging to a given product family code.

CREATE OR REPLACE FUNCTION fn_material_by_family(
  p_family_code text,
  p_limit       int DEFAULT 200
)
RETURNS TABLE (
  tc_ima001  text,   -- 料號
  tc_ima002  text,   -- 品名
  tc_ima021  text,   -- 規格
  tc_ima007  text,   -- 產品族群 code
  tc_ima007c text    -- 產品族群 label
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    tc_ima001::text,
    tc_ima002::text,
    tc_ima021::text,
    tc_ima007::text,
    tc_ima007c::text
  FROM tiptop.cimzr067
  WHERE tc_ima007 = p_family_code
  ORDER BY tc_ima001
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;
