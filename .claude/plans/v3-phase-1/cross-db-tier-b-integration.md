# Cross-DB / Cross-Schema × Tier B Integration

- **Owner:** Adam Ou
- **Status:** APPROVED 2026-05-04 — defaults locked, execution starts
- **Supersedes:** `cross-db-flow-composer.md` (incorporated; old file deleted)
- **Depends on:** [`two-tier-platform-model.md`](./two-tier-platform-model.md) · [`tier-a-primitives-roadmap.md`](./tier-a-primitives-roadmap.md) · V070 schema-as-resource · DAG-SAVE-PAGE-01 (2026-04-26)

---

## 1. Goal

把 **Flow Composer (curator authoring) ↔ Tier B (consumer rendering)** 做成跨 DB / 跨 schema 的 bottom-up 平台層：

- 同一條 DAG 裡的 node 可以分別綁不同 data source（PG↔Oracle / **PG↔PG** / 未來 BigQuery / Trino / Mongo），只要相鄰節點 column 型態可橋接就合法
- DAG 完成後 curator 可一鍵 publish 為 Tier B page，consumer 開頁時拿到 cross-DS 結果，自動套上 Tier A primitives（saved_view / feedback / help_text）
- frame 是 source-agnostic 中介層；DS 是 node-level attribute（不再是 DAG-level）

**驅動原因**：oracle-direct 已上線，Adam 立刻點到痛點 — Oracle view 想接 PG fn 做 normalize，現在做不到。長期看，這是 Flow Composer 該長的樣子（DB-agnostic data ops），不做就一直被當 PG-only 工具。

---

## 2. 連結現有平台（不重蓋的部分）

| 現有 | 提供什麼 | 本 plan 不重蓋 |
|---|---|---|
| **V070 schema-as-resource** | `parent_id` walk → schema → DS cascade，permission 已繼承 | cross-schema authz 直接沿用 |
| **Tier A primitives** (help_text / saved_view / feedback ✅) | consumer 端共享服務 | Tier B page 自動拿到，不重做 |
| **DAG-SAVE-PAGE-01 PATH A** (frozen snapshot) | Curator 把 DAG node `last_result` 凍進 `authz_ui_page.snapshot_data` | L4 沿用，加 cross-DS metadata |
| **Catalog Workspace** (3 agents 平行進行) | unified preset-driven UI | L4 整合進 catalog 渲染流，不另開 tab |
| **oracle-direct shared lib** (本 session 新增) | `runOracleDirect()` + per-resource authz | L1 driver layer 整合進 logical_type |
| **`getDataSourcePool(sourceId)`** (`db.ts:27`) | per-DS PG pool | L2 executor 直接用，不改 |

---

## 3. 缺口分析（本 plan 要補）

### 3.1 跨 DB
- 異質 (PG↔Oracle)：類型系統不通、SQL dialect 異
- **同質 (PG↔PG)**：兩端同 OID，logical_type round-trip 是 identity，無資訊損失
- 目前 DAG 強制 single DS（dag.ts:316 接 top-level `data_source_id`），兩種都做不到

### 3.2 跨 schema
- **同 DS 不同 schema**（如 `analytics.fn_a` → `ops.fn_b`）：`resource_id = function:schema.name` 已記，executor 已支援
- **schema-level cascade**：V070 已做 → ✅
- 缺：UI 沒有清楚的 schema 切換器（curator 在 fn 加進來時靠 resource_id 字串認 schema）

### 3.3 frame 中介層
- PG fn 出 `dataTypeID` (PG OID)，Oracle 出 `type` (字串)
- 沒有 logical_type，operator 內部假設 PG 風格
- cast operator 寫死 PG type names

