-- @inputs: ima_file(ima01, ima02, ima021, ima25)
-- @subtype: query
-- @semantic_key: material_no (ima01)
-- @purpose: Keyword search across material code, name and spec.

CREATE OR REPLACE FUNCTION fn_material_search(
  p_keyword text,
  p_limit   int DEFAULT 50
)
RETURNS TABLE (
  ima01  text,   -- 料號 (semantic_type: material_no)
  ima02  text,   -- 品名
  ima021 text,   -- 規格
  ima25  text    -- 庫存單位
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    ima01::text,
    ima02::text,
    ima021::text,
    ima25::text
  FROM tiptop.ima_file
  WHERE ima01  ILIKE '%' || p_keyword || '%'
     OR ima02  ILIKE '%' || p_keyword || '%'
     OR ima021 ILIKE '%' || p_keyword || '%'
  ORDER BY ima01
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;
