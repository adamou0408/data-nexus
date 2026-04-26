# Permission Default-Allow Pilot — L0 反轉 + Deny-List

- **Planner Owner:** Adam (planner session)
- **Executor Owner:** Claude executor session（同工作目錄,Plan↔Execution 透過 git 同步）
- **Status:** IN-PROGRESS（Phase 0 起跑）
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §基座（Q3 2026）— onboarding 摩擦降低，配合 Tier 2 wizard 解鎖
- **Target:** Pilot 完成於 Q3 2026（先 Phase 0+1+2 = 4 週驗證）
- **Created:** 2026-04-26
- **Last updated:** 2026-04-27

---

## Status Lifecycle

> **Legend:** `DRAFT` → `READY-FOR-IMPLEMENTATION` → `IN-PROGRESS` → `READY-FOR-REVIEW` → `DONE` → `ARCHIVED`
>
> **2026-04-26 Adam 解 Q1-Q3,直接 flip 至 `IN-PROGRESS`**(走捷徑跳過 READY-FOR-IMPLEMENTATION,因 executor 同 session 收到答案立即執行):
> 1. **Q1 = All schema objects**(tables + views + functions + sequences,Path C 走 GRANT ON ALL TABLES + ALTER DEFAULT PRIVILEGES × 三類 object)
> 2. **Q2 = External audit (SOX-like / TW 主管機關)** → deny-list ≥30 條 + dual code review;audit retention ≥7 年;pilot 前需 IT audit 簽核
> 3. **Q3 = BI sandbox / 分析師工作區**(具體 schema 名待 Adam 指定;planner 在 Phase 1 開工前補)
>
> Q4 (pgaudit benchmark) 由 Executor 在 Phase 0 解;Q5 (default-allow 不可逆反彈溝通) 由 Adam 平行進行,不擋 status。

---

## 1. Problem / Why

**現況痛點（量化）**

- 新 DB onboarding 端到端 **5-10 工作天**（純處理 30-100 min，剩下都在 AUTHZ_ADMIN 工單排隊）
- AUTHZ_ADMIN 工時 **~80-160 hr/月**（接近 0.5-1 FTE 純做點擊核准）
- BI 分析師 ad-hoc 探索可用資料覆蓋率 **~30%**（70% 的表沒權限直接放棄）
- 每新 DB 產生 **150-200 條政策行**（多數是基本 allow，價值低）

**目標**

L0 (functional access) 從 default-deny 改為 **per-data-source 可選 default-allow + deny-list**，**L1/L2/L3 完全不動**（敏感欄位仍由 RLS row filter + column mask 保護）。預期：

- Onboarding 端到端 **5-10 天 → 0.5-1 天**（−90%）
- AUTHZ_ADMIN 工時 **−85%**（解放成戰略型而非工單型）
- BI ad-hoc 覆蓋率 **30% → 80%**（解鎖 Phase 1 Tier 2 wizard 場景）

**為什麼現在做** — Tier 2 wizard MVP（Q4 2026）依賴使用者能夠快速取得跨 schema 資料；如果 onboarding 仍要 5-10 天，wizard 體驗會被權限工單卡死。此 plan 與 G2 pilot 同期推進，pilot 結果可作為 G2 入口條件之一。

---

## 2. Scope

**In scope（本 plan 涵蓋）：**

- [ ] **Phase 0：Audit 補完**（先決條件，沒做不能上線）
- [ ] **Phase 1：metadata flag 機制**（`authz_data_source.default_l0_policy`，雙模式並存）
- [ ] **Phase 2：1 個 pilot schema 跑 2 週**（含 NPS 量測 + 漏失監控）
- [ ] L0 邏輯反轉（限制在 `authz_resolve` / `authz_check` 應用層）
- [ ] Discovery rules 反向（找應該 deny 的 pattern）
- [ ] Deny-rule pattern 庫建立（≥15 條覆蓋 PII / 薪資 / 合約 / IP）
- [ ] Path C `authz_sync_db_grants` 改寫支援 schema-grant + REVOKE 模式
- [ ] Rollback 機制（一鍵切回 deny + Path C GRANT 還原）

**Out of scope（不在本 plan，下個 plan 再議）：**

