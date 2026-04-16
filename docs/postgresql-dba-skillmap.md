# PostgreSQL DBA 技能全景圖

> 寫給 Phison Data Nexus 團隊 — 從專案實戰出發，對照 DBA 全貌

---

## 目錄

1. [技能總覽](#1-技能總覽)
2. [架構與安裝](#2-架構與安裝-foundation)
3. [SQL 語言力](#3-sql-語言力)
4. [日常管理營運](#4-日常管理營運)
5. [效能調校](#5-效能調校-performance-tuning)
6. [高可用與備份復原](#6-高可用與備份復原-ha--dr)
7. [安全性](#7-安全性-security)
8. [學習路徑](#8-學習路徑--data-nexus-對照)

---

## 1. 技能總覽

```
                              ┌─────────────────┐
                              │   PostgreSQL     │
                              │   DBA Master     │
                              └────────┬────────┘
            ┌────────────┬────────────┼────────────┬────────────┐
            ▼            ▼            ▼            ▼            ▼
     ┌────────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐
     │  架構與安裝 ││ SQL 語言力││ 日常營運  ││ 效能調校  ││ HA & DR  │
     │ Foundation ││          ││          ││          ││          │
     └────────────┘└──────────┘└──────────┘└──────────┘└──────────┘
        pg 內部       查詢/函數    權限/監控     EXPLAIN     複寫/備份
        記憶體模型     PL/pgSQL    VACUUM       Index 策略   Failover
        設定檔        型別系統     空間管理      參數調校     PITR
```

五大領域互相關聯：理解架構才能調效能，懂安全才能管權限，會備份才敢上生產。

---

## 2. 架構與安裝 (Foundation)

### PostgreSQL 程序架構

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                        Client Application                       │
  │                  (psql / App / pgAdmin / DBeaver)                │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │ TCP :5432
                                 ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  Postmaster (主程序，監聽連線、fork 子程序)                         │
  │                                                                  │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │  Backend Process  (每條連線 fork 一個)                       │  │
  │  │                                                            │  │
  │  │   SQL ──▶ Parser ──▶ Rewriter ──▶ Planner ──▶ Executor    │  │
  │  │                                      │                     │  │
  │  │                                      ▼                     │  │
  │  │                              產生執行計畫                    │  │
  │  │                         (這就是 EXPLAIN 看到的)              │  │
  │  └────────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  ┌─ Shared Memory ──────────────────────────────────────────┐   │
  │  │                                                          │   │
  │  │  Shared Buffers         WAL Buffers        CLOG          │   │
  │  │  (資料頁快取)            (寫前日誌緩衝)      (交易狀態點陣圖) │   │
  │  │                                                          │   │
  │  │  ► 所有 Backend 共用這塊記憶體                               │   │
  │  │  ► 讀資料先查 Shared Buffers，miss 才讀磁碟                  │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                  │
  │  ┌─ Background Workers ─────────────────────────────────────┐   │
  │  │                                                          │   │
  │  │  WAL Writer       定期將 WAL buffer flush 到磁碟           │   │
  │  │  Checkpointer     定期將 dirty pages 寫回磁碟 (checkpoint) │   │
  │  │  BG Writer        提前清理 dirty pages，降低 checkpoint 壓力│   │
  │  │  Autovacuum       自動回收 dead tuples、更新統計資訊         │   │
  │  │  Stats Collector  收集表/索引的讀寫統計                      │   │
  │  │  Archiver         將 WAL 檔複製到歸檔位置 (備份用)           │   │
  │  │                                                          │   │
  │  └──────────────────────────────────────────────────────────┘   │
  └────────────────────────┬─────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │  Data Files  │  │  WAL Files   │  │   Archive   │
   │  base/       │  │  pg_wal/     │  │  (歸檔備份)  │
   │              │  │              │  │              │
   │  表資料       │  │  交易日誌     │  │  PITR 基礎   │
   │  索引資料     │  │  crash 復原   │  │  時間點還原   │
   │  TOAST 大值   │  │  replication │  │              │
   └─────────────┘  └─────────────┘  └─────────────┘
```

### 三個最重要的設定檔

| 檔案 | 用途 | DBA 必改場景 |
|------|------|-------------|
| **`postgresql.conf`** | 所有運行參數 | 記憶體調校、連線數、WAL 設定、日誌策略 |
| **`pg_hba.conf`** | 連線認證規則 | 開放 IP、切換認證方式 (md5→scram→ldap) |
| **`recovery.conf`** / `standby.signal` | 複寫 & 還原 | 建立 Standby、執行 PITR |

---

## 3. SQL 語言力

### 三個層次

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                                                                          │
 │  Level 1  基本功                                                         │
 │  ──────────────────────────────────────────                              │
 │  SELECT / JOIN / WHERE / GROUP BY / ORDER BY                            │
 │  INSERT / UPDATE / DELETE                                                │
 │  CREATE TABLE / ALTER TABLE / DROP                                       │
 │  基本 INDEX (CREATE INDEX ... ON)                                        │
 │  Aggregate: COUNT, SUM, AVG, MAX, MIN                                   │
 │                                                                          │
 ├──────────────────────────────────────────────────────────────────────────┤
 │                                                                          │
 │  Level 2  進階查詢                                                       │
 │  ──────────────────────────────────────────                              │
 │  Window Functions     ROW_NUMBER(), RANK(), LAG(), LEAD()               │
 │  LATERAL JOIN         子查詢可引用外層欄位                                 │
 │  CTE (WITH)           可讀性 + 遞迴查詢基礎                               │
 │  UPSERT               INSERT ... ON CONFLICT DO UPDATE                  │
 │  RETURNING             DML 後直接回傳結果                                 │
 │  Partial Index         WHERE 條件索引，省空間                              │
 │  JSONB 操作            ->, ->>, @>, jsonb_path_query                    │
 │  Array / Range Types   ANY(), ARRAY_AGG(), daterange                    │
 │                                                                          │
 ├──────────────────────────────────────────────────────────────────────────┤
 │                                                                          │
 │  Level 3  DBA 等級                                                       │
 │  ──────────────────────────────────────────                              │
 │  Recursive CTE         WITH RECURSIVE (樹狀結構、BOM 展開)               │
 │  GENERATE_SERIES       產生序列資料 (時間軸填補、批次處理)                   │
 │  Advisory Locks         應用層分散式鎖 (pg_advisory_lock)                 │
 │  Cursor                大量資料逐批處理，避免 OOM                          │
 │  Event Trigger          DDL 事件攔截 (CREATE/ALTER/DROP 監聽)             │
 │  Custom Operator        自定義運算子                                      │
 │  Foreign Data Wrapper   查詢外部資料來源 (其他 DB、CSV、API)               │
 │                                                                          │
 └──────────────────────────────────────────────────────────────────────────┘
```

### PL/pgSQL — 資料庫端程式設計

```sql
-- Data Nexus 的 authz_check() 就是一個典型的 PL/pgSQL 函數

CREATE OR REPLACE FUNCTION authz_check(
    p_user_id    TEXT,
    p_groups     TEXT[],        -- Array 型別
    p_action     TEXT,
    p_resource   TEXT
) RETURNS BOOLEAN              -- 回傳布林
LANGUAGE plpgsql
SECURITY DEFINER               -- 以函數擁有者權限執行 (重要！)
AS $$
DECLARE
    v_allowed BOOLEAN := FALSE;
BEGIN
    -- 1. 查詢角色權限 (RBAC)
    -- 2. 查詢屬性策略 (ABAC)
    -- 3. 合併判斷
    RETURN v_allowed;

EXCEPTION                      -- 錯誤處理
    WHEN OTHERS THEN
        RAISE WARNING 'authz_check error: %', SQLERRM;
        RETURN FALSE;          -- 失敗預設拒絕
END;
$$;
```

**PL/pgSQL 核心能力：**

| 能力 | 說明 | Data Nexus 使用處 |
|------|------|-------------------|
| `SECURITY DEFINER` | 函數以擁有者權限執行，呼叫者不需直接表權限 | `authz_check()`, `authz_resolve()` |
| `EXECUTE ... USING` | 動態 SQL — 運行時組裝查詢 | `authz_filter()` 動態 WHERE |
| `RETURN TABLE` | 回傳虛擬表，可當子查詢用 | `fn_ui_root()`, `fn_ui_page()` |
| `LISTEN / NOTIFY` | 跨程序事件通知 | 快取失效通知 (V011) |
| `RAISE` / `EXCEPTION` | 日誌 + 錯誤處理 | 所有 authz 函數 |

---

## 4. 日常管理營運

### 營運循環圖

```
              ┌──────────────────────────────────────┐
              │           日常營運循環                  │
              └──────────────────┬───────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
  ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
  │   使用者管理   │       │   權限管理    │       │  Schema 管理  │
  │              │       │              │       │              │
  │ CREATE ROLE  │       │ GRANT/REVOKE │       │ CREATE TABLE │
  │ ALTER ROLE   │──────▶│ RLS Policy   │──────▶│ ALTER TABLE  │
  │ pg_hba.conf  │       │ Column Priv  │       │ Migrations   │
  │ 密碼輪替      │       │ Default Priv │       │ info_schema  │
  └──────────────┘       └──────────────┘       └──────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
  ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
  │    監控       │       │   維護排程    │       │   空間管理    │
  │              │       │              │       │              │
  │ pg_stat_*    │       │ VACUUM       │       │ TABLESPACE   │
  │ pg_locks     │◀──────│ REINDEX      │◀──────│ Partitioning │
  │ log analysis │       │ ANALYZE      │       │ TOAST 管理   │
  │ 連線數追蹤    │       │ pg_cron      │       │ 磁碟容量規劃  │
  └──────────────┘       └──────────────┘       └──────────────┘
```

### VACUUM — 為什麼這麼重要？

PostgreSQL 使用 **MVCC**（多版本並行控制），UPDATE/DELETE 不會立刻刪除舊資料：

```
  UPDATE 前：                    UPDATE 後：
  ┌──────────────────┐          ┌──────────────────┐
  │ Row v1 (active)  │          │ Row v1 (dead)    │  ← dead tuple
  └──────────────────┘          ├──────────────────┤
                                │ Row v2 (active)  │  ← 新版本
                                └──────────────────┘

  不 VACUUM 的後果：
  ├── dead tuples 累積 → 表膨脹 (table bloat)
  ├── 索引指向 dead tuples → 查詢變慢
  └── Transaction ID wraparound → 極端情況資料庫停機！
```

| VACUUM 類型 | 做什麼 | 何時用 |
|-------------|--------|--------|
| `VACUUM` | 回收 dead tuples，不縮小檔案 | Autovacuum 自動執行 |
| `VACUUM FULL` | 重寫整張表，完全回收空間 | 停機維護窗口（會鎖表） |
| `VACUUM ANALYZE` | 回收 + 更新統計資訊 | 大量 DML 後 |
| `ANALYZE` | 只更新統計（不回收） | Planner 選錯計畫時 |

### 關鍵監控查詢

```sql
-- 1. 當前活動連線：誰在做什麼？
SELECT pid, usename, state, query, now() - query_start AS duration
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;

-- 2. 表膨脹程度：dead tuple 比例
SELECT schemaname, relname,
       n_live_tup, n_dead_tup,
       ROUND(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 1) AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;

-- 3. 缺少索引的慢查詢候選
SELECT schemaname, relname, seq_scan, idx_scan,
       ROUND(seq_scan::numeric / NULLIF(seq_scan + idx_scan, 0) * 100, 1) AS seq_pct
FROM pg_stat_user_tables
WHERE seq_scan > 1000
ORDER BY seq_pct DESC;

-- 4. 鎖等待：誰卡住誰？
SELECT blocked.pid     AS blocked_pid,
       blocked.query   AS blocked_query,
       blocking.pid    AS blocking_pid,
       blocking.query  AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_locks bl ON bl.pid = blocked.pid
JOIN pg_locks kl ON kl.locktype = bl.locktype
  AND kl.relation = bl.relation AND kl.pid != bl.pid
JOIN pg_stat_activity blocking ON blocking.pid = kl.pid
WHERE NOT bl.granted;
```

### 與 Data Nexus 的關聯

```
 ┌────────────────────────────────────────────────────────────────────┐
 │                                                                    │
 │  Data Nexus 正在自動化 DBA 的權限管理工作：                           │
 │                                                                    │
 │  傳統 DBA 手動操作              Data Nexus 自動化                    │
 │  ────────────────────          ────────────────────                │
 │  GRANT SELECT ON t TO r;   →   authz_role_permission INSERT       │
 │  CREATE POLICY ... ON t;   →   authz_policy + fn_rls_policy()     │
 │  ALTER ROLE ... PASSWORD;  →   authz_db_pool_profile sync         │
 │  手動查權限矩陣             →   Dashboard Permission Matrix         │
 │  口頭通知權限變更           →   authz_audit_log 自動記錄             │
 │                                                                    │
 └────────────────────────────────────────────────────────────────────┘
```

---

## 5. 效能調校 (Performance Tuning)

### Query 生命週期 — 每個環節都能調

```
  SQL 送入
    │
    ▼
  ┌────────────────┐
  │    Parser       │   語法解析，產生 Parse Tree
  └───────┬────────┘
          ▼
  ┌────────────────┐   ◀── 調校重點 ──────────────────────────────────┐
  │    Planner      │   │ EXPLAIN ANALYZE — 看這裡選了什麼計畫          │
  │   (Optimizer)   │   │ 統計資訊是否過時？ → 跑 ANALYZE               │
  └───────┬────────┘   │ 成本參數 → random_page_cost,                 │
          │            │            effective_cache_size               │
          ▼            └──────────────────────────────────────────────┘
  ┌────────────────┐   ◀── 調校重點 ──────────────────────────────────┐
  │   Executor      │   │ 選對 Index → B-tree / GIN / GiST / BRIN    │
  │                 │   │ Seq Scan vs Index Scan 取捨                 │
  └───────┬────────┘   │ 平行查詢 → max_parallel_workers_per_gather   │
          │            └──────────────────────────────────────────────┘
          ▼
  ┌────────────────┐   ◀── 調校重點 ──────────────────────────────────┐
  │ Shared Buffers  │   │ shared_buffers → 通常 RAM 的 25%            │
  │ / Disk I/O      │   │ effective_cache_size → RAM 的 50-75%       │
  └───────┬────────┘   │ work_mem → 排序/Hash 用 (小心別設太大)        │
          │            └──────────────────────────────────────────────┘
          ▼
  ┌────────────────┐   ◀── 調校重點 ──────────────────────────────────┐
  │ WAL / Checkpoint│   │ wal_buffers → WAL 緩衝大小                  │
  │                 │   │ max_wal_size → checkpoint 間隔              │
  └────────────────┘   │ checkpoint_completion_target → 寫入分散度     │
                       └──────────────────────────────────────────────┘
```

### EXPLAIN ANALYZE — DBA 最重要的工具

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM lot_status WHERE product_line = 'SSD-Controller';
```

```
 讀懂執行計畫：
 ─────────────────────────────────────────────────────────────────────
 Seq Scan on lot_status                          ← 掃描方式
   (cost=0.00..25.00 rows=5 width=120)           ← 估算成本/行數
   (actual time=0.015..0.230 rows=5 loops=1)     ← 實際耗時/行數
   Filter: (product_line = 'SSD-Controller')     ← 過濾條件
   Rows Removed by Filter: 95                    ← 被過濾掉的行數
   Buffers: shared hit=10                        ← 記憶體命中 10 pages
 Planning Time: 0.085 ms
 Execution Time: 0.260 ms

 判讀重點：
 ├── rows 估算 vs actual 差很多？ → 統計過時，跑 ANALYZE
 ├── Seq Scan 在大表上？          → 可能需要加 Index
 ├── shared hit vs shared read    → read 多 = 快取不足
 └── Nested Loop 在大表上？       → 考慮改 Hash Join
```

### Index 選擇決策樹

```
                    ┌──────────────────┐
                    │   查詢條件類型？   │
                    └────────┬─────────┘
          ┌─────────┬────────┼────────┬──────────┐
          ▼         ▼        ▼        ▼          ▼
     ┌─────────┐┌───────┐┌───────┐┌───────┐┌─────────┐
     │  等值    ││ 前綴   ││ 全文   ││ JSONB  ││ 範圍    │
     │ WHERE = ││ LIKE   ││ 搜尋   ││ 查詢   ││ BETWEEN │
     └────┬────┘│ 'abc%' │└───┬───┘└───┬───┘└────┬────┘
          │     └───┬───┘    │        │         │
          ▼         ▼        ▼        ▼         ▼
      B-tree     B-tree     GIN    GIN with    BRIN
      (預設)     (預設)   (tsvector) (jsonb_   (大表，按
                                   path_ops)  時間排序)
```

| Index 類型 | 適用場景 | 大小 | 範例 |
|-----------|---------|------|------|
| **B-tree** | `=`, `<`, `>`, `BETWEEN`, `ORDER BY` | 中 | `CREATE INDEX ON lot_status(product_line)` |
| **GIN** | 全文搜尋、JSONB `@>`、Array `&&` | 大 | `CREATE INDEX ON policies USING GIN(config)` |
| **GiST** | 地理資料、範圍重疊 | 中 | `CREATE INDEX ON events USING GiST(period)` |
| **BRIN** | 大表按物理順序排列的欄位 (時間戳) | 極小 | `CREATE INDEX ON logs USING BRIN(created_at)` |
| **Partial** | 只索引部分資料 | 小 | `CREATE INDEX ON orders(id) WHERE status='active'` |

### postgresql.conf 關鍵參數速查

```
 ┌─ 記憶體 ──────────────────────────────────────────────────────────┐
 │                                                                   │
 │  shared_buffers        = '4GB'     # RAM 的 25% (資料頁快取)       │
 │  effective_cache_size  = '12GB'    # RAM 的 50-75% (Planner 參考)  │
 │  work_mem              = '64MB'    # 每個排序/Hash 操作的記憶體      │
 │  maintenance_work_mem  = '1GB'     # VACUUM / CREATE INDEX 用      │
 │                                                                   │
 ├─ WAL & Checkpoint ────────────────────────────────────────────────┤
 │                                                                   │
 │  wal_buffers                    = '64MB'                          │
 │  max_wal_size                   = '4GB'   # checkpoint 間隔上限    │
 │  checkpoint_completion_target   = 0.9     # 寫入均勻分散            │
 │                                                                   │
 ├─ 連線 ────────────────────────────────────────────────────────────┤
 │                                                                   │
 │  max_connections        = 200      # 搭配 PgBouncer 可設較低       │
 │  idle_in_transaction_session_timeout = '5min'  # 清理閒置交易       │
 │                                                                   │
 ├─ 平行查詢 ────────────────────────────────────────────────────────┤
 │                                                                   │
 │  max_parallel_workers_per_gather  = 4                             │
 │  max_parallel_workers             = 8                             │
 │  parallel_tuple_cost              = 0.01                          │
 │                                                                   │
 ├─ 日誌 ────────────────────────────────────────────────────────────┤
 │                                                                   │
 │  log_min_duration_statement  = '500ms'   # 慢查詢門檻              │
 │  log_checkpoints             = on                                 │
 │  log_lock_waits              = on                                 │
 │  log_temp_files              = 0         # 記錄所有暫存檔           │
 │                                                                   │
 └───────────────────────────────────────────────────────────────────┘
```

### 常用診斷工具

| 工具 | 用途 | 安裝方式 |
|------|------|---------|
| `EXPLAIN (ANALYZE, BUFFERS)` | 單一查詢效能分析 | 內建 |
| `pg_stat_statements` | Top SQL 排行榜 (累計耗時) | `CREATE EXTENSION` |
| `pg_stat_user_tables` | 表的讀寫熱度、seq vs idx scan | 內建 view |
| `pg_stat_activity` | 當前連線狀態、正在執行的 SQL | 內建 view |
| `pg_locks` | 鎖等待分析 | 內建 view |
| `auto_explain` | 自動記錄慢查詢的執行計畫 | 內建 module |
| `pgBadger` | 日誌分析、報表產生 | 外部工具 |
| `pg_stat_monitor` | pg_stat_statements 加強版 | Extension |

---

## 6. 高可用與備份復原 (HA & DR)

### 複寫架構

```
                          ┌──────────────┐
                          │  Application │
                          │  / 負載均衡   │
                          └──────┬───────┘
                                 │
                    寫入 ────────┼──────── 唯讀
                    │                      │
                    ▼                      ▼
        ┌───────────────────┐  ┌───────────────────┐
        │                   │  │                   │
        │  Primary (主庫)    │  │  Standby (備庫)    │
        │  ─────────────    │  │  ─────────────    │
        │  接受所有讀寫      │  │  接受唯讀查詢      │
        │                   │  │  (hot_standby=on) │
        │  WAL 產生 ────────────▶ WAL 接收 & 重放   │
        │       (Streaming Replication)            │
        │                   │  │                   │
        └─────────┬─────────┘  └─────────┬─────────┘
                  │                      │
                  │  WAL Archive         │ 可串接更多
                  ▼                      ▼
        ┌───────────────────┐  ┌───────────────────┐
        │  Archive Storage  │  │  Cascading Standby│
        │  (S3 / NFS)       │  │  (第二層唯讀)      │
        │                   │  │                   │
        │  用於 PITR         │  │  分散讀取負載      │
        │  (時間點還原)       │  │                   │
        └───────────────────┘  └───────────────────┘
```

### 備份策略三層堆疊

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                                                                      │
 │  Layer 3 ▲  持續複寫 (Continuous Replication)                        │
 │          │  ─────────────────────────────────                        │
 │  即時     │  Streaming Replication    即時 HA、自動 failover          │
 │  ↑       │  Logical Replication      選擇性表同步、跨版本、跨叢集     │
 │  ↓       │                                                          │
 │  離線     │  Layer 2  物理備份 (Physical Backup)                      │
 │          │  ─────────────────────────────────                        │
 │          │  pg_basebackup + WAL archiving                           │
 │          │  支援 PITR (Point-in-Time Recovery)                       │
 │          │  「還原到今天下午 2:30 的狀態」                               │
 │          │                                                          │
 │          │  Layer 1  邏輯備份 (Logical Backup)                       │
 │          ▼  ─────────────────────────────────                        │
 │             pg_dump / pg_dumpall                                     │
 │             SQL 文字格式，可跨版本還原                                  │
 │             適合小型資料庫、schema 遷移                                 │
 │                                                                      │
 └──────────────────────────────────────────────────────────────────────┘
```

### 工具生態系

| 工具 | 定位 | 特色 |
|------|------|------|
| **pgBackRest** | 企業級備份 | 增量備份、並行壓縮、加密、S3 支援 |
| **Patroni** | 自動 failover | 搭配 etcd/ZK，自動選主、自動切換 |
| **PgBouncer** | 連線池 | 輕量、transaction pooling |
| **Pgpool-II** | 連線池 + 讀寫分離 | 自動路由 SELECT → Standby |
| **repmgr** | 複寫管理 | 簡化 Standby 建立和 switchover |

> Data Nexus 已使用 **PgBouncer** 作為 Path C 的連線池層，搭配 `authz_db_pool_profile` 做權限感知的連線路由。

---

## 7. 安全性 (Security)

### 三道防線

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                                                                      │
 │   第 1 道：認證 (Authentication) — 你是誰？                            │
 │   ─────────────────────────────────────────                          │
 │                                                                      │
 │   pg_hba.conf 決定：                                                  │
 │   ┌──────────────┬────────────────────────────────────────────┐      │
 │   │ 認證方式      │ 說明                                       │      │
 │   ├──────────────┼────────────────────────────────────────────┤      │
 │   │ trust        │ 不需密碼 (僅限本機開發)                      │      │
 │   │ scram-sha-256│ 密碼雜湊 (PG 10+ 推薦)                     │      │
 │   │ md5          │ 舊式密碼雜湊 (逐步淘汰)                     │      │
 │   │ cert         │ SSL 客戶端憑證                              │      │
 │   │ ldap         │ LDAP 目錄認證  ◀── Data Nexus 使用         │      │
 │   │ gss/kerberos │ 企業級 SSO                                 │      │
 │   └──────────────┴────────────────────────────────────────────┘      │
 │                                                                      │
 ├──────────────────────────────────────────────────────────────────────┤
 │                                                                      │
 │   第 2 道：授權 (Authorization) — 你能做什麼？                         │
 │   ─────────────────────────────────────────                          │
 │                                                                      │
 │   ┌─────────────────────────────────────────────────────────────┐    │
 │   │                                                             │    │
 │   │  GRANT / REVOKE            表層級、Schema 層級權限           │    │
 │   │      │                                                      │    │
 │   │      ├── Table Privileges   SELECT, INSERT, UPDATE, DELETE  │    │
 │   │      ├── Column Privileges  GRANT SELECT(col1, col2) ON t   │    │
 │   │      ├── Function Privileges GRANT EXECUTE ON FUNCTION      │    │
 │   │      └── Schema Privileges  GRANT USAGE ON SCHEMA           │    │
 │   │                                                             │    │
 │   │  Row Level Security (RLS)  行級過濾                          │    │
 │   │      │                                                      │    │
 │   │      ├── ALTER TABLE t ENABLE ROW LEVEL SECURITY;           │    │
 │   │      └── CREATE POLICY p ON t                               │    │
 │   │            USING (department = current_setting('app.dept'))  │    │
 │   │                                                             │    │
 │   │  SECURITY DEFINER          函數權限提升                      │    │
 │   │      └── 呼叫者不需表權限，函數以擁有者身份執行                 │    │
 │   │                                                             │    │
 │   └─────────────────────────────────────────────────────────────┘    │
 │   ◀── Data Nexus 自動化管理整個授權層                                 │
 │                                                                      │
 ├──────────────────────────────────────────────────────────────────────┤
 │                                                                      │
 │   第 3 道：加密 (Encryption) — 資料安全                               │
 │   ─────────────────────────────────────────                          │
 │                                                                      │
 │   傳輸層   SSL/TLS 連線加密 (ssl = on in postgresql.conf)             │
 │   儲存層   pgcrypto 欄位加密 (敏感欄位如密碼、身分證)                   │
 │   磁碟層   Transparent Data Encryption (TDE, PG 16 community 討論中) │
 │   備份層   pgBackRest 支援 AES-256 備份加密                           │
 │                                                                      │
 ├──────────────────────────────────────────────────────────────────────┤
 │                                                                      │
 │   稽核 (Audit) — 誰做了什麼？                                         │
 │   ─────────────────────────────────────────                          │
 │                                                                      │
 │   pgAudit extension          企業級 SQL 操作稽核日誌                   │
 │   log_statement = 'all'      基本 SQL 記錄 (效能影響大)                │
 │   authz_audit_log            應用層稽核 ◀── Data Nexus 已實作         │
 │   authz_admin_audit_log      管理操作稽核 ◀── Data Nexus V027         │
 │                                                                      │
 └──────────────────────────────────────────────────────────────────────┘
```

---

## 8. 學習路徑 — Data Nexus 對照

### 你已覆蓋的 vs 建議加強的

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                                                                         │
 │  已透過 Data Nexus 專案實戰覆蓋                                          │
 │  ════════════════════════════════                                       │
 │                                                                         │
 │  ✅ PL/pgSQL 函數開發     authz_check, authz_resolve, fn_ui_*          │
 │  ✅ RLS / GRANT 管理      Path C 自動同步 PG 原生權限                    │
 │  ✅ 權限系統設計           L0-L3 四層模型 + RBAC/ABAC 混合               │
 │  ✅ Migration 管理        V001-V029 循序 SQL 遷移                       │
 │  ✅ PgBouncer 連線池      Path C 連線路由 + pool profile                │
 │  ✅ Docker Compose 部署   PG 16 + Redis + OpenLDAP 本地環境             │
 │  ✅ LISTEN / NOTIFY       快取失效通知機制 (V011)                        │
 │  ✅ Dynamic SQL           authz_filter() 動態 WHERE 組裝                │
 │  ✅ JSONB 操作            column_mask_rules, approval_chain 等          │
 │                                                                         │
 ├─────────────────────────────────────────────────────────────────────────┤
 │                                                                         │
 │  建議優先加強 — 生產上線前必備                                             │
 │  ════════════════════════════════                                       │
 │                                                                         │
 │  🔶 EXPLAIN ANALYZE        學會讀執行計畫，判斷該不該加 Index             │
 │  🔶 Index 策略選擇          B-tree / GIN / BRIN 的取捨                  │
 │  🔶 postgresql.conf 調參   shared_buffers, work_mem 等記憶體參數         │
 │  🔶 pg_stat_statements     找出最耗資源的 Top 10 SQL                    │
 │  🔶 VACUUM / ANALYZE 原理  理解 MVCC、dead tuple、autovacuum 調校       │
 │  🔶 Lock 診斷              長交易卡住的排查流程                           │
 │                                                                         │
 ├─────────────────────────────────────────────────────────────────────────┤
 │                                                                         │
 │  進階方向 — 擴展和高可用                                                  │
 │  ════════════════════════════════                                       │
 │                                                                         │
 │  🔷 Patroni HA 叢集        自動 failover，生產必備                       │
 │  🔷 pg_basebackup + PITR   時間點還原，災難復原基礎                       │
 │  🔷 Logical Replication    跨版本、選擇性同步 (未來多站部署用)             │
 │  🔷 Partitioning           大表分割策略 (audit_log 會長很快)              │
 │  🔷 pgBackRest             企業級增量備份                                │
 │  🔷 Extension 開發         C 語言寫 PG 擴充 (最終形態)                   │
 │                                                                         │
 └─────────────────────────────────────────────────────────────────────────┘
```

### 建議學習順序

```
  現在                    1-2 個月                  3-6 個月
  (Data Nexus 上線前)     (生產穩定後)              (擴展期)
  ─────────────────      ─────────────────        ─────────────────

  1. EXPLAIN ANALYZE      4. Patroni HA            7. Logical Replication
  2. Index 策略           5. pgBackRest + PITR     8. Partitioning 策略
  3. postgresql.conf      6. pg_stat_statements    9. Extension 開發
     基礎調參                深度分析

  每一步都能直接應用在 Data Nexus：
  ├── Step 1-2: 優化 authz_check / authz_resolve 查詢效能
  ├── Step 3:   生產環境參數規劃
  ├── Step 4-5: 生產高可用 + 備份策略
  └── Step 6+:  長期效能監控和架構擴展
```

---

> **最後一句話：** DBA 的核心價值不是記住所有參數，而是「出事時知道去哪裡看、怎麼判斷、如何修復」。Data Nexus 專案已經讓你在安全性和權限管理上走得很深，接下來補上效能調校和備份復原，就是一個能獨立管理生產環境的 DBA 了。
