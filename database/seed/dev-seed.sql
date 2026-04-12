-- ============================================================
-- Phison Electronics — Development Seed Data
-- Realistic test personas, resources, permissions, and ABAC policies
-- ============================================================

-- ============================================================
-- 1. LDAP Groups (simulating Phison AD groups)
-- ============================================================
INSERT INTO authz_subject (subject_id, subject_type, display_name, attributes) VALUES
    -- PE groups by product line
    ('group:PE_SSD',      'ldap_group', 'PE - SSD Controller Team',   '{"product_line": "SSD", "site": "HQ", "dept": "PE"}'),
    ('group:PE_EMMC',     'ldap_group', 'PE - eMMC/UFS Team',         '{"product_line": "eMMC", "site": "HQ", "dept": "PE"}'),
    ('group:PE_SD',       'ldap_group', 'PE - SD Controller Team',    '{"product_line": "SD", "site": "HQ", "dept": "PE"}'),
    -- PM groups by product line
    ('group:PM_SSD',      'ldap_group', 'PM - SSD Product Mgmt',      '{"product_line": "SSD", "dept": "PM"}'),
    ('group:PM_EMMC',     'ldap_group', 'PM - eMMC Product Mgmt',     '{"product_line": "eMMC", "dept": "PM"}'),
    -- QA (cross product line)
    ('group:QA_ALL',      'ldap_group', 'QA - All Products',          '{"dept": "QA"}'),
    -- Sales by region
    ('group:SALES_TW',    'ldap_group', 'Sales - Taiwan / HQ',        '{"region": "TW", "dept": "SALES"}'),
    ('group:SALES_CN',    'ldap_group', 'Sales - China',              '{"region": "CN", "dept": "SALES"}'),
    ('group:SALES_US',    'ldap_group', 'Sales - US / Europe',        '{"region": "US", "dept": "SALES"}'),
    -- FAE by region
    ('group:FAE_TW',      'ldap_group', 'FAE - Taiwan',               '{"region": "TW", "dept": "FAE"}'),
    ('group:FAE_CN',      'ldap_group', 'FAE - China',                '{"region": "CN", "dept": "FAE"}'),
    -- R&D
    ('group:RD_FW',       'ldap_group', 'R&D - Firmware Team',        '{"dept": "RD", "sub_dept": "FW"}'),
    ('group:RD_IC',       'ldap_group', 'R&D - IC Design Team',       '{"dept": "RD", "sub_dept": "IC"}'),
    -- Support groups
    ('group:BI_TEAM',     'ldap_group', 'BI / Data Analytics Team',   '{"dept": "BI"}'),
    ('group:DBA_TEAM',    'ldap_group', 'DBA Team',                   '{"dept": "IT"}'),
    ('group:FINANCE_TEAM','ldap_group', 'Finance Department',         '{"dept": "FINANCE"}'),
    ('group:VP_OFFICE',   'ldap_group', 'VP / Executive Office',      '{"dept": "EXEC"}'),
    ('group:OP_SSD',      'ldap_group', 'OP - SSD Production Line',   '{"product_line": "SSD", "site": "HQ", "dept": "OP"}');

