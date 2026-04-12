# AuthZ 安全審查

> 本規則是 AuthZ 專案專用，補充 Dev Kit 的通用 code-review 安全檢查。
> 本專案是安全關鍵服務——authz_check 出錯 = 全系統權限失控。安全審查標準高於一般專案。

## 觸發條件

修改以下任一路徑時自動觸發：authz-service、authz-client、database、任何包含 `authz_check` 或 `authz_resolve` 呼叫的檔案。

## 執行指令

### 1. 權限邊界檢查

- 本次變更是否擴大了任何 subject 的可存取範圍？若是，列出具體影響（哪些 subject 增加了哪些 resource 的存取權）。
- 本次變更是否縮小了範圍？若是，確認有通知受影響的使用者。
- 是否有新的 `effect='allow'` 且 `resource_id='*'` 或 `action_id='*'` 的萬用字元授權？這需要人類明確批准。

### 2. SSOT 違反掃描

- 搜尋本次變更中是否有在 AuthZ Service 外部實作的權限判斷邏輯（例如在 API handler 中直接用 `if (user.role === 'admin')` 而非呼叫 `authz_check()`）。
- 發現任何硬編碼的角色判斷，立即改為呼叫 authz_check 或 authz_check_from_cache。

### 3. 資訊洩漏檢查

- 確認回傳給客戶端的 JSON 中不包含 `rls_expression`、`pg_function`、`template` 等伺服器端實作細節。
- 確認錯誤回應不洩漏 policy_id、table 結構、或 SQL 片段。
- 確認 audit_log 的 context JSONB 不寫入 password、token、或 session secret。

### 4. Audit 完整性

- 確認每個新增的寫入操作都有對應的 audit log 記錄。
- 確認 audit log 的 INSERT 走 batch mode，且 deny 事件不被 batch 延遲（deny 必須即時記錄或批次間隔 ≤ 1 秒）。
- 確認沒有任何路徑可以繞過 audit log（包括 sync engine 的操作）。

### 5. Policy 變更安全

- 若變更涉及 authz_policy 或 authz_role_permission 的 INSERT/UPDATE/DELETE：
  - 確認走 pending_review → approve 流程，不直接寫入 status='active'。
  - 唯一的例外是 seed data（Phase 2）和 emergency_override（必須在 audit_log 標記）。
- 若變更涉及 authz_composite_action 的 approval_chain：確認 min_approvers ≥ 1。

### 6. Cache 安全

- 確認 cache invalidation 路徑完整：policy 變更 → PG NOTIFY → Redis flush → L2 miss → re-resolve。
- 確認沒有繞過 cache invalidation 的寫入路徑（例如直接 UPDATE authz_policy 而不觸發 trigger）。
- 確認 explicit deny 規則不從 cache 讀取，而是即時查詢 DB。

## 輸出

安全審查通過時，在 PR 描述加入：

```
## 安全審查
- [x] 權限邊界無意外擴大
- [x] 無 SSOT 違反（所有權限判斷走 authz_check）
- [x] 無資訊洩漏（客戶端 JSON 不含伺服器實作細節）
- [x] Audit 完整（所有寫入有記錄，deny 即時）
- [x] Policy 變更走 pending_review 流程
- [x] Cache invalidation 路徑完整
```
