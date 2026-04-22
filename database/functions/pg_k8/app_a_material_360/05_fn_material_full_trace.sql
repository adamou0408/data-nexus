-- @inputs: csfzr121(t01, t02, t07, t08), csfzr120(t01, t03, t04, t05, t06, t02),
--          cxmzr115(t01, t02, t03, t04, t09, t17)
-- @subtype: query
-- @semantic_key: material_no (t07)
-- @purpose: End-to-end footprint of a material — work orders + shipments.
-- @note: Returns UNION of two logical streams distinguished by stream column.

CREATE OR REPLACE FUNCTION fn_material_full_trace(
  p_material_no text,
  p_limit       int DEFAULT 100
)
RETURNS TABLE (
  stream        text,   -- 'wo' | 'shipment'
  doc_no        text,   -- t01 工單單號 or 出貨單號
  doc_line      text,   -- t02 序號
  doc_status    text,   -- WO: t04 / Shipment: t09
  counterparty  text,   -- WO: t05 供應商 / Shipment: t03 客戶
  doc_date      text,   -- t02 / t02 單據日期
  qty           text    -- t08 / t17
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  (
    SELECT
      'wo'::text          AS stream,
      wo.t01::text        AS doc_no,
      dt.t02::text        AS doc_line,
      wo.t04::text        AS doc_status,
      wo.t05::text        AS counterparty,
      wo.t02::text        AS doc_date,
      dt.t08::text        AS qty
    FROM tiptop.csfzr121 dt
    JOIN tiptop.csfzr120 wo ON wo.t01 = dt.t01
    WHERE dt.t07::text = p_material_no
    ORDER BY wo.t02 DESC
    LIMIT GREATEST(1, LEAST(p_limit, 500))
  )
  UNION ALL
  (
    SELECT
      'shipment'::text    AS stream,
      t01::text           AS doc_no,
      NULL::text          AS doc_line,
      t09::text           AS doc_status,
      t03::text           AS counterparty,
      t02::text           AS doc_date,
      t17::text           AS qty
    FROM tiptop.cxmzr115
    WHERE t07::text = p_material_no
    ORDER BY t02 DESC
    LIMIT GREATEST(1, LEAST(p_limit, 500))
  )
$$;