### 3.4 Tier B 渲染跨 DS
- DAG-SAVE-PAGE-01 PATH A 是 snapshot — 跨 DS 在 publish 時固化，render 時讀 snapshot，跨 DS 無感（其實已 work）
- 但 PATH B (live re-execute) 規劃中 — render 時要重跑 DAG，跨 DS 需 L1+L2+L3 都到位
- saved_view 跨 DS column 名衝突未處理

---

## 4. 4-Layer Architecture（自底向上）

### L1 — Logical Type Layer

**目標**：所有 source adapter 在 driver 層統一吐 `logical_type`，operator 與 UI 走 logical_type 為主、原生 type 為輔助顯示。

**Decisions baked**：
- L1.1: **9 種 logical_type** — `string / int64 / decimal / float64 / bool / date / timestamp / bytes / json` (+ `unknown` 為 fallback)
- L1.2: **source-of-truth in `db-driver.ts`** — driver 是 DB 接觸面，map 一次源頭乾淨
- L1.3: **命名 `logical_type`** — 與 PG/Oracle `data_type` 區隔，不撞 `semantic_type` (business_term)

**Files touched**:
1. `services/authz-api/src/lib/db-driver.ts` — `LogicalType` enum + `pgTypeToLogical(oid)` + `oracleTypeToLogical(s)` + `DriverColumn.logical_type` 欄位
2. `services/authz-api/src/lib/oracle-direct.ts` — output columns 加 logical_type（從 driver 拿）
3. `services/authz-api/src/routes/dag.ts` — fn 分支 / oracle-source 分支 enrichedColumns 加 logical_type
4. `services/authz-api/src/routes/dag-operators.ts` — cast operator 接受 `target_logical_type` spec
5. `apps/authz-dashboard/src/components/DagTab.tsx` — IO type 加 logical_type，Inspector 顯示

**Type compatibility matrix**:

| logical_type | PG | Oracle | 隱式 cast 接受方 |
|---|---|---|---|
| string | text, varchar | VARCHAR2, CHAR, CLOB | ← * |
| int64 | int4, int8 | NUMBER (scale=0, prec≤18) | → decimal, float64, string |
| decimal | numeric | NUMBER (scale>0) | → string |
| float64 | float8 | BINARY_DOUBLE | → string |
| bool | bool | NUMBER(1) (慣例) | → string |
| date | date | DATE | → timestamp, string |
| timestamp | timestamptz | TIMESTAMP* | → string |
| bytes | bytea | BLOB, RAW | → string (b64) |
| json | jsonb | (none → fallback string) | → string |
| unknown | — | — | 邊界拒絕 |

**PG↔PG 特性**：兩邊都 PG OID，`pgTypeToLogical → logical_type → pgTypeToLogical` 是 identity（無損）。

**Acceptance**：
- `DriverColumn` 帶 logical_type
- runOracleDirect 與 fn 分支兩邊輸出 columns 都有 logical_type 欄位
- cast operator 可在 9 種 logical_type 間做 explicit 轉換
- typecheck clean + curl smoke green
- `npx tsx scripts/test-logical-type.ts`（新增）走完 9 種 type 各 round-trip 一次

---

### L2 — Per-Node DS + Schema Binding

**目標**：每個 source node 自帶 `data_source_id`，executor 用 node 級別 dispatch，DAG-level DS 改為 UI prefill。

**Decisions baked**：
- L2.1: **legacy DAG 用 read-time fan-out** — 不動已存資料、可 rollback
- L2.2: **subdag invariant 暫保留** — relax 留到 L4
- L2.3: **DAG-level `default_data_source_id` 留作 UI prefill** — executor 不再讀
- L2.4: **沿用 V070 schema-as-resource** — schema cascade 不重蓋

