# Domain Expert — Operations / Production (OP)

> 生產營運部門視角 — 生產排程、WIP 管理、lot 追蹤、產線監控

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | OP |
| **LDAP Groups** | OP_SSD（SSD Production Line） |
| **系統角色** | OP (Operator) |
| **人數規模** | 依產線規模，目前 seed data 有 SSD 線 |
| **資料敏感度** | 中 — 生產數據本身不敏感，但含產能資訊 |

## 業務場景

1. **WIP Management**：在製品追蹤，管理各站點的 lot 進度
2. **Production Scheduling**：生產排程、產線負載平衡
3. **Lot Status Monitoring**：即時監控 lot 狀態（測試中/hold/release/出貨）
4. **Line Efficiency**：產線效率統計（UPH, utilization rate）
5. **Material Feeding**：生產用料管理和追蹤

## Data Access Needs

### 需要存取的 Module
- `module:mrp.lot_tracking` — lot_status, WIP inventory（核心）
- `module:mrp.yield_analysis` — yield summary（產線管理用）

### 存取範圍 (L1 ABAC Scope)
```
OP_SSD: product_line = 'SSD'
未來可能增加 OP_EMMC, OP_SD, OP_PKG (封裝線)
OP 只看自己產線的資料
```

### Column Masking (L2)
| 欄位 | 遮罩方式 | 原因 |
|------|---------|------|
| unit_price | full mask | OP 不需要價格 |
| cost | full mask | 成本為財務機密 |
| customer | partial mask | OP 只需知道客戶代號（排 priority 用） |
| margin | full mask | 毛利與 OP 無關 |
| yield_raw | visible | OP 需要 yield 做產線調整 |

## RLS Rules (業務邏輯)

```sql
-- OP 只看自己產線的 lot_status
CREATE POLICY op_lot_access ON lot_status
  FOR SELECT TO pool_op_readonly
  USING (product_line = current_setting('app.product_line'));

-- OP 看 yield 只限自己產線（用於調整產線參數）
-- OP 不看跨產線的 yield comparison
```

## Pain Points

1. **即時性需求最高**：產線監控需要秒級更新，CDC 延遲可能不夠
2. **Hold/Release 操作**：目前 lot hold/release 要在 ERP 操作，希望在 dashboard 直接操作
3. **跨站點追蹤**：一個 lot 從晶圓到封裝到測試跨多個站點，追蹤困難
4. **夜班交接**：需要「交班 dashboard」顯示本班次的 lot 異動
5. **產能資訊敏感**：OP 的 WIP 數據反映公司產能，不應被外部取得

## Real-time Requirements

OP 對資料即時性的要求最高：

| 資料 | 可接受延遲 | 說明 |
|------|-----------|------|
| Lot status change | < 10 秒 | 產線即時監控 |
| Yield summary | < 1 分鐘 | 班次結束時 summary |
| WIP count | < 5 分鐘 | 產能規劃 |
| Schedule update | < 30 分鐘 | 排程變更通知 |

**CDC 延遲影響**：如果 Oracle → PG CDC 延遲超過 10 秒，OP 的即時監控場景可能不滿足。可能需要雙 path（即時走 Oracle direct query，歷史走 PG replica）。

## Metabase BI Needs

- **Dashboard**: 「Production Live」— 即時 lot status board（大螢幕顯示）
- **Dashboard**: 「Shift Handover」— 班次交接 summary
- **Report**: 「WIP Aging」— 在製品齡期分析
- **Report**: 「Line Utilization」— 產線稼動率趨勢
- **Alert**: Lot hold > 24h 未處理通知

## Interaction

- **需求提交 to**: Product Owner
- **即時性需求 to**: AuthZ Architect（可能需要架構調整）
- **品質異常 with**: QA（lot hold 原因）、PE（yield 異常）
- **出貨排程 with**: Sales（客戶 priority）、PM（產品 priority）
