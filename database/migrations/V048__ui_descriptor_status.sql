-- ============================================================
-- V048 — UI descriptor lifecycle status (BU-08 schema-driven UI POC)
--
-- Adds status tracking so we can distinguish hand-seeded descriptors
-- (status='manual') from schema-introspected ones (status='derived'),
-- which Phase 4 override editor will consume.
--
-- Design: docs/design-schema-driven-ui.md §5
-- Migration is backward-compatible: all existing rows default to 'manual'.
-- ============================================================

ALTER TABLE authz_ui_descriptor
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'manual'
    CHECK (status IN ('manual', 'derived', 'overridden', 'hybrid'));

ALTER TABLE authz_ui_descriptor
  ADD COLUMN IF NOT EXISTS derived_at TIMESTAMPTZ;

ALTER TABLE authz_ui_descriptor
  ADD COLUMN IF NOT EXISTS derived_from JSONB;

COMMENT ON COLUMN authz_ui_descriptor.status IS
  'manual = hand-seeded; derived = schema introspector output; overridden = admin edited a derived row; hybrid = derived baseline + override layer (Phase 4)';

COMMENT ON COLUMN authz_ui_descriptor.derived_at IS
  'When the introspector last (re)generated this row. NULL for status=manual.';

COMMENT ON COLUMN authz_ui_descriptor.derived_from IS
  'Provenance: { source_id, schema, table_name, schema_hash } so we can detect upstream drift.';

-- Index for "show me everything generated from source X" admin queries
CREATE INDEX IF NOT EXISTS idx_authz_ui_descriptor_derived_source
  ON authz_ui_descriptor ((derived_from->>'source_id'))
  WHERE status IN ('derived', 'overridden', 'hybrid');