**Files touched**:
1. `services/authz-api/src/routes/dag.ts` — `/save` 接受 node.data.data_source_id；`/execute-node` 改用 `node.data.data_source_id || data_source_id` (legacy fallback)
2. `services/authz-api/src/lib/dag-exec.ts` — `executeDagAsPublished` 對每 node 用 own ds
3. `services/authz-api/src/lib/published-dag.ts` (or wherever snapshot loader is) — read-time fan-out: legacy snapshot 無 node-level ds 時用 top-level
4. `apps/authz-dashboard/src/components/DagTab.tsx` — 加 node 時記 node.data.data_source_id；palette 同時顯示多 DS（badge）；Inspector 顯示 node ds (read-only)
5. `apps/authz-dashboard/src/api.ts` — DAG save payload 帶 per-node ds
6. Migration 文件補 (no DB schema migration — `dag_snapshot` JSON 結構是 free-form)
7. `services/authz-api/scripts/test-dag-cross-ds.ts` (新增) — E2E test legacy DAG 仍正確 + 新 DAG per-node ds
8. `apps/authz-dashboard/src/components/catalog/...` — Catalog Workspace 列 published DAG 要看得出多 DS（與 catalog agents 協調）

**Acceptance**：
- 舊 DAG read 不破（legacy fallback path）
- 新建 DAG 每個 source node 自帶 ds_id（即使值都一樣也記下）
- `executeDagAsPublished` 跑舊 DAG + 新 DAG 都通

---

### L3 — Cross-DB Edge Compatibility

**目標**：開放跨 DS 連線，UI + backend 雙邊做 logical_type compatibility check，型態不符紅線 + 建議插 cast operator。

**Decisions baked**：
- L3.1: **reject + suggest cast** — 不 auto-cast（會藏 bug），讓 curator 顯式選
- L3.2: **沿用 1000 row 上限** — composer preview 不是生產 ETL
- L3.3: **紅線 + warning icon** 兩者都有 — 紅線示連線錯，icon 說原因 + 建議

**Files touched**:
1. `services/authz-api/src/routes/dag.ts` — `/execute-node` 在跨 DS edge 時做 logical_type 檢查
2. `apps/authz-dashboard/src/components/DagTab.tsx` — edge UI 邊連邊 type check；不符畫紅線 + warning icon + context menu「Insert cast operator」
3. `apps/authz-dashboard/src/components/dag/EdgeWithType.tsx` (新增 atom) — render 帶 type info 的 edge
4. `services/authz-api/src/lib/logical-type-compat.ts` (新增 shared lib) — `canConnect(from: LogicalType, to: LogicalType): { ok: boolean; needCast?: LogicalType[] }`
5. `services/authz-api/scripts/test-cross-ds-edge.ts` (新增) — Oracle view → cast → PG fn 跑通
6. `apps/authz-dashboard/src/components/dag/Inspector.tsx` (or relevant inspector file) — column type mismatch 顯示在 inspector

**Acceptance**：
- 可組 oracle-source → cast(string→int64) → pg-fn 的 flow，執行成功
- 型態不符的連線 UI 紅線顯示 + warning icon + context menu 提示插 cast
- backend 邊界 type check 在不符時 reject 並回 actionable error

---

### L4 — Tier B Page Bridge for Cross-DS DAG

**目標**：跨 DS DAG 一鍵 publish 為 Tier B page，consumer render 時拿到結果並自動套 Tier A primitives；render 時重查 authz。

**Decisions baked**：
- L4.1: **curator 選 frozen snapshot vs live re-execute** — page-level toggle
- L4.2: **render 時每次重查 authz** — constitution Article 8 精神，user 角色可能變
- L4.3: **column 衝突在 publish 時 curator 改名** — 平面 column name 對 consumer 友善（不加 ds prefix）

