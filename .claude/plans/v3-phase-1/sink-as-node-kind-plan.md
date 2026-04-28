# Sink-as-Node-Kind (Composer Sink Primitive)

- **Planner Owner:** Adam Ou
- **Executor Owner:** Adam (this session)
- **Status:** IN-PROGRESS
- **Linked from:** [`./composer-operator-and-sink.md`](./composer-operator-and-sink.md) §2 next-sprint / [`./two-tier-platform-model.md`](./two-tier-platform-model.md) Tier B authoring loop
- **Target:** Q3 2026 — composer-native sink kinds (rolling, no hard gate)
- **Created:** 2026-04-29
- **Last updated:** 2026-04-29

> 本 sub-plan 從 `composer-operator-and-sink.md` §2 next-sprint 拆出來獨立規劃,因為 sink 是 Tier B authoring loop 的「終點 primitive」,維運面向跟 operator 不同(operator 影響 row set 變形,sink 影響 platform-side artifact lifecycle),需要獨立 risk register。

---

## 1. Problem / Why

### 1.1 現況症狀

Composer 目前只有**一條 sink 路徑**:Inspector 底下的 `Save as page` 按鈕,把 selected node 的 `last_result` 拍 snapshot 寫進 `authz_ui_page.snapshot_data`(DAG-SAVE-PAGE-01 Path A,2026-04-26 ship)。

對應 user flow:
```
[fn / op node 選中] → Run this node → 看到 last_result → 點 "Save as page" → fill dialog → submit
```

### 1.2 三個結構性問題

| # | 問題 | 證據 |
|---|------|------|
| **P1** | **Sink lifecycle 不可見** | DAG canvas 只看得到 source/transform,看不到「這個 DAG 最後變成 page / API / 排程」。Curator 必須記得「這個 DAG 後面有個 snapshot page 連著」,平台沒有單一視覺真相 |
| **P2** | **Sink 跟 Composer 解耦,擴 sink_kind 要改兩層** | 加 `api` sink 要在 Inspector 多開一個按鈕 + 多寫一個 dialog + 後端多寫一條 route。每加一種 sink 類別,UI patch 與 route patch 平行成長 |
| **P3** | **Sink 沒有 authz_resource row,cascade / rename / lifecycle 無 hook** | `authz_ui_page` row 跟原 DAG 之間只有 `snapshot_data.origin.dag_id` 一條 JSONB 弱關聯。DAG 改名 / 刪除 / disable 時,下游 page 不會被 V079 cascade 掃到 |

### 1.3 對照 Two-Tier Platform Model

`two-tier-platform-model.md` 把 Tier B 定義為「completely Curator-configured app, 0 行 React」。Q4 2026 explicit AC: **「≥ 1 個 Tier B app 完全由 Curator 配出」**。

這個 AC 解構成兩半:
1. **DAG 能描述業務邏輯** — operator 補完後達成(literal/filter/cast/aggregate ✅ done as of 2026-04-28)
2. **DAG 能直接「變成」一個應用 artifact** — 缺 sink primitive

**結論:** sink-as-node-kind 不是 nice-to-have,是 Q4 2026 Tier B 自助 AC 的最後一塊拼圖。

---

## 2. Scope

### 2.1 In scope (本 sprint, ~5 天)

- [ ] **`SinkNode` React component** — composer-native node kind, `node.type='sink'`
- [ ] **`sink_kind='page'` MVP** — 取代 `Save as page` button 的 underlying mechanism
  - Inspector 提供 sink_kind dropdown(MVP 只有 `page`,但 UI 預留擴充欄位)
  - Snapshot 行為與現行 `Save as page` 完全等價(零 behavior 退步)
