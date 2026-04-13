-- ============================================================
-- V027: EdgePolicy Fusion — Schema Extensions
-- Absorbs EdgePolicy strengths into Data Nexus:
--   1. Security Clearance (4-tier) on roles
--   2. Data Classification taxonomy for columns
--   3. Policy Assignment table (6 assignment types)
--   4. Admin Audit Log (management ops, separate from data access)
--   5. Clearance Mapping (job_level → clearance)
--   6. Extended mask types (nullify, email, redact)
-- ============================================================

-- 1. Security Clearance ENUM
CREATE TYPE security_clearance AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');

-- 2. Extend authz_role with security_clearance and job_level
ALTER TABLE authz_role
  ADD COLUMN security_clearance security_clearance NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN job_level INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN authz_role.security_clearance IS
  'EdgePolicy-style 4-tier clearance: PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED';
COMMENT ON COLUMN authz_role.job_level IS
  'Numeric job level for ABAC evaluation (higher = more access)';

-- 3. Data Classification table (SSOT for column sensitivity)
CREATE TABLE authz_data_classification (
  classification_id SERIAL PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  sensitivity_level INTEGER NOT NULL,
  description       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO authz_data_classification (name, sensitivity_level, description) VALUES
  ('PUBLIC',       1, 'Public data, no restrictions'),
  ('INTERNAL',     2, 'Internal use only'),
  ('CONFIDENTIAL', 3, 'Confidential, role-restricted access'),
  ('RESTRICTED',   4, 'Highly restricted, need-to-know basis');

-- 4. Index for column classification lookups via authz_resource.attributes
CREATE INDEX idx_resource_classification
  ON authz_resource ((attributes->>'classification_id'))
  WHERE resource_type = 'column' AND attributes->>'classification_id' IS NOT NULL;

-- 5. Policy Assignment table (EdgePolicy-style targeting)
--    Coexists with authz_policy.subject_condition JSONB — evaluator checks both
CREATE TABLE authz_policy_assignment (
  id                SERIAL PRIMARY KEY,
  policy_id         BIGINT NOT NULL REFERENCES authz_policy(policy_id) ON DELETE CASCADE,
  assignment_type   TEXT NOT NULL CHECK (assignment_type IN (
    'role', 'department', 'security_level', 'user', 'job_level_below', 'group'
  )),
  assignment_value  TEXT NOT NULL,
  is_exception      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, assignment_type, assignment_value, is_exception)
);

COMMENT ON TABLE authz_policy_assignment IS
  'EdgePolicy-style policy targeting with 6 assignment types + exception support. Coexists with subject_condition JSONB.';

CREATE INDEX idx_policy_assignment_policy ON authz_policy_assignment (policy_id);

-- 6. Admin Audit Log (management operations, separate from data access audit)
CREATE TABLE authz_admin_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id         TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  details         JSONB DEFAULT '{}',
  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_audit_timestamp ON authz_admin_audit_log (timestamp DESC);
CREATE INDEX idx_admin_audit_user ON authz_admin_audit_log (user_id);
CREATE INDEX idx_admin_audit_action ON authz_admin_audit_log (action);

COMMENT ON TABLE authz_admin_audit_log IS
  'Tracks management UI actions (create/update/delete policies, roles, resources). Separate from data access audit in authz_audit_log.';

-- 7. Clearance Mapping (job_level ranges → security_clearance)
CREATE TABLE authz_clearance_mapping (
  id              SERIAL PRIMARY KEY,
  min_job_level   INTEGER NOT NULL,
  max_job_level   INTEGER NOT NULL,
  clearance       security_clearance NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_job_level <= max_job_level)
);

INSERT INTO authz_clearance_mapping (min_job_level, max_job_level, clearance) VALUES
  (1,  3,  'PUBLIC'),
  (4,  5,  'INTERNAL'),
  (6,  7,  'CONFIDENTIAL'),
  (8,  10, 'RESTRICTED');

-- 8. Extend mask_type ENUM with EdgePolicy mask varieties
ALTER TYPE mask_type ADD VALUE IF NOT EXISTS 'nullify';
ALTER TYPE mask_type ADD VALUE IF NOT EXISTS 'email';
ALTER TYPE mask_type ADD VALUE IF NOT EXISTS 'redact';

-- 9. Register new mask functions
INSERT INTO authz_mask_function (function_name, mask_type, pg_function, description, example_input, example_output, template) VALUES
  ('fn_mask_nullify', 'nullify', 'fn_mask_nullify', 'Replace with NULL',        'anything',      'NULL',          'NULL'),
  ('fn_mask_email',   'email',   'fn_mask_email',   'Mask email (keep domain)', 'john@acme.com', 'j***@acme.com', 'fn_mask_email({col})'),
  ('fn_mask_redact',  'redact',  'fn_mask_redact',  'Replace with [REDACTED]',  'secret data',   '[REDACTED]',    '''[REDACTED]''')
ON CONFLICT (function_name) DO NOTHING;

-- 10. Create PG functions for new mask types
CREATE OR REPLACE FUNCTION fn_mask_nullify(val TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::TEXT $$;

CREATE OR REPLACE FUNCTION fn_mask_email(val TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN val LIKE '%@%' THEN
      LEFT(val, 1) || '***@' || SUBSTRING(val FROM POSITION('@' IN val) + 1)
    ELSE '***'
  END
$$;

CREATE OR REPLACE FUNCTION fn_mask_redact(val TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT '[REDACTED]'::TEXT $$;
