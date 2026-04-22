-- @inputs: tiptop.cimzr067(tc_ima001, tc_ima002, tc_ima021, tc_ima004c, tc_ima007c, tc_ima025)
-- @subtype: action
-- @semantic_key: material_no (tc_ima001)
-- @purpose: Snapshot material attributes into a side cache table so downstream
--           Nexus consumers don't need to hit pg_k8 per request.
-- @note: VOLATILE; Greenplum does NOT support ON CONFLICT, so we emulate upsert via DELETE+INSERT.
-- @cache_ddl:
--   CREATE TABLE IF NOT EXISTS public.material_attr_cache (
--     material_no   text PRIMARY KEY,
--     name          text,
--     spec          text,
--     make_buy      text,
--     family        text,
--     unit          text,
--     synced_at     timestamptz DEFAULT now()
--   );

CREATE OR REPLACE FUNCTION fn_material_attr_sync(p_material_no text)
RETURNS TABLE (
  material_no  text,
  synced_at    timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
BEGIN
  DELETE FROM public.material_attr_cache WHERE material_no = p_material_no;

  INSERT INTO public.material_attr_cache (material_no, name, spec, make_buy, family, unit, synced_at)
  SELECT
    m.tc_ima001::text,
    m.tc_ima002::text,
    m.tc_ima021::text,
    m.tc_ima004c::text,
    m.tc_ima007c::text,
    m.tc_ima025::text,
    now()
  FROM tiptop.cimzr067 m
  WHERE m.tc_ima001 = p_material_no;

  RETURN QUERY
  SELECT p_material_no::text, now()::timestamptz;
END;
$$;