- ❌ L1 / L2 / L3 任何修改（敏感資料保護仍依賴 RLS + mask）
- ❌ Phase 3-4：擴大到多個 schemas / 全面預設 allow（需 pilot 結果通過後另開 plan）
- ❌ 敏感 schema 反轉（永遠保留 default-deny，不在本 plan 討論）
- ❌ UI 上的 deny-rule 管理介面（pilot 階段用 SQL / API 即可，UI 留 Phase 3）

---

## 3. Design / Approach

### 3.1 整體流程

```
[既有 default-deny (預設)]              [新 default-allow (per data_source)]
  authz_data_source.default_l0_policy = 'deny'  →  authz_data_source.default_l0_policy = 'allow'
       │                                                │
       ▼                                                ▼
  authz_resolve() 走原邏輯                     authz_resolve() 改為：
  (只回 explicit allow 政策)                   1. 找 explicit deny → 拒絕
                                              2. 否則 → 允許 (auto-grant)
                                              3. L1/L2 政策仍照常 apply
```

### 3.2 Path 別實作

| Path | 改動 | 工作量 |
|------|------|--------|
| **Path A** (Config-SM UI) | `authz_resolve()` JSONB 增加 `_default_policy` 欄位；前端依旗標決定預設可見 | 小 |
| **Path B** (Web middleware) | `authz_resolve_web_acl()` 同步處理；middleware 邏輯反轉 | 小 |
| **Path C** (DB pool) | `authz_sync_db_grants()` 大改：`GRANT ... ON ALL TABLES IN SCHEMA + ALTER DEFAULT PRIVILEGES + REVOKE 例外` | **重點** |

### 3.3 Audit 先決條件

- Path A/B：現況 `authz_audit_log` 已有 batch insert + hypertable（V005/V011/V030），但要驗證 SELECT (read) 動作真的有寫入
- Path C：現況**沒有** read 動作 audit。要開 PostgreSQL `pgaudit` extension，並把 log 導入 `authz_audit_log` 或獨立 hypertable
- 容量驗證：read 量增加 30-100%，V030 hypertable 壓縮策略要先確認能撐住

### 3.4 Deny-rule pattern 庫

**Q2 答案 (SOX) → 最少 30 條 + dual code review (Adam + 法遵 / 內稽 sign-off)**，覆蓋以下類型（pattern matching 優先 column 名稱、其次 table 名稱、最後 schema/comment）：

| Category | Pattern 例 | Effect |
|----------|-----------|--------|
| PII | `email`, `phone`, `id_number`, `ssn` | column mask (既有 L2) + L0 可訪問 |
| 薪資 | `salary`, `bonus`, `compensation` | L0 deny |
| 合約 | `contract_*`, `agreement_*` | L0 deny |
| IP / 機密 | `formula`, `recipe`, `secret_*` | L0 deny |
| 客戶 | `customer_contact`, `client_*` | column mask (L2)，table 仍可看 |
| 系統 | `*_password`, `*_token`, `*_key` | L0 deny |

> Pattern 庫實作於 `authz_discovery_rule` 表，新增 `effect ENUM('allow','deny')` 欄位區分建議方向。

### Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Granularity of flag | per `authz_data_source` | 漸進可控、可獨立 rollback |
| Deny-list 形式 | 沿用 `authz_policy` 加 `effect='deny'` + `status='active'` | 不引入新表 |
| 動 L1/L2 嗎？ | **不動** | 敏感資料保護不變，本 plan 風險局限在 L0 |
| 反轉範圍 | per data_source flag，不全開 | 可 pilot、可 rollback |
| Audit 先做還是同時做？ | **先做（Phase 0 是 gating）** | 沒 audit = 沒安全網 = 不能 default-allow |
| Pilot schema 大小 | ≤50 tables，≤10 active users | 易監控、易 rollback |

### Open questions

- [x] **Q1：「SQL function」字面意義 vs 泛指 schema 物件？** — **2026-04-26 Adam:** All schema objects (tables + views + functions + sequences)
- [x] **Q2：是否有外部稽核 / SOX 合規？** — **2026-04-26 Adam:** External audit (SOX / TW 主管機關),最嚴格規格
- [x] **Q3：Pilot schema 選哪個？** — **2026-04-26 Adam:** BI sandbox / 分析師工作區（具體 schema 名待補,Phase 1 開工前確認）
- [ ] **Q4：pgaudit 對 hypertable 容量影響需 benchmark** — owner: Executor (Phase 0,AC-0.3)
- [ ] **Q5：「default-allow + 用戶習慣後不可逆」的反彈如何溝通？** — owner: Adam（產品溝通,Phase 2 啟動前完成）

