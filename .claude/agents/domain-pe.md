# Domain Expert — Product Engineering (PE)

> 產品工程部門視角 — SSD/eMMC/SD controller 開發、lot tracking、yield analysis、NPI

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | PE |
| **LDAP Groups** | PE_SSD, PE_EMMC, PE_SD |
| **系統角色** | PE (Product Engineer) |
| **人數規模** | 約 3 個子團隊（SSD/eMMC/SD） |
| **資料敏感度** | 高 — 良率數據為公司核心機密 |

## 業務場景

1. **Lot Tracking**：追蹤晶圓、封裝、測試各階段的 lot 狀態
2. **Yield Analysis**：分析 CP/FT 測試良率，找出 failure pattern
3. **NPI (New Product Introduction)**：新產品導入的 gate review checklist
4. **Product Characterization**：controller 效能驗證和 qualification

## Data Access Needs

### 需要存取的 Module
- `module:mrp.lot_tracking` — lot_status, WIP inventory
- `module:mrp.yield_analysis` — cp_ft_result, yield metrics
- `module:mrp.npi` — npi_gate_checklist

### 存取範圍 (L1 ABAC Scope)
```
PE_SSD 只能看 product_line = 'SSD' 的資料
PE_EMMC 只能看 product_line = 'eMMC' 的資料
PE_SD 只能看 product_line = 'SD' 的資料
```

跨產品線資料需要特殊申請（由 PM 或 VP 核准）。

### Column Masking (L2)
| 欄位 | 遮罩方式 | 原因 |
|------|---------|------|
| unit_price | range mask | PE 不需要精確價格 |
| cost | full mask | 成本為財務機密 |
| customer | visible | PE 需知道客戶以做 qualification |
| margin | full mask | 毛利率為財務機密 |

## RLS Rules (業務邏輯)

```sql
-- PE 只能看自己產品線的 lot_status
CREATE POLICY pe_lot_access ON lot_status
  FOR SELECT TO pool_pe_readonly
  USING (product_line = current_setting('app.product_line'));

-- PE 可以看所有產品線的 NPI checklist（跨產品線學習）
-- 但 yield data 只限自己產品線
```

## Pain Points (目前痛點)

1. **良率資料延遲**：目前從 ERP 手動匯出，希望透過 CDC 即時同步
2. **跨產品線比較**：SSD team 想看 eMMC 的 yield trend（目前被 RLS 擋住）
3. **NPI gate 審核**：需要 PM + QA + PE 三方同時看到 checklist，但各自看到不同細節
4. **測試程式碼存取**：test program 在 RD 的 module 下，PE 需要 read-only 存取

## Metabase BI Needs

- **Dashboard**: 「PE Daily」— 今日 lot status summary by product line
- **Report**: 「Yield Trend」— 週/月良率趨勢（CP + FT）
- **Alert**: 良率低於門檻值時通知（需要 Metabase alert 功能）

## Interaction

- **需求提交 to**: Product Owner
- **資料爭議 with**: RD（test program 存取）、QA（failure analysis 共享）
- **權限審核 by**: AuthZ Architect（跨產品線存取）
