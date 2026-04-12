# Phison Data Nexus — Business DB 分離規劃

**文件類型**：實作指引  
**建立日期**：2026-04-12  
**對應 backlog**：ARCH-01  
**狀態**：規劃中（未開始實作）

---

## 一、背景：為什麼要拆

### POC 現狀的設計決策

目前 `docker-compose.yml` 只起一個 PostgreSQL instance，所有資料都放在 `nexus_authz` 這個 database：

- **Policy store**：`authz_subject`、`authz_role`、`authz_policy`、`authz_role_permission` 等 15 張 authz_* 表
- **Business data**：`lot_status`（21 筆）、`sales_order`（14 筆）
- **PG functions**：`authz_resolve()`、`authz_check()`、`authz_filter()` 等全部在同一個 DB
- **Native PG roles + RLS**：V019 在同一個 DB 裡建立 pool roles 並設定 RLS

這個設計在 POC 階段有充分理由：初始化腳本簡單（`init-db.sh` 線性跑完所有 V*.sql）、可在本地一個 `make up` 就啟動、方便 RLS 演示。

### 生產環境的必要分離

| 問題面向 | 說明 |
|---------|------|
| **安全隔離** | Policy store 被攻破不應等同業務資料外洩；反之亦然 |
| **運維分工** | AuthZ 服務的 DB 由平台團隊維護；業務資料由各產品線 DBA 維護 |
| **連線模型** | Path C 的 pool roles（`nexus_pe_ro` 等）連的是業務資料，不需要也不該接觸 policy store |
| **備份策略** | Policy config 和業務資料的備份週期、保留策略不同 |
| **水平擴展** | 業務 DB 可能需要 read replica；authz DB 通常不需要 |
| **多業務系統** | 未來多個業務系統共用同一個 authz policy store，每個業務有自己的 data DB |

---

## 二、目前現狀：哪些東西混在 nexus_authz

### 2.1 資料庫物件清單

```
nexus_authz（目前唯一的 DB）
│
├── [Policy Store — 應留在 nexus_authz]
│   ├── authz_subject            (V002)
│   ├── authz_resource           (V002)
│   ├── authz_action             (V002)
│   ├── authz_role               (V002)
│   ├── authz_role_permission    (V002)
│   ├── authz_subject_role       (V002)
│   ├── authz_policy             (V003)
│   ├── authz_composite_action   (V003)
│   ├── authz_mask_function_reg  (V003)
│   ├── authz_pool_profile       (V004)
│   ├── authz_pool_assignment    (V004)
│   ├── authz_pool_credentials   (V004)
│   ├── authz_sync_log           (V005)
│   ├── authz_audit_log          (V005)
│   ├── authz_policy_version     (V006)
│   ├── authz_group_member       (V018)
│   └── [PG functions: authz_resolve, authz_check, authz_filter ...]
│
└── [Business Data — 應移至 nexus_data]
    ├── lot_status               (V014)  ← 21 筆 sample 資料
    ├── sales_order              (V014)  ← 14 筆 sample 資料
    └── [RLS + GRANTs on above tables]  (V019)
```

### 2.2 V019 的物件歸屬分析

V019 包含兩類性質不同的物件：

| 物件 | 目前位置 | 應移至 |
|------|---------|--------|
| `CREATE ROLE nexus_pe_ro` 等 5 個 PG roles | 叢集層（共用） | 叢集層（不變，PG roles 是 cluster-level 物件） |
| `GRANT SELECT ON lot_status TO nexus_pe_ro` | nexus_authz | nexus_data |
| `ALTER TABLE lot_status ENABLE ROW LEVEL SECURITY` | nexus_authz | nexus_data |
| `CREATE POLICY lot_pe_product_line ON lot_status` | nexus_authz | nexus_data |
| `CREATE VIEW v_lot_status_pe` | nexus_authz | nexus_data |
| `INSERT INTO authz_sync_log ...` | nexus_authz | nexus_authz（保留） |