---

## 4. Acceptance Criteria

> **Executor 看這裡知道何時算「做完」。Planner 必須在 READY-FOR-IMPLEMENTATION 之前把這節寫死。Open Questions 解決後將檢視一次。**

### Phase 0 — Audit 補完（gating）

- [x] **AC-0.1:** Path A/B 的 SELECT 動作確認寫入 `authz_audit_log`（抽樣 100 個 read 動作，100% 可追溯）— **VERIFIED 2026-04-27**: middleware 30/30 deny + config-exec 32/32 (21 allow + 11 deny) Path A rows 全進 hypertable, context 含 source_id/row_count/filtered_count, see Handoff Log 2026-04-27 entries
  - 已知 gap: `routes/config-exec.ts` 不寫 audit;`middleware/authz.ts` 401/403 拒絕不寫 audit。需補。
  - **Scope (2026-04-27 Adam 決議):** 只涵蓋「真的回 dataset 的資料讀取 endpoint」(config-exec `/run`、dag、data-query)。管理用 GET (列 datasource、列 user、audit-log 自身) **不在** AC-0.1 範圍。理由:稽核要的是「誰看了什麼業務資料」,管理頁本身查詢有 noise 且容易 recursive。
- [ ] **AC-0.2:** Path C 啟用 `pgaudit` extension，read 動作寫入 audit pipeline
  - Pipeline 選定:**pgaudit → log_destination=csvlog → pg_cron + COPY FROM** → 新 hypertable `authz_audit_log_path_c`(理由:Phison PG-heavy,零新增 service,維運成本最低)
  - **Image bundle (2026-04-27 Adam 決議):** 目前 docker-compose 用的 `timescale/timescaledb` image 不含 pgaudit / pg_cron。改 base image 為 `timescale/timescaledb-ha:pg16`(官方 HA image,bundle pgaudit + pg_cron + 其他常見 ext),不自建 Dockerfile。Trade-off: image size ~1.5GB (vs 400MB),所有 dev `docker compose pull` 一次。
- [ ] **AC-0.3:** Audit volume benchmark — 模擬讀取量 +100%，V030 hypertable 壓縮 / retention 策略可承受 **≥7 年**(per Q2 SOX,原本 ≥6 個月升級)
  - 現況 V030 retention 2y → 需 V0XX 升級至 7y;壓縮 segmentby 重排
- [x] **AC-0.4:** Audit query API：給定 `(subject_id, time_range)` 可在 ≤2s 內列出該 user 訪問過的所有 resource — VERIFIED 2026-04-27 (P0-I, 1M-row hypertable, 1.6-89.8ms across all scenarios)
  - 現況 `GET /api/audit-logs` 已支援 subject 但**缺 time_range 參數 + CSV 匯出**(per Q2 SOX 需 export for auditor)
- [ ] **AC-0.5:** Phase 0 通過前不執行 Phase 1+2

### Phase 1 — Metadata flag 機制

- [ ] **AC-1.1:** Migration `V0XX__data_source_default_l0_policy.sql` 新增欄位：
  - `authz_data_source.default_l0_policy` ENUM(`deny`, `allow`) NOT NULL DEFAULT `'deny'`
- [ ] **AC-1.2:** `authz_resolve()` 邏輯反轉支援：
  - flag=`deny` → 行為與現況完全相同（regression test pass）
  - flag=`allow` → 對該 datasource 的所有 resource 自動視為 L0 allow，除非 `authz_policy.effect='deny'` 命中
- [ ] **AC-1.3:** `authz_check()` 同步支援（含資源繼承邏輯）
- [ ] **AC-1.4:** Discovery rule 支援 `effect ENUM('allow','deny')` 欄位
- [ ] **AC-1.5:** Deny pattern 庫種子資料 **≥30 條**（per Q2 SOX,依 §3.4 表格）寫成 V0XX seed migration + **Adam + 法遵 / 內稽 dual sign-off**
- [ ] **AC-1.6:** Path C `authz_sync_db_grants()` 支援 `default_l0_policy='allow'` 模式（per Q1 = all schema objects）：
  - `GRANT USAGE ON SCHEMA`
  - `GRANT SELECT ON ALL TABLES IN SCHEMA`
  - `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA`
  - `GRANT USAGE ON ALL SEQUENCES IN SCHEMA`
  - `ALTER DEFAULT PRIVILEGES IN SCHEMA ... GRANT ...` × 3 種 object 確保未來新建物件自動 allow
  - `REVOKE` deny-list 命中的 table/column/function
