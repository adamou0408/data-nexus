-- ============================================================
-- EXPLORER-MODE-V01 smoke test: multi-leaf navigable DAG.
--
-- Three-node fan-out (TWO leaves, deliberately — this is the shape
-- that exercises the explorer-vs-tabular branching):
--
--                ┌──────→ n_history (leaf)
--                │         drill: 出貨單號 → p_order_no
--   n_search ────┤
--                │
--                └──────→ n_aging   (leaf, fictional fn from §1)
--                          drill keyed off the same tc_ima001 cell
--
-- Edges fan from n_search's `tc_ima001` column to both downstream
-- functions' input handles. Two leaves means:
--   * tabular publish FAILS — `findSingleLeaf` rejects multi-leaf
--     (this is what acceptance criterion §11.2 asserts).
--   * explorer publish SUCCEEDS — `pickFirstLeafOrThrow` tolerates
--     multiple leaves and the renderer navigates per drill click.
--
-- Two sections in this file (run them in order):
--   §1  Run against `ds:pg_k8`     — installs `fn_aging_by_order` so the
--                                    aging leaf has a real callable target.
--   §2  Run against `nexus_authz`  — registers the DAG row + function
--                                    resource for the new fn so authz
--                                    cascade resolves execute permission
--                                    via module:pg_tiptop_v1.
--
-- Why a fictional fn: the plan §8 demos drill from search → aging, but
-- the tiptop ERP image doesn't ship an aging function. A 6-row toy fn
-- keeps the smoke deterministic without depending on real ERP data.
--
-- After running both sections, publish via the dashboard or curl:
--   POST /api/dag/dag:_test_publish_smoke_explorer/publish
--   {
--     "page_id": "test_publish_smoke_explorer",
--     "title": "Smoke (explorer mode)",
--     "parent_module_id": "module:pg_tiptop_v1",
--     "display_mode": "explorer",
--     "overwrite": true
--   }
--
-- Expected:
--   * dag_snapshot.display_mode === 'explorer'
--   * dag_snapshot.exposed_node_ids contains all 3 nodes (explorer is
--     opt-out and none flagged expose_output:false here).
--   * /api/config-exec form_load: meta.display_mode === 'explorer',
--     form_schema includes p_keywords.
--   * /api/config-exec exec: meta.outputs has 3 keys.
--   * Re-publishing the SAME DAG with display_mode='tabular'
--     (overwrite=true) is REJECTED with "Multiple leaf nodes" —
--     proves the if/else branch in the publish handler.
-- ============================================================


-- ════════════════════════════════════════════════════════════════
-- §1.  Run against `ds:pg_k8` (the tiptop schema lives here).
-- ════════════════════════════════════════════════════════════════
-- Toy aging-by-order function. Returns hard-coded rows so the smoke is
-- deterministic regardless of upstream ERP state. Idempotent — CREATE
-- OR REPLACE means re-running this seed never fails on a second pass.

CREATE OR REPLACE FUNCTION tiptop.fn_aging_by_order(p_order_no text)
RETURNS TABLE (
  order_no       text,
  bucket         text,
  amount_twd     numeric,
  invoice_date   date
)
LANGUAGE sql
STABLE
AS $$
  -- Static mapping keyed on input. Every order_no returns 3 buckets so
  -- the explorer page has rows to render at the leaf frame regardless
  -- of which value the user clicks through.
  WITH input AS (SELECT COALESCE(p_order_no, 'UNKNOWN') AS o)
  SELECT i.o,            '0-30'::text,   12345.00::numeric, CURRENT_DATE - 15 FROM input i
  UNION ALL
  SELECT i.o,            '31-60'::text,   8200.50::numeric, CURRENT_DATE - 45 FROM input i
  UNION ALL
  SELECT i.o,            '61+'::text,     1500.00::numeric, CURRENT_DATE - 90 FROM input i;
$$;

COMMENT ON FUNCTION tiptop.fn_aging_by_order(text) IS
  'EXPLORER-MODE-V01 smoke fixture — toy aging by order_no. Not an ERP function.';


-- ════════════════════════════════════════════════════════════════
-- §2.  Run against `nexus_authz`.
-- ════════════════════════════════════════════════════════════════

-- 2a. Register the new fn as an authz_resource so cascade grants
-- DATA_STEWARD execute via module:pg_tiptop_v1 (mirrors siblings).
-- parent_id matches dag_material_search_fanout's siblings — the
-- `db_schema:pg_k8.tiptop` row is seeded by the live data-source
-- introspection job on the tiptop schema.
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'function:tiptop.fn_aging_by_order',
  'function',
  'db_schema:pg_k8.tiptop',
  'fn_aging_by_order',
  jsonb_build_object(
    'data_source_id', 'ds:pg_k8',
    'schema', 'tiptop',
    'function_name', 'fn_aging_by_order',
    'parsed_args', jsonb_build_array(
      jsonb_build_object('name','p_order_no','pgType','text','hasDefault',false)
    ),
    'arguments', 'p_order_no text'
  ),
  TRUE
)
ON CONFLICT (resource_id) DO UPDATE
  SET attributes = EXCLUDED.attributes,
      display_name = EXCLUDED.display_name,
      parent_id = EXCLUDED.parent_id,
      is_active = TRUE;


