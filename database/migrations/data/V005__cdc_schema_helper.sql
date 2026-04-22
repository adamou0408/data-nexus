-- ============================================================
-- data/V005: CDC Schema Helper
-- Provides a function to create CDC target schemas in nexus_data
-- with proper ownership and default privileges for pool roles.
-- Called by authz-api during Oracle data source registration.
-- ============================================================

CREATE OR REPLACE FUNCTION _nexus_create_cdc_schema(
  p_schema_name TEXT,
  p_owner       TEXT DEFAULT current_user
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Create schema owned by the specified user (default: nexus_admin)
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', p_schema_name, p_owner);

  -- Ensure nexus_admin has full access for discovery and grant sync
  EXECUTE format('GRANT ALL ON SCHEMA %I TO %I', p_schema_name, p_owner);

  -- Future tables created by CDC in this schema auto-grant SELECT to nexus_admin
  -- (pool roles get USAGE+SELECT via syncExternalGrants at deploy time)
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO %I',
    p_schema_name, p_owner
  );
END;
$$;

COMMENT ON FUNCTION _nexus_create_cdc_schema(TEXT, TEXT)
  IS 'Creates a CDC target schema in nexus_data with proper grants. Called during Oracle data source registration.';
