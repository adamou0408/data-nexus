# Domain Expert — Field Application Engineering (FAE)

> 客戶技術服務部門視角 — 客戶技術支援、應用方案、問題排除、技術文件

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | FAE |
| **LDAP Groups** | FAE_TW (台灣), FAE_CN (中國) |
| **系統角色** | FAE (Field Application Engineer) |
| **人數規模** | 2 個區域團隊 |
| **資料敏感度** | 中 — 需要技術資料但不觸及核心機密 |

## 業務場景

1. **Customer Technical Support**：協助客戶整合 Phison controller
2. **Application Solution**：為客戶設計儲存解決方案
3. **Issue Debugging**：客戶端問題排除，需要查看 lot/yield 資料
4. **Technical Documentation**：維護客戶端技術文件和 FAQ
5. **Sample Management**：管理客戶樣品發放和追蹤

## Data Access Needs

### 需要存取的 Module
- `module:mrp.lot_tracking` — 客戶出貨 lot 追蹤（debug 用）
- `module:quality.rma` — RMA 資料（客戶反饋追蹤）
- `module:sales.customer` — 客戶基本資料（read-only）
- `module:engineering.firmware` — firmware release notes（不含 source）

### 存取範圍 (L1 ABAC Scope)
```
FAE_TW: region IN ('TW', 'Global') — 同 Sales 區域劃分
FAE_CN: region = 'CN'
FAE 只能看自己負責客戶的資料
```

### Column Masking (L2)
| 欄位 | 遮罩方式 | 原因 |
|------|---------|------|
| unit_price | full mask | FAE 不需要價格資訊 |
| cost | full mask | 成本為財務機密 |
| margin | full mask | 毛利與 FAE 無關 |
| customer | visible | FAE 需知道客戶 |
| firmware_source | full mask | FAE 只看 release note |
| design_data | full mask | FAE 不需 IC design |
| yield_detail | partial mask | FAE 看 pass/fail，不看 raw measurement |

## RLS Rules (業務邏輯)

```sql
-- FAE 只能看自己區域的客戶資料
-- FAE 看 lot_status 限於客戶出貨的 lot（不是所有 lot）
CREATE POLICY fae_lot_access ON lot_status
  FOR SELECT TO pool_fae_readonly
  USING (
    customer_id IN (SELECT customer_id FROM fae_customer_assignment WHERE fae_region = current_setting('app.region'))
  );
```

## Pain Points

1. **客戶問題回應慢**：客戶報問題，FAE 需要找 PE 查 lot → 找 QA 查 FA → 找 RD 查 firmware，週轉時間長
2. **Firmware 版本追蹤**：需要知道客戶用的 firmware 版本，但 firmware repo 存取受限
3. **跨區域客戶**：同一客戶的 TW FAE 和 CN FAE 需要共享 case history
4. **技術文件管理**：客戶特定的技術文件目前散落在不同系統

## Metabase BI Needs

- **Dashboard**: 「FAE Case Board」— 待處理客戶 issue 清單 by region
- **Report**: 「Customer Issue Trend」— 客戶問題類型統計
- **Cross-reference**: FAE 查問題時需要 lot_status + RMA + firmware version 聯合查詢

## Interaction

- **需求提交 to**: Product Owner
- **技術支援 from**: PE（lot 追蹤）、RD（firmware issue）、QA（RMA 分析）
- **客戶協調 with**: Sales（商務面）
- **安全注意**: FAE 常在客戶端工作，存取環境不可控，建議 IP 白名單 + session timeout