-- ============================================================
-- 2. Test Users (simulating Phison employees)
-- ============================================================
INSERT INTO authz_subject (subject_id, subject_type, display_name, attributes) VALUES
    ('user:wang_pe',      'user', 'Wang (PE-SSD)',        '{"product_line": "SSD", "site": "HQ", "employee_id": "P2024001"}'),
    ('user:chen_pe',      'user', 'Chen (PE-eMMC)',       '{"product_line": "eMMC", "site": "HQ", "employee_id": "P2024002"}'),
    ('user:su_pe',        'user', 'Su (PE-SD)',           '{"product_line": "SD", "site": "HQ", "employee_id": "P2024003"}'),
    ('user:lin_pm',       'user', 'Lin (PM-SSD)',         '{"product_line": "SSD", "employee_id": "P2024010"}'),
    ('user:kuo_pm',       'user', 'Kuo (PM-eMMC)',        '{"product_line": "eMMC", "employee_id": "P2024011"}'),
    ('user:huang_qa',     'user', 'Huang (QA)',           '{"employee_id": "P2024020"}'),
    ('user:lee_sales',    'user', 'Lee (Sales-TW)',       '{"region": "TW", "employee_id": "P2024030"}'),
    ('user:zhang_sales',  'user', 'Zhang (Sales-CN)',     '{"region": "CN", "employee_id": "P2024031"}'),
    ('user:smith_sales',  'user', 'Smith (Sales-US)',     '{"region": "US", "employee_id": "P2024032"}'),
    ('user:wu_fae',       'user', 'Wu (FAE-TW)',          '{"region": "TW", "employee_id": "P2024040"}'),
    ('user:zhou_fae',     'user', 'Zhou (FAE-CN)',        '{"region": "CN", "employee_id": "P2024041"}'),
    ('user:liu_fw',       'user', 'Liu (FW Engineer)',    '{"product_line": "SSD", "employee_id": "P2024050"}'),
    ('user:tseng_rd',     'user', 'Tseng (IC Design)',    '{"employee_id": "P2024051"}'),
    ('user:hsu_op',       'user', 'Hsu (OP-SSD Line)',    '{"product_line": "SSD", "site": "HQ", "employee_id": "P2024060"}'),
    ('user:tsai_bi',      'user', 'Tsai (BI Analyst)',    '{"employee_id": "P2024070"}'),
    ('user:yang_finance', 'user', 'Yang (Finance)',       '{"employee_id": "P2024080"}'),
    ('user:chang_vp',     'user', 'Chang (VP)',           '{"employee_id": "P2024090"}'),
    ('user:sys_admin',    'user', 'SysAdmin',             '{"employee_id": "P2024099"}'),
    ('svc:etl_pipeline',  'service_account', 'ETL Pipeline', '{"service": "data-pipeline"}');

-- ============================================================
-- 3. Role Assignments
-- ============================================================
INSERT INTO authz_subject_role (subject_id, role_id, granted_by) VALUES
    -- PE engineers
    ('user:wang_pe',      'PE',          'ldap_sync'),
    ('user:chen_pe',      'PE',          'ldap_sync'),
    ('user:su_pe',        'PE',          'ldap_sync'),
    -- PM managers
    ('user:lin_pm',       'PM',          'ldap_sync'),
    ('user:kuo_pm',       'PM',          'ldap_sync'),
    -- QA
    ('user:huang_qa',     'QA',          'ldap_sync'),
    -- Sales
    ('user:lee_sales',    'SALES',       'ldap_sync'),
    ('user:zhang_sales',  'SALES',       'ldap_sync'),
    ('user:smith_sales',  'SALES',       'ldap_sync'),
    -- FAE
    ('user:wu_fae',       'FAE',         'ldap_sync'),
    ('user:zhou_fae',     'FAE',         'ldap_sync'),
    -- R&D / FW
    ('user:liu_fw',       'FW',          'ldap_sync'),
    ('user:liu_fw',       'RD',          'ldap_sync'),
    ('user:tseng_rd',     'RD',          'ldap_sync'),
    -- OP
    ('user:hsu_op',       'OP',          'ldap_sync'),
    -- BI
    ('user:tsai_bi',      'BI_USER',     'ldap_sync'),
    -- Finance
    ('user:yang_finance', 'FINANCE',     'ldap_sync'),
    -- VP (executive access)
    ('user:chang_vp',     'VP',          'ldap_sync'),
    -- Admin
    ('user:sys_admin',    'ADMIN',       'ldap_sync'),
    ('user:sys_admin',    'AUTHZ_ADMIN', 'ldap_sync'),
    -- Service account
    ('svc:etl_pipeline',  'ETL_SVC',     'system'),
    -- Group-level assignments
    ('group:PE_SSD',      'PE',          'ldap_sync'),
    ('group:PE_EMMC',     'PE',          'ldap_sync'),
    ('group:PE_SD',       'PE',          'ldap_sync'),
    ('group:PM_SSD',      'PM',          'ldap_sync'),
    ('group:PM_EMMC',     'PM',          'ldap_sync'),
    ('group:QA_ALL',      'QA',          'ldap_sync'),
    ('group:SALES_TW',    'SALES',       'ldap_sync'),
    ('group:SALES_CN',    'SALES',       'ldap_sync'),
    ('group:SALES_US',    'SALES',       'ldap_sync'),
    ('group:FAE_TW',      'FAE',         'ldap_sync'),
    ('group:FAE_CN',      'FAE',         'ldap_sync'),
    ('group:RD_FW',       'FW',          'ldap_sync'),
    ('group:RD_FW',       'RD',          'ldap_sync'),
    ('group:RD_IC',       'RD',          'ldap_sync'),
    ('group:BI_TEAM',     'BI_USER',     'ldap_sync'),
    ('group:DBA_TEAM',    'DBA',         'ldap_sync'),
    ('group:FINANCE_TEAM','FINANCE',     'ldap_sync'),
    ('group:VP_OFFICE',   'VP',          'ldap_sync'),
    ('group:OP_SSD',      'OP',          'ldap_sync');

