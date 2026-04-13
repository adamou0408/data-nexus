# AuthZ Dashboard Testing Guide

## Testing Method

Use the web UI at `http://localhost:5173/` combined with browser F12 DevTools:

- **Network tab**: Watch API calls, verify request/response payloads
- **Console tab**: Check for JavaScript errors
- **Application tab**: Verify no stale data cached

### How to test each user

1. Open http://localhost:5173/
2. Select a user from the sidebar dropdown
3. Observe the Overview page — should show role-appropriate content
4. Navigate through tabs — verify visible/hidden sections
5. In F12 Network tab, filter by `api` to see all backend calls

---

## Permission Matrix by Role

### Legend

| Symbol | Meaning |
|--------|---------|
| R | read allow |
| W | write allow |
| A | approve allow |
| D | deny (explicit) |
| M | masked (via L2 column mask) |
| RLS | row-level filter applied |
| - | no permission (implicit deny) |

### L0 Functional Permissions

| Module / Resource | PE | PM | QA | SALES | FAE | FW | RD | OP | BI | FINANCE | VP | ADMIN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mrp.lot_tracking | RW | R | R | R | R | R | R | R | - | - | R | RW |
| mrp.yield_analysis | R | R | R | - | R | R | R | - | - | - | R | RW |
| mrp.npi | RWA | RA | R | - | - | - | R | - | - | - | R | RW |
| quality | R | R | RW | - | R | - | - | - | - | - | R | RW |
| quality.rma | R | R | RW | - | R | - | - | - | - | - | R | RW |
| sales | - | - | - | R | - | - | - | - | - | - | R | RW |
| sales.order_mgmt | - | R | - | W | R | - | - | - | - | R | R | RW |
| sales.pricing | - | R | - | - | - | - | - | - | - | RW | R | RW |
| sales.customer | - | - | - | W | - | - | - | - | - | - | R | RW |
| engineering | R | - | R | - | R | R | R | - | - | - | R | RW |
| engineering.firmware | R | - | R | - | R | RW | R | - | - | - | R | RW |
| analytics | - | - | - | - | - | - | - | - | RW | R | R | RW |
| analytics.dashboard | R | R | R | R | R | - | - | - | RW | R | R | RW |

### Column-Level Access

| Column | PE | PM | QA | SALES | FAE | FW | OP | BI | FINANCE | VP | ADMIN |
|--------|----|----|----|----|----|----|----|----|---------|----|----|
| lot_status.unit_price | D | - | D | R(allow) | M(range) | - | D | M(hash) | - | R | R |
| lot_status.cost | D | - | - | - | D | - | - | - | - | R | R |
| lot_status.customer | R | - | - | - | - | - | D | - | - | - | - |
| price_book.margin | D | - | - | - | D | - | - | D | - | R | R |

### L1 RLS Policies (Row Filtering)

| Policy | Applies To | Condition | Affected Table |
|--------|-----------|-----------|---------------|
| pe_ssd_data_scope | PE + product_line=SSD | `product_line = 'SSD'` | lot_status, wip_inventory |
| pe_emmc_data_scope | PE + product_line=eMMC | `product_line = 'eMMC'` | lot_status |
| pe_sd_data_scope | PE + product_line=SD | `product_line = 'SD'` | lot_status |
| pm_ssd_data_scope | PM + product_line=SSD | `product_line = 'SSD'` | lot_status |
| pm_emmc_data_scope | PM + product_line=eMMC | `product_line = 'eMMC'` | lot_status |
| op_ssd_data_scope | OP + product_line=SSD | `product_line = 'SSD'` | lot_status |
| fw_ssd_data_scope | FW + product_line=SSD | `product_line = 'SSD'` | lot_status |
| sales_tw_region | SALES + region=TW | `region = 'TW'` | sales_order |
| sales_cn_region | SALES + region=CN | `region = 'CN'` | sales_order |
| sales_us_region | SALES + region=US | `region = 'US'` | sales_order |
| fae_tw_region | FAE + region=TW | `region = 'TW'` | sales_order |
| fae_cn_region | FAE + region=CN | `region = 'CN'` | sales_order |