**Files touched**:
1. `services/authz-api/src/routes/dag.ts` — `/publish` 接受 `render_mode: 'snapshot' | 'live'`
2. `services/authz-api/src/lib/dag-publish.ts` — publish 時偵測跨 DS + column 衝突，要求 curator 改名（reject if duplicate name 沒 rename）
3. `services/authz-api/src/routes/ui-page-render.ts` (or ConfigEngine page render route) — render 時 if `render_mode === 'live'` → 重執行 DAG + 重查 authz
4. `apps/authz-dashboard/src/components/DagTab.tsx` — publish UI 加 render_mode 選項 + column 重命名 form (when conflict detected)
5. `apps/authz-dashboard/src/components/catalog/...` — page-detail 顯示跨 DS metadata（與 catalog agents 協調）
6. `database/migrations/V0xx_dag_render_mode.sql` (新增 migration if needed) — `published_dag.render_mode` 欄位 OR `dag_snapshot.render_mode` JSON 欄
7. `services/authz-api/scripts/test-cross-ds-publish.ts` (新增) — publish + render 雙模式 E2E

**subdag invariant 此時 relax**（L2.2 deferred 到此）：移除 same-DS check (`dag.ts:382-388`)，published subdag inline 進 parent 後跨 DS 合法。

**Acceptance**：
- 跨 DS DAG 可 publish 為 page
- consumer 開頁，frozen 模式秒開、live 模式重跑 DAG 並重查 authz
- column 衝突時 publish UI 強制 curator 改名（不可繞）
- Tier A primitives (saved_view / feedback / help_text) 對 cross-DS page 自動 work

---

## 5. Decision Matrix（已批准 2026-05-04，default 全收）

| # | 決策 | 採用 |
|---|---|---|
| L1.1 | logical_type 數量 | 9 種 |
| L1.2 | source-of-truth | `db-driver.ts` |
| L1.3 | 命名 | `logical_type` |
| L2.1 | legacy migration | read-time fan-out |
| L2.2 | subdag invariant | 等 L4 才 relax |
| L2.3 | DAG default DS | 留作 UI prefill |
| L2.4 | schema-as-resource | 沿用 V070 |
| L3.1 | edge type check | reject + suggest cast |
| L3.2 | 邊界 row 上限 | 沿用 1000 |
| L3.3 | type 不符視覺 | 紅線 + warning icon |
| L4.1 | render 模式 | curator 選 frozen vs live |
| L4.2 | render-time authz | 每次重查 |
| L4.3 | column 名衝突 | curator 改名 at publish |
| O1 | subagent 切分 | by layer |
| O2 | 隔離 | git worktree per agent |
| O3 | review checkpoint | per-layer |
| O4 | 主 agent 角色 | review + glue |

執行中遇到新分叉 → 主 agent 沿同方向（4 軸 bias：完整性 / 低維運 / 不跑偏主題 / 使用者友善）自決，記入 §11 Decision Log。

---

## 6. Subagent Orchestration

### 執行流（pipelined，因 layer 有 dep）

```
[main agent] L1 直接做 (~150 LoC, 5 files, 小到不需 delegate)
   ↓ smoke test green + typecheck clean
[main agent] review L1 → write any glue → commit
   ↓
[subagent worktree] L2 (per-node DS, ~400 LoC, 8 files)
   ↓ smoke + typecheck
[main agent] review L2 → glue (Catalog Workspace 整合) → commit
   ↓
[subagent worktree] L3 (cross-DB edges, ~250 LoC, 6 files)
   ↓
[main agent] review L3 → glue → commit
   ↓
[subagent worktree] L4 (Tier B publish, ~300 LoC, 7 files)
   ↓
[main agent] review L4 → glue → commit
```

### 每 subagent 開工 prompt 模板（要點）

1. **Re-read target files first** — codebase 可能在你 spawn 前被改動（per `feedback_subagent_reread_codebase`）
2. **明確 layer scope** — 給定該 layer 的 Decisions baked + Files touched + Acceptance
3. **Edges 之間 contract** — 上層的 Acceptance（如 L1 的 logical_type 列表）作為 input
4. **不碰 out-of-scope** — 如 L2 不要碰 L3 的 edge type check
5. **Acceptance 自驗** — typecheck clean + 寫該 layer 的 smoke script + green

