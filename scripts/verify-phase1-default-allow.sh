#!/bin/bash
# ============================================================
# Phase 1 default-allow regression — AC-X.1
# (.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md)
#
# 12-cell matrix: Path A/B/C × default=deny/allow × explicit deny presence,
# plus L1/L2/L3 semantic regression (V060 incidentally repaired V008-era
# bugs in authz_resolve — these checks lock that in).
#
# Strategy: flip ds:local default_l0_policy in-place, run assertions,
# always restore to 'deny' before exit (trap).
# ============================================================

set -e

PSQL="docker compose -f deploy/docker-compose/docker-compose.yml exec -T postgres psql -U nexus_admin -d nexus_authz"

PASS=0
FAIL=0
FAIL_LOG=()

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "  ✓ $label  [expected=$expected, got=$actual]"
        PASS=$((PASS+1))
    else
        echo "  ✗ $label  [expected=$expected, got=$actual]"
        FAIL=$((FAIL+1))
        FAIL_LOG+=("$label  expected=$expected got=$actual")
    fi
}

flip() {
    $PSQL -tAc "UPDATE authz_data_source SET default_l0_policy='$1' WHERE source_id='ds:local'" >/dev/null
}

restore() {
    flip 'deny' || true
    # Drain any lingering pg_default_acl rows from this run
    $PSQL -tAc "SELECT count(*) FROM authz_sync_db_grants() WHERE FALSE" >/dev/null 2>&1 || true
    echo ""
    echo "── Cleanup: ds:local restored to 'deny', pg_default_acl drained ──"
}
trap restore EXIT

check() {
    # $1 = bare user_id (no 'user:' prefix; helper adds it),
    # $2 = bare group name (no 'group:' prefix; helper adds it),
    # $3 = action, $4 = resource
    $PSQL -tAc "SELECT authz_check('$1', ARRAY['$2'], '$3', '$4');" | tr -d ' '
}

echo "=========================================="
echo " Phase 1 default-allow — AC-X.1 regression"
echo "=========================================="

# ── BASELINE ──
flip 'deny'
echo ""
echo "── BASELINE: ds:local default_l0_policy = 'deny' ──"

# Path B + default=deny
echo ""
echo "── Path B × default=deny ──"
assert_eq "B1 PE→table:sales_order (no rule, deny mode)"        "f"  "$(check wang_pe PE_SSD read table:sales_order)"
assert_eq "B2 PE→column:lot_status.cost (explicit deny)"        "f"  "$(check wang_pe PE_SSD read column:lot_status.cost)"
assert_eq "B3 PE→module:mrp.lot_tracking (L1 allow)"            "t"  "$(check wang_pe PE_SSD read module:mrp.lot_tracking)"

# ── FLIP TO ALLOW ──
flip 'allow'
echo ""
echo "── ds:local default_l0_policy → 'allow' ──"

echo ""
echo "── Path B × default=allow ──"
assert_eq "B4 PE→table:sales_order (no rule, allow mode)"       "t"  "$(check wang_pe PE_SSD read table:sales_order)"
assert_eq "B5 PE→column:lot_status.cost (deny-wins, SEC-02)"    "f"  "$(check wang_pe PE_SSD read column:lot_status.cost)"
assert_eq "B6 PE→module:mrp.lot_tracking (no DS, legacy allow)" "t"  "$(check wang_pe PE_SSD read module:mrp.lot_tracking)"

# ── B7: V064 — approved authz_policy(effect='deny') enforces in allow branch ──
# Models the AC-1.5 approval loop: engine writes pending_review → operator
# approves (status='active') → authz_check must return FALSE.
# Target: table:sales_order (B4 baseline = allow). Cleanup is unconditional.
B7_POLICY="_test_p1_b7_deny_sales_order"
$PSQL -tAc "DELETE FROM authz_policy WHERE policy_name='$B7_POLICY'" >/dev/null
$PSQL -tAc "INSERT INTO authz_policy
    (policy_name, description, granularity, priority, effect, status,
     applicable_paths, subject_condition, resource_condition,
     action_condition, environment_condition, created_by)
   VALUES
    ('$B7_POLICY', 'B7 verify cell — approved deny suggestion (V064)',
     'L0_functional', 200, 'deny', 'active',
     '{A,B,C}',
     '{\"role\": [\"PE\"]}'::jsonb,
     '{\"resource_ids\": [\"table:sales_order\"]}'::jsonb,
     '{}'::jsonb, '{}'::jsonb,
     'verify-phase1.sh')" >/dev/null
