-- V031: Make connector_password optional for trust/cert/pgpass auth methods
ALTER TABLE authz_data_source ALTER COLUMN connector_password DROP NOT NULL;