- [ ] **Sink runtime 後端** — 抽 `lib/sink-runtime.ts`,新 route `POST /api/dag/execute-sink`
- [ ] **Authz 模型確認** — sink 繼承上游 fn ancestor 的 `resource_id`(與 operator 一致),`access_path='B'`
- [ ] **Save 後 sink node 持續存在 canvas** — 不像現行 button 是 fire-and-forget
- [ ] **保留現行 `Save as page` button 完全不動** — dialog 仍彈、行為仍相同(真正的 alias)。Sink palette 是新增的第二條路;deprecate 舊 button 留待下個 sprint review
- [ ] **Smoke test + Playwright e2e**

### 2.2 Out of scope (deferred,留下個 sprint 或更後)

| 項目 | 為什麼延後 |
|------|-----------|
| `sink_kind='api'` | 需要先解決 per-call authz_check 動態介面 + bound_params binding spec — 自成一個 sub-plan |
| `sink_kind='scheduled_job'` | 阻塞於 V057 cron stability;且 owner / on-fail 通知 contract 跟 subscription primitive(Q1 2027)綁 |
| `sink_kind='alert'` | 等 subscription primitive(Q1 2027) |
| Sink-as-`authz_resource` row(cascade hookable) | 需 schema 設計(`resource_type='sink'` 的 lifecycle)—— 跟 saved_view primitive(Q4 2026)一起做更省 |
| Live re-execution snapshot page (Path B) | 等 saved_view primitive,本 sprint 仍是 snapshot-only |
| 移除舊 `Save as page` button | 至少留 1 sprint alias,觀察 Curator 改 muscle memory 速度 |

### 2.3 Non-goals

- **不重構** `authz_ui_page` schema — sink 仍寫進現行 `snapshot_data` 結構
- **不引入** sink 獨立的 RBAC 矩陣 — 繼承上游
- **不加** sink 之間的 fan-out / 多 sink 同 origin —— 一個 sink node 對應一個 artifact

---

## 3. Design / Approach

### 3.1 Sink node 模型

```ts
type SinkNode = Node<{
  label: string;                      // "Snapshot → modules_home"
  sink_kind: 'page';                  // future: 'api' | 'scheduled_job' | 'alert'
  sink_config: PageSinkConfig;        // discriminated by sink_kind
  status?: 'unsaved' | 'saved' | 'stale';   // last execute → snapshot lifecycle
  last_run?: { artifact_id: string; at: string; row_count: number };
}>

type PageSinkConfig = {
  page_id: string;                    // authz_ui_page.page_id
  title: string;
  parent_page_id?: string;
  description?: string;
  overwrite?: boolean;
}
```

**為什麼 `sink_kind` 用 string union 而不是各做一個 React component:**

| 選項 | Pros | Cons | 採用? |
|------|------|------|------|
| A. 一個 SinkNode + sink_kind discriminator | Inspector 切 form 容易;canvas 上看到一致的「sink」視覺;cascade / lifecycle 統一 | sink_config 是 union,TS 類型較 verbose | **✅ 採用** |
| B. PageSinkNode / ApiSinkNode / ... 各 component | TS 類型乾淨 | Palette 隨 sink_kind 擴充膨脹;canvas 視覺不一致;cascade scan 要列舉所有 type | ❌ — 每加一種 sink_kind UI 都要再 patch palette + nodeTypes map |

**理由:** 對照 React Flow 慣例(custom node type 應 stable),sink 是「終點」這個語意應該被視覺一致地表達。`sink_kind` 是 sink 內部的策略,不是新類別。

### 3.2 Authz 模型

**承襲 operator plan §3.2:**

| 規則 | 內容 |
|------|------|
| Sink 不獨立 `authz_check` | 跟 operator 一樣,sink 是「把已通過 authz 的 row set 落地」,不接觸新資料源 |
| Authz 繼承上游 fn ancestor | walk DAG 至最近的 `node.type='fn'` 祖先,使用其 `resource_id` |
| Audit log 保留 | `audit({ access_path:'B', action_id:'dag_sink_<kind>', resource_id:<上游 fn>, context:{ sink_node_id, sink_config, artifact_id } })` |
| Sink 寫入 platform-side artifact 仍受該 artifact 的權限規範 | 例如寫入 `authz_ui_page` 仍經 `requirePageAuthor` middleware,sink runtime 內部處理 |

