# Domain Expert — Product Management (PM)

> 產品管理部門視角 — 產品策略、NPI 管理、跨部門資料彙整、roadmap

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | PM |
| **LDAP Groups** | PM_SSD, PM_EMMC |
| **系統角色** | PM (Product Manager) |
| **人數規模** | 約 2 個子團隊（SSD/eMMC） |
| **資料敏感度** | 中高 — 需要跨部門彙整資料，包含部分定價資訊 |

## 業務場景

1. **Product Roadmap**：規劃 controller 產品線的發展方向
2. **NPI Gate Review**：主導新產品導入流程，審核各 gate 的達成狀態
3. **Pricing Strategy**：與 Sales 和 Finance 協調產品定價
4. **Cross-functional Reporting**：彙整 PE/QA/Sales/OP 的資料做產品決策
5. **Customer Spec Review**：審核客戶規格需求，決定是否承接

## Data Access Needs

### 需要存取的 Module
- `module:mrp.lot_tracking` — 產品出貨追蹤
- `module:mrp.npi` — NPI gate checklist（主導者）
- `module:mrp.yield_analysis` — yield summary（非 raw data）
- `module:sales.order_mgmt` — 訂單狀態（read-only）
- `module:sales.pricing` — 產品定價（limited access）

### 存取範圍 (L1 ABAC Scope)
```
PM_SSD 可看 product_line = 'SSD' 的完整資料
PM_EMMC 可看 product_line = 'eMMC' 的完整資料
PM 可看所有產品線的 NPI summary（但非 raw test data）
```

### Column Masking (L2)
| 欄位 | 遮罩方式 | 原因 |
|------|---------|------|
| unit_price | visible | PM 需要定價決策 |
| cost | range mask | PM 看成本範圍，不看精確成本 |
| customer | visible | PM 需知道客戶 |
| margin | range mask | PM 看毛利範圍做定價參考 |
| test_raw_data | full mask | PM 不需要原始測試數據 |

## RLS Rules (業務邏輯)

```sql
-- PM 可看自己產品線的完整資料
-- PM 可看其他產品線的 summary/aggregate（但非 row-level detail）
-- NPI checklist 不受產品線限制（PM 是 NPI 主導者）
```

## Pain Points

1. **跨部門資料散落**：需要從 PE、QA、Sales 各自的系統拉資料，沒有統一 dashboard
2. **NPI 追蹤繁瑣**：gate review 目前用 spreadsheet，希望整合到平台
3. **定價資料權限**：PM 需要看 pricing，但不應看到所有客戶的特殊價格
4. **競品資訊**：PM 管理的競品分析資料目前沒有系統化存放

## Metabase BI Needs

- **Dashboard**: 「PM Product Overview」— 各產品線的出貨/良率/訂單 summary
- **Report**: 「NPI Status」— 所有進行中 NPI 的 gate 狀態
- **Report**: 「Product Revenue」— 產品線營收趨勢
- **Cross-reference**: PM 需要在同一頁面看到 PE 的良率 + Sales 的訂單

## Interaction

- **需求提交 to**: Product Owner
- **主導 NPI with**: PE（驗證）、QA（品質）、Sales（客戶需求）
- **定價協調 with**: Sales（市場價格）、Finance（成本/毛利）
- **存取審核 by**: AuthZ Architect（跨產品線 summary 存取）