-- ============================================================
-- 4. Resources (Phison data center module hierarchy)
-- ============================================================
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name) VALUES
    -- MRP System
    ('module:mrp',                      'module', NULL,                          'MRP System'),
    ('module:mrp.lot_tracking',         'module', 'module:mrp',                 'Lot Tracking / WIP'),
    ('table:lot_status',                'table',  'module:mrp.lot_tracking',    'Lot Status Table'),
    ('column:lot_status.unit_price',    'column', 'table:lot_status',           'Unit Price'),
    ('column:lot_status.customer',      'column', 'table:lot_status',           'Customer'),
    ('column:lot_status.cost',          'column', 'table:lot_status',           'Cost (internal)'),
    ('table:wip_inventory',             'table',  'module:mrp.lot_tracking',    'WIP Inventory'),
    ('module:mrp.yield_analysis',       'module', 'module:mrp',                 'Yield Analysis'),
    ('table:cp_ft_result',              'table',  'module:mrp.yield_analysis',  'CP/FT Test Results'),
    ('module:mrp.npi',                  'module', 'module:mrp',                 'NPI Gate Review'),
    ('table:npi_gate_checklist',        'table',  'module:mrp.npi',             'NPI Gate Checklist'),

    -- Quality System
    ('module:quality',                  'module', NULL,                          'Quality System'),
    ('module:quality.reliability',      'module', 'module:quality',             'Reliability Testing'),
    ('table:reliability_report',        'table',  'module:quality.reliability', 'Reliability Reports'),
    ('module:quality.rma',              'module', 'module:quality',             'RMA Management'),
    ('table:rma_record',                'table',  'module:quality.rma',         'RMA Records'),
    ('module:quality.failure_analysis', 'module', 'module:quality',             'Failure Analysis'),

    -- Sales System
    ('module:sales',                    'module', NULL,                          'Sales System'),
    ('module:sales.order_mgmt',         'module', 'module:sales',               'Order Management'),
    ('table:sales_order',               'table',  'module:sales.order_mgmt',    'Sales Orders'),
    ('module:sales.pricing',            'module', 'module:sales',               'Pricing Management'),
    ('table:price_book',                'table',  'module:sales.pricing',       'Price Book'),
    ('column:price_book.margin',        'column', 'table:price_book',           'Margin (confidential)'),
    ('module:sales.customer',           'module', 'module:sales',               'Customer Management'),

    -- Engineering System
    ('module:engineering',              'module', NULL,                          'Engineering System'),
    ('module:engineering.firmware',     'module', 'module:engineering',          'Firmware Repository'),
    ('module:engineering.test_program', 'module', 'module:engineering',          'Test Programs'),
    ('module:engineering.design_data',  'module', 'module:engineering',          'Design Data (restricted)'),

    -- Analytics
    ('module:analytics',                'module', NULL,                          'Analytics & BI'),
    ('module:analytics.dashboard',      'module', 'module:analytics',           'BI Dashboards'),
    ('module:analytics.reports',        'module', 'module:analytics',           'Reports'),

    -- Web pages (Path B)
    ('web_page:home',                   'web_page', NULL,                        'Homepage'),
    ('web_page:admin_dashboard',        'web_page', NULL,                        'Admin Dashboard'),
    ('web_page:authz_admin',            'web_page', NULL,                        'AuthZ Admin Panel');