**理由(對照 P3):** sink 不獨立 authz row 是 *MVP 取捨*;cascade hookability 要等 saved_view sub-plan(Q4 2026)時再把 sink artifact 提升為 first-class authz_resource。本 sprint 寫 cascade-aware 是過度設計。

### 3.3 Runtime — 後端 dispatch

**現行:** `POST /api/dag/save-as-page` 一條 fixed route,client 把已執行的 `columns + rows` 直接附在 request body 送過來(snapshot of what Curator 剛看到的)。

**改為(MVP 維持 client-provides-rows 契約,純 refactor):**

```
POST /api/dag/execute-sink
  body: {
    dag_id,
    sink_node_id,
    sink_kind: 'page',
    sink_config: { page_id, title, parent_page_id?, description?, overwrite? },
    bound_params?,
    columns,                         // ← client 從 last_result 帶過來,跟現行 save-as-page 一致
    rows,                            // ← 同上
  }

internally:
  1. 驗 sink_config(由 sink_kind dispatch 對應 schema)
  2. 從 DAG attributes 取 sink_node 的 inbound edge → 上游 node id
  3. Resolve 上游 fn ancestor → authz_check(execute, fn:...)
     (不重新執行 upstream — 維持「snapshot of what Curator saw」語意)
  4. Dispatch 到 sink_kind handler:
     - 'page' → 呼叫 lib/sink-runtime.ts emitPageSnapshot()(從現行 save-as-page route 抽出來)
     - 'api' (future) → register endpoint
     - 'scheduled_job' (future) → upsert cron entry
  5. Audit + 回傳 { artifact_id, row_count, elapsed_ms }
```

**為什麼不在 server 端 re-execute upstream?**
- 現行 `save-as-page` 是「拍 Curator 剛看到的 row set 的照片」— Curator 已 Run upstream、檢視 rows、再選 Save。Server 端 re-execute 會破壞這個語意(upstream 可能在那幾秒內變化)。
- "Always-fresh" 是另一個 feature(「Refresh sink」按鈕,將來 saved_view sub-plan 落地時自然會做),本 sprint 不引入。

**舊 route `POST /api/dag/save-as-page` 完全保留不變(真正的 alias):**
- Dialog 仍彈、行為仍相同、現行 e2e `save + reload round-trip` 完全不需動。
- Sink palette 是 *新增* 的第二條路;deprecate 舊 button 等下個 sprint review 再決定。

### 3.4 UX flow — 三段反覆驗證

**新 flow:**

```
1. Curator 點 Run this node → 看 last_result OK
2. Palette → Sinks section → 拖 Page Snapshot 到 canvas (or 從 selected node 右鍵「Add sink → page」)
3. Sink node 自動連到 selected node(若有 selection)or 提示 "Connect upstream"
4. Inspector 出現 sink form(page_id / title / parent / overwrite)
5. 點 sink node 上的 ▶ Execute → snapshot 寫入,artifact_id 顯示在 node 上
6. canvas 永久看得到 "fn → snapshot:dag_x_node_y_snapshot"
```

**UX validation pass 1 — muscle memory 不破:**
- 舊 `Save as page` button 仍在原位置 + 完全相同的 dialog 流程(零改動)
- Sink palette 是 *新增* 的第二條路,讓喜歡 canvas-centric 的 Curator 用
- ✅ 既有使用者行為零驚嚇;新使用者看到 palette,會自然走 canvas 路徑
- 量測點:下個 sprint review 時看 alias 點擊 vs palette spawn 的比例,實證後再決定是否 deprecate 舊 button

