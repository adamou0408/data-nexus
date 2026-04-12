-- ============================================================
-- V003: ABAC Policy Tables (L1 + L2 + L3)
-- ============================================================

-- ABAC POLICIES: attribute-based rules
CREATE TABLE authz_policy (
    policy_id       BIGSERIAL PRIMARY KEY,
    policy_name     TEXT NOT NULL UNIQUE,
    description     TEXT,
    granularity     authz_granularity NOT NULL,
    priority        INTEGER NOT NULL DEFAULT 100,
    effect          authz_effect NOT NULL DEFAULT 'allow',
    status          policy_status NOT NULL DEFAULT 'active',
    applicable_paths TEXT[] NOT NULL DEFAULT '{A,B,C}',
    subject_condition   JSONB NOT NULL DEFAULT '{}',
    resource_condition  JSONB NOT NULL DEFAULT '{}',
    action_condition    JSONB NOT NULL DEFAULT '{}',
    environment_condition JSONB NOT NULL DEFAULT '{}',
    rls_expression      TEXT,
    column_mask_rules   JSONB,
    created_by      TEXT NOT NULL,
    approved_by     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until TIMESTAMPTZ
);

-- COMPOSITE ACTION POLICIES (L3: dual-sign, workflow-gate)
CREATE TABLE authz_composite_action (
    id              BIGSERIAL PRIMARY KEY,
    policy_name     TEXT NOT NULL UNIQUE,
    description     TEXT,
    target_action   TEXT NOT NULL REFERENCES authz_action(action_id),
    target_resource TEXT NOT NULL REFERENCES authz_resource(resource_id),
    approval_chain  JSONB NOT NULL,
    preconditions   JSONB NOT NULL DEFAULT '{}',
    timeout_hours   INTEGER DEFAULT 72,
    status          policy_status NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- COLUMN MASKING FUNCTIONS REGISTRY
CREATE TABLE authz_mask_function (
    function_name   TEXT PRIMARY KEY,
    mask_type       mask_type NOT NULL,
    pg_function     TEXT NOT NULL,
    description     TEXT,
    example_input   TEXT,
    example_output  TEXT,
    template        TEXT NOT NULL
);

INSERT INTO authz_mask_function VALUES
    ('fn_mask_full',    'full',    'fn_mask_full',    'Replace with ****',        'John Doe',      '****',        'fn_mask_full({col})'),
    ('fn_mask_partial', 'partial', 'fn_mask_partial', 'Show first/last chars',    'john@acme.com', 'j***@***e.com','fn_mask_partial({col})'),
    ('fn_mask_hash',    'hash',    'fn_mask_hash',    'SHA256 hash',              'John Doe',      'a8cfcd74...', 'fn_mask_hash({col})'),
    ('fn_mask_range',   'range',   'fn_mask_range',   'Numeric to range bucket',  '42.50',         '40-50',       'fn_mask_range({col})'),
    ('fn_mask_null',    'full',    'fn_mask_null',    'Replace with NULL',        'anything',      NULL,          'NULL');
