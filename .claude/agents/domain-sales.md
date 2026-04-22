# Domain Expert — Sales Department

> 業務部門視角 — 客戶管理、訂單追蹤、定價策略、區域業績

## Department Profile

| 屬性 | 值 |
|------|---|
| **部門代碼** | SALES |
| **LDAP Groups** | SALES_TW (台灣/總部), SALES_CN (中國), SALES_US (美國/歐洲) |
| **系統角色** | SALES |
| **人數規模** | 3 個區域團隊 |
| **資料敏感度** | 最高 — 客戶定價為最高商業機密 |

## 業務場景

1. **Order Management**：訂單建立、追蹤、出貨確認
2. **Pricing Management**：客戶報價、特殊價格核准
3. **Customer Management**：OEM/Channel/Branded 客戶關係維護
4. **Regional Sales Tracking**：區域業績追蹤和預測
5. **Customer Allocation**：產能分配和交期管理

## Key Customers (from seed data)

| 區域 | 客戶 | 類型 |
|------|------|------|
| TW/Global | Samsung, WD, Micron, SK Hynix | OEM |
| TW/Global | Kingston, Corsair, Transcend | Channel |
| CN | Longsys, YMTC, Lenovo, Xiaomi | China OEM/Brand |
| US/EU | (overlap with Global OEMs) | Western Market |

## Data Access Needs

### 需要存取的 Module
- `module:sales.order_mgmt` — 訂單管理（核心）
- `module:sales.pricing` — 價格表、報價歷史
- `module:sales.customer` — 客戶資料
- `module:mrp.lot_tracking` — 出貨 lot 追蹤（read-only）

### 存取範圍 (L1 ABAC Scope)
```
SALES_TW: region IN ('TW', 'Global')
SALES_CN: region = 'CN'
SALES_US: region IN ('US', 'EU')

核心規則：業務員只能看自己區域的客戶和訂單
跨區域客戶（如 Samsung 全球）需要特殊處理
```

### Column Masking (L2)
| 欄位 | 遮罩方式 | 原因 |
|------|---------|------|
| unit_price | visible (own region) | Sales 需要定價 |
| cost | full mask | 成本為財務機密，Sales 不應知道 |
| margin | full mask | 毛利率為財務機密 |
| other_region_price | full mask | A 區域不能看 B 區域的報價 |
| customer_contact | visible (own customer) | 客戶聯絡資訊 |
| yield_data | full mask | 良率為技術機密 |

## RLS Rules (業務邏輯)

```sql
-- Sales 只能看自己區域的訂單
CREATE POLICY sales_region_access ON sales_order
  FOR SELECT TO pool_sales_readonly
  USING (region = current_setting('app.region'));

-- 全球客戶的訂單：所有區域可看 summary，但只有負責區域看 detail
-- 報價資料：嚴格區域隔離，跨區域需 VP 核准
```

## Security Concerns

**定價資料是最高商業機密**：

1. **跨區域報價隔離**：客戶 A 在台灣的報價不能被中國團隊看到
2. **成本/毛利不可見**：Sales 知道售價但不應知道成本和毛利
3. **客戶資料保護**：客戶的聯絡人和合約資訊不能被非負責業務看到
4. **離職風控**：業務員離職前應能快速凍結其存取權限

## Pain Points

1. **報價查詢慢**：目前從 ERP 手動查詢歷史報價，希望有即時 dashboard
2. **跨區域客戶困擾**：Samsung 同時在 TW/CN/US 下單，三個區域看到的資訊不一致
3. **出貨追蹤**：客戶問出貨進度，Sales 要去找 OP 查 lot_status
4. **業績統計**：月報需要手動從多個系統彙整
5. **特殊價格核准流程**：目前用 email，希望系統化

## Metabase BI Needs

- **Dashboard**: 「Sales Daily」— 今日訂單/出貨/AR summary by region
- **Report**: 「Monthly Revenue」— 月營收 by customer/product_line/region
- **Report**: 「Price History」— 客戶報價歷史趨勢
- **Alert**: 大額訂單通知、逾期訂單提醒

## Interaction

- **需求提交 to**: Product Owner
- **定價協調 with**: PM（產品定價策略）、Finance（毛利管控）
- **出貨追蹤 with**: OP（生產進度）、PE（品質確認）
- **RMA 處理 with**: QA（退貨分析）
- **權限審核 by**: AuthZ Architect + VP（跨區域存取需高階主管核准）
