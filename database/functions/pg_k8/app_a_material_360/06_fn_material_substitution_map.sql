-- @inputs: csfzr125(t04, t18, t20, t27)
-- @subtype: query
-- @semantic_key: material_no (t18)
-- @purpose: Substitution relationships — which sub-items have been used for a material,
--           and whether the substitution is blocked (t20='不可取替代').

CREATE OR REPLACE FUNCTION fn_material_substitution_map(
  p_material_no text,
  p_limit       int DEFAULT 100
)
RETURNS TABLE (
  wo_no              text,   -- t04 委外工單
  sub_material_no    text,   -- t18 替代/子件料號
  substitution_flag  text,   -- t20 是否可替代
  spec               text    -- t27 規格
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    t04::text,
    t18::text,
    t20::text,
    t27::text
  FROM tiptop.csfzr125
  WHERE t18 = p_material_no
  ORDER BY t04 DESC
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;