> **重要**：PostgreSQL 的 PG roles（`nexus_pe_ro` 等）是 cluster-level 物件，對同一個 PostgreSQL instance 上的所有 DB 都可見。拆分後兩個 DB 在同一個 cluster（同一個 container）時，roles 不需要重建，只需要把 GRANT 和 RLS 移到 `nexus_data`。

### 2.3 應用層現狀

`services/authz-api/src/db.ts` 目前只有一個 pool：

```typescript
export const pool = new Pool({
  database: process.env.DB_NAME || 'nexus_authz',
  // ...
});
```

`rls-simulate.ts` 用同一個 pool 同時查 authz functions（Step 1-2）和業務資料（Step 4：`SELECT ... FROM lot_status`）。拆分後需要兩個 pool。

---

## 三、目標架構

### 3.1 DB 職責劃分

```
┌─────────────────────────────────────┐   ┌─────────────────────────────────────┐
│         nexus_authz                 │   │         nexus_data                  │
│  （AuthZ Policy Store）              │   │  （Business Data）                   │
│                                     │   │                                     │
│  authz_subject                      │   │  lot_status                         │
│  authz_role                         │   │  sales_order                        │
│  authz_policy                       │   │  [未來：其他業務表]                   │
│  authz_role_permission              │   │                                     │
│  authz_pool_profile                 │   │  [RLS policies 在這裡]               │
│  authz_pool_credentials             │   │  [Column-level GRANTs 在這裡]        │
│  authz_group_member                 │   │  [Masking views 在這裡]              │
│  authz_audit_log                    │   │                                     │
│                                     │   │  連線入口：pgbouncer:6432            │
│  authz_resolve()                    │   │  （pool roles 直接連此 DB）           │
│  authz_check()                      │   │                                     │
│  authz_filter() → 回傳 WHERE clause │   └─────────────────────────────────────┘
│                                     │
│  連線入口：5432（authz-api 專用）    │
└─────────────────────────────────────┘
                    │
                    │ WHERE clause（跨 DB 注入，非跨 DB 查詢）
                    ▼
          authz-api（應用層）
          ├── authzPool → nexus_authz:5432
          └── dataPool  → nexus_data:5432
```

### 3.2 連線流量模型

| 用途 | 連線路徑 |
|------|---------|
| authz-api 查詢 policy functions | `authz-api → nexus_authz:5432`（直連，不走 pgbouncer） |
| authz-api 查詢業務資料 | `authz-api → nexus_data:5432`（或透過 pgbouncer） |
| Path C 應用程式直連 | `app → pgbouncer:6432 → nexus_data:5432` |
| Path C RLS 生效 | `nexus_pe_ro` 連到 nexus_data，RLS policies 在 nexus_data 觸發 |

---

## 四、跨 DB 查詢方案比較

分離後，核心問題是：**業務資料在 nexus_data，但 RLS filter 邏輯（`authz_filter()`）在 nexus_authz，如何讓兩者協作？**

### 方案一：應用層 API 注入（推薦）

```
[目前已有的架構延伸]

authz-api 先呼叫 authzPool 取得 WHERE clause：
  SELECT authz_filter($1,$2,$3,$4,$5) → "product_line = 'SSD'"

authz-api 再用 dataPool 執行業務查詢：
  SELECT * FROM lot_status WHERE product_line = 'SSD'
```

**優點**：
- 完全不需要 DB-level 跨 DB 能力
- `rls-simulate.ts` 已有此模式的雛形（兩步驟：先取 filter，再查資料）
- 最容易測試、最容易 debug
- authz-api 可以做 filter clause 的白名單驗證，防止 injection

**缺點**：
- 業務資料的 RLS 完全依賴應用層注入，沒有 DB-level 的 hard enforcement
- Path C（直連 nexus_data）的 RLS 必須另外建立（不能依靠 `authz_filter()`）

**適用場景**：Path A（Config-SM UI）、Path B（Web API）

---

### 方案二：dblink

