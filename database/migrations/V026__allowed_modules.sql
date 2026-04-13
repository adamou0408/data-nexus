-- V026: Add allowed_modules to pool profiles for metadata-driven table resolution
-- When populated, sync logic expands module resource_ids into child tables
-- via authz_resource hierarchy. Union with allowed_tables (both additive).

ALTER TABLE authz_db_pool_profile ADD COLUMN allowed_modules TEXT[];

COMMENT ON COLUMN authz_db_pool_profile.allowed_modules IS
  'Module resource_ids (e.g. module:tiptop_reports); sync expands to child tables via resource hierarchy. Union with allowed_tables.';
