-- ============================================================
-- V001: ENUM Types for Authorization Service
-- ============================================================

CREATE TYPE authz_effect AS ENUM ('allow', 'deny');
CREATE TYPE authz_granularity AS ENUM ('L0_functional', 'L1_data_domain', 'L2_row_column', 'L3_action');
CREATE TYPE mask_type AS ENUM ('none', 'full', 'partial', 'hash', 'range', 'custom');
CREATE TYPE policy_status AS ENUM ('active', 'inactive', 'pending_review');
CREATE TYPE sync_status AS ENUM ('pending', 'synced', 'failed', 'rollback');
CREATE TYPE db_connection_mode AS ENUM ('readonly', 'readwrite', 'admin');