**UX validation pass 2 — discoverability 提升:**
- Sinks 在 palette 跟 Operators 並列,新 Curator 直接看到「DAG 可以變成 page / (未來)API」
- ✅ 對照現況「藏在 Inspector 底下的 button」,palette 是更主動的 affordance

**UX validation pass 3 — error / lifecycle 可見性:**
- Sink node 顯示 `unsaved` / `saved (3min ago, 6 rows)` / `stale (upstream changed)` chip
- 點擊 sink node 看到 origin lineage(canvas 上已有 edge 視覺)
- ✅ 對照現況「Curator 必須跨頁去 authz_ui_page 找 snapshot」,lifecycle 內聚於 canvas

**UX validation pass 4 — 失敗模式:**
- Sink 沒接 upstream → Validate report `missing_input` (跟 operator 一致)
- Sink 接到沒 last_result 的 upstream → Execute 顯示 "Run upstream first" + jump-to button
- 重複 page_id → 與現行邏輯一致,提示 overwrite
- ✅ 失敗訊息走既有 validate / execute 通道,不另開 error UX 分支

### 3.5 視覺設計 — sink node

```
┌─────────────────────────┐
│ 🗄️ snapshot:modules_xyz │  ← icon + page_id mono
│    [SAVED · 6 rows]     │  ← lifecycle chip
├─────────────────────────┤
│ ◯  upstream             │  ← 只有 input handle, no output
└─────────────────────────┘
```

Color: slate/zinc(終點氣質),與 operator 的 amber、fn 的 sky 區分。

### 3.6 Storage

**無 schema change。** Sink 跟 operator 一樣存進 `authz_resource.attributes->'nodes'` JSONB(現行 DAG 儲存通道)。

### 3.7 Key decisions(每個都列 rationale + 維運成本)

| # | Decision | Choice | Rationale | 維運成本 |
|---|----------|--------|-----------|---------|
| D1 | Sink 是 composer-native node 還是維持 button? | composer-native node | 解決 P1/P2/P3;Q4 2026 AC 需要 | +1 React component;但取代既有 dialog,淨成本 ≈ 0 |
| D2 | MVP sink_kind | 只 `page` | 行為等價於現行 button,風險最小;api / cron 各自 unblock 條件未到 | 之後加 sink_kind 是 dispatch table 一行 + 一個 handler module,線性 |
| D3 | Authz model | 繼承上游(同 operator) | 不引入新 RBAC 矩陣;與 operator 設計一致 | 零新增;若未來 sink-as-resource 升 first-class 時可平移 |
| D4 | Sink 是否做成 `authz_resource` row | 不做(MVP) | 過度設計;saved_view sub-plan (Q4 2026) 會統一處理 | 短期省 schema 設計成本;但 V079 cascade 暫無 hook(已知技術債,登記在 backlog) |
| D5 | 舊 `Save as page` button 怎麼處理 | 完全保留不動 ≥1 sprint(真 alias);sink palette 是新增的第二條路 | 既有 e2e / muscle memory 零破壞;真實量測 alias-vs-palette 採用率後再決定 deprecate | +0(舊 button 零改動);未來 deprecate 刪 ~30 行 dialog + 1 個 e2e adjust |
| D6 | 一個 sink_kind 對應一個 React component vs 共用 SinkNode | 共用 SinkNode + discriminator | Palette 不爆;canvas 視覺一致 | sink_config 用 discriminated union;TS 維護成本可預測 |
| D7 | 後端 route 重構 | 抽 `lib/sink-runtime.ts`;新 `/api/dag/execute-sink`;舊 `/save-as-page` thin-wrapper alias | 隔離 sink 邏輯,future sink_kind 都走同 dispatch | +1 module(~100 行);既有 route 行為不變 |
| D8 | Sink 執行語意 | 顯式按 ▶ execute(不自動隨 upstream re-run) | Snapshot 是「刻意的存檔動作」,不該 implicit 觸發 | 跟現行 button click 語意一致;Curator 不會 surprise |
| D9 | Stale 偵測 | 如果 upstream `last_result` 比 sink `last_run.at` 新,sink chip 標 stale | UX validation pass 3 的「lifecycle 可見性」 | 純 client-side 比對 timestamp,~10 行 |
| D10 | Sink node 是否能複製 / 多 sink 同 origin | 允許,但每個 sink 須有 unique page_id | 滿足 future「同個 DAG 落地多個 audience(管理層 vs 工程)」需求 | 零新增 — page_id 衝突檢查現行已存在 |

