-- ============================================================
-- Golden-case DAG: Material search fan-out (sink-as-node-kind demo)
--
-- User flow this seeds:
--   1. Open Composer → load `dag:material_search_fanout`
--   2. Run with the pre-bound keyword `PC7250020H-00000-01229`
--   3. n1 returns rows with column `tc_ima001`
--   4. tc_ima001 fans out to BOTH downstream nodes simultaneously
--   5. Either downstream node's table can be saved as a Tier B page
--      via the sink dialog (DAG-SAVE-PAGE-01 / V054 snapshot path)
--
-- Why this seed exists:
--   Demonstrates the canonical "1 source → N sinks via shared semantic
--   key" pattern. Mirrors the structure of dag_material_360_trace
--   (lookup → enrich) but uses search_cimzr067_by_keys as entry so
--   the user does not need to know an exact material_no upfront.
--
-- IO contracts below are declared at the DAG-node level. The actual
-- function DDL lives in the external Tiptop DB (ds:pg_k8 → tiptop
-- schema); we cannot CREATE FUNCTION here. authz_resource rows for
-- all three functions already exist (parent_id=db_schema:pg_k8.tiptop)
-- so V070 cascade resolves execute permission via module:pg_tiptop_v1.
--
-- Re-runnable: ON CONFLICT updates attributes JSONB in place.
-- ============================================================

INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'dag:material_search_fanout',
  'dag',
  'module:pg_tiptop_v1',
  'Material Search Fan-out',
  jsonb_build_object(
    'data_source_id', 'ds:pg_k8',
    'description', 'Search material master by keyword, then fan out to work-order list and shipment history on tc_ima001.',
    'version', 1,
    'authored_by', 'system',
    'updated_at', now()::text,
    'nodes', jsonb_build_array(
      -- n1: search_cimzr067_by_keys (entry point, keyword pre-bound)
      jsonb_build_object(
        'id', 'n1', 'type', 'fn',
        'position', jsonb_build_object('x', 80, 'y', 240),
        'data', jsonb_build_object(
          'resource_id', 'function:tiptop.search_cimzr067_by_keys',
          'label', 'search_cimzr067_by_keys',
          'subtype', 'function',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_keywords','semantic_type','keyword','hasDefault',false,'pgType','text')
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','tc_ima001','semantic_type','material_no','pgType','character varying'),
            jsonb_build_object('name','tc_ima002','semantic_type','unknown','pgType','character varying'),
            jsonb_build_object('name','tc_ima021','semantic_type','unknown','pgType','character varying'),
            jsonb_build_object('name','tc_ima004','semantic_type','make_buy_flag','pgType','character varying'),
            jsonb_build_object('name','tc_ima007','semantic_type','product_family','pgType','character varying'),
            jsonb_build_object('name','tc_ima025','semantic_type','unknown','pgType','character varying')
          ),
          'bound_params', jsonb_build_object(
            'p_keywords', 'PC7250020H-00000-01229'
          )
        )
      ),
      -- n2: get_work_orders_by_part (csfzr120 work-order header)
      jsonb_build_object(
        'id', 'n2', 'type', 'fn',
        'position', jsonb_build_object('x', 520, 'y', 80),
        'data', jsonb_build_object(
          'resource_id', 'function:tiptop.get_work_orders_by_part',
          'label', 'get_work_orders_by_part',
          'subtype', 'function',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_material_no','semantic_type','material_no','hasDefault',false,'pgType','text')
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','工單編號','semantic_type','wo_no','pgType','character varying'),
            jsonb_build_object('name','工單狀態','semantic_type','status','pgType','character varying'),
            jsonb_build_object('name','產品料號','semantic_type','material_no','pgType','character varying'),
            jsonb_build_object('name','預計開工日','semantic_type','unknown','pgType','date'),
            jsonb_build_object('name','預計完工日','semantic_type','unknown','pgType','date'),
            jsonb_build_object('name','預計數量','semantic_type','quantity','pgType','numeric')
          ),
          'bound_params', jsonb_build_object()
        )
      ),
      -- n3: fn_cxmzr115_shipment_history_by_material_no
      jsonb_build_object(
        'id', 'n3', 'type', 'fn',
        'position', jsonb_build_object('x', 520, 'y', 420),
        'data', jsonb_build_object(
          'resource_id', 'function:tiptop.fn_cxmzr115_shipment_history_by_material_no',
          'label', 'fn_cxmzr115_shipment_history_by_material_no',
          'subtype', 'function',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_material_no','semantic_type','material_no','hasDefault',false,'pgType','text')
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','料號','semantic_type','material_no','pgType','character varying'),
            jsonb_build_object('name','出貨單號','semantic_type','shipment_no','pgType','character varying'),
            jsonb_build_object('name','帳戶客戶','semantic_type','customer_code','pgType','character varying'),
            jsonb_build_object('name','出貨狀態','semantic_type','status','pgType','character varying'),
            jsonb_build_object('name','計價數量','semantic_type','quantity','pgType','numeric')
          ),
          'bound_params', jsonb_build_object()
        )
      )
    ),
    'edges', jsonb_build_array(
      jsonb_build_object('id','e1','source','n1','target','n2','sourceHandle','tc_ima001','targetHandle','p_material_no'),
      jsonb_build_object('id','e2','source','n1','target','n3','sourceHandle','tc_ima001','targetHandle','p_material_no')
    )
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      parent_id    = EXCLUDED.parent_id,
      attributes   = EXCLUDED.attributes,
      is_active    = TRUE,
      updated_at   = now();

SELECT refresh_module_tree_stats();
