-- @inputs: cimzr067(tc_ima001, tc_ima002, tc_ima003, tc_ima004, tc_ima004c,
--                   tc_ima007, tc_ima007c, tc_ima021, tc_ima025)
-- @subtype: query
-- @semantic_key: material_no (tc_ima001)
-- @purpose: Material 360° primary lookup — returns code+label pairs intact.

CREATE OR REPLACE FUNCTION fn_material_lookup(p_material_no text)
RETURNS TABLE (
  tc_ima001   text,    -- 料號 (semantic_type: material_no)
  tc_ima002   text,    -- 品名
  tc_ima021   text,    -- 規格
  tc_ima004   text,    -- 自製/外購 code
  tc_ima004c  text,    -- 自製/外購 label
  tc_ima007   text,    -- 產品族群 code
  tc_ima007c  text,    -- 產品族群 label
  tc_ima025   text     -- 庫存單位
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
    tc_ima004c::text,
    tc_ima007::text,
    tc_ima007c::text,
    tc_ima025::text
  FROM tiptop.cimzr067
  WHERE tc_ima001 = p_material_no
  LIMIT 1
$$;