-- Set homepage as public
UPDATE authz_resource SET attributes = '{"auth_required": false}' WHERE resource_id = 'web_page:home';

-- ============================================================
-- 5. L0 Permissions (Role × Action × Resource)
-- ============================================================
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    -- ═══ PE: Product Engineer ═══
    ('PE', 'read',    'module:mrp.lot_tracking',        'allow'),
    ('PE', 'write',   'module:mrp.lot_tracking',        'allow'),
    ('PE', 'read',    'module:mrp.yield_analysis',      'allow'),
    ('PE', 'read',    'module:mrp.npi',                 'allow'),
    ('PE', 'write',   'module:mrp.npi',                 'allow'),
    ('PE', 'approve', 'module:mrp.npi',                 'allow'),
    ('PE', 'read',    'module:quality',                 'allow'),
    ('PE', 'read',    'module:engineering',             'allow'),
    ('PE', 'read',    'module:analytics.dashboard',     'allow'),
    ('PE', 'hold',    'table:lot_status',               'allow'),
    ('PE', 'release', 'table:lot_status',               'allow'),
    -- PE column denials
    ('PE', 'read',    'column:lot_status.unit_price',   'deny'),
    ('PE', 'read',    'column:lot_status.cost',         'deny'),
    ('PE', 'read',    'column:price_book.margin',       'deny'),

    -- ═══ PM: Product Manager ═══
    ('PM', 'read',    'module:mrp.lot_tracking',        'allow'),
    ('PM', 'read',    'module:mrp.yield_analysis',      'allow'),
    ('PM', 'read',    'module:mrp.npi',                 'allow'),
    ('PM', 'approve', 'module:mrp.npi',                 'allow'),
    ('PM', 'read',    'module:quality',                 'allow'),
    ('PM', 'read',    'module:sales.order_mgmt',        'allow'),
    ('PM', 'read',    'module:sales.pricing',           'allow'),
    ('PM', 'read',    'module:analytics.dashboard',     'allow'),

    -- ═══ OP: Operator ═══
    ('OP', 'read',    'module:mrp.lot_tracking',        'allow'),
    -- OP column denials
    ('OP', 'read',    'column:lot_status.unit_price',   'deny'),
    ('OP', 'read',    'column:lot_status.customer',     'deny'),

    -- ═══ QA: Quality Assurance ═══
    ('QA', 'read',    'module:mrp.lot_tracking',        'allow'),
    ('QA', 'read',    'module:mrp.yield_analysis',      'allow'),
    ('QA', 'read',    'module:mrp.npi',                 'allow'),
    ('QA', 'read',    'module:quality',                 'allow'),
    ('QA', 'write',   'module:quality',                 'allow'),
    ('QA', 'read',    'module:engineering',             'allow'),
    ('QA', 'read',    'module:analytics.dashboard',     'allow'),
    -- QA column denial
    ('QA', 'read',    'column:lot_status.unit_price',   'deny'),

    -- ═══ SALES: Sales ═══
    ('SALES', 'read',  'module:mrp.lot_tracking',       'allow'),
    ('SALES', 'read',  'module:sales',                  'allow'),
    ('SALES', 'write', 'module:sales.order_mgmt',       'allow'),
    ('SALES', 'write', 'module:sales.customer',         'allow'),
    ('SALES', 'read',  'module:analytics.dashboard',    'allow'),
    ('SALES', 'read',  'column:lot_status.unit_price',  'allow'),

    -- ═══ FAE: Field Application Engineer ═══
    ('FAE', 'read',   'module:mrp.lot_tracking',        'allow'),
    ('FAE', 'read',   'module:mrp.yield_analysis',      'allow'),
    ('FAE', 'read',   'module:quality',                 'allow'),
    ('FAE', 'read',   'module:sales.order_mgmt',        'allow'),
    ('FAE', 'read',   'module:engineering',             'allow'),
    ('FAE', 'read',   'module:analytics.dashboard',     'allow'),
    -- FAE column denials
    ('FAE', 'read',   'column:lot_status.cost',         'deny'),
    ('FAE', 'read',   'column:price_book.margin',       'deny'),

    -- ═══ RD: R&D Engineer ═══
    ('RD', 'read',    'module:mrp.lot_tracking',        'allow'),
    ('RD', 'read',    'module:mrp.yield_analysis',      'allow'),
    ('RD', 'read',    'module:mrp.npi',                 'allow'),
    ('RD', 'read',    'module:engineering',             'allow'),
    ('RD', 'write',   'module:engineering',             'allow'),

    -- ═══ FW: Firmware Engineer ═══
    ('FW', 'read',    'module:mrp.lot_tracking',        'allow'),
    ('FW', 'read',    'module:mrp.yield_analysis',      'allow'),
    ('FW', 'read',    'module:engineering',             'allow'),
    ('FW', 'write',   'module:engineering.firmware',     'allow'),
    ('FW', 'write',   'module:engineering.test_program', 'allow'),

    -- ═══ FINANCE: Finance ═══
    ('FINANCE', 'read',  'module:sales.order_mgmt',     'allow'),
    ('FINANCE', 'read',  'module:sales.pricing',        'allow'),
    ('FINANCE', 'write', 'module:sales.pricing',        'allow'),
    ('FINANCE', 'read',  'module:analytics',            'allow'),

    -- ═══ VP: Executive ═══
    ('VP', 'read',    'module:mrp',                     'allow'),
    ('VP', 'read',    'module:quality',                 'allow'),
    ('VP', 'read',    'module:sales',                   'allow'),
    ('VP', 'read',    'module:engineering',             'allow'),
    ('VP', 'read',    'module:analytics',               'allow'),
    ('VP', 'read',    'column:lot_status.unit_price',   'allow'),
    ('VP', 'read',    'column:lot_status.cost',         'allow'),
    ('VP', 'read',    'column:price_book.margin',       'allow'),

    -- ═══ BI_USER: BI Analyst ═══
    ('BI_USER', 'read',  'module:analytics',            'allow'),
    ('BI_USER', 'write', 'module:analytics',            'allow'),
    -- BI column denial
    ('BI_USER', 'read',  'column:price_book.margin',    'deny'),

    -- ═══ ADMIN: System Admin (full access via top-level modules) ═══
    ('ADMIN', 'read',  'module:mrp',                    'allow'),
    ('ADMIN', 'write', 'module:mrp',                    'allow'),
    ('ADMIN', 'read',  'module:quality',                'allow'),
    ('ADMIN', 'write', 'module:quality',                'allow'),
    ('ADMIN', 'read',  'module:sales',                  'allow'),
    ('ADMIN', 'write', 'module:sales',                  'allow'),
    ('ADMIN', 'read',  'module:engineering',            'allow'),
    ('ADMIN', 'write', 'module:engineering',            'allow'),
    ('ADMIN', 'read',  'module:analytics',              'allow'),
    ('ADMIN', 'write', 'module:analytics',              'allow'),
    ('ADMIN', 'read',  'column:lot_status.unit_price',  'allow'),
    ('ADMIN', 'read',  'column:lot_status.cost',        'allow'),
    ('ADMIN', 'read',  'column:price_book.margin',      'allow'),
    -- Admin web pages
    ('ADMIN', 'read',  'web_page:admin_dashboard',      'allow'),
    ('ADMIN', 'write', 'web_page:admin_dashboard',      'allow'),

    -- ═══ AUTHZ_ADMIN: AuthZ Admin ═══
    ('AUTHZ_ADMIN', 'read',  'web_page:authz_admin',    'allow'),
    ('AUTHZ_ADMIN', 'write', 'web_page:authz_admin',    'allow'),

    -- ═══ ETL_SVC: ETL Service Account ═══
    ('ETL_SVC', 'read',  'module:mrp',                  'allow'),
    ('ETL_SVC', 'write', 'module:mrp',                  'allow'),
    ('ETL_SVC', 'read',  'module:quality',              'allow'),
    ('ETL_SVC', 'write', 'module:quality',              'allow');

