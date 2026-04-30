-- temporary smoke-test DAG for DAG-PUBLISH-V01
INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
VALUES (
  'dag:_test_publish_smoke',
  'dag',
  'Smoke Test Published DAG',
  jsonb_build_object(
    'data_source_id', 'ds:pg_k8',
    'nodes', jsonb_build_array(
      jsonb_build_object(
        'id', 'n1',
        'type', 'fn',
        'data', jsonb_build_object(
          'label', 'search_cimzr067_by_keys',
          'resource_id', 'function:tiptop.search_cimzr067_by_keys',
          'subtype', 'query',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_keywords','pgType','text[]','hasDefault',false),
            jsonb_build_object('name','p_limit','pgType','integer','hasDefault',true)
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','tc_ima001','pgType','character varying'),
            jsonb_build_object('name','ima02','pgType','character varying'),
            jsonb_build_object('name','ima021','pgType','character varying')
          ),
          'bound_params', jsonb_build_object('p_keywords', jsonb_build_array('PC7250020H-00000-01229')),
          'user_input_params', jsonb_build_array('p_keywords')
        ),
        'position', jsonb_build_object('x', 0, 'y', 0)
      )
    ),
    'edges', jsonb_build_array()
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes = EXCLUDED.attributes,
      display_name = EXCLUDED.display_name,
      is_active = TRUE;

SELECT resource_id, display_name, attributes->'data_source_id' as ds, jsonb_array_length(attributes->'nodes') as n FROM authz_resource WHERE resource_id='dag:_test_publish_smoke';