```sql
-- 在 nexus_data 建立 extension + helper function
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE OR REPLACE FUNCTION get_authz_filter(
  p_user_id TEXT, p_groups TEXT[], p_attrs JSONB,
  p_resource_type TEXT, p_path TEXT
) RETURNS TEXT AS $$
  SELECT filter_clause FROM dblink(
    'dbname=nexus_authz user=nexus_admin password=...',
    format('SELECT authz_filter(%L, %L, %L, %L, %L)',
           p_user_id, p_groups, p_attrs, p_resource_type, p_path)
  ) AS t(filter_clause TEXT);
$$ LANGUAGE SQL;
```

**優點**：
- RLS USING clause 可以直接 call `get_authz_filter()`，實現 DB-level 強制
- Path C 的 RLS 也能依賴 authz policy store

**缺點**：
- 連線字串和密碼硬編碼在 DB function 裡（安全隱患）
- 每次 RLS 觸發都會產生一個新的 DB 連線（效能問題）
- `transaction` pool mode 的 pgbouncer 與 dblink 相容性差
- 測試複雜度大幅提升

**建議**：暫不採用，除非 Path C 的 DB-level 強制是硬性需求。

---

### 方案三：postgres_fdw

```sql
-- 在 nexus_data 建立 foreign server 連到 nexus_authz
CREATE EXTENSION IF NOT EXISTS postgres_fdw;
CREATE SERVER authz_server FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host 'postgres', dbname 'nexus_authz');
CREATE USER MAPPING FOR nexus_pe_ro SERVER authz_server
  OPTIONS (user 'nexus_admin', password '...');

-- 把 authz_policy 等表 import 進來
IMPORT FOREIGN SCHEMA public LIMIT TO (authz_policy, authz_role_permission)
  FROM SERVER authz_server INTO authz_fdw;
```

**優點**：
- nexus_data 內的 function 可以讀取 authz 表做判斷
- 不需要字串拼接 DB 連線

**缺點**：
- 維護成本高（schema 變更要同步更新 FDW mapping）
- 效能比 dblink 更難預測
- 導入了資料複製不一致的風險

**建議**：不適合此場景，過度複雜。

---

### 決策建議

```
Path A / Path B：採用「方案一：應用層注入」
Path C（直連）：在 nexus_data 建立獨立的 RLS policies（不依賴 authz_filter()）
              RLS USING clause 改用 pg_has_role() 或 current_setting() 判斷
```

這個決策同時解決了 backlog 中的 ARCH-03（Path A/C 共用 RLS 的矛盾）：兩個路徑本來就不該共用同一份 RLS policy，Path A 的 filter 由應用層負責，Path C 的 RLS 由 nexus_data 內的 native PG policies 負責。

---

## 五、分離步驟

### Step 0：建立分支

```bash
git checkout -b feat/business-db-separation
```

---

### Step 1：docker-compose 新增 nexus_data 服務

**檔案**：`deploy/docker-compose/docker-compose.yml`

新增一個獨立的 postgres service（或在同一個 instance 用 `CREATE DATABASE`）：

**方案 A：同一個 PG instance，兩個 DB（建議，本地 dev 最簡單）**

在 `init-db.sh` 裡新增建立第二個 DB 的邏輯：

```bash
# init-db.sh 開頭加入
psql -U "$POSTGRES_USER" -c "CREATE DATABASE nexus_data;"
```

**方案 B：兩個獨立的 postgres service（更貼近生產隔離）**

```yaml
postgres-data:
  image: postgres:16-alpine
  environment:
    POSTGRES_DB: nexus_data
    POSTGRES_USER: nexus_admin
    POSTGRES_PASSWORD: nexus_dev_password
  ports:
    - "5433:5432"
  volumes:
    - pgdata_data:/var/lib/postgresql/data
    - ./init-data-db.sh:/docker-entrypoint-initdb.d/00-init-data-db.sh:ro
```

> **建議先實作方案 A（同一 instance 兩個 DB）**，生產再切換方案 B，遷移成本低。

---

### Step 2：拆分 init scripts

**目前**：`init-db.sh` 把所有 `V*.sql` 全部跑進 `nexus_authz`

**改後**：