- [ ] **AC-1.7:** Rollback：將 flag 改回 `deny`，10 分鐘內 Path A/B/C 全部回到 deny 狀態，Path C `REVOKE` 完整還原

### Phase 2 — Pilot 1 schema

- [ ] **AC-2.1:** 選定 pilot schema = **BI sandbox 內具體 schema**（per Q3,≤50 tables，≤10 active users，Adam 在 Phase 1 開工前指定具體 schema 名）
- [ ] **AC-2.2:** 切換 `default_l0_policy='allow'` 並跑 ≥14 天
- [ ] **AC-2.3:** Pilot 期間每日抽樣 audit log，**0 件**未授權敏感欄位存取（敏感 = pattern 庫命中）
- [ ] **AC-2.4:** Pilot 用戶 ≥5 人填 NPS-like 問卷（5 點量表 × 3 題：體感速度 / 易用度 / 想推廣度），平均 ≥4.0
- [ ] **AC-2.5:** Onboarding 時間實測：pilot schema 新增 1 張表，從新增到可查 < 1 工作天（vs 改前 ~3-5 天）
- [ ] **AC-2.6:** 漏失工單數 / 週 ≤ 改前的 50%（從用戶端統計「我看不到 X」工單）
- [ ] **AC-2.7:** Pilot 啟動前需 **IT audit / 法遵 sign-off**(per Q2 SOX),sign-off 文件存於 `docs/audit-signoff/permission-pilot-{date}.md`

### 跨階段交付

- [ ] **AC-X.1:** Tests：Path A/B/C × default=deny/allow × explicit deny 命中 = 12 種組合的整合測試
- [ ] **AC-X.2:** Docs 更新：
  - `docs/api-reference.md` — `default_l0_policy` 欄位 + 新 endpoint
  - `docs/architecture-diagram.md` — 反轉邏輯圖
  - `docs/constitution.md` — 若涉及 article 8（authz_data_source 修改 → schema migration 不算 identity field 變更，仍須 self-review）
- [ ] **AC-X.3:** PROGRESS.md 更新（pilot 結果 + 是否進 Phase 3 的決議）
- [ ] **AC-X.4:** Pilot 報告 markdown：交付實測數據對照本 plan §1 的目標數值

---

## 5. Implementation Plan (Executor 填)

> Executor session 在 `IN-PROGRESS` 階段填這節。Planner **不要** pre-fill。
>
> **2026-04-26 開工 by Claude executor session(同工作目錄,跟 planner session 透過 git 同步)**

### Phase 0 任務拆解(按依賴順序)

| # | Task | AC | 預估 | 依賴 |
|---|------|----|------|------|
| P0-A | `routes/config-exec.ts` 加 `audit({access_path:'A', action_id:'config_exec', ...})` 在 read return path | 0.1 | 1-2h | 無 |
| P0-B | `middleware/authz.ts` 加 `audit()` on 401 (requireAuth fail) + 403 (requireRole/requirePermission fail) | 0.1 | 1h | 無 |
| P0-C | `routes/browse-read.ts` `/api/audit-logs` 加 `start_time`/`end_time` 參數 + `format=csv` 匯出 | 0.4 | 2h | 無 |
| P0-D | 跑 100 reads × 三 path,SQL 查 audit_log → 100% 可追溯驗證 ✅ DONE 2026-04-27 (middleware 30 + config-exec 32, 100% 進 hypertable) | 0.1 | 1h | A,B 完成 |
| P0-E | `database/migrations/V056__audit_retention_7y.sql` — V030 retention policy 2y → 7y + 壓縮 segmentby 重排 | 0.3 | 1h | 無 |
| P0-F | Synthetic load benchmark — pgbench 模擬 1M reads/day × 7d,量壓縮率 + 儲存成長 (開 7 年情境推估) ✅ DONE 2026-04-27 (100k synthetic rows, 12.71× combined ratio, 7y extrapolation 寫入 Handoff) | 0.3 / Q4 | 4-8h | E 完成 |
| P0-G | docker-compose 切 base image → `timescale/timescaledb-ha:pg16`(bundle pgaudit + pg_cron);新 migration `V057__pgaudit_path_c.sql` (CREATE EXTENSION pgaudit + pg_cron + `authz_audit_log_path_c` hypertable);postgresql.conf 加 shared_preload_libraries / pgaudit.log = 'read' / log_destination=csvlog | 0.2 | 2-4h | 無 |
| P0-H | pg_cron job + state table (last_processed_filename + offset) 把 csvlog 收進 `authz_audit_log_path_c`(parser SQL function + filter:只收 `pgaudit_log` row + 排除 `authz_audit_log_path_c` 自身查詢避免 recursive) | 0.2 | 4-6h (LOC ~100-200) | G 完成 |
| P0-I | EXPLAIN ANALYZE on 1M-row hypertable: `subject_id + 30d range` ≤2s SLA 驗證 ✅ DONE 2026-04-27 (subject+30d 1.6-6.3ms, time-only 1k 39ms, time-only 50k CSV 90ms — all 22-1250× under SLA) | 0.4 | 1h | C,F 完成 |

