-- Temporary AC-0.1 verification setup. Cleaned up by _p0d_teardown.sql.
INSERT INTO authz_data_source (
  source_id, display_name, description, db_type, host, port,
  database_name, schemas, connector_user, connector_password,
  registered_by, is_active
) VALUES (
  'ds:_test_p0d_audit', 'P0-D AC-0.1 verification source',
  'Agent test data — cleaned up before session end',
  'postgresql', 'localhost', 5432, 'nexus_data', '{public}',
  'nexus_admin', 'nexus_dev_password', 'executor_session', true
);

INSERT INTO authz_resource (
  resource_id, resource_type, display_name, attributes
) VALUES (
  'table:lot_status', 'table', 'Lot Status (test binding)',
  '{"data_source_id":"ds:_test_p0d_audit"}'::jsonb
);

INSERT INTO authz_ui_page (
  page_id, title, layout, resource_id, data_table, row_limit, is_active
) VALUES (
  'test_audit_smoke', 'P0-D Audit Smoke', 'table',
  'table:lot_status', 'lot_status', 10, true
);