```
database/
├── migrations/
│   ├── authz/          ← 只含 authz 相關（V001-V013, V015-V018）
│   │   ├── V001__enum_types.sql
│   │   ├── ...
│   │   └── V018__group_membership.sql
│   └── data/           ← 業務 DB 的 migration
│       ├── V001__business_tables.sql    (現在的 V014 內容)
│       └── V002__path_c_rls.sql         (現在的 V019 拆分後的 GRANTs + RLS)
```

`init-db.sh` 改為分別初始化兩個 DB：

```bash
#!/bin/bash
set -e

# Create nexus_data if not exists
psql -U "$POSTGRES_USER" -c "SELECT 1 FROM pg_database WHERE datname='nexus_data'" | grep -q 1 \
  || psql -U "$POSTGRES_USER" -c "CREATE DATABASE nexus_data;"

# Initialize nexus_authz (policy store)
echo "Initializing nexus_authz..."
for f in /docker-entrypoint-initdb.d/migrations/authz/V*.sql; do
    [ -f "$f" ] && psql -U "$POSTGRES_USER" -d nexus_authz -f "$f" && echo "  Applied $(basename $f)"
done

# Initialize nexus_data (business data)
echo "Initializing nexus_data..."
for f in /docker-entrypoint-initdb.d/migrations/data/V*.sql; do
    [ -f "$f" ] && psql -U "$POSTGRES_USER" -d nexus_data -f "$f" && echo "  Applied $(basename $f)"
done

# Seed data
for f in /docker-entrypoint-initdb.d/seed/authz/*.sql; do
    [ -f "$f" ] && psql -U "$POSTGRES_USER" -d nexus_authz -f "$f"
done
for f in /docker-entrypoint-initdb.d/seed/data/*.sql; do
    [ -f "$f" ] && psql -U "$POSTGRES_USER" -d nexus_data -f "$f"
done
```

---

### Step 3：拆分 V014 和 V019

**V014（業務資料表）→ 移至 `database/migrations/data/V001__business_tables.sql`**

內容不變，只是改跑進 `nexus_data`。

**V019（PG roles + RLS）→ 拆成兩份**

`database/migrations/authz/V019__path_c_roles_register.sql`（在 nexus_authz 執行）：
- 保留 `INSERT INTO authz_sync_log` 的記錄
- 其餘移除

`database/migrations/data/V002__path_c_rls.sql`（在 nexus_data 執行）：
- CREATE ROLE 語句（PG roles 是 cluster-level，兩個 DB 都可以發這個命令，幂等即可）
- 所有 GRANT 語句（GRANT ON lot_status / sales_order）
- ALTER TABLE ... ENABLE ROW LEVEL SECURITY
- 所有 CREATE POLICY 語句
- CREATE VIEW v_lot_status_pe 等

---

### Step 4：pgbouncer 新增 nexus_data 入口

**檔案**：`deploy/docker-compose/pgbouncer/pgbouncer.ini`

```ini
[databases]
; AuthZ policy store — authz-api 直連，不走 pgbouncer
nexus_authz = host=postgres port=5432 dbname=nexus_authz

; Business data — Path C pool roles 的連線目標
nexus_data = host=postgres port=5432 dbname=nexus_data
```

`deploy/docker-compose/pgbouncer/userlist.txt` 需確認 `nexus_pe_ro` 等 pool roles 的密碼已包含。

`deploy/docker-compose/pg_hba_custom.conf` 需確認 nexus_data DB 的連線規則：

```
# nexus_data business DB
host nexus_data nexus_pe_ro   0.0.0.0/0 md5
host nexus_data nexus_sales_ro 0.0.0.0/0 md5
host nexus_data nexus_bi_ro   0.0.0.0/0 md5
host nexus_data nexus_etl_rw  0.0.0.0/0 md5
```

---

### Step 5：authz-api 加入第二個 DB pool

**檔案**：`services/authz-api/src/db.ts`