### L2 Column Masks

| Policy | Column | Mask Function | Effect |
|--------|--------|---------------|--------|
| pe_column_masks | lot_status.unit_price | fn_mask_range | 12.50 → "10-15" |
| pe_column_masks | lot_status.cost | fn_mask_full | 6.80 → "****" |
| op_column_masks | lot_status.cost | fn_mask_full | "****" |
| qa_column_masks | lot_status.unit_price | fn_mask_range | "10-15" |
| fae_column_masks | lot_status.unit_price | fn_mask_range | "10-15" |
| bi_column_masks | price_book.margin | fn_mask_hash | hash value |

> Note: L0 deny overrides L2 mask. If a role has `deny` on a column, the mask is not applied — the column shows `[DENIED]`.

---

## Test Scenarios

### Test 1: wang_pe (PE-SSD)

**Expected Behavior:**
- **Overview**: No admin stats, 4 Quick Actions (Resolver, Matrix, Tables, Workbench)
- **Roles**: `PE`
- **L0**: Can read MRP, Quality, Engineering; Can write lot_tracking, NPI; Can approve NPI
- **RLS on lot_status**: Only SSD rows (8 of 21)
- **Column**: unit_price=DENIED, cost=DENIED, customer=visible

**F12 Verification:**
1. Login → Network: `POST /api/resolve` → check `resolved_roles: ["PE"]`
2. Go to Data Workbench → `POST /api/rls/simulate` with `table=lot_status`
   - `filter_clause` should be `(product_line = 'SSD')`
   - `filtered_count: 8, total_count: 21`
   - `column_masks.cost: "DENIED"`, `column_masks.unit_price: "DENIED"`
3. Go to Permission Checker → batch check → unit_price=DENY, cost=DENY, customer=ALLOW

### Test 2: lee_sales (Sales-TW)

**Expected Behavior:**
- **Roles**: `SALES`
- **L0**: Can read lot_tracking, sales module; Can write orders + customer
- **RLS on sales_order**: Only TW rows (4 of 15)
- **Column**: unit_price=ALLOW (explicit), cost=no perm, margin=no perm

**F12 Verification:**
1. Login → `resolved_roles: ["SALES"]`
2. RLS Simulator → select sales_order table
   - `filter_clause` should contain `region = 'TW'`
   - Should see ORD-TW-001 through ORD-TW-004 only
3. Compare with smith_sales (Sales-US) → should see ORD-US-* only

### Test 3: huang_qa (QA)

**Expected Behavior:**
- **Roles**: `QA`
- **L0**: Full read MRP + Quality + Engineering; Can write Quality
- **RLS**: None (QA sees all product lines)
- **Column**: unit_price=DENIED (L0 deny overrides L2 mask)

**F12 Verification:**
1. Login → `resolved_roles: ["QA"]`
2. Data Workbench → lot_status → should see ALL 21 rows (no RLS filter)
3. unit_price column should show `[DENIED]` or be hidden
4. Check batch → `read:column:lot_status.unit_price` = DENY

### Test 4: chang_vp (VP)

**Expected Behavior:**
- **Roles**: `VP`
- **L0**: Read ALL top-level modules (mrp, quality, sales, engineering, analytics)
- **Column**: unit_price=ALLOW, cost=ALLOW, margin=ALLOW (VP sees everything)
- **RLS**: None
- **No write access** to any module

**F12 Verification:**
1. Login → `resolved_roles: ["VP"]`
2. Data Workbench → lot_status → all 21 rows, unit_price visible, cost visible
3. Permission Checker → `write:module:mrp` = DENY (VP is read-only)

### Test 5: sys_admin (Admin)

