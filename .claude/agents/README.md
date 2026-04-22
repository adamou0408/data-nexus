# Data Nexus — Agent Roles

> 16 個 agent 定義，分三層：技術團隊、產品管理、業務部門。
> 所有 agent 共享 [ARCHITECTURE-PRINCIPLES.md](./ARCHITECTURE-PRINCIPLES.md) 的 8 條原則和混合互動規則。

---

## Architecture & Principles

| 文件 | 說明 |
|------|------|
| [ARCHITECTURE-PRINCIPLES.md](./ARCHITECTURE-PRINCIPLES.md) | P1-P8 架構原則 + 混合互動規則（嚴格鎖定 / Review 制 / 自由） |

---

## Technical Team — 建構平台（5 agents）

寫程式、review、維護系統安全。

| Agent | 檔案 | 核心職責 | 嚴格鎖定範圍 |
|-------|------|---------|-------------|
| **AuthZ Architect** | [authz-architect.md](./authz-architect.md) | Migration 治理、架構決策、SSOT 守護 | migrations/, PROGRESS.md, CLAUDE.md |
| **Backend Engineer** | [backend-engineer.md](./backend-engineer.md) | API routes、SQL pipeline、Oracle CDC | routes/, lib/, rewriter/ |
| **Dashboard Engineer** | [dashboard-engineer.md](./dashboard-engineer.md) | React UI、Config-SM、role-based 可見性 | components/, api.ts |
| **DBA Guardian** | [dba-guardian.md](./dba-guardian.md) | PG function、RLS、pgbouncer、加密 | SQL function body, pg_hba, pgbouncer |
| **QA Engineer** | [qa-engineer.md](./qa-engineer.md) | 3-path 一致性驗證、audit 完整性 | tests/, testing-guide.md |

---

## Product Management（1 agent）

需求收集、優先排序、跨部門協調。

| Agent | 檔案 | 核心職責 |
|-------|------|---------|
| **Product Owner** | [product-owner.md](./product-owner.md) | 需求優先排序、user story、feature 驗收、部門協調 |

---

## Domain Experts — 業務部門視角（9 agents）

代表各部門提出存取需求、定義敏感欄位、驗證 RLS 規則。不寫程式。

| Agent | 檔案 | 部門 | LDAP Groups | 關鍵資料 |
|-------|------|------|-------------|---------|
| **PE Expert** | [domain-pe.md](./domain-pe.md) | Product Engineering | PE_SSD, PE_EMMC, PE_SD | lot_status, yield, NPI |
| **PM Expert** | [domain-pm.md](./domain-pm.md) | Product Management | PM_SSD, PM_EMMC | NPI gate, pricing summary, roadmap |
| **RD Expert** | [domain-rd.md](./domain-rd.md) | R&D Engineering | RD_FW, RD_IC | firmware, IC design, test program |
| **QA Dept Expert** | [domain-qa-dept.md](./domain-qa-dept.md) | Quality Assurance | QA_ALL | reliability, RMA, failure analysis |
| **Sales Expert** | [domain-sales.md](./domain-sales.md) | Sales | SALES_TW/CN/US | orders, pricing, customer |
| **FAE Expert** | [domain-fae.md](./domain-fae.md) | Field Application Engineering | FAE_TW, FAE_CN | customer support, lot tracking |
| **OP Expert** | [domain-ops.md](./domain-ops.md) | Operations / Production | OP_SSD | WIP, lot status, production line |
| **Finance & BI Expert** | [domain-finance-bi.md](./domain-finance-bi.md) | Finance + BI | FINANCE_TEAM, BI_TEAM | cost, margin, analytics |
| **SCM Expert** | [domain-scm.md](./domain-scm.md) | Supply Chain | (需新增) | BOM, inventory, Tiptop ERP |

---

## Department × Module Access Matrix

| Module | PE | PM | RD | QA | Sales | FAE | OP | Finance | BI | SCM |
|--------|----|----|----|----|-------|-----|----|---------|----|-----|
| mrp.lot_tracking | RW | R | R | R | - | R | RW | - | R | R |
| mrp.yield_analysis | R | R(sum) | R | R | - | - | R | - | R | - |
| mrp.npi | R | RW | R | R | - | - | - | - | R | - |
| quality.* | - | R(sum) | R(FA) | RW | - | R(RMA) | - | - | R | - |
| sales.order_mgmt | - | R | - | R(RMA) | RW | - | - | R | R | - |
| sales.pricing | - | R | - | - | R | - | - | RW | R(hash) | - |
| sales.customer | - | R | - | R | RW | R | - | R | R | - |
| engineering.* | - | - | RW | - | - | R(notes) | - | - | - | - |
| analytics.* | - | - | - | - | - | - | - | R | RW | - |
| tiptop_inventory | - | - | - | - | - | - | R | R | R | RW |

> R = read, RW = read-write, R(sum) = summary only, R(hash) = hashed values, R(FA) = failure analysis only, R(RMA) = RMA related only, R(notes) = release notes only

---

## How to Use These Agents

### 1. 開發新功能
```
PO 收集 Domain Expert 需求
→ PO 撰寫 user story + 3-path impact
→ Architect 評估架構影響 + 建立 migration
→ Backend/Frontend/DBA 分工實作
→ QA 驗證 3-path 一致性
→ Domain Expert 驗收業務邏輯
```

### 2. 權限變更
```
Domain Expert 提出存取需求
→ PO 評估優先級和安全影響
→ Architect 設計權限模型（role/policy/RLS）
→ DBA Guardian 實作 RLS + GRANT
→ Backend 更新 API（如需要）
→ QA 驗證三條 path 一致
```

### 3. 新部門上線
```
定義 LDAP group + system role
→ 建立 Domain Expert agent 文件
→ PO 收集初始需求
→ Architect 規劃 module + pool profile
→ DBA 設定 GRANT + RLS
→ BI 建立 Metabase dashboard
```