### 3.8 Open questions(留待 sprint 中或 review 解決)

- **Q1**: Sink node ▶ Execute 按鈕是否要先 confirm dialog?(snapshot overwrite 是 user-visible side effect)
  - 傾向 *否* — overwrite checkbox 在 inspector;execute 直接執行符合「明確操作」語意
- **Q2**: Sink node delete 時是否同步 disable / delete `authz_ui_page` row?
  - 傾向 *否* — 平台 artifact 跟 DAG 分離 lifecycle,刪 sink node 只代表 DAG 不再 produce;artifact 可獨立保留(等 cascade plan)
- **Q3**: Save DAG 時若 sink 從未 execute,要不要警告?
  - 傾向 *是* — Validate 顯示 `info: sink "X" never executed, no artifact will exist after save`(non-blocking)

---

## 4. Acceptance Criteria

- [x] **AC-1**: Palette `Sinks` section 出現,含 `Page Snapshot` 一個項目;點擊在 canvas 上加一顆 sink node
- [x] **AC-2**: SinkNode 視覺 = 上述 §3.5(icon + page_id + chip + 單 input handle, no output)
- [x] **AC-3**: Inspector 對 sink node 顯示 sink_kind dropdown(MVP 只 `page`)+ page_id / title / parent_page_id / description / overwrite 五個欄位,預設值同現行 `SaveAsPageDialog` 邏輯
- [x] **AC-4**: Sink node ▶ Execute 按鈕呼叫 `POST /api/dag/execute-sink`,client 把 upstream `last_result.columns` + `last_result.rows` 附在 body(維持現行 save-as-page 的「snapshot of what Curator saw」契約);成功後 chip 顯示 `SAVED · N rows · Hh:MMago`,artifact 寫入 `authz_ui_page` 與現行 save-as-page 路徑等價
- [x] **AC-5**: Sink node ▶ Execute 失敗(例:upstream 沒 last_result / page_id 衝突 / authz fail / sink 沒接 upstream)顯示 inline error + actionable hint
- [x] **AC-6**: 舊 `Save as page` button 完全保留不動(dialog 仍彈、流程相同) — 既有 e2e `save + reload round-trip` 不需修改
- [x] **AC-7**: Sink 走 `audit_log` action_id=`dag_sink_page` row,resource_id 是上游 fn ancestor 的 resource_id(authz 繼承驗證)
- [x] **AC-8**: Save DAG 含 sink node 後 reload,sink node 與 sink_config 完整保留;Validate 不噴錯
      → 改用 DB-level roundtrip test(`test-sink.ts` Test 7+8):比 UI e2e 更穩、env-independent。實際保證來自三件事:
        (a) `dag-validate.ts` 對 unknown type 是 permissive 的(已加 sink/aggregate 到型別 union 註解)
        (b) `/save` 用 `JSON.stringify(attrs)` 持久化整個 nodes[] 到 JSONB
        (c) `loadDag()` 用 `setNodes(d.nodes)` 完整還原