-- ============================================================
-- 6. L1 ABAC Policies (data scope by product_line / region)
-- ============================================================
INSERT INTO authz_policy (
    policy_name, description, granularity, effect, status,
    applicable_paths, subject_condition, resource_condition,
    rls_expression, created_by
) VALUES
-- PE scoped by product_line
('pe_ssd_data_scope',
 'PE SSD engineers can only see SSD product line data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["PE"], "product_line": ["SSD"]}',
 '{"resource_type": "table", "data_domain": ["lot", "yield", "npi"]}',
 'product_line = ''SSD''',
 'system'),

('pe_emmc_data_scope',
 'PE eMMC engineers can only see eMMC product line data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["PE"], "product_line": ["eMMC"]}',
 '{"resource_type": "table", "data_domain": ["lot", "yield", "npi"]}',
 'product_line = ''eMMC''',
 'system'),

('pe_sd_data_scope',
 'PE SD engineers can only see SD product line data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["PE"], "product_line": ["SD"]}',
 '{"resource_type": "table", "data_domain": ["lot", "yield", "npi"]}',
 'product_line = ''SD''',
 'system'),

-- PM scoped by product_line
('pm_ssd_data_scope',
 'PM SSD managers can only see SSD product line data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["PM"], "product_line": ["SSD"]}',
 '{"resource_type": "table", "data_domain": ["lot", "yield", "npi"]}',
 'product_line = ''SSD''',
 'system'),

