-- DAG-SUBDAG-EMBED-V01 smoke test: parent embeds child published_dag.
--
-- Topology:
--   CHILD  dag:_test_subdag_active_parts (search → filter)
--     n_search (fn: tiptop.search_cimzr067_by_keys, user_input p_keywords) →
--     n_filter (op:filter tc_ima001 ne '')   <-- child leaf, exposed
--
--   PARENT dag:_test_subdag_embed
--     n_subdag (type='subdag', resource_id='published_dag:dag:_test_subdag_active_parts',
--               surfaces p_keywords from child) →
--     n_count  (op:aggregate count(*))      <-- parent leaf
--
-- After seeding, publish workflow:
--   1. POST /api/dag/dag:_test_subdag_active_parts/publish
--      { page_id: '_test_subdag_active_parts_pub', title: 'Active parts (shared)',
--        parent_page_id: 'modules_home', overwrite: true }
--   2. POST /api/dag/dag:_test_subdag_embed/publish
--      { page_id: '_test_subdag_embed_pub', title: 'BU count (via subdag)',
--        parent_page_id: 'modules_home', overwrite: true }
--
-- Expected on parent publish:
--   * dag_snapshot.nodes contains n_subdag__n_search, n_subdag__n_filter, n_count
--     (n_subdag itself disappears post-expansion)
--   * dag_snapshot.edges contains n_subdag__n_search → n_subdag__n_filter
--     (inlined from child) AND n_subdag__n_filter → n_count (rewired from
--     parent's n_subdag → n_count)
--   * dag_snapshot.embedded_subdags contains the child rid index
--   * form_schema includes p_keywords with source_node_id = 'n_subdag__n_search'
--   * GET /api/dag/published/published_dag:dag:_test_subdag_active_parts/embedders
--     returns _test_subdag_embed_pub in the parents array
--
-- Cleanup: DELETE FROM authz_resource WHERE resource_id LIKE 'dag:_test_subdag%';
--          DELETE FROM authz_ui_page WHERE page_id LIKE '_test_subdag%';

-- ── Child DAG ──
INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
VALUES (
  'dag:_test_subdag_active_parts',
  'dag',
  'Subdag smoke: active parts (child)',
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
          'user_input_params', jsonb_build_array('p_keywords')
        ),
        'position', jsonb_build_object('x', 0, 'y', 0)
      ),
      jsonb_build_object(
        'id', 'n_filter',
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
        'id', 'e_search_to_filter',
        'source', 'n_search',
        'target', 'n_filter'
      )
    )
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes = EXCLUDED.attributes,
      display_name = EXCLUDED.display_name,
      is_active = TRUE;

-- ── Parent DAG (uses the child via a 'subdag' node) ──
-- Aggregate operator counts rows from the inlined child output. op_config
-- mirrors the existing aggregate operator schema in lib/dag-operators.
INSERT INTO authz_resource (resource_id, resource_type, display_name, attributes, is_active)
VALUES (
  'dag:_test_subdag_embed',
  'dag',
  'Subdag smoke: BU count (parent embeds child)',
  jsonb_build_object(
    'data_source_id', 'ds:pg_k8',
    'nodes', jsonb_build_array(
      jsonb_build_object(
        'id', 'n_subdag',
        'type', 'subdag',
        'data', jsonb_build_object(
          'label', 'Active parts (shared)',
          'subtype', 'subdag',
          'resource_id', 'published_dag:dag:_test_subdag_active_parts',
          'subdag_source_output_node_id', 'n_filter',
          'subdag_user_inputs', jsonb_build_array('p_keywords'),
          'bound_subdag_params', jsonb_build_object(),
          -- DagTab callbacks (onConnect, isValidConnection) read data.inputs/outputs
          -- on every node, so subdag rows must include both keys even though the
          -- resolver ignores them. Mirrors what addSubdagNode produces on fresh authoring.
          'inputs', jsonb_build_array(),
          'outputs', jsonb_build_array(
            jsonb_build_object('name', '__downstream', 'semantic_type', '__rowset')
          ),
          'bound_params', jsonb_build_object()
        ),
        'position', jsonb_build_object('x', 0, 'y', 0)
      ),
      jsonb_build_object(
        'id', 'n_count',
        'type', 'aggregate',
        'data', jsonb_build_object(
          'label', 'count active rows',
          'subtype', 'query',
          'op_kind', 'aggregate',
          'op_config', jsonb_build_object(
            'kind', 'aggregate',
            'group_by', jsonb_build_array(),
            'aggregations', jsonb_build_array(
              jsonb_build_object('column', 'tc_ima001', 'fn', 'count', 'alias', 'row_count')
            )
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
        'id', 'e_subdag_to_count',
        'source', 'n_subdag',
        'target', 'n_count'
      )
    )
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes = EXCLUDED.attributes,
      display_name = EXCLUDED.display_name,
      is_active = TRUE;

-- Sanity check: both DAGs should be visible.
SELECT
  resource_id,
  display_name,
  attributes->>'data_source_id' AS ds,
  jsonb_array_length(attributes->'nodes') AS n_nodes,
  jsonb_array_length(attributes->'edges') AS n_edges,
  (SELECT COUNT(*) FROM jsonb_array_elements(attributes->'nodes') node
     WHERE node->>'type' = 'subdag') AS n_subdag_nodes
FROM authz_resource
WHERE resource_id IN ('dag:_test_subdag_active_parts', 'dag:_test_subdag_embed')
ORDER BY resource_id;
