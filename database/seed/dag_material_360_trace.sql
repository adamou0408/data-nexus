-- ============================================================
-- Production DAG: Material 360 trace
--
-- Single root node (fn_material_lookup) drives 3 downstream
-- enrichment functions, all in module:analytics so one execute
-- grant on that module covers the whole pipeline.
--
-- Resource:
--   dag:material_360_trace under parent module:analytics
--
-- Re-runnable: ON CONFLICT updates the attributes JSONB in place.
-- ============================================================

INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'dag:material_360_trace',
  'dag',
  'module:analytics',
  'Material 360 Trace',
  jsonb_build_object(
    'data_source_id', 'ds:pg_k8',
    'description', 'Lookup a material number, then fan out to substitution map, full document trace, and shipment history.',
    'version', 1,
    'authored_by', 'system',
    'updated_at', now()::text,
    'nodes', jsonb_build_array(
      -- n1: fn_material_lookup (entry point, user provides p_material_no)
      jsonb_build_object(
        'id', 'n1', 'type', 'fn',
        'position', jsonb_build_object('x', 80, 'y', 80),
        'data', jsonb_build_object(
          'resource_id', 'function:public.fn_material_lookup',
          'label', 'fn_material_lookup',
          'subtype', 'function',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_material_no','semantic_type','material_no','hasDefault',false,'pgType','text')
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','tc_ima001','semantic_type','material_no','pgType','text'),
            jsonb_build_object('name','tc_ima002','semantic_type','unknown','pgType','text'),
            jsonb_build_object('name','tc_ima004','semantic_type','make_buy_flag','pgType','text'),
            jsonb_build_object('name','tc_ima007','semantic_type','product_family','pgType','text')
          ),
          'bound_params', jsonb_build_object()
        )
      ),
      -- n2: fn_material_substitution_map
      jsonb_build_object(
        'id', 'n2', 'type', 'fn',
        'position', jsonb_build_object('x', 480, 'y', 40),
        'data', jsonb_build_object(
          'resource_id', 'function:public.fn_material_substitution_map',
          'label', 'fn_material_substitution_map',
          'subtype', 'function',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_material_no','semantic_type','material_no','hasDefault',false,'pgType','text'),
            jsonb_build_object('name','p_limit','semantic_type','limit','hasDefault',true,'pgType','integer')
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','wo_no','semantic_type','wo_no','pgType','text'),
            jsonb_build_object('name','sub_material_no','semantic_type','material_no','pgType','text'),
            jsonb_build_object('name','substitution_flag','semantic_type','status','pgType','text'),
            jsonb_build_object('name','spec','semantic_type','unknown','pgType','text')
          ),
          'bound_params', jsonb_build_object()
        )
      ),
      -- n3: fn_material_full_trace
      jsonb_build_object(
        'id', 'n3', 'type', 'fn',
        'position', jsonb_build_object('x', 480, 'y', 280),
        'data', jsonb_build_object(
          'resource_id', 'function:public.fn_material_full_trace',
          'label', 'fn_material_full_trace',
          'subtype', 'function',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_material_no','semantic_type','material_no','hasDefault',false,'pgType','text'),
            jsonb_build_object('name','p_limit','semantic_type','limit','hasDefault',true,'pgType','integer')
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','stream','semantic_type','unknown','pgType','text'),
            jsonb_build_object('name','doc_no','semantic_type','unknown','pgType','text'),
            jsonb_build_object('name','doc_status','semantic_type','status','pgType','text'),
            jsonb_build_object('name','qty','semantic_type','quantity','pgType','text')
          ),
          'bound_params', jsonb_build_object()
        )
      ),
      -- n4: fn_cxmzr115_shipment_history_by_material_no
      jsonb_build_object(
        'id', 'n4', 'type', 'fn',
        'position', jsonb_build_object('x', 480, 'y', 520),
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
      jsonb_build_object('id','e2','source','n1','target','n3','sourceHandle','tc_ima001','targetHandle','p_material_no'),
      jsonb_build_object('id','e3','source','n1','target','n4','sourceHandle','tc_ima001','targetHandle','p_material_no')
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