```typescript
import { Pool } from 'pg';

// Policy store — authz functions, policy tables
export const authzPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.AUTHZ_DB_NAME || 'nexus_authz',
  user: process.env.DB_USER || 'nexus_admin',
  password: process.env.DB_PASSWORD || 'nexus_dev_password',
  max: 10,
});

// Business data — lot_status, sales_order, etc.
export const dataPool = new Pool({
  host: process.env.DATA_DB_HOST || 'localhost',
  port: parseInt(process.env.DATA_DB_PORT || '5432'),
  database: process.env.DATA_DB_NAME || 'nexus_data',
  user: process.env.DATA_DB_USER || 'nexus_admin',
  password: process.env.DATA_DB_PASSWORD || 'nexus_dev_password',
  max: 10,
});

// Backward compatibility export (for routes that only need authz DB)
export const pool = authzPool;
```

**.env 新增**（`deploy/docker-compose/.env` 或 `services/authz-api/.env`）：

```
AUTHZ_DB_NAME=nexus_authz
DATA_DB_NAME=nexus_data
DATA_DB_HOST=localhost
DATA_DB_PORT=5432
DATA_DB_USER=nexus_admin
DATA_DB_PASSWORD=nexus_dev_password
```

---

### Step 6：更新 rls-simulate.ts

**檔案**：`services/authz-api/src/routes/rls-simulate.ts`

```typescript
import { authzPool, dataPool } from '../db';

// Step 1: Get RLS filter → authzPool (nexus_authz)
const filterResult = await authzPool.query(
  'SELECT authz_filter($1, $2, $3, $4, $5) AS filter_clause', ...
);

// Step 2: Get column masks → authzPool
const resolveResult = await authzPool.query(
  'SELECT authz_resolve($1, $2, $3) AS config', ...
);

// Step 3: Get column list → dataPool (nexus_data)
const colResult = await dataPool.query(`
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = $1 ...
`, [table]);

// Step 4: Deny columns → authzPool (policy tables still in nexus_authz)
const denyCheckResult = await authzPool.query(
  'SELECT _authz_resolve_roles($1, $2) AS roles', ...
);
const denyResult = await authzPool.query(
  'SELECT rp.resource_id FROM authz_role_permission ...', ...
);

// Step 5: Final SELECT → dataPool
const dataResult = await dataPool.query(query);
const totalResult = await dataPool.query(`SELECT count(*)::int AS total FROM ${table}`);
```

---

### Step 7：更新其他 routes

以下 routes 僅使用 authz tables，繼續使用 `authzPool`（或原有的 `pool` alias）不需改動：
- `resolve.ts`、`check.ts`、`filter.ts`、`matrix.ts`
- `middleware/authz.ts`
- `browse.ts`（browse 的是 authz SSOT 表）
- `pool.ts`（pool 管理的是 authz_pool_* 表）

> `browse.ts` 的 `/browse/tables` 和 `/browse/functions` 目前查的是 `nexus_authz` 的 `information_schema`。拆分後如果需要顯示業務 DB 的 tables/functions，需另外建立 `/browse/data-tables` endpoint 使用 `dataPool`，或讓現有 endpoint 接受 `?db=data` 參數。

---

## 六、各路徑受影響分析

### Path A：Config-as-State-Machine UI

| 組件 | 影響 | 調整方式 |
|------|------|---------|
| `authz_resolve()` | 無影響，函式在 nexus_authz | 不變 |
| RLS Simulator（`rls-simulate.ts`） | Step 5-6 所述的 pool 分離 | 改用雙 pool |
| WorkbenchTab 的 `api.rlsSimulate()` | 無影響（API 不變，後端透明處理） | 不變 |
| `authz_filter()` 回傳的 WHERE clause | 函式在 nexus_authz，clause 注入到 dataPool 查詢 | 已是現有設計 |

**影響評估**：小。主要是 `rls-simulate.ts` 的 pool 切換。

---

### Path B：Web API + AuthZ Middleware

| 組件 | 影響 | 調整方式 |
|------|------|---------|
| `requireRole()` / `requirePermission()` middleware | 查 authz_role_permission（nexus_authz）| 繼續用 `authzPool` |
| API routes 的業務資料查詢 | 若有直接 `SELECT FROM lot_status`，需改用 `dataPool` | 逐一檢查 `routes/*.ts` |
| `authz_filter()` 注入 WHERE clause | 不變（取 clause 用 authzPool，執行查詢用 dataPool）| 標準 2-step 模式 |

