-- ============================================================
-- V072: NPI_G* prefix on NPI gate tokens
--
-- Was: gate_color tokens "G0_concept" .. "G4_mass_production"
-- Now: "NPI_G0_concept" .. "NPI_G4_mass_production"
--
-- Rationale: explicit namespacing. The gate_color category is the
-- NPI stage system; the NPI_ prefix removes any ambiguity with
-- other gate-shaped concepts (e.g. project milestone gates) and
-- aligns with upcoming entity_kind='npi_material' lifecycle stages.
--
-- Touches:
--   1. authz_ui_render_token rows (token_key column)
--   2. npi_gate_checklist.gate_phase row values
--
-- Frontend (RenderTokensContext.tsx fallback) is updated in the
-- same commit so behaviour is consistent regardless of API merge.
-- ============================================================

BEGIN;

UPDATE authz_ui_render_token
   SET token_key = 'NPI_' || token_key
 WHERE category  = 'gate_color'
   AND token_key IN ('G0_concept',
                     'G1_feasibility',
                     'G2_dev',
                     'G3_qualification',
                     'G4_mass_production');

UPDATE npi_gate_checklist
   SET gate_phase = 'NPI_' || gate_phase
 WHERE gate_phase IN ('G0_concept',
                      'G1_feasibility',
                      'G2_dev',
                      'G3_qualification',
                      'G4_mass_production');

COMMIT;