- [x] **AC-9**: TypeScript build pass(`tsc -p` for both authz-api 和 authz-dashboard)
- [x] **AC-10**: Smoke test `services/authz-api/scripts/test-sink.ts` covers:page sink success / page_id 衝突 + overwrite / validateDag accepts sink / JSONB roundtrip(10/10 PASS)
- [x] **AC-11**: Playwright e2e (`05-flow-composer.spec.ts`) 2 個 sink case:palette→inspector 渲染、execute-without-upstream actionable error(4/4 PASS;execute happy path 改在 smoke test 覆蓋,因為 e2e env 沒 deploy fn_material_lookup)
- [x] **AC-12**: PROGRESS.md 加 `COMPOSER-SINK-V01` 條目;`composer-operator-and-sink.md` §2 next-sprint 標 sink-as-node-kind ✅;README sub-plans index 加本檔
- [ ] **AC-13**(stretch): 量測 — 在新 PR 描述加「old button 保留作 alias 的觀察期 deadline:下個 sprint review」,讓 deprecation 時點 explicit

---

## 5. Implementation Plan

### 5.1 Files touched

- `apps/authz-dashboard/src/components/DagTab.tsx` (sink node type + palette + Inspector branch + alias rewire)
- `apps/authz-dashboard/src/lib/api.ts` (新 `dagExecuteSink()` client)
- `services/authz-api/src/routes/dag.ts` (新 `/execute-sink` route;舊 `/save-as-page` 改 thin wrapper)
- `services/authz-api/src/lib/sink-runtime.ts` (NEW — emitPageSnapshot 從 save-as-page route 抽出)
- `services/authz-api/scripts/test-sink.ts` (NEW)
- `apps/authz-dashboard/e2e/05-flow-composer.spec.ts` (加 sink case)
- `.claude/plans/v3-phase-1/sink-as-node-kind-plan.md` (本檔)
- `.claude/plans/v3-phase-1/README.md` (索引 + status row)
- `.claude/plans/v3-phase-1/composer-operator-and-sink.md` (§2 標 sink-as-node ✅,加 cross-link)
- `docs/PROGRESS.md` (entry)

### 5.2 順序

1. 寫本 plan + README 更新(現在進行) ✅
2. 後端先行:`lib/sink-runtime.ts` 抽 `emitPageSnapshot`(refactor,行為不變);`/execute-sink` route;舊 route thin-wrap
3. 後端 smoke test 通過後做 frontend
4. Frontend:SinkNode component → palette → Inspector → alias rewire
5. Playwright e2e
6. PROGRESS.md + commit + push

### 5.3 Migration / DB notes

無 schema change。

---

## 6. Risks & Rollback

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| 既有 5/7 個 flow-composer e2e 因 env(palette-fn_material_lookup 未部署) pre-existing fail,新 sink-test 失敗時混淆歸因 | 高 | 低 | **實作前先 run e2e baseline 抓 pass/fail map;新 sink-test 只跟同一份 baseline diff** |
| Sink node 沒接 upstream 時 ▶ execute 邏輯模糊 | 低 | 低 | 早期 return + 明確 error;UX validation pass 4 已涵蓋 |
| sink_config JSONB 跟 operator op_config 都用 `node.data` 名稱衝突 | 低 | 低 | TypeScript discriminated union by `node.type`;sink_config / op_config 永遠互斥 |
| Stale 偵測 client-side timestamp 比對在 reload 後 lose state | 低 | 低 | sink `last_run.at` 跟 upstream `last_result` 都存 DAG attributes JSONB;reload 後仍可比對 |
| Sink 寫入 `authz_ui_page` 失敗(權限 / 衝突)時 sink node lifecycle chip 卡 `unsaved` 永遠 | 低 | 中 | execute 結果用 `last_run` + 錯誤 inline 顯示;不更新 chip 狀態,讓 Curator 直觀知道「這個 sink 還沒落地」 |
| Future `api` sink_kind 加進來時 dispatch table 變大 | 低 | 低 | 已用 strategy pattern;每個 sink_kind 自己一個 handler module |

