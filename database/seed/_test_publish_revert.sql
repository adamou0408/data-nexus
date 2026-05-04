-- Revert: restore literal node + edge so curator practices the UI flow.
UPDATE authz_resource
SET attributes = jsonb_build_object(
  'data_source_id', attributes->>'data_source_id',
  'nodes', jsonb_build_array(
    jsonb_build_object(
      'id', 'n1',
      'type', 'literal',
      'position', jsonb_build_object('x', -458.7316451677782, 'y', 91.30925209321673),
      'data', jsonb_build_object(
        'label', 'literal',
        'subtype', 'operator',
        'op_kind', 'literal',
        'op_config', jsonb_build_object('kind', 'literal', 'value', 'PC7250020H-00000-01229', 'pgType', 'text'),
        'inputs', jsonb_build_array(),
        'outputs', jsonb_build_array(jsonb_build_object('name', 'value', 'pgType', 'text')),
        'bound_params', jsonb_build_object(),
        'expose_output', false,
        'resource_id', ''
      )
    ),
    -- keep n2 as-is from current DB
    (SELECT node FROM jsonb_array_elements(attributes->'nodes') AS node WHERE node->>'id' = 'n2')
  ),
  'edges', jsonb_build_array(
    jsonb_build_object(
      'id', 'e1_1777874413640',
      'source', 'n1', 'target', 'n2',
      'sourceHandle', 'value', 'targetHandle', 'p_searchkey',
      'style', jsonb_build_object('stroke', '#cbd5e1', 'strokeWidth', 2)
    )
  )
)
WHERE resource_id = 'dag:test_publish';

-- Also strip the user_input_params/bound_params we added on n2,
-- so the only input source is the literal upstream (matches Adam's last screenshot).
UPDATE authz_resource
SET attributes = jsonb_set(
  attributes,
  '{nodes}',
  (SELECT jsonb_agg(
    CASE WHEN node->>'id' = 'n2'
      THEN node #- '{data,user_input_params}' #- '{data,bound_params}'
           || jsonb_build_object('data', (node->'data') #- '{user_input_params}' || jsonb_build_object('bound_params', '{}'::jsonb))
      ELSE node
    END
  ) FROM jsonb_array_elements(attributes->'nodes') AS node)
)
WHERE resource_id = 'dag:test_publish';

SELECT
  jsonb_array_length(attributes->'nodes') AS n_nodes,
  jsonb_array_length(attributes->'edges') AS n_edges
FROM authz_resource WHERE resource_id='dag:test_publish';
