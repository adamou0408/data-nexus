-- ============================================================
-- V076: NPI gate sign-off vertical seed
--
-- First dogfood of the V073-V075 platform primitives:
--   - entity_kind          (V073)
--   - lifecycle definition (V074)
--   - composite_action     (V003) + workflow runtime (V075)
--
-- What this migration sets up:
--   1. entity_kind 'npi_material'
--   2. resource 'module:mrp.npi.gate_signoff' (target_resource for the
--      4 composite_actions)
--   3. lifecycle_definition 'npi_gate_lifecycle' on 'npi_material'
--      with 5 states (NPI_G0_concept .. NPI_G4_mass_production) and
--      4 forward transitions
--   4. 4 composite_actions, one per gate transition. Each carries
--      the SAME approval_chain (PE → QA → VP); separate rows so
--      Curators can later tune per-transition (e.g. G3→G4 may
--      escalate beyond VP).
--
-- What is intentionally NOT here:
--   - lifecycle_instance rows. Created lazily by the npi_gate_console
--     page when Adam (or a real PM) opens a material for the first time.
--   - Material filter on cimzr067. Lives in the page query
--     (WHERE tc_ima007 = '<NPI code>'), not in a discovery_rule —
--     authz_discovery_rule pattern-matches column NAMES, not row values.
--
-- Naming: composite_action.policy_name = 'npi_advance_<from>_to_<to>'
-- so the API can resolve the right composite by current_state.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) entity_kind
-- ------------------------------------------------------------
INSERT INTO authz_entity_kind (entity_kind, display_name, description)
VALUES (
    'npi_material',
    'NPI Material',
    'New Product Introduction stage material — keyed on cimzr067.tc_ima001 (Tiptop ERP material number). Lifecycle: NPI_G0_concept → NPI_G4_mass_production.'
)
ON CONFLICT (entity_kind) DO NOTHING;

-- ------------------------------------------------------------
-- 2) target_resource for the composite_actions
--    Parent left NULL — the Curator can later reparent under
--    'module:mrp.npi' when that module resource exists.
-- ------------------------------------------------------------
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
VALUES (
    'module:mrp.npi.gate_signoff',
    'module',
    NULL,
    'NPI Gate Sign-off',
    jsonb_build_object(
        'created_by', 'V076',
        'comment',    'Target resource for the 4 npi_advance_* composite_actions. Path A npi_gate_console page renders against this.',
        'entity_kind','npi_material'
    ),
    TRUE
)
ON CONFLICT (resource_id) DO UPDATE
   SET attributes = EXCLUDED.attributes,
       is_active  = TRUE,
       updated_at = now();

UPDATE authz_resource
   SET entity_kind = 'npi_material'
 WHERE resource_id = 'module:mrp.npi.gate_signoff';

-- ------------------------------------------------------------
-- 3) Lifecycle definition
-- ------------------------------------------------------------
INSERT INTO authz_lifecycle_definition
    (lifecycle_id, entity_kind, display_name, description, states, initial_state, transitions)
VALUES (
    'npi_gate_lifecycle',
    'npi_material',
    'NPI Gate Lifecycle',
    '5-stage NPI gate flow. Each forward transition is gated by the npi_advance_<from>_to_<to> composite_action (PE → QA → VP approval chain).',
    ARRAY['NPI_G0_concept',
          'NPI_G1_feasibility',
          'NPI_G2_dev',
          'NPI_G3_qualification',
          'NPI_G4_mass_production'],
    'NPI_G0_concept',
    '[
        {"from": "NPI_G0_concept",       "to": "NPI_G1_feasibility",     "action": "npi_advance_g0_to_g1"},
        {"from": "NPI_G1_feasibility",   "to": "NPI_G2_dev",             "action": "npi_advance_g1_to_g2"},
        {"from": "NPI_G2_dev",           "to": "NPI_G3_qualification",   "action": "npi_advance_g2_to_g3"},
        {"from": "NPI_G3_qualification", "to": "NPI_G4_mass_production", "action": "npi_advance_g3_to_g4"}
     ]'::jsonb
)
ON CONFLICT (lifecycle_id) DO UPDATE
   SET states        = EXCLUDED.states,
       initial_state = EXCLUDED.initial_state,
       transitions   = EXCLUDED.transitions,
       updated_at    = now();