**Rollback:**
1. **Frontend rollback** — 移除 sink palette entry + sink Inspector branch + alias rewire,Save-as-page button 復原為 dialog。已存的 sink node 在 reload 時 React Flow 會 graceful 顯示 unknown type chip。
2. **Backend rollback** — `/execute-sink` route 移除;`/save-as-page` 從 thin-wrapper 復原為原本邏輯(從 git history pull pre-commit 版本)。
3. **DAG cleanup**(若有 sink node 殘留):`UPDATE authz_resource SET attributes = jsonb_set(attributes, '{nodes}', (SELECT jsonb_agg(n) FROM jsonb_array_elements(attributes->'nodes') n WHERE n->>'type' != 'sink')) WHERE resource_type = 'function' AND resource_id LIKE 'dag:%' AND attributes ? 'nodes';`(SQL one-liner,zero data loss because authz_ui_page rows 是獨立的 artifact)

---

## 7. Maintenance Cost Assessment

### 7.1 一次性成本(本 sprint)

| 項目 | 估時 |
|------|------|
| 本 plan + README 更新 | 0.5 day(現在) |
| 後端 sink-runtime.ts + execute-sink route + smoke test | 1 day |
| Frontend SinkNode + Inspector + palette + alias | 1.5 day |
| Playwright e2e + bug fix | 0.5 day |
| Self-review + commit + PROGRESS update | 0.5 day |
| **合計** | **~4 days** |

### 7.2 持續成本(每月 / 每加 1 個 sink_kind)

| 項目 | 預估 |
|------|------|
| 既有 page sink 維護 | 接近 0 — 行為等價於現行 save-as-page,沒新增邏輯面 |
| 加一個新 sink_kind(api / cron / alert) | ~1.5-2 days/個(handler module + Inspector form + smoke) — 線性,不爆炸 |
| 舊 alias 觀察期 → 確定 deprecate | ~0.5 day(刪 ~10 行 + 1 個 e2e adjust) |
| `sink-as-resource` 升 first-class(saved_view sub-plan 時) | ~3-5 days(schema + cascade hook + migration) — 但這是平台升級,不是 sink-as-node-kind 的負債 |

### 7.3 機會成本對比(若不做)

- Q4 2026 AC「Tier B app 完全由 Curator 配出」**不可能達成** — 因為 Curator 看不到 sink 是 DAG 的一部分,「自助配 app」這件事在 sink 那一段 break
- 加 `api` / `cron` sink 時要在 button 平面開兩個新 button + 兩個 dialog —— 對應 P2 patch 增長,~每加一個 sink_kind 多 ~2 day 的 UI patch(對比 1.5 day 走 dispatch)

### 7.4 結論

**值得做**。一次性成本 4 天,換到:
- Q4 2026 AC unblock
- 未來每個 sink_kind 加成本從 ~2 day → ~1.5 day(節省 0.5 day × 預估 3 個 sink_kind = 1.5 day,基本回本)
- Canvas 單一視覺真相、cascade-ready 的 future 起點(雖本 sprint 不做 cascade,但結構就位)

---

## 8. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-29 | Adam | → DRAFT → IN-PROGRESS | 一人 session,planner = executor;接 composer-operator-and-sink §2 next-sprint 起跑 |

---

## 9. References

- Parent plan: [`./composer-operator-and-sink.md`](./composer-operator-and-sink.md) (operator + sink 整體)
- Two-tier model: [`./two-tier-platform-model.md`](./two-tier-platform-model.md) — Q4 2026 Tier B AC
- Master plan: [`../../../docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md)
- Cascade primitive: V079 `authz_resource_cascade_policy`(本 sprint 不 hook,但 D4 已記錄技術債)
- Save-as-page Path A ship note: `two-tier-platform-model.md` Phase 2 entry (2026-04-26)
- React Flow nodeTypes registry: https://reactflow.dev/learn/customization/custom-nodes
- Power Query / Dataiku output-as-step pattern (industry reference)
