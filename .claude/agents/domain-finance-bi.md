# Domain Expert — Finance & Business Intelligence

> 財務暨商業智慧部門視角 — 成本分析、毛利管控、BI 報表、資料分析

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | FINANCE + BI |
| **LDAP Groups** | FINANCE_TEAM, BI_TEAM |
| **系統角色** | FINANCE, BI_USER (BI Analyst) |
| **人數規模** | 2 個團隊 |
| **資料敏感度** | 最高 — Finance 擁有成本和毛利的完整存取 |

## 業務場景

### Finance
1. **Cost Analysis**：產品成本結構分析（材料、製造、測試）
2. **Margin Management**：毛利率管控和異常預警
3. **Pricing Approval**：特殊報價的財務可行性審核
4. **Revenue Reporting**：營收報表（月/季/年）
5. **Budget Control**：部門預算管控

### BI
1. **Dashboard Development**：為各部門建立 Metabase dashboard
2. **Ad-hoc Analysis**：臨時性資料分析需求
3. **Cross-department Reporting**：跨部門彙整報表
4. **Data Quality Monitoring**：資料品質監控和異常偵測
5. **KPI Tracking**：關鍵績效指標追蹤

## Data Access Needs

### Finance 需要存取的 Module
- `module:sales.pricing` — 完整定價資料（含成本、毛利）
- `module:sales.order_mgmt` — 訂單和營收
- `module:mrp.lot_tracking` — 生產成本分攤

### BI 需要存取的 Module
- **所有 module**（read-only）— BI 需要跨部門資料做分析
- 但受 column masking 限制（BI 看 hash 而非原始值）

### 存取範圍 (L1 ABAC Scope)
```
FINANCE_TEAM: 不受區域/產品線限制（需要全局財務視角）
BI_TEAM: 不受區域/產品線限制（需要全局分析視角）
  但 BI 的某些敏感欄位被 hash mask（可做統計但不能看原始值）
```

### Column Masking (L2)
| 欄位 | Finance | BI | 原因 |
|------|---------|-----|------|
| unit_price | visible | hash mask | Finance 需要原始值；BI 用 hash 做分群 |
| cost | visible | hash mask | Finance 核心資料；BI 不需原始值 |
| margin | visible | hash mask | Finance 核心資料；BI 做趨勢分析 |
| customer | visible | visible | 兩者都需要 |
| design_data | full mask | full mask | 兩者都不需要 |
| firmware | full mask | full mask | 兩者都不需要 |

## RLS Rules (業務邏輯)

```sql
-- Finance: 不受區域/產品線 RLS 限制
-- 但 Finance 不能看技術資料（design_data, firmware, test_program）
CREATE POLICY finance_access ON sales_order
  FOR SELECT TO pool_finance_readonly
  USING (true); -- 全部可見

-- BI: 跨所有業務資料（read-only），但敏感值被 hash
-- BI 的 pool profile 用 column-level masking functions
```

## Security Concerns

1. **Finance 是成本/毛利的唯一完整存取者**
   - Finance 帳號被入侵 = 全公司財務機密外洩
   - 建議：MFA、session timeout 30 min、IP 白名單
2. **BI 的跨部門存取風險**
   - BI 能看到所有部門的資料（雖然有 mask）
   - 建議：BI 的 Metabase 帳號定期 review
3. **報表分享風險**
   - Metabase dashboard 可被分享，需確保不會外洩到無權限使用者

## Pain Points

### Finance
1. **月結報表工時長**：從多個系統彙整資料做月報，目前 3+ 天
2. **成本分攤不即時**：生產成本需等 ERP 結帳才知道
3. **特殊報價審核慢**：業務提特殊價格，Finance 審核需要查歷史定價
4. **匯率影響分析**：多幣別報價需要即時匯率資料

### BI
1. **新 dashboard 開發週期長**：從需求到上線需 2+ 週
2. **資料來源分散**：需要連接多個 DB/系統
3. **權限設定複雜**：每個 dashboard 需要針對不同角色設定存取權限
4. **Self-service 需求**：各部門希望自己做報表，但受限於 SQL 能力

## Metabase BI Needs (BI team 負責建立和維護)

- **Executive Dashboard**: VP 等級的全公司 KPI 總覽
- **Finance Dashboard**: 營收/成本/毛利 monthly trend
- **Department Dashboards**: 為各部門客製的 dashboard
- **Data Quality Dashboard**: 資料完整性和時效性監控
- **Self-service**: 提供 curated datasets 讓各部門自行查詢

## Interaction

- **需求提交 to**: Product Owner
- **定價協調 with**: Sales（特殊報價）、PM（產品定價策略）
- **成本資料 from**: OP（生產成本）、SCM（材料成本）
- **報表需求 from**: 所有部門（BI 服務全公司）
- **安全審核 by**: DBA Guardian（Finance pool profile 需特殊安全設定）
