-- Strip literal node (n1) + edge from dag:test_publish, then expose
-- p_searchkey as form input with default value on n2.
UPDATE authz_resource
SET attributes = attributes
  || jsonb_build_object(
       'nodes', (
         SELECT jsonb_agg(
           jsonb_set(
             jsonb_set(node, '{data,user_input_params}', '["p_searchkey"]'::jsonb),
             '{data,bound_params}', '{"p_searchkey": "PC7250020H-00000-01229"}'::jsonb
           )
         )
         FROM jsonb_array_elements(attributes->'nodes') AS node
         WHERE node->>'id' = 'n2'
       ),
       'edges', '[]'::jsonb
     )
WHERE resource_id = 'dag:test_publish';

SELECT
  jsonb_array_length(attributes->'nodes') AS n_nodes,
  jsonb_array_length(attributes->'edges') AS n_edges,
  attributes->'nodes'->0->'data'->'user_input_params' AS user_inputs,
  attributes->'nodes'->0->'data'->'bound_params' AS bound
FROM authz_resource WHERE resource_id='dag:test_publish';
