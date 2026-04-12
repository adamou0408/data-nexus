# CLAUDE.md — Phison AuthZ Service

@./docs/tech-debt.md
@./docs/authz-known-risks.md

## 專案概述

本專案是群聯電子（Phison Electronics）內部資料中心的授權服務（Authorization Service），作為所有存取控制決策的 Single Source of Truth（SSOT）。設計細節見 `docs/architecture.md`。

## 三條存取路徑

每一次變更都必須考慮對三條路徑的影響，不可只處理其中一條：

```
Path A: Config-as-State-Machine UI + AI Agent → authz_resolve()
Path B: 傳統網頁 + API → authz_resolve_web_acl()
Path C: DB 直連（pgbouncer）→ authz_sync_db_grants()
```

變更涉及 authz_role_permission 或 authz_policy 時，列出每條路徑的影響再動手。

## 技術棧

- Policy Store：PostgreSQL 14+（唯一，不可替換）
- Policy Engine：Casbin（RBAC + ABAC hybrid）
- 後端：Node.js / TypeScript
- 前端：React（Path A 用 Metadata-Driven UI，AuthZ Admin 用 Hardcoded routing）
- Connection Pooler：pgbouncer
- 部署：K8s（Helm umbrella chart）
- Monorepo：Nx/Turborepo

## Coding Standards（補充 Dev Kit 通用規範）

- **命名**：TypeScript 用 camelCase 變數、PascalCase 類別、kebab-case 檔案。PL/pgSQL 函式用 `authz_` 前綴 + snake_case。
- **函式**：TypeScript 不超過 40 行。PL/pgSQL 函式不限行數但每個邏輯區塊用 `-- ====` 分隔並加註說明。
- **型別**：所有 authz config 的 TypeScript 型別定義在 `packages/authz-types/`。新增欄位必須同步更新型別。
- **SQL 風格**：關鍵字大寫（`SELECT`、`CREATE`、`WHERE`），表名 snake_case，欄位名 snake_case。
- **TECH_DEBT 註解**：TypeScript 用 `// TECH_DEBT:`，SQL 用 `-- TECH_DEBT:`。

## 安全紅線

這是安全關鍵服務——authz_check 出錯等於全系統權限失控。以下規則不可妥協：

1. **永遠不在 AuthZ Service 外部實作權限邏輯**。任何新路徑只能新增 enforcement adapter，不能新增 permission store。
2. **Resolved config 不傳送 rls_expression 和 mask function 到客戶端**。客戶端只收到 resource + action + allowed:boolean + mask_type。
3. **authz_audit_log 是 append-only**。任何角色（含 SUPER_ADMIN）都不可 DELETE 或 UPDATE audit log。
4. **Path C 的 RLS 不可依賴 current_setting()**。必須用 `pg_has_role()` 檢查，防止 session variable 偽造。
5. **Policy 變更必須經過 Policy Simulator + Impact Analysis**。Submit for Review 按鈕在未執行 simulation 前保持 disabled。

## 工作流程（補充 Dev Kit 通用流程）

Dev Kit 的 8 步流程全部適用，以下是本專案的額外步驟：

```
Dev Kit Step 2（衝突偵測）之後，額外執行：
2a. 三路徑影響分析 → 列出 Path A/B/C 各自的影響
2b. 安全影響評估 → 是否涉及權限擴大或縮小？影響多少 subject？

Dev Kit Step 6（測試）之後，額外執行：
6a. Policy Simulation → 用至少 3 個 persona（PE_SSD、SALES_TW、BI_USER）跑模擬
6b. 若涉及 RLS 或 GRANT 變更 → 跑 sync dry-run 確認產出的 SQL 正確
```

## 已知風險追蹤

本專案有 16 個已識別的生產風險，記錄在 `docs/authz-known-risks.md`。格式：

```
RISK-{維度}-{序號}: {描述} | 嚴重等級 | 狀態
維度：OPS | SEC | SCALE | DATA | DX | FT | COMP | EVOL
狀態：mitigated | needs_work | monitoring
```

新增風險或變更狀態時更新該文件。每次 sprint planning 檢視未解決的 HIGH 風險。

## 架構決策觸發點（補充 Dev Kit）

除 Dev Kit 定義的觸發點外，以下情境也必須建 ADR：

- 新增第四條存取路徑
- 變更 Casbin model.conf（matcher 或 effect 邏輯）
- 變更 authz_resolve() 的輸出契約（會影響所有 Path A 消費者）
- 引入非 PostgreSQL 的 Target Database
