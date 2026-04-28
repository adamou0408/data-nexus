-- ============================================================
-- Data V007: npi_gate_checklist.gate_phase rename to NPI_ prefix
--
-- Companion to migrations/V072 (which renamed gate_color tokens
-- and the vestigial copy on nexus_authz). The authoritative
-- npi_gate_checklist lives on nexus_data — this migration brings
-- existing dev/staging DBs into line with the NPI_G* namespace
-- introduced for V073-V076.
--
-- Idempotent on fresh installs: data/V003 was edited in place to
-- already insert NPI_G* values, so the WHERE filter matches zero
-- rows and the UPDATE no-ops.
-- ============================================================

BEGIN;

UPDATE npi_gate_checklist
   SET gate_phase = 'NPI_' || gate_phase
 WHERE gate_phase IN ('G0_concept',
                      'G1_feasibility',
                      'G2_dev',
                      'G3_qualification',
                      'G4_mass_production');

COMMIT;