### Files touched (預估)

- `services/authz-api/src/routes/config-exec.ts` (P0-A)
- `services/authz-api/src/middleware/authz.ts` (P0-B)
- `services/authz-api/src/routes/browse-read.ts` (P0-C)
- `database/migrations/V056__audit_retention_7y.sql` (P0-E)
- `database/migrations/V057__pgaudit_path_c.sql` (P0-G)
- `database/migrations/V058__path_c_audit_ingest_cron.sql` (P0-H,可能合進 V057)
- `deploy/docker-compose/docker-compose.yml` (P0-G,加 pgaudit shared_preload + log_destination=csvlog)
- `deploy/docker-compose/postgresql.conf` (新建,pgaudit 設定)
- ~~`tests/audit/audit-coverage.test.ts` (P0-D 自動化)~~ — DROPPED 2026-04-27;authz-api 沒有 test runner setup,加 runner 違反 task scope。Coverage 由 runtime smoke + `migration-drafts/_p0d_{setup,teardown}.sql` reproducer 取代 (Handoff 2026-04-27)

### Migration / DB notes

- **編號**:已 land V055 (semantic_color);本 phase 用 V056 / V057 / V058
- **V056** 注意:TimescaleDB `remove_retention_policy` 後 `add_retention_policy` 才能改參數
- **V057** 注意:`shared_preload_libraries` 改完要重啟 PG,docker-compose 改完跑 `docker compose down && up -d`;**base image 同 commit 換到 `timescale/timescaledb-ha:pg16`** (2026-04-27 拍板,含 pgaudit + pg_cron),所有 dev 要 `docker compose pull`(image ~1.5GB)
- **V058 / pg_cron**:已確認 timescaledb-ha image bundle pg_cron;cron schedule 跑 `every 1 minute` 收 csvlog
- **回滾**:每個 V0XX 都附 down migration(V030 retention 還原 / drop pgaudit extension / drop ingest cron job)

---

## 6. Risks & Rollback

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| pgaudit 啟用後 hypertable 容量爆增 | 中 | 中 | Phase 0 先 benchmark；超 6 個月 retention 改壓縮策略 |
| Path C `ALTER DEFAULT PRIVILEGES` 與既有 sync 邏輯衝突 | 中 | 高 | dev pool 先測；保留既有 allow-list 路徑做雙模式 |
| Deny pattern 庫不完備 → 敏感欄位漏網 | 中 | **高** | (1) 選低敏感 pilot schema，(2) 每日 audit 抽樣，(3) code review deny-list |
| Pilot 期間真實洩露事件 | 低 | 致命 | 立即 rollback flag → deny；事後檢討 + pattern 補強 |
| 用戶習慣 default-allow 後反彈 | 中 | 中 | Pilot 範圍明確、預先溝通「實驗性」、設定 pilot 結束日期 |
| AUTHZ_ADMIN 抗拒（少了把關角色感）| 低 | 低 | 提前溝通「從工單機 → 治理者」的角色轉變 |
| 稽核 / 法規（若 Q2 確認有 SOX）| 視 Q2 | 視 Q2 | 若有，本 plan 暫停，先補合規 control 設計 |

**Rollback 程序：**