-- ------------------------------------------------------------
-- 4) composite_actions — one per transition
--    approval_chain is the SAME PE → QA → VP today; rows split so
--    Curators can later set different chains per transition (e.g.
--    G3→G4 mass-production escalation beyond VP).
-- ------------------------------------------------------------
INSERT INTO authz_composite_action
    (policy_name, description, target_action, target_resource, approval_chain, preconditions, timeout_hours, status)
VALUES
    ('npi_advance_g0_to_g1',
     'Advance NPI material from G0_concept to G1_feasibility.',
     'approve',
     'module:mrp.npi.gate_signoff',
     '[{"step": 0, "role": "PE", "label": "PE Lead sign-off"},
       {"step": 1, "role": "QA", "label": "QA Lead sign-off"},
       {"step": 2, "role": "VP", "label": "VP final sign-off"}]'::jsonb,
     '{"from_state": "NPI_G0_concept", "to_state": "NPI_G1_feasibility"}'::jsonb,
     72, 'active'),

    ('npi_advance_g1_to_g2',
     'Advance NPI material from G1_feasibility to G2_dev.',
     'approve',
     'module:mrp.npi.gate_signoff',
     '[{"step": 0, "role": "PE", "label": "PE Lead sign-off"},
       {"step": 1, "role": "QA", "label": "QA Lead sign-off"},
       {"step": 2, "role": "VP", "label": "VP final sign-off"}]'::jsonb,
     '{"from_state": "NPI_G1_feasibility", "to_state": "NPI_G2_dev"}'::jsonb,
     72, 'active'),

    ('npi_advance_g2_to_g3',
     'Advance NPI material from G2_dev to G3_qualification.',
     'approve',
     'module:mrp.npi.gate_signoff',
     '[{"step": 0, "role": "PE", "label": "PE Lead sign-off"},
       {"step": 1, "role": "QA", "label": "QA Lead sign-off"},
       {"step": 2, "role": "VP", "label": "VP final sign-off"}]'::jsonb,
     '{"from_state": "NPI_G2_dev", "to_state": "NPI_G3_qualification"}'::jsonb,
     72, 'active'),

    ('npi_advance_g3_to_g4',
     'Advance NPI material from G3_qualification to G4_mass_production.',
     'approve',
     'module:mrp.npi.gate_signoff',
     '[{"step": 0, "role": "PE", "label": "PE Lead sign-off"},
       {"step": 1, "role": "QA", "label": "QA Lead sign-off"},
       {"step": 2, "role": "VP", "label": "VP final sign-off"}]'::jsonb,
     '{"from_state": "NPI_G3_qualification", "to_state": "NPI_G4_mass_production"}'::jsonb,
     72, 'active')
ON CONFLICT (policy_name) DO UPDATE
   SET description     = EXCLUDED.description,
       target_action   = EXCLUDED.target_action,
       target_resource = EXCLUDED.target_resource,
       approval_chain  = EXCLUDED.approval_chain,
       preconditions   = EXCLUDED.preconditions,
       timeout_hours   = EXCLUDED.timeout_hours,
       status          = EXCLUDED.status;

-- ------------------------------------------------------------
-- 5) role_permission seeds — PE / QA / VP × approve ×
--    module:mrp.npi.gate_signoff
--
-- Workflow API will call authz_check(actor, 'approve',
-- 'module:mrp.npi.gate_signoff') on every /api/workflow/:id/approve.
-- Without these rows the chain would silently default-deny — the
-- requester sees "rejected" with no policy hit.
--
-- The chain enforcement (PE first, then QA, then VP) lives in the
-- workflow runtime: it reads composite_action.approval_chain[step]
-- and refuses to record an approval whose actor's role doesn't match
-- the expected step. authz_check only answers "is this role allowed
-- to approve at all on this resource".
-- ------------------------------------------------------------
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect, is_active)
VALUES
    ('PE', 'approve', 'module:mrp.npi.gate_signoff', 'allow', TRUE),
    ('QA', 'approve', 'module:mrp.npi.gate_signoff', 'allow', TRUE),
    ('VP', 'approve', 'module:mrp.npi.gate_signoff', 'allow', TRUE)
ON CONFLICT (role_id, action_id, resource_id) DO UPDATE
   SET effect    = EXCLUDED.effect,
       is_active = EXCLUDED.is_active;

COMMIT;
