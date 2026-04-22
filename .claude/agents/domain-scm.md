# Domain Expert — Supply Chain Management (SCM)

> 供應鏈/料件管理部門視角 — BOM 管理、庫存追蹤、供應商管理、Tiptop ERP 整合

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | SCM (Supply Chain Management) |
| **LDAP Groups** | 尚未在 seed data 中定義（需新增） |
| **系統角色** | 尚未定義（需新增 SCM 角色） |
| **人數規模** | 預估 1-2 個團隊（採購 + 倉管） |
| **資料敏感度** | 中高 — 供應商報價和庫存數量為商業敏感資訊 |

## 業務場景

1. **BOM Management**：產品物料清單管理（NAND, DRAM, PCB, connector 等）
2. **Inventory Tracking**：原物料和成品庫存追蹤
3. **Supplier Management**：供應商資料、報價、交期管理
4. **Purchase Order**：採購單建立和追蹤
5. **Material Requirement Planning**：根據生產排程計算物料需求
6. **Tiptop ERP Integration**：與鼎新 Tiptop ERP 的庫存/採購模組整合

## Data Access Needs

### 需要存取的 Module
- `module:tiptop_inventory` — 庫存主檔（核心）
- `module:tiptop_approval` — 採購核准流程
- `module:tiptop_reports` — ERP 報表
- `module:mrp.lot_tracking` — 生產用料追蹤（read-only）

### Tiptop ERP Tables (from pg_k8cluster scenario)
- Inventory master tables
- Purchase order tables
- BOM structure tables
- Supplier master tables

### 存取範圍 (L1 ABAC Scope)
```
SCM_PROCUREMENT: 採購相關資料（供應商報價、PO、交期）
SCM_WAREHOUSE: 倉庫/庫存相關（庫存數量、進出貨記錄）
兩者分開：倉管不應看到採購價格，採購不需看倉位明細
```

### Column Masking (L2)
| 欄位 | 採購 | 倉管 | 原因 |
|------|------|------|------|
| supplier_price | visible | full mask | 採購核心；倉管不需知價格 |
| inventory_qty | visible | visible | 兩者都需要 |
| warehouse_location | partial mask | visible | 採購不需倉位細節 |
| supplier_contact | visible | full mask | 採購管理供應商 |
| cost_breakdown | visible | full mask | 成本結構為採購機密 |

## RLS Rules (業務邏輯)

```sql
-- 採購只看自己負責的 commodity group
-- (NAND 採購只看 NAND 相關供應商和 PO)
CREATE POLICY scm_commodity_access ON purchase_order
  FOR SELECT TO pool_scm_readonly
  USING (commodity_group = current_setting('app.commodity'));

-- 倉管看所有庫存但不看價格欄位
```

## Pain Points

1. **ERP 資料延遲**：Tiptop ERP 的庫存資料不即時，需要 CDC 同步
2. **跨系統 BOM**：BOM 在 ERP，但工程變更在 PE 系統，兩邊不同步
3. **供應商資料管控**：供應商報價不應被其他部門（尤其 Sales）看到
4. **安全庫存預警**：庫存低於安全水位時沒有自動通知
5. **多供應商比價**：同一料件的多家供應商報價需要在同一畫面比較

## Tiptop ERP Integration Notes

群聯使用鼎新 Tiptop ERP，SCM 的主要資料來源：

- **CDC Path**: Tiptop DB (可能是 Oracle 或 SQL Server) → CDC → nexus_data.tiptop_* schema
- **Module Mapping**: tiptop_inventory, tiptop_approval, tiptop_reports, tiptop_views, tiptop_config
- **Pool Profile**: `pool:tiptop_readonly` 已在 seed data 中定義（pg_k8cluster scenario）
- **注意**：Tiptop 資料結構由 ERP 廠商定義，欄位命名可能與 Data Nexus 慣例不同

## Metabase BI Needs

- **Dashboard**: 「SCM Inventory」— 各倉庫庫存水位、安全庫存 vs 實際
- **Report**: 「Supplier Performance」— 供應商交期達成率、品質 pass rate
- **Alert**: 安全庫存低於門檻通知
- **Report**: 「Material Cost Trend」— 主要料件價格趨勢

## 需要新增的系統設定

由於 SCM 尚未在 seed data 中完整定義，需要：

1. **LDAP Groups**: `SCM_PROCUREMENT`, `SCM_WAREHOUSE`
2. **System Role**: `SCM` (Supply Chain)
3. **Pool Profile**: `pool:scm_procurement_readonly`, `pool:scm_warehouse_readonly`
4. **Module**: `module:scm` parent + child modules

## Interaction

- **需求提交 to**: Product Owner
- **庫存資料 to**: OP（生產排程用料）、Finance（成本結算）
- **供應商品質 with**: QA（incoming QC 結果）
- **BOM 變更 from**: PE（engineering change）、RD（design change）
- **ERP 整合 with**: IT/DBA（CDC 設定）、Backend Engineer（API 串接）