assert_eq "B7 V064 approved policy(effect=deny) enforces in allow branch"  "f"  "$(check wang_pe PE_SSD read table:sales_order)"
$PSQL -tAc "DELETE FROM authz_policy WHERE policy_name='$B7_POLICY'" >/dev/null

# ── Path A — authz_resolve_web_acl is NOT inverted (plan §3.2). ──
# Frontend reads default_l0_policy directly; cache stays SSOT-faithful.
# We assert here that the function is callable & returns a JSONB envelope
# in BOTH modes (i.e. no regression from V060), and document the gap.
echo ""
echo "── Path A × {deny, allow} — cache deliberately NOT inverted (§3.2) ──"
flip 'deny'
A_DENY=$($PSQL -tAc "SELECT (authz_resolve_web_acl('wang_pe', ARRAY['PE_SSD']) ? 'access_path');" | tr -d ' ')
flip 'allow'
A_ALLOW=$($PSQL -tAc "SELECT (authz_resolve_web_acl('wang_pe', ARRAY['PE_SSD']) ? 'access_path');" | tr -d ' ')
assert_eq "A1 web_acl callable in deny mode"                    "t"  "$A_DENY"
assert_eq "A2 web_acl callable in allow mode"                   "t"  "$A_ALLOW"
echo "  ⓘ Path A inversion is a frontend responsibility (plan §3.2)."

# ── Path C — sync_db_grants symmetric ALTER DEFAULT PRIVILEGES ──
echo ""
echo "── Path C × {deny, allow} — pg_default_acl symmetry ──"
flip 'allow'
$PSQL -tAc "SELECT count(*) FROM (SELECT * FROM authz_sync_db_grants()) s" >/dev/null
ACL_ALLOW=$($PSQL -tAc "SELECT count(*) FROM pg_default_acl;" | tr -d ' ')
assert_eq "C1 pg_default_acl rows after allow-sync (3 = tables/funcs/seqs)"  "3"  "$ACL_ALLOW"

flip 'deny'
$PSQL -tAc "SELECT count(*) FROM (SELECT * FROM authz_sync_db_grants()) s" >/dev/null
ACL_DENY=$($PSQL -tAc "SELECT count(*) FROM pg_default_acl;" | tr -d ' ')
assert_eq "C2 pg_default_acl rows after deny-sync (rollback drains)"        "0"  "$ACL_DENY"

# ── L1/L2/L3 semantic regression (V060 incidentally fixed V008 bugs) ──
echo ""
echo "── L1/L2/L3 semantic regression on authz_resolve() ──"
RESOLVE=$($PSQL -tAc "SELECT authz_resolve('wang_pe', ARRAY['PE_SSD'], '{\"product_line\": \"SSD-Controller\"}'::jsonb);")
L1_HAS_MODULE=$(echo "$RESOLVE" | grep -c 'module:mrp.lot_tracking' || true)
L3_HAS_KEY=$(echo "$RESOLVE" | grep -c 'L3_actions' || true)
assert_eq "L1 resolve includes mrp.lot_tracking"                "1"  "$L1_HAS_MODULE"
assert_eq "L3 resolve envelope has L3_actions key"              "1"  "$L3_HAS_KEY"

# L2 row filter should produce a SQL expression for PE on lot_status (per V024 RLS)
L2_FILTER=$($PSQL -tAc "SELECT length(authz_filter('wang_pe', ARRAY['PE_SSD'], '{\"product_line\": \"SSD-Controller\"}'::jsonb, 'table:lot_status', 'A')) > 0;" | tr -d ' ')
assert_eq "L2 row filter returns non-empty expression"          "t"  "$L2_FILTER"

# ── Summary ──
echo ""
echo "=========================================="
echo " RESULT: $PASS passed, $FAIL failed"
echo "=========================================="
if [ $FAIL -gt 0 ]; then
    printf '%s\n' "${FAIL_LOG[@]}"
    exit 1
fi