('pm_emmc_data_scope',
 'PM eMMC managers can only see eMMC product line data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["PM"], "product_line": ["eMMC"]}',
 '{"resource_type": "table", "data_domain": ["lot", "yield", "npi"]}',
 'product_line = ''eMMC''',
 'system'),

-- OP scoped by product_line
('op_ssd_data_scope',
 'SSD line operators can only see SSD lot data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["OP"], "product_line": ["SSD"]}',
 '{"resource_type": "table", "data_domain": ["lot"]}',
 'product_line = ''SSD''',
 'system'),

-- FW scoped by product_line
('fw_ssd_data_scope',
 'SSD firmware engineers can only see SSD data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["FW"], "product_line": ["SSD"]}',
 '{"resource_type": "table", "data_domain": ["lot", "yield"]}',
 'product_line = ''SSD''',
 'system'),

-- SALES scoped by region
('sales_tw_region',
 'Taiwan sales can only see TW region orders',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["SALES"], "region": ["TW"]}',
 '{"resource_type": "table", "data_domain": ["order"]}',
 'region = ''TW''',
 'system'),

('sales_cn_region',
 'China sales can only see CN region orders',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["SALES"], "region": ["CN"]}',
 '{"resource_type": "table", "data_domain": ["order"]}',
 'region = ''CN''',
 'system'),

('sales_us_region',
 'US/EU sales can only see US region orders',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["SALES"], "region": ["US"]}',
 '{"resource_type": "table", "data_domain": ["order"]}',
 'region = ''US''',
 'system'),

-- FAE scoped by region
('fae_tw_region',
 'Taiwan FAE can only see TW region customer data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["FAE"], "region": ["TW"]}',
 '{"resource_type": "table", "data_domain": ["order"]}',
 'region = ''TW''',
 'system'),