**影響評估**：中。需要檢視每個 route 哪些查詢需要切換 pool。

---

### Path C：Direct DB Connection

| 組件 | 影響 | 調整方式 |
|------|------|---------|
| pgbouncer 連線目標 | 必須改指向 nexus_data | Step 4 |
| pool roles 的 GRANT | GRANT 需在 nexus_data 執行 | Step 3 |
| RLS policies | 需在 nexus_data 內建立 | Step 3 |
| `authz_sync_db_grants()` | 目前在 nexus_authz 執行 REVOKE/GRANT，拆分後這些 DDL 需對 nexus_data 執行 | 函式需改為 dblink 到 nexus_data，或改由應用層執行 |
| `authz_sync_pgbouncer_config()` | 需更新 `[databases]` section 指向 nexus_data | Step 4 + 函式更新 |

**影響評估**：大。`authz_sync_db_grants()` 是跨 DB 操作（在 nexus_authz 執行，但 DDL 效果要在 nexus_data 生效），這是最複雜的部分。

#### Path C 的 `authz_sync_db_grants()` 問題解決方案

**選項 A（推薦）**：改由應用層（`pool.ts`）執行 GRANT/REVOKE

```typescript
// pool.ts 的 /pool/sync/grants 端點
// 步驟 1：從 authzPool 取得需要的 GRANT SQL
const grantsResult = await authzPool.query('SELECT authz_sync_db_grants()');
const grantSqls = grantsResult.rows[0].authz_sync_db_grants.actions;

// 步驟 2：用 dataPool 執行這些 DDL
for (const { action: sql } of grantSqls) {
  await dataPool.query(sql);
}
```

**選項 B**：`authz_sync_db_grants()` 函式內部用 dblink 連到 nexus_data 執行 DDL（需要 superuser 權限，安全隱患大，不建議）

---

## 七、驗證清單

拆分完成後，按以下順序驗證：

### 7.1 初始化驗證

- [ ] `make db-reset` 成功建立 `nexus_authz` 和 `nexus_data` 兩個 DB
- [ ] `psql -d nexus_authz -c '\dt'` 顯示所有 authz_* 表，不含 lot_status / sales_order
- [ ] `psql -d nexus_data -c '\dt'` 顯示 lot_status 和 sales_order
- [ ] `psql -d nexus_data -c 'SELECT count(*) FROM lot_status'` 回傳 21
- [ ] `psql -d nexus_data -c 'SELECT count(*) FROM sales_order'` 回傳 14

### 7.2 Path A 驗證

- [ ] `make q-resolve` 成功（`authz_resolve()` 仍在 nexus_authz 正常運作）
- [ ] Dashboard RLS Simulator tab → PE SSD 用戶 → 只看到 SSD 的 lot，不含 eMMC/SD/PCIe
- [ ] Dashboard RLS Simulator tab → PE SSD 用戶 → `unit_price` 和 `cost` 顯示 `[DENIED]`
- [ ] `filtered_count` < `total_count`（確認 filter 有生效）

### 7.3 Path B 驗證

- [ ] `POST /api/filter` 回傳正確的 WHERE clause
- [ ] `POST /api/rls/simulate` 回傳業務資料（從 nexus_data 取得）
- [ ] `POST /api/check` 仍正常（查 nexus_authz）

### 7.4 Path C 驗證

- [ ] `psql -h localhost -p 6432 -U nexus_pe_ro -d nexus_data`（pgbouncer 導向正確 DB）
- [ ] `SET app.product_line = 'SSD'; SELECT * FROM lot_status;` → 只回傳 SSD rows
- [ ] `SET app.product_line = 'SSD'; SELECT unit_price FROM lot_status;` → 回傳 Permission denied（column GRANT 生效）
- [ ] `psql -h localhost -p 6432 -U nexus_sales_ro -d nexus_data`
- [ ] `SET app.region = 'TW'; SELECT * FROM sales_order;` → 只回傳 TW 訂單

