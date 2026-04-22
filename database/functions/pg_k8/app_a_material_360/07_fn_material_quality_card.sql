-- @inputs: cimzr067(tc_ima001..tc_ima025), csfzr121(t07, t01, t08),
--          cxmzr115(t07, t01, t17)
-- @subtype: report
-- @semantic_key: material_no (tc_ima001)
-- @purpose: Single-row Material 360° report card — combines master + usage aggregates.

CREATE OR REPLACE FUNCTION fn_material_quality_card(p_material_no text)
RETURNS TABLE (
  tc_ima001     text,   -- 料號
  tc_ima002     text,   -- 品名
  tc_ima021     text,   -- 規格
  tc_ima004c    text,   -- 自製/外購 label
  tc_ima007c    text,   -- 產品族群 label
  tc_ima025     text,   -- 庫存單位
  wo_line_count bigint, -- 工單明細筆數
  shipment_count bigint -- 出貨單筆數
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    m.tc_ima001::text,
    m.tc_ima002::text,
    m.tc_ima021::text,
    m.tc_ima004c::text,
    m.tc_ima007c::text,
    m.tc_ima025::text,
    COALESCE((SELECT COUNT(*) FROM tiptop.csfzr121 WHERE t07::text = p_material_no), 0)::bigint,
    COALESCE((SELECT COUNT(*) FROM tiptop.cxmzr115 WHERE t07::text = p_material_no), 0)::bigint
  FROM tiptop.cimzr067 m
  WHERE m.tc_ima001 = p_material_no
  LIMIT 1
$$;