**Expected Behavior:**
- **Roles**: `ADMIN`, `AUTHZ_ADMIN`, `DBA`
- **L0**: Full read+write ALL modules + column access
- **RLS**: None
- **UI**: Admin stats, 6 Quick Actions, Three Paths, admin-only tabs visible

**F12 Verification:**
1. Login → `resolved_roles: ["ADMIN","AUTHZ_ADMIN","DBA"]`
2. Overview → should show stat cards (Subjects/Roles/Resources/Policies counts)
3. Entity Browser → should have Add/Edit/Delete buttons
4. All tabs visible including admin-only ones (Pool, Audit, etc.)

### Test 6: tsai_bi (BI Analyst)

**Expected Behavior:**
- **Roles**: `BI_USER`
- **L0**: Only analytics module (read+write)
- **Column**: price_book.margin=DENIED
- **RLS**: None
- **Very limited access** — most tabs/modules should be invisible or show no data

**F12 Verification:**
1. Login → `resolved_roles: ["BI_USER"]`
2. Permission Checker → `read:module:mrp.lot_tracking` = DENY
3. Data Workbench → lot_status → should show all rows (no RLS) but check column access

### Test 7: RLS Side-by-Side Comparison

**In RLS Simulator tab:**
1. Select `lot_status` table
2. User A: `wang_pe` (PE-SSD) — expects 8 rows, only SSD
3. User B: `chen_pe` (PE-eMMC) — expects 5 rows, only eMMC
4. Compare: different product_lines, same column masks

### Test 8: Cross-region Sales Comparison

**In RLS Simulator tab:**
1. Select `sales_order` table
2. User A: `lee_sales` (TW) — expects 4 rows, TW region
3. User B: `zhang_sales` (CN) — expects 4 rows, CN region
4. Compare: completely different order sets

### Test 9: Entity CRUD (Admin Only)

1. Login as `sys_admin`
2. Go to Entity Browser → Subjects
3. Click Add → create test subject `user:test_crud`
4. Expand the new subject → assign role `PE`
5. Click Edit → update display name
6. Click Delete → should soft-deactivate
7. Verify in F12 Network tab that POST/PUT/DELETE calls succeed

### Test 10: Dynamic Tables Verification

1. RLS Simulator → should show ALL 8 business tables (not just 2)
2. Data Workbench → table dropdown should list all tables
3. Permission Checker → batch checks should show 50+ items (from DB)
4. F12: `GET /api/browse/tables` → 8 tables
5. F12: `GET /api/browse/batch-checks` → 50+ checks

---

## F12 Key API Endpoints to Monitor

| Endpoint | Method | Triggered By | What to Check |
|----------|--------|-------------|---------------|
| `/api/resolve` | POST | User login | resolved_roles, L0_functional, L1_data_scope, L2_column_masks |
| `/api/check` | POST | Single permission check | `allowed: true/false` |
| `/api/check/batch` | POST | Batch check tab | Array of allowed/denied |
| `/api/rls/simulate` | POST | RLS Simulator / Workbench | filter_clause, filtered_count, column_masks |
| `/api/browse/subjects/profiles` | GET | Page load | User list from DB |
| `/api/browse/batch-checks` | GET | Check tab load | Dynamic test cases |
| `/api/browse/tables` | GET | RLS/Workbench tab load | All business tables |
| `/api/browse/resources` | GET | Entity Browser | All resources |
| `/api/matrix` | GET | Permission Matrix | Role × Resource × Action grid |

## Common Issues

1. **"getaddrinfo ENOTFOUND postgres"**: Data source host is set to Docker service name. Fix: Update `ds:local` host to `localhost` via Pool Management → Data Sources.
2. **Column shows [DENIED] when mask expected**: L0 deny overrides L2 mask. Check `authz_role_permission` for explicit deny entries.
3. **RLS returns all rows**: User has no matching L1 policy, or policy subject_condition doesn't match user attributes.
4. **User dropdown empty**: Backend `/api/browse/subjects/profiles` failed. Check API server is running and DB is accessible.
