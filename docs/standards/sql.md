---
paths:
  - "database/**"
  - "**/*.sql"
---

# SQL 與資料庫遷移規範

> 本規則是 AuthZ 專案專用。

## PL/pgSQL 函式規範

- 所有 authz 函式以 `authz_` 開頭，內部 helper 以 `_authz_` 開頭。
- 每個函式開頭用 `-- ====` 區塊標註：用途、使用路徑（Path A/B/C）、輸入輸出契約。
- 純讀取函式標記 `STABLE`，無副作用的 JSON 操作標記 `IMMUTABLE`。
- Column masking 函式額外標記 `PARALLEL SAFE`。
- 函式內的錯誤用 `RAISE EXCEPTION` 並帶錯誤碼，不靜默失敗。

## Migration 規範

- 使用 Flyway（`database/migrations/`），檔名格式：`V{NNN}__{描述}.sql`。
- 每個 migration 必須冪等——重複執行不報錯（用 `IF NOT EXISTS`、`CREATE OR REPLACE`）。
- Schema 變更（ALTER TABLE）必須能無停機升級：先加欄位（nullable）→ 部署新程式碼 → backfill → 加 NOT NULL constraint。
- 不可在 migration 中 DROP COLUMN 或 DROP TABLE。先標記 is_active=false，下個版本再清理。
- 每個 migration 結尾加 `-- VERIFY:` 區塊，包含驗證 SQL（SELECT count(*) 或 \d table_name）。

## RLS Policy 生成規範

- 自動生成的 RLS policy 名稱格式：`rls_{table}_{role}_{scope}`。
- RLS USING 子句中，Path A 可用 `current_setting()`，Path C 必須用 `pg_has_role()`。
- RLS policy 變更前，先在 `authz_sync_log` 記錄 `sync_status='pending'`，執行後更新為 `synced` 或 `failed`。
- 新增 RLS 時確認目標欄位有索引，避免全表掃描。用 `=` 比較而非 `ANY()` 以啟用 index scan。

## 效能約束

- authz_check() 在有快取的情況下不應觸發 DB 查詢（使用 authz_check_from_cache）。
- authz_resolve() 的 JOIN 數量不超過 6 張表。超過時拆分為子查詢。
- authz_audit_log INSERT 必須走 batch mode（authz_audit_batch_insert），不可單筆 INSERT。
- 分頁查詢的 LIMIT 上限寫在 API 層，PG 函式中不硬編碼。

## 判斷準則

- **不確定 migration 是否能無停機**：寫成兩個 migration（V015a + V015b），中間允許舊版程式碼運行。
- **需要修改 authz_resolve() 的輸出結構**：這是架構級變更，建立 ADR。同時更新 `packages/authz-types/` 和 Mega-Prompt（§VII）。
- **RLS 效能不確定**：先用 `EXPLAIN ANALYZE` 驗證查詢計劃，貼到 PR 描述中。
