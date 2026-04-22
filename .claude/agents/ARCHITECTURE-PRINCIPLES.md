# Data Nexus — Architecture Principles

> 所有 agent 共享此原則文件。違反任何原則需 AuthZ Architect 明確核准。

---

## P1: Single Source of Truth (SSOT)

所有權限來自 `authz_role_permission` + `authz_policy` 兩張表。

- 不允許在應用程式碼中硬編碼權限判斷
- 不允許在前端做 access control 決策（前端只做 UI 可見性，不做安全閘門）
- `authz_resolve()` → `authz_check()` → `authz_filter()` 是唯一的權限解析鏈
- 任何新的存取路徑必須接入此 SSOT

## P2: Three Paths

每個權限變更必須評估三條執行路徑的影響：

| Path | 機制 | 說明 |
|------|------|------|
| **A** | Config-SM UI | metadata-driven 頁面，經 `config-exec` pipeline（buildMaskedSelect → rewrite → authz_check） |
| **B** | API middleware | Express `requireAuth` / `requirePermission` / `requireRole` |
| **C** | Direct DB | PG native `GRANT` + `RLS` + column `REVOKE`，經 pgbouncer |

**規則**：新增功能或修改權限時，必須在 PR 描述中說明對三條 path 的影響。若某 path 不受影響，明確標註「Path X: 不影響」。

## P3: Migration Safety

- 循序編號 `V0xx`，永不跳號、永不插入
- 使用 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` — 冪等執行
- 永不 `DROP TABLE` 或 `DROP COLUMN`（先 deprecate，下個版本再移除）
- `ALTER TABLE` 加欄位必須有 `DEFAULT` 或允許 `NULL`
- 每個 migration 有明確的 rollback 計畫（即使不寫 down migration）

## P4: Database Separation

| Database | 用途 | 管理者 |
|----------|------|--------|
| `nexus_authz` | 授權設定、角色、政策、audit | AuthZ 系統 |
| `nexus_data` | 業務資料（含 CDC replica） | 各 data source |

- 永不在 `nexus_data` 中存放授權設定
- 永不在 `nexus_authz` 中存放業務資料
- 跨 DB 查詢用 API call，不用 `dblink` 或 `FDW`

## P5: Oracle CDC

Oracle 資料透過外部 CDC 工具複寫到 `nexus_data` 的獨立 schema。

- **讀取**：所有 data query 打 PG replica，不打 Oracle
- **寫入**：Oracle function call 經 `/api/oracle-exec`，必經 `authz_check` 閘門
- **DDL**：永不對 Oracle 執行 DDL — Data Nexus 不管理 Oracle schema
- **Discovery**：掃 PG replica 的 `information_schema`（SSOT = CDC 已同步的結構）
- **CDC 監控**：外部基礎建設負責，Data Nexus 不監控 CDC lag

## P6: Dependency Order

設定資料的匯入/建立必須遵循相依順序：

```
actions → resources → roles → permissions → subjects → assignments → policies
```

- Bulk import 自動排序
- 手動建立時 UI 引導順序
- 刪除時反向（policies → ... → actions）

## P7: Audit Trail

所有 admin 操作經 `logAdminAction()` 記錄到 `authz_audit_log`。

- 三條 path 的操作統一寫入同一張 audit 表
- 記錄：userId, action, resourceType, resourceId, details (JSON), ip, timestamp
- Oracle function call 同樣寫入此表
- Audit log 永不刪除（只能 archive）

## P8: Least Privilege

- Pool role 只授予必要的 `GRANT`（schema USAGE + table SELECT）
- RLS 必須 `FORCE` 啟用（防止 superuser bypass）
- Column 級別用 `REVOKE` 隱藏敏感欄位
- L2 column mask 在 query 層額外遮罩（defense in depth）
- 永不在 migration 中寫明文密碼
- Credential 經 `encrypt()` / `decrypt()` 處理

---

## Interaction Rules — 混合模式

### 嚴格鎖定（必須由指定角色處理）

| 操作 | 負責角色 | 原因 |
|------|---------|------|
| Migration 檔案建立/編號 | AuthZ Architect | 防止版號衝突，確保 3-path 評估 |
| PG function 修改 | DBA Guardian | SQL 安全性、效能、RLS 正確性 |
| RLS / GRANT / 加密 | DBA Guardian | 安全關鍵操作需專業 review |
| `PROGRESS.md` 更新 | AuthZ Architect | SSOT 進度追蹤 |
| `CLAUDE.md` 修改 | AuthZ Architect | 全局設定影響所有角色 |

### Review 制（可跨界，需指定角色 review）

| 操作 | 主要角色 | Reviewer |
|------|---------|----------|
| API route 新增/修改 | Backend Engineer | AuthZ Architect |
| Oracle CDC 相關 | Backend Engineer | DBA Guardian + Architect |
| UI component 新增 | Dashboard Engineer | QA Engineer |
| Pool/Sync 修改 | Backend Engineer | DBA Guardian |
| 權限模型變更 | AuthZ Architect | DBA Guardian + PO |
| Domain 需求轉技術規格 | PO | 對應 Domain Expert |

### 自由（任何技術角色可修改）

- 文件（`docs/` 除 `PROGRESS.md`）
- 測試程式碼
- 型別定義（types, interfaces）
- 開發設定檔（vite.config, tsconfig, .env.example）
- README 更新