---

## 7. PG↔PG 跨 DB 三情境（明確 covered）

| 情境 | 現況 | layer | 額外工作 |
|---|---|---|---|
| 同 DS 不同 schema (`analytics.fn_a` → `ops.fn_b`) | ✅ 今天就能用 | none | 0 |
| 同 DS 跨 schema + V070 cascade | ✅ permission 已繼承 | L2.4 沿用 | 0 |
| 跨 PG DS (`ds:phison_a` → `ds:phison_b`) | ❌ DAG 強制 single DS | L2 + L3 | 跟 PG↔Oracle 完全一樣 path |

跨 PG DS 的特性：
- ✅ logical_type round-trip 是 identity（兩端 PG OID）
- ✅ 同 SQL dialect，cast operator 行為一致
- ⚠️ 同名 schema/column 衝突 → L4.3 publish 時 curator 改名

---

## 8. Risks & Mitigations

| # | Risk | 緩解 |
|---|---|---|
| R1 | 跨 DS 邊界記憶體爆（oracle-source 拉 10 萬 rows 餵 PG fn） | L3.2 沿用 1000 hard cap；長期靠 Phase 2 push-down |
| R2 | 跨 DS 沒 transactional 保證 | source 全 read-only（現狀），sink 失敗時 read 無副作用；明確標註 best-effort |
| R3 | published_dag 跨版本 schema 演進 | L2.1 read-time fan-out；不 mutate 已存 row |
| R4 | logical_type edge case (e.g., NUMBER without precision) | 保守歸 decimal（不丟精度），L1 落地時 freeze 規則表 |
| R5 | UI mental model 切換（DAG = 一個 DB → 多 DS） | L2 UI 預設只顯 default DS palette，「Show all sources」漸進披露 |
| R6 | column 名衝突 cascading 到 saved_view / feedback | L4.3 強制 publish 時改名；下游 primitives 拿到的就是平面 column name |

---

## 9. Out of Scope（Phase 2+）

- **Push-down optimization**：filter / limit 推給上游 DS
- **Cross-DB join operator**：目前 join 只在 single-DS（PG fn 內部）
- **Streaming frames**：現在 frame 一次性載入
- **Schema drift detection**：source DS schema 變了自動偵測
- **Cross-DB sink writes**：read-only 已夠，write 留 Phase 2
- **Subscription primitive 整合**：A4 subscription 還 gated，跨 DS event 發佈是雙重 gated

---

## 10. Acceptance per Layer (Done definition)

| Layer | Done = |
|---|---|
| L1 | DriverColumn 帶 logical_type；oracle-direct + fn 兩 path 都吐；cast operator 可在 9 種間轉換；typecheck clean；smoke green |
| L2 | 新建 DAG 每 source node 自帶 ds_id；舊 DAG read 不破；execute-node 用 node 級 dispatch；2 個 PG DS 可共存於同 DAG |
| L3 | oracle-source → cast → pg-fn 可組可跑；UI 紅線 + warning icon；型態錯時 backend reject 帶 actionable error |
| L4 | 跨 DS DAG publish 為 page；render 雙模式 (snapshot / live) work；render-time authz 重查；column 衝突強制改名；Tier A primitives auto-work |

---

## 11. Decision Log

- **2026-05-04**：plan 整合自 `cross-db-flow-composer.md`（已刪），加 Tier B / cross-schema / PG↔PG / Tier A 連結章節
- **2026-05-04**：Adam 批准 default 全收（17 條 decisions），執行中新分叉 by 4-axis bias
- **2026-05-04**：執行流改 pipelined（不是並 spawn）— layer dep 真實存在；L1 由主 agent 直接做（小到不需 delegate）

---

## 12. Next Action

**Now**：主 agent 開始 L1（logical type layer），預計 ~150 LoC、5 files。完成後 smoke green → commit → spawn L2 subagent。