('fae_cn_region',
 'China FAE can only see CN region customer data',
 'L1_data_domain', 'allow', 'active', '{A,B,C}',
 '{"role": ["FAE"], "region": ["CN"]}',
 '{"resource_type": "table", "data_domain": ["order"]}',
 'region = ''CN''',
 'system');

-- NOTE: QA, VP, FINANCE, BI_USER have NO L1 policies → they see all data (TRUE)

-- ============================================================
-- 6b. AUTHZ_ADMINS group + web_api resources
-- ============================================================
INSERT INTO authz_subject (subject_id, subject_type, display_name, attributes) VALUES
    ('group:AUTHZ_ADMINS', 'ldap_group', 'AuthZ Administrators', '{"dept": "IT"}');

INSERT INTO authz_subject_role (subject_id, role_id, granted_by) VALUES
    ('group:AUTHZ_ADMINS', 'AUTHZ_ADMIN', 'ldap_sync'),
    ('group:AUTHZ_ADMINS', 'ADMIN',       'ldap_sync');

-- Web API resources (Path B)
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name) VALUES
    ('web_api:resolve',         'web_api', 'web_page:home',           'Resolve API'),
    ('web_api:check',           'web_api', 'web_page:home',           'Check API'),
    ('web_api:filter',          'web_api', 'web_page:home',           'Filter API'),
    ('web_api:matrix',          'web_api', 'web_page:admin_dashboard','Permission Matrix API'),
    ('web_api:pool_manage',     'web_api', 'web_page:admin_dashboard','Pool Management API'),
    ('web_api:audit_log',       'web_api', 'web_page:admin_dashboard','Audit Log API');

-- API permissions
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    -- All authenticated users can call resolve/check/filter
    ('PE',          'read', 'web_api:resolve', 'allow'),
    ('PM',          'read', 'web_api:resolve', 'allow'),
    ('OP',          'read', 'web_api:resolve', 'allow'),
    ('QA',          'read', 'web_api:resolve', 'allow'),
    ('SALES',       'read', 'web_api:resolve', 'allow'),
    ('FAE',         'read', 'web_api:resolve', 'allow'),
    ('RD',          'read', 'web_api:resolve', 'allow'),
    ('FW',          'read', 'web_api:resolve', 'allow'),
    ('FINANCE',     'read', 'web_api:resolve', 'allow'),
    ('VP',          'read', 'web_api:resolve', 'allow'),
    ('BI_USER',     'read', 'web_api:resolve', 'allow'),
    ('ADMIN',       'read', 'web_api:resolve', 'allow'),
    ('AUTHZ_ADMIN', 'read', 'web_api:resolve', 'allow'),
    -- Admin-only APIs
    ('ADMIN',       'read',  'web_api:matrix',      'allow'),
    ('ADMIN',       'write', 'web_api:matrix',      'allow'),
    ('ADMIN',       'read',  'web_api:pool_manage',  'allow'),
    ('ADMIN',       'write', 'web_api:pool_manage',  'allow'),
    ('ADMIN',       'read',  'web_api:audit_log',    'allow'),
    ('AUTHZ_ADMIN', 'read',  'web_api:matrix',      'allow'),
    ('AUTHZ_ADMIN', 'write', 'web_api:matrix',      'allow'),
    ('AUTHZ_ADMIN', 'read',  'web_api:pool_manage',  'allow'),
    ('AUTHZ_ADMIN', 'write', 'web_api:pool_manage',  'allow'),
    ('AUTHZ_ADMIN', 'read',  'web_api:audit_log',    'allow');

-- ============================================================
-- 7. L3 Composite Actions (approval workflows)
-- ============================================================
INSERT INTO authz_composite_action (
    policy_name, description, target_action, target_resource,
    approval_chain, preconditions, status
) VALUES
('lot_hold_approval',
 'Lot hold requires PE approval',
 'hold', 'table:lot_status',
 '[{"step": 1, "required_role": "PE", "min_approvers": 1}]',
 '{"phase": "!shipped"}',
 'active'),

