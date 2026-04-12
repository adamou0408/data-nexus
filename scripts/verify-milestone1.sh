#!/bin/bash
# ============================================================
# Milestone 1 Verification Script
# Tests: authz_resolve, authz_check, authz_resolve_web_acl
# ============================================================

set -e

PSQL="docker compose -f deploy/docker-compose/docker-compose.yml exec -T postgres psql -U nexus_admin -d nexus_authz"

echo "=========================================="
echo " Milestone 1 Verification"
echo "=========================================="

echo ""
echo "--- TEST 1: authz_resolve() for PE SSD user ---"
echo ""
$PSQL -c "
SELECT jsonb_pretty(
    authz_resolve('test_pe_ssd', ARRAY['PE_SSD'], '{\"product_line\": \"SSD-Controller\"}'::jsonb)
);
"

echo ""
echo "--- TEST 2: authz_check() permission tests ---"
echo ""
echo "PE reads lot_tracking (expect: true):"
$PSQL -c "SELECT authz_check('test_pe_ssd', ARRAY['PE_SSD'], 'read', 'module:mrp.lot_tracking');"

echo ""
echo "PE reads unit_price (expect: false - denied):"
$PSQL -c "SELECT authz_check('test_pe_ssd', ARRAY['PE_SSD'], 'read', 'column:lot_status.unit_price');"

echo ""
echo "SALES reads unit_price (expect: true):"
$PSQL -c "SELECT authz_check('test_sales', ARRAY['SALES_TW'], 'read', 'column:lot_status.unit_price');"

echo ""
echo "ADMIN reads mrp (expect: true - hierarchy):"
$PSQL -c "SELECT authz_check('test_admin', ARRAY[]::TEXT[], 'read', 'module:mrp.lot_tracking');"

echo ""
echo "--- TEST 3: authz_filter() for PE SSD ---"
echo ""
$PSQL -c "
SELECT authz_filter(
    'test_pe_ssd',
    ARRAY['PE_SSD'],
    '{\"product_line\": \"SSD-Controller\"}'::jsonb,
    'table:lot_status',
    'A'
);
"

echo ""
echo "--- TEST 3b: authz_filter() for Admin (should be TRUE = no filter) ---"
echo ""
$PSQL -c "
SELECT authz_filter(
    'test_admin',
    ARRAY[]::TEXT[],
    '{}'::jsonb,
    'table:lot_status',
    'A'
);
"

echo ""
echo "--- TEST 4: authz_resolve_web_acl() for admin ---"
echo ""
$PSQL -c "
SELECT jsonb_pretty(
    authz_resolve_web_acl('test_admin', ARRAY['AUTHZ_ADMINS'])
);
"

echo ""
echo "--- TEST 5: authz_check_from_cache() ---"
echo ""
$PSQL -c "
WITH resolved AS (
    SELECT authz_resolve('test_pe_ssd', ARRAY['PE_SSD'], '{\"product_line\": \"SSD-Controller\"}'::jsonb) AS config
)
SELECT
    authz_check_from_cache(config, 'read', 'module:mrp.lot_tracking') AS can_read_lot,
    authz_check_from_cache(config, 'write', 'module:mrp.lot_tracking') AS can_write_lot,
    authz_check_from_cache(config, 'read', 'module:mrp.yield_analysis') AS can_read_yield
FROM resolved;
"

echo ""
echo "--- TEST 6: _authz_resolve_roles() ---"
echo ""
echo "Roles for test_pe_ssd with group PE_SSD:"
$PSQL -c "SELECT _authz_resolve_roles('test_pe_ssd', ARRAY['PE_SSD']);"

echo ""
echo "Roles for test_admin (no groups):"
$PSQL -c "SELECT _authz_resolve_roles('test_admin', ARRAY[]::TEXT[]);"

echo ""
echo "--- TEST 7: Schema integrity check ---"
echo ""
$PSQL -c "
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'authz_%'
ORDER BY table_name;
"

echo ""
echo "=========================================="
echo " All tests completed!"
echo "=========================================="
