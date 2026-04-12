-- ============================================================
-- V013: Base Seed Data - Roles & Actions
-- Aligned with Phison Electronics organization structure
-- ============================================================

-- Core roles (Phison org)
INSERT INTO authz_role (role_id, display_name, description, is_system) VALUES
    ('PE',          'Product Engineer',         'Product engineering - lot tracking, yield, NPI',        FALSE),
    ('PM',          'Product Manager',          'Product management - specs, roadmap, pricing review',   FALSE),
    ('OP',          'Operator',                 'Production line operator - WIP, lot status',            FALSE),
    ('QA',          'Quality Assurance',        'Quality engineering - reliability, RMA, failure analysis', FALSE),
    ('SALES',       'Sales',                    'Sales team - orders, pricing, customer management',     FALSE),
    ('FAE',         'Field Application Engineer','Customer-facing technical support',                    FALSE),
    ('RD',          'R&D Engineer',             'IC design and architecture',                            FALSE),
    ('FW',          'Firmware Engineer',        'Firmware development and test programs',                FALSE),
    ('FINANCE',     'Finance',                  'Finance team - cost analysis, margin, pricing approval',FALSE),
    ('VP',          'Vice President',           'Executive - full read across all modules',              FALSE),
    ('ADMIN',       'System Administrator',     'IT system administrator',                              TRUE),
    ('BI_USER',     'BI Analyst',              'Business intelligence and reporting',                    FALSE),
    ('ETL_SVC',     'ETL Service',             'ETL pipeline service account',                          TRUE),
    ('DBA',         'Database Administrator',   'Database operations',                                  TRUE),
    ('AUTHZ_ADMIN', 'AuthZ Administrator',      'Authorization service administrator',                  TRUE),
    ('AUTHZ_AUDITOR','AuthZ Auditor',           'Authorization audit viewer',                           TRUE);