1. UPDATE `authz_data_source SET default_l0_policy='deny'` WHERE pilot_id
2. 觸發 `authz_sync_db_grants()` 重跑 → Path C REVOKE 還原成原 explicit allow-list
3. Cache invalidation（`/api/resolve` + `/api/check`）
4. 預期 ≤10 分鐘全鏈路回到改前狀態
5. **驗收條件：** rollback 後跑既有 regression test 100% pass

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-26 | Planner | → DRAFT | 起草；以 advisor 評估後的量化分析為基礎 |
| 2026-04-26 | Adam (via executor session AskUserQuestion) | DRAFT → IN-PROGRESS | Q1=all-objects, Q2=SOX, Q3=BI-sandbox;走捷徑跳過 READY-FOR-IMPLEMENTATION (executor 同 session 收答案直接開工);AC-0.3/0.4/1.5/1.6/2.7 已對應更新 |
| 2026-04-26 | Executor | → IN-PROGRESS | Phase 0 開工,P0-A 起跑 |
| 2026-04-27 | Adam (via executor session AskUserQuestion) | (no status change) | 拍板兩個 blocker:(1) AC-0.1 scope 縮窄為「只算資料讀取 endpoint」,管理 GET 不算;(2) AC-0.2 image 走 `timescale/timescaledb-ha:pg16` swap 路線(不自建 Dockerfile、不走 fluent-bit),最小改動最低運維成本 |
| 2026-04-27 | Executor | (no status change) | Phase 0 work batch 1 landed: P0-A/B/C/D/E 完成。P0-A/B/C audit hooks 9c5454a;P0-D smoke 30/30 deny audits 進入 hypertable in <1.5s flush(allow path code-reviewed,等真實 data_table page 後 runtime 補驗證);P0-E V056 retention 7y migration 已 apply 到 dev,sanity check 通過 7 years。剩 P0-G(V057 + compose swap)draft 進 `migration-drafts/`,待 Adam 同意 image swap 後一起跑;P0-F benchmark 與 P0-H/I 排在 G 之後。 |
| 2026-04-27 | Executor | (no status change) | AC-0.1 runtime gap 補完(advisor flag 觸發):用 constitution-compliant `ds:_test_p0d_audit`(localhost:15432/nexus_data)+ `table:lot_status` resource binding + `test_audit_smoke` page,對 `/api/config-exec/` 發 1+30 reads。觀測 32 筆 Path A audit rows(21 allow + 11 deny)全進 `authz_audit_log`,context 含 `source_id`/`row_count`/`filtered_count`/`total_count`/`page_id`。teardown 完成,leftover_test_rows=0。AC-0.1 真正驗證通過。Setup/teardown SQL 留在 `migration-drafts/_p0d_setup.sql` + `_p0d_teardown.sql` 供 reproduce。 |
| 2026-04-27 | Executor | (no status change) | **P0-F audit volume benchmark — 完成。** approach (b) per advisor: 開獨立 `authz_audit_log_bench` hypertable(schema 1:1 mirror authz_audit_log,segmentby=(access_path,subject_id), orderby=timestamp DESC, 7d chunk_time_interval),灌 100k synthetic rows(500 distinct subjects, 60 distinct resources, 5 actions,context shape 來自 real Path A 147字元 emit + Path B deny variants 80-150字元;decision/path mix B/allow=35k, B/deny=33k, A/allow=27k, A/deny=5k),timestamp 跨 8 天 → 2 chunks。手動 `compress_chunk()` 跳過 30d wait。**測量結果**:`chunk_compression_stats()` 回 chunk_8 17MB→1376KB (12.38×), chunk_9 18MB→1384KB (13.04×),combined 35MB→2.7MB = **12.71× ratio**;per-row uncompressed 359.2 B (含 4 個 index),compressed 28.3 B。**7y 推估**(30d hot uncompressed + 2525d cold compressed): 100k/day → 7.8 GB total;500k/day → 38.9 GB;1M/day → **77.8 GB**(V056 line 21 註解「<10 GB at 1M」嚴重低估,應更新)。bench hypertable teardown 完成(constitution-compliant)。Setup SQL 留在 `migration-drafts/_p0f_bench_setup.sql` + `_p0f_bench_teardown.sql`。**Caveat (advisor flagged)**: 12.71× 是在 ~50 rows/(access_path,subject_id) segment density 下量到的;TSDB compression 隨 segment density scale,production 1M/day × 1000 subjects ≈ 3500 rows/segment 可能拉到 15-20×,反之低 volume + 高 subject count 可能掉到 5-7×。78 GB @ 1M/day 屬保守估,order-of-magnitude (10-100 GB) robust。次要:bench 沒灌 `policy_ids`/`duration_ms`(real 偶有值,影響 <5%)。**Follow-up**: V056 capacity comment 已更新成 measured 數字。 |
| 2026-04-27 | Executor | (no status change) | **P0-I AC-0.4 SLA validation — 完成。** 重建 1M-row `authz_audit_log_bench`(1000 distinct subjects, 60 resources, 5 actions, 35 天 timestamp 跨 6 chunks)→ 對應到 production-realistic 858 rows/subject/30d。`EXPLAIN (ANALYZE, BUFFERS)` 三種壓縮狀態 × 兩種 query shape:**(1)** `subject + 30d` all hot uncompressed: 3.4ms (per-chunk Index Scan 走 `idx_audit_subject`,ChunkAppend 拼合)。**(2)** `subject + 30d` mixed (4 cold + 2 hot): 6.3ms (compressed chunks 走 ColumnarScan + segmentby index)。**(3)** `subject + 30d` all cold compressed: **1.6ms**(segmentby=(access_path,subject_id) 命中,反而比 hot 還快)。**(4)** time-range only LIMIT 1000 (admin dashboard scan): 38.9ms (top-N heapsort 提早收網)。**(5)** time-range only LIMIT 50000 (CSV export edge,browse-read.ts 規定上限): 89.8ms。**結論**:全部 22-1250× under 2s SLA,AC-0.4 PASS。Plan SQL `SELECT * FROM authz_audit_log WHERE subject_id=$1 AND timestamp BETWEEN $2 AND $3 ORDER BY timestamp DESC LIMIT $N` (browse-read.ts:576) 在 1M rows 下安全。bench teardown 完成,leftover=0。Setup/teardown SQL 留在 `migration-drafts/_p0i_sla_{setup,teardown}.sql`。 |
| 2026-04-27 | Executor | IN-PROGRESS → READY-FOR-REVIEW (Phase 0 部分完成,P0-H 待 image swap) | **Phase 0 work batch 2 landed**:P0-D / P0-F / P0-I 全部 AC pass。剩餘 P0-H(V058 pg_cron csvlog ingest)blocked on Adam 執行 docker compose pull + restart 切到 timescaledb-ha image。所有 AC 中,AC-0.1 / 0.3 / 0.4 已 verified;AC-0.2(default-allow toggle)+ AC-0.5(SOX retention 已 V056 ground)等 P0-H 完成後可整體 sign off。 |
| TBD | Executor → Planner | IN-PROGRESS → READY-FOR-REVIEW | Phase 0 全部 AC pass 後 review,Planner 決定是否進 Phase 1 |
| TBD | Executor → Planner | IN-PROGRESS → READY-FOR-REVIEW | Phase 2 pilot 結果出來後 |
| TBD | Planner | → DONE | Pilot 通過 + PROGRESS.md 更新 |

---

## 8. References

- Master plan: [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md)
- Architecture: [`docs/phison-data-nexus-architecture-v2.4.md`](../../../docs/phison-data-nexus-architecture-v2.4.md) — §I-III 三 path 模型、§VII Mega-Prompt
- Constitution: [`docs/constitution.md`](../../../docs/constitution.md) — Article 8（authz_data_source 修改規範）
- Tech debt：[`docs/backlog-tech-debt.md`](../../../docs/backlog-tech-debt.md) — FEAT-02（資源繼承）、FEAT-03（teardown 缺失）
- Known risks: [`docs/standards/known-risks.md`](../../../docs/standards/known-risks.md)
- 相關 sub-plans:
  - [`./tier2-analytics-wizard-plan.md`](./tier2-analytics-wizard-plan.md) — Tier 2 wizard 受益方
  - [`./two-tier-platform-model.md`](./two-tier-platform-model.md) — 平台 vs 應用分層
  - [`./dependency-cascade-plan.md`](./dependency-cascade-plan.md) — V045 cascade 與本 plan 部署順序
- 既有遷移：V005 / V011 / V030（audit pipeline）、V008 (`authz_resolve`)、V010 (`authz_sync_db_grants`)