### 7.5 AuthZ Admin 驗證

- [ ] Pool Management tab → 新增/編輯/刪除 profile 仍正常（操作 nexus_authz）
- [ ] Sync Grants → Pool 角色的 GRANT 正確在 nexus_data 執行
- [ ] Sync pgbouncer → 產生的 config 包含 nexus_data 的 `[databases]` entry

### 7.6 Regression 驗證

- [ ] `make verify`（milestone-1 驗證腳本）仍全部通過
- [ ] Audit log 繼續寫入（`authz_audit_log` 在 nexus_authz）

---

## 八、狀態追蹤

| 步驟 | 工作項目 | 狀態 | 負責人 | 備註 |
|------|---------|------|--------|------|
| Step 0 | 建立 feature branch | ⬜ 未開始 | — | |
| Step 1 | docker-compose 新增 nexus_data DB | ⬜ 未開始 | — | 建議方案 A（同 instance） |
| Step 2 | 拆分 init scripts | ⬜ 未開始 | — | |
| Step 3a | 建立 `database/migrations/data/V001__business_tables.sql` | ⬜ 未開始 | — | V014 內容搬移 |
| Step 3b | 建立 `database/migrations/data/V002__path_c_rls.sql` | ⬜ 未開始 | — | V019 GRANTs + RLS 部分 |
| Step 3c | 更新 `database/migrations/authz/V019` | ⬜ 未開始 | — | 僅保留 sync_log 記錄 |
| Step 4 | 更新 pgbouncer.ini + pg_hba_custom.conf | ⬜ 未開始 | — | |
| Step 5 | 拆分 `services/authz-api/src/db.ts` | ⬜ 未開始 | — | authzPool + dataPool |
| Step 6 | 更新 `rls-simulate.ts` 使用雙 pool | ⬜ 未開始 | — | |
| Step 7 | 更新 `pool.ts` sync grants 使用 dataPool | ⬜ 未開始 | — | Path C 最複雜處 |
| Step 8 | 環境變數 + .env 更新 | ⬜ 未開始 | — | DATA_DB_NAME 等 |
| 驗證 | 7.1-7.6 全部通過 | ⬜ 未開始 | — | |
| 收尾 | 更新 CLAUDE.md、startup guide、docker-compose 說明 | ⬜ 未開始 | — | |

**狀態圖示**：⬜ 未開始　🔄 進行中　✅ 完成　⚠️ 阻塞中

---

## 附錄：相關檔案索引

| 檔案 | 修改原因 |
|------|---------|
| `deploy/docker-compose/docker-compose.yml` | 新增 nexus_data DB（方案 A 或 B） |
| `deploy/docker-compose/init-db.sh` | 拆分兩個 DB 的初始化流程 |
| `deploy/docker-compose/pgbouncer/pgbouncer.ini` | 新增 nexus_data 入口 |
| `deploy/docker-compose/pg_hba_custom.conf` | 新增 nexus_data 的連線規則 |
| `database/migrations/V014__sample_lot_status.sql` | 標記為「移至 data migration」 |
| `database/migrations/V019__path_c_native_rls.sql` | 拆分為 authz 和 data 兩份 |
| `database/migrations/data/V001__business_tables.sql` | 新建（V014 內容） |
| `database/migrations/data/V002__path_c_rls.sql` | 新建（V019 GRANTs + RLS 部分） |
| `services/authz-api/src/db.ts` | authzPool + dataPool |
| `services/authz-api/src/routes/rls-simulate.ts` | 改用雙 pool |
| `services/authz-api/src/routes/pool.ts` | sync grants 改用 dataPool |
| `docs/nexus-startup-guide.md` | 更新啟動說明、docker-compose 範例 |
| `CLAUDE.md` | 更新目錄結構、migration 表格 |

---

*本文件隨實作進度更新狀態追蹤表。步驟完成時更新對應狀態圖示，阻塞時在備註欄記錄原因。*