-- 2b. Register the explorer-mode DAG itself.
-- Per plan §5.3 explorer is opt-out: no `expose_output` flags here, the
-- publish handler defaults all non-sink nodes into `exposed_node_ids`.
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
  'dag:_test_publish_smoke_explorer',
  'dag',
  'module:pg_tiptop_v1',
  'Smoke Test (explorer mode)',
  jsonb_build_object(
    'data_source_id', 'ds:pg_k8',
    'description', 'EXPLORER-MODE-V01 smoke: search fan-out to shipment + aging — 2 leaves, navigable.',
    'version', 1,
    'authored_by', 'system',
    'updated_at', now()::text,
    'nodes', jsonb_build_array(
      -- n_search: keyword entry. Same params shape as the bidir smoke
      -- so curators recognize the form field.
      jsonb_build_object(
        'id', 'n_search', 'type', 'fn',
        'position', jsonb_build_object('x', 80, 'y', 240),
        'data', jsonb_build_object(
          'resource_id', 'function:tiptop.search_cimzr067_by_keys',
          'label', 'search_cimzr067_by_keys',
          'subtype', 'function',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_keywords','semantic_type','keyword','hasDefault',false,'pgType','text[]')
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','tc_ima001','semantic_type','material_no','pgType','character varying'),
            jsonb_build_object('name','ima02','semantic_type','unknown','pgType','character varying'),
            jsonb_build_object('name','ima021','semantic_type','unknown','pgType','character varying')
          ),
          'bound_params', jsonb_build_object(
            'p_keywords', jsonb_build_array('PC7250020H-00000-01229')
          ),
          'user_input_params', jsonb_build_array('p_keywords')
        )
      ),
      -- n_history: leaf #1 — shipment lookup keyed by material_no.
      -- Real fn, already registered as authz_resource.
      jsonb_build_object(
        'id', 'n_history', 'type', 'fn',
        'position', jsonb_build_object('x', 520, 'y', 80),
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
      ),
      -- n_aging: leaf #2 — toy fn from §1 above. Fans off the same
      -- tc_ima001 column so explorer's drill UX surfaces a popover
      -- ("via p_material_no" vs "via p_order_no") when the user clicks
      -- a tc_ima001 cell.
      jsonb_build_object(
        'id', 'n_aging', 'type', 'fn',
        'position', jsonb_build_object('x', 520, 'y', 400),
        'data', jsonb_build_object(
          'resource_id', 'function:tiptop.fn_aging_by_order',
          'label', 'fn_aging_by_order',
          'subtype', 'function',
          'inputs', jsonb_build_array(
            jsonb_build_object('name','p_order_no','semantic_type','shipment_no','hasDefault',false,'pgType','text')
          ),
          'outputs', jsonb_build_array(
            jsonb_build_object('name','order_no','semantic_type','shipment_no','pgType','text'),
            jsonb_build_object('name','bucket','semantic_type','aging_bucket','pgType','text'),
            jsonb_build_object('name','amount_twd','semantic_type','amount','pgType','numeric'),
            jsonb_build_object('name','invoice_date','semantic_type','date','pgType','date')
          ),
          'bound_params', jsonb_build_object()
        )
      )
    ),
    'edges', jsonb_build_array(
      -- e1: search → shipment lookup (tc_ima001 → p_material_no).
      jsonb_build_object('id','e_search_to_history','source','n_search','target','n_history',
                        'sourceHandle','tc_ima001','targetHandle','p_material_no'),
      -- e2: search → aging lookup. Reuses tc_ima001 as the cell key
      -- (smoke fixture — production usage would route shipment_no after
      -- a shipment lookup, but exposing the multi-outbound popover is
      -- the demo target here, not realistic data flow).
      jsonb_build_object('id','e_search_to_aging','source','n_search','target','n_aging',
                        'sourceHandle','tc_ima001','targetHandle','p_order_no')
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

-- 2c. Sanity printout: confirm node/edge counts and that no expose_output
-- flag was set (explorer mode should auto-expose everything on publish).
SELECT
  resource_id,
  display_name,
  attributes->>'data_source_id' AS ds,
  jsonb_array_length(attributes->'nodes') AS n_nodes,
  jsonb_array_length(attributes->'edges') AS n_edges,
  (SELECT COUNT(*) FROM jsonb_array_elements(attributes->'nodes') node
     WHERE node->'data' ? 'expose_output') AS n_expose_flagged
FROM authz_resource
WHERE resource_id = 'dag:_test_publish_smoke_explorer';

SELECT refresh_module_tree_stats();
