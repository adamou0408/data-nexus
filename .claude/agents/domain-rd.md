# Domain Expert — R&D Engineering (RD)

> 研發工程部門視角 — Firmware 開發、IC Design、test program、design data

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | RD |
| **LDAP Groups** | RD_FW (Firmware), RD_IC (IC Design) |
| **系統角色** | RD (R&D Engineer), FW (Firmware Engineer) |
| **人數規模** | 約 2 個子團隊（Firmware + IC Design） |
| **資料敏感度** | 最高 — 包含 IC 設計資料和 firmware source code |

## 業務場景

1. **Firmware Development**：NAND flash controller firmware 開發和維護
2. **IC Design**：controller IC 架構設計、驗證
3. **Test Program Development**：開發 CP/FT 測試程式
4. **Design Data Management**：管理 IC layout、netlist、simulation 結果
5. **Customer Firmware Customization**：為特定客戶做 firmware 客製化

## Data Access Needs

### 需要存取的 Module
- `module:engineering.firmware` — firmware repository（核心）
- `module:engineering.test_program` — test program management
- `module:engineering.design_data` — IC design data（最高機密）
- `module:mrp.yield_analysis` — 測試結果分析（debug 用）

### 存取範圍 (L1 ABAC Scope)
```
RD_FW: firmware + test_program 完整存取，design_data read-only
RD_IC: design_data 完整存取，firmware read-only
兩組都可看 yield analysis（用於 debug）
跨團隊存取需特殊申請
```

### Column Masking (L2)
| 欄位 | 遮罩方式 | 原因 |
|------|---------|------|
| unit_price | full mask | RD 不需要價格資訊 |
| cost | full mask | 成本為財務機密 |
| customer | partial mask | RD 只需知道客戶代號（非全名） |
| design_netlist | visible (RD_IC only) | IC 核心機密 |
| firmware_source | visible (RD_FW only) | firmware 核心機密 |

## RLS Rules (業務邏輯)

```sql
-- RD 看 yield data 不受產品線限制（需要跨產品線 debug）
-- 但 design_data 嚴格限制：RD_IC only
-- firmware 嚴格限制：RD_FW only（IC 團隊不需看 firmware source）
-- customer firmware customization 只能看該客戶的 fork
```

## Security Concerns

**RD 是最高機密部門**，以下為特殊安全需求：

1. **Design Data**：IC layout/netlist 外洩等同洩漏公司核心技術
   - 建議：獨立 pool profile、IP 白名單、額外 audit logging
2. **Firmware Source**：firmware binary 分發給客戶，但 source code 永不外流
   - 建議：read-only 存取、禁止 download/export 功能
3. **Test Program**：test program 含 yield improvement 的 know-how
   - 建議：PE 可 execute 但不能 read source
4. **客戶資料隔離**：A 客戶的 customized firmware 不能被 B 客戶看到

## Pain Points

1. **Debug 資料存取慢**：分析 yield issue 需要從 PE 那裡要資料，週轉時間太長
2. **版本管理**：firmware 和 test program 的版本對應目前靠人工維護
3. **Design data 無權限控制**：目前放在 file server，靠 folder permission 管理
4. **跨團隊協作**：FW 和 IC 需要共享部分資料但又要隔離核心機密

## Metabase BI Needs

- **Dashboard**: 「RD Debug Console」— yield anomaly drill-down by wafer/lot
- **Report**: 「Test Program Coverage」— 各測試程式的覆蓋率和 pass rate
- 不建議 RD 的 design data 上 Metabase（太敏感）

## Interaction

- **需求提交 to**: Product Owner
- **資料共享 with**: PE（yield debug、test program）
- **安全審核 by**: DBA Guardian（特殊 pool profile）、AuthZ Architect（額外安全層）
- **注意**：RD 的任何存取權限變更都需要 Architect + DBA Guardian 雙重 review