('lot_release_approval',
 'Lot release requires PE + QA dual approval',
 'release', 'table:lot_status',
 '[{"step": 1, "required_role": "PE", "min_approvers": 1}, {"step": 2, "required_role": "QA", "min_approvers": 1}]',
 '{"status": "hold"}',
 'active'),

('npi_gate_approval',
 'NPI gate advancement requires PM + PE approval',
 'approve', 'table:npi_gate_checklist',
 '[{"step": 1, "required_role": "PE", "min_approvers": 1}, {"step": 2, "required_role": "PM", "min_approvers": 1}]',
 '{}',
 'active');

-- ============================================================
-- 8. Path C: DB Connection Pool Profiles, Assignments, Credentials
-- ============================================================

-- Pool profiles (different access levels for different roles)
INSERT INTO authz_db_pool_profile (
    profile_id, pg_role, allowed_schemas, allowed_tables,
    denied_columns, connection_mode, max_connections,
    rls_applies, description
) VALUES
('pool:pe_readonly',
 'nexus_pe_ro', '{public}',
 '{lot_status,wip_inventory,cp_ft_result,npi_gate_checklist}',
 '{"lot_status": ["unit_price", "cost"]}',
 'readonly', 10, TRUE,
 'PE engineers — read-only on MRP tables, price/cost columns denied'),

('pool:sales_readonly',
 'nexus_sales_ro', '{public}',
 '{lot_status,sales_order,price_book}',
 '{"price_book": ["margin"]}',
 'readonly', 10, TRUE,
 'Sales team — read-only on lot + sales tables, margin denied'),

('pool:bi_readonly',
 'nexus_bi_ro', '{public}',
 NULL,
 '{"price_book": ["margin"]}',
 'readonly', 20, TRUE,
 'BI analysts — read-only on all tables, margin denied'),

('pool:etl_readwrite',
 'nexus_etl_rw', '{public}',
 '{lot_status,wip_inventory,cp_ft_result,reliability_report,rma_record}',
 NULL,
 'readwrite', 5, FALSE,
 'ETL service account — read/write on MRP+Quality tables, no RLS'),

('pool:admin_full',
 'nexus_admin_full', '{public}',
 NULL, NULL,
 'admin', 3, FALSE,
 'DBA/Admin — full access, no RLS');

-- Pool assignments (who can use which pool)
INSERT INTO authz_db_pool_assignment (subject_id, profile_id, granted_by) VALUES
    ('group:PE_SSD',      'pool:pe_readonly',     'system'),
    ('group:PE_EMMC',     'pool:pe_readonly',     'system'),
    ('group:PE_SD',       'pool:pe_readonly',     'system'),
    ('group:SALES_TW',    'pool:sales_readonly',  'system'),
    ('group:SALES_CN',    'pool:sales_readonly',  'system'),
    ('group:SALES_US',    'pool:sales_readonly',  'system'),
    ('group:BI_TEAM',     'pool:bi_readonly',     'system'),
    ('svc:etl_pipeline',  'pool:etl_readwrite',   'system'),
    ('user:sys_admin',    'pool:admin_full',      'system'),
    ('group:DBA_TEAM',    'pool:admin_full',      'system');

-- Pool credentials (dev passwords — hashed with md5 for pgbouncer compatibility)
INSERT INTO authz_pool_credentials (pg_role, password_hash) VALUES
    ('nexus_pe_ro',       'md5' || md5('dev_pe_pass'      || 'nexus_pe_ro')),
    ('nexus_sales_ro',    'md5' || md5('dev_sales_pass'    || 'nexus_sales_ro')),
    ('nexus_bi_ro',       'md5' || md5('dev_bi_pass'       || 'nexus_bi_ro')),
    ('nexus_etl_rw',      'md5' || md5('dev_etl_pass'      || 'nexus_etl_rw')),
    ('nexus_admin_full',  'md5' || md5('dev_admin_pass'    || 'nexus_admin_full'));
