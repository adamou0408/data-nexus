---
paths:
  - "services/authz-service/**"
  - "packages/authz-client/**"
  - "packages/authz-types/**"
  - "database/**"
---

# 三路徑影響分析

> 本規則是 AuthZ 專案專用，補充 Dev Kit 的通用 code-review。

修改 authz-service、authz-client、authz-types 或 database 時，必須在提交前完成三路徑影響分析。

## 執行指令

對本次變更，逐一回答以下問題：

### Path A（Config-SM UI + AI Agent）

- authz_resolve() 的輸出 JSON 結構是否改變？若是，`packages/authz-types/resolved-config.ts` 是否同步更新？
- UI 的 visible_when / editable_when 是否受影響？
- AI Agent 的 tool gating 邏輯是否需要調整？

### Path B（傳統網頁）

- authz_resolve_web_acl() 的輸出是否改變？若是，`packages/authz-types/web-acl.ts` 是否同步更新？
- Express middleware（`packages/authz-client/express-middleware.ts`）是否需要調整？
- Session 中快取的 web_acl 結構是否相容？

### Path C（DB 直連）

- authz_sync_db_grants() 產出的 GRANT/REVOKE SQL 是否改變？
- RLS policy 是否需要重新生成？
- pgbouncer.ini 是否需要重新同步？
- Pool credentials 是否受影響？

### 跨路徑

- authz_check() 或 authz_filter() 的行為是否改變？這兩個函式被三條路徑共用。
- authz_audit_log 的寫入格式是否改變？
- 是否有新的 sync_type 需要加入 authz_sync_log？

## 輸出

在 PR 描述中加入以下區塊：

```
## 三路徑影響

| 路徑 | 影響 | 需要同步更新 |
|------|------|------------|
| A    | {描述或「無影響」} | {列出檔案} |
| B    | {描述或「無影響」} | {列出檔案} |
| C    | {描述或「無影響」} | {列出檔案} |
```
