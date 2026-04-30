-- DAG-PUBLISH-V01-FU smoke test: bidirectional exposure.
--
-- Two-node DAG:
--   n_search (fn: tiptop.search_cimzr067_by_keys) → n_leaf (op: filter)
--
-- n_leaf is the primary output (single-leaf invariant). n_search is admin-
-- flagged with expose_output:true so its raw frame surfaces as an extra
-- output block on the published page. The filter op is a no-op predicate
-- (tc_ima001 ne '') chosen because it preserves all non-null rows without
-- requiring a real downstream fn — keeps the smoke test schema-light.
--
-- After running this seed, publish via the dashboard or:
--   POST /api/dag/dag:_test_publish_smoke_bidir/publish
--     { page_id: "test_publish_smoke_bidir", title: "Smoke (bidir)",
--       parent_page_id: "modules_home", overwrite: true }
--
-- Expected:
--   * dag_snapshot.exposed_node_ids = ["n_leaf","n_search"]
--   * /api/config-exec form_load: returns form_schema with p_keywords
--   * /api/config-exec exec: meta.outputs has 2 keys, primary = n_leaf
--   * BI_USER (tsai_bi) sees both blocks; nobody_user → 403

INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
VALUES (
  'dag:_test_publish_smoke_bidir',
  'dag',
  'Smoke Test (bidirectional exposure)',
  jsonb_build_object(
    'data_source_id', 'ds:pg_k8',
    'nodes', jsonb_build_array(
      jsonb_build_object(
        'id', 'n_search',
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
          'user_input_params', jsonb_build_array('p_keywords'),
          'expose_output', true
        ),
        'position', jsonb_build_object('x', 0, 'y', 0)
      ),
      jsonb_build_object(
        'id', 'n_leaf',
        'type', 'filter',
        'data', jsonb_build_object(
          'label', 'filter non-empty tc_ima001',
          'subtype', 'query',
          'op_kind', 'filter',
          'op_config', jsonb_build_object(
            'kind', 'filter',
            'column', 'tc_ima001',
            'op', 'ne',
            'value', ''
          ),
          'inputs', jsonb_build_array(),
          'outputs', jsonb_build_array(),
          'bound_params', jsonb_build_object()
        ),
        'position', jsonb_build_object('x', 240, 'y', 0)
      )
    ),
    'edges', jsonb_build_array(
      jsonb_build_object(
        'id', 'e_search_to_leaf',
        'source', 'n_search',
        'target', 'n_leaf'
      )
    )
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes = EXCLUDED.attributes,
      display_name = EXCLUDED.display_name,
      is_active = TRUE;

SELECT
  resource_id,
  display_name,
  attributes->>'data_source_id' AS ds,
  jsonb_array_length(attributes->'nodes') AS n_nodes,
  jsonb_array_length(attributes->'edges') AS n_edges,
  (SELECT COUNT(*) FROM jsonb_array_elements(attributes->'nodes') node
     WHERE (node->'data'->>'expose_output')::boolean IS TRUE) AS n_expose_flagged
FROM authz_resource
WHERE resource_id = 'dag:_test_publish_smoke_bidir';
