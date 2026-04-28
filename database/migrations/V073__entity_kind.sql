-- ============================================================
-- V073: authz_entity_kind primitive
--
-- Adds a Tier B–curatable registry of "entity kinds" — semantic
-- classifications layered on top of authz_resource.resource_type.
--
--   resource_type (Tier A, code-defined enum):  what KIND of thing
--     this resource is from a permission-routing standpoint
--     (module, page, table, column, ...).
--
--   entity_kind (Tier B, SQL-curatable):        what BUSINESS
--     concept this resource models (e.g. 'npi_material',
--     'workflow_request', 'lifecycle_state'). Lets the platform
--     attach lifecycles, workflows, and views to a class of
--     resources without code change.
--
-- First consumer: NPI gate sign-off dogfood (V075). Adds
-- entity_kind='npi_material' so the lifecycle / workflow
-- primitives in V074/V075 can target it.
--
-- Hot-path note: authz_resource.entity_kind is NOT read inside
-- authz_check / authz_resolve. It's metadata for the discovery /
-- catalog / workflow layer — kept off the permission hot path.
-- ============================================================

BEGIN;

CREATE TABLE authz_entity_kind (
    entity_kind   TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  authz_entity_kind IS
    'Tier B-curatable registry of business entity kinds. Distinct from authz_resource.resource_type (Tier A enum). Names a business concept (e.g. ''npi_material'') so lifecycle/workflow/view primitives can target a class of resources by SQL.';

ALTER TABLE authz_resource
    ADD COLUMN IF NOT EXISTS entity_kind TEXT
        REFERENCES authz_entity_kind(entity_kind);

COMMENT ON COLUMN authz_resource.entity_kind IS
    'Optional Tier B classifier. Lifecycle/workflow primitives target resources by entity_kind. NOT read by authz_check / authz_resolve — keep off permission hot path.';

-- Partial index: only the resources actually opted into a kind.
-- Query shape: "list all resources of kind X" (catalog / workflow).
CREATE INDEX idx_authz_resource_entity_kind
    ON authz_resource (entity_kind)
 WHERE entity_kind IS NOT NULL;

COMMIT;
