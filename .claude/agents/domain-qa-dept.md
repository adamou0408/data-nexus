# Domain Expert — Quality Assurance Department (QA)

> 品保部門視角 — 可靠性測試、RMA 管理、failure analysis、品質稽核

**注意**：此角色代表群聯品保部門的業務需求，與技術團隊的 QA Engineer（測試平台功能）不同。

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | QA |
| **LDAP Groups** | QA_ALL（跨產品線） |
| **系統角色** | QA (Quality Assurance) |
| **人數規模** | 單一團隊，負責所有產品線 |
| **資料敏感度** | 中高 — failure analysis 涉及技術細節 |

## 業務場景

1. **Reliability Testing**：controller 可靠性驗證（溫度、耐久度、電壓）
2. **RMA Management**：客戶退貨分析和處理
3. **Failure Analysis (FA)**：不良品根因分析
4. **Incoming QC**：來料品質檢驗
5. **Process Audit**：製程品質稽核
6. **Customer Quality Report**：出具客戶品質報告

## Data Access Needs

### 需要存取的 Module
- `module:quality.reliability` — 可靠性測試報告
- `module:quality.rma` — RMA 記錄
- `module:quality.failure_analysis` — FA 文件
- `module:mrp.lot_tracking` — lot 追蹤（品質事件時需要）
- `module:mrp.yield_analysis` — yield data（品質分析用）

### 存取範圍 (L1 ABAC Scope)
```
QA_ALL: 跨所有產品線的品質資料存取
  - reliability, rma, failure_analysis: 完整存取
  - lot_status: 完整存取（品質事件追蹤）
  - yield data: read-only（分析用）
  - sales_order: 限 RMA 相關訂單
```

QA 是少數可以跨產品線存取的部門（因為品質事件不分產品線）。

### Column Masking (L2)
| 欄位 | 遮罩方式 | 原因 |
|------|---------|------|
| unit_price | range mask | QA 不需精確價格，但需知道價格級距做 risk 評估 |
| cost | full mask | 成本為財務機密 |
| customer | visible | QA 需知道客戶以追蹤 RMA |
| margin | full mask | 毛利與品質無關 |
| failure_detail | visible | QA 核心資料 |
| design_data | full mask | QA 不需 IC design 細節 |

## RLS Rules (業務邏輯)

```sql
-- QA 跨產品線存取品質資料（不受 product_line 限制）
-- QA 看 sales_order 只限有 RMA flag 的訂單
CREATE POLICY qa_order_access ON sales_order
  FOR SELECT TO pool_qa_readonly
  USING (has_rma = true OR rma_count > 0);
```

## Pain Points

1. **RMA 追蹤斷鏈**：客戶退貨 → 訂單 → lot → wafer 的追蹤需要跨 4 個模組
2. **品質事件回應慢**：發現品質問題時，需要緊急存取 lot_status + yield，目前要人工申請
3. **FA 報告分享**：failure analysis 報告需要分享給 PE/RD，但不能讓 Sales 看到技術細節
4. **客戶品質報告**：出給客戶的品質報告需要遮罩內部良率數據
5. **跨廠區資料**：HQ/JP/HK 的品質資料目前各自獨立

## Metabase BI Needs

- **Dashboard**: 「QA Daily」— RMA 狀態、本月品質事件 summary
- **Report**: 「Reliability Trend」— 各產品線的可靠性測試趨勢
- **Alert**: RMA 數量超過門檻時通知（weekly 統計）
- **Cross-reference**: QA 需要在分析 RMA 時連結到 lot_status 和 yield data

## Interaction

- **需求提交 to**: Product Owner
- **資料共享 with**: PE（品質事件）、RD（failure root cause）、Sales（RMA 客戶通知）
- **品質報告 to**: PM（產品品質 summary）、VP（高階品質報告）
