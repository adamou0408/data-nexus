-- Teardown for AC-0.1 verification setup. Constitution-compliant — removes
-- all agent-created _test_ rows before session end.
DELETE FROM authz_role_permission
  WHERE role_id = 'AUTHZ_ADMIN' AND action_id = 'read' AND resource_id = 'table:lot_status';
DELETE FROM authz_ui_page WHERE page_id = 'test_audit_smoke';
DELETE FROM authz_resource WHERE resource_id = 'table:lot_status';
DELETE FROM authz_data_source WHERE source_id = 'ds:_test_p0d_audit';
