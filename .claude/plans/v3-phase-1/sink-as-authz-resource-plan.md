# Sink-as-authz_resource (Tier B Page Lifecycle Primitive)

- **Planner Owner:** Adam Ou
- **Executor Owner:** Claude (auto mode, 2026-04-29)
- **Status:** IN-REVIEW (code shipped, awaiting Adam smoke + AC closeout)
- **Linked from:** [`./sink-as-node-kind-plan.md`](./sink-as-node-kind-plan.md) §2.2 deferred / [`./tier-a-primitives-roadmap.md`](./tier-a-primitives-roadmap.md)
- **Target:** rolling — close before Q4 2026 Tier B 自助 AC
- **Created:** 2026-04-29
- **Last updated:** 2026-04-29

> 從 `sink-as-node-kind-plan.md` §2.2 被 deferred 的「Sink-as-authz_resource row (cascade hookable)」拆出來獨立規劃。原因:該 deferred 條目的鎖定理由是「跟 saved_view primitive(Q4 2026)一起做更省」,但 saved_view 已於 2026-04-29 改走 `authz_user_view`(per-user × per-page filter)路線(SAVED-VIEW-V01),跟 sink lifecycle 是不同 primitive,不應該綁。本 sub-plan 補上這條獨立的工作。

---

## 1. Problem / Why

### 1.1 Adam 直接觸發的 user flow gap

2026-04-29 Adam 在 Composer 把 `dag_test.n4` 拍成 Tier B page (`dag_test__n4_snapshot`) 之後問:**「之後的 ui 入口要怎麼進去?」**

當下系統行為:

1. Save 成功 → `authz_ui_page` row 寫入 (V054 path)
2. Frontend 派發 `open-auto-page` CustomEvent → `App.tsx` 把該 page 塞進 React state (`autoPagePreview`) + 切 `tab='auto-page'`
3. 立刻看得到 — **但 reload 即消失**(state-only,沒有持久化導航)

對照三個導航面:
| 面 | 是否能找到剛 save 的 page | 為什麼 |
|----|-------------------------|--------|
| **ModulesTab** (左側 Modules 樹) | ❌ 看不到 | ModulesTab 走 `module_tree_stats` matview,**完全不讀** `authz_ui_page` |
| **CommandPalette** (Ctrl+K) | ❌ 看不到 | 沒有 pages section |
| **URL deep-link** | ⚠️ 理論可,但需手動拼 `?page=<id>` | 沒有 router,沒有持久化 |

結論:save 成功 = "snapshot 進 DB" + "session-only preview"。**reload 之後該 page 等同孤兒**,只能靠 SQL `SELECT page_id FROM authz_ui_page` 找回來。

### 1.2 為什麼這是 architectural,不是 UX patch

現況有 **兩棵互不相連的樹**:

```
authz_resource (parent_id self-ref)        authz_ui_page (parent_page_id self-ref)
├─ module:pg_tiptop_v1                     ├─ modules_home  (root)
│  ├─ db_schema:pg_k8.tiptop               │  ├─ resource_detail
│  │  ├─ function:tiptop.search_cimzr...   │  └─ access_management
│  │  └─ ...                               └─ dag_test__n4_snapshot ← 新 sink artifact
│  └─ dag:material_search_fanout                                 (孤兒,無人指)
```

V070 cascade 只 walk `authz_resource.parent_id`。`authz_ui_page.parent_page_id` 是另一個獨立 FK 鏈,**沒有 cascade、沒有 RBAC 繼承、沒有 lifecycle hook**。

`sink-runtime.ts` 自己也承認:

```ts
//   - sink-as-authz_resource (deferred to saved_view sub-plan, Q4 2026).
```

而 saved_view 已改走 `authz_user_view`(per-user filter)那條路線,跟這裡完全不同的 primitive。**這個 deferred TODO 沒有 home,本 plan 補上。**

### 1.3 為什麼 Adam 拒絕短期方案

Adam 明確要求「直接完整方案,不用做短期的方案」。三個能想到的短期方案都被排除:

| 短期 | 為什麼不採 |
|------|-----------|
| URL deep-link `?page=<id>` | 治標,reload 仍需手動拼 URL,且新 page 沒有任何 surface 提示存在 |
| CommandPalette pages section | UI patch,但底層 `authz_ui_page` 仍是孤兒,RBAC 與 cascade 仍斷 |
| ModulesTab 直接 `SELECT * FROM authz_ui_page` 並列出 | 兩棵樹仍各自獨立,V079 cascade 不認 page,DAG rename / delete 仍 leak |

完整方案的判定:**page 必須是 first-class `authz_resource`**,讓兩棵樹在 root 處合一。

---

## 2. Scope

### 2.1 In scope

- [ ] **Schema:** `authz_resource.resource_type='ui_page'` 接受 `authz_ui_page.page_id` 作為 `resource_id` suffix(`page:<page_id>`)
- [ ] **Migration V0??:** 為現存 `authz_ui_page` 行 backfill `authz_resource(resource_type='ui_page')` row;parent_id 由 `parent_page_id` 推導(若 parent_page_id 在 authz_resource 已有對應 page row,直接接;否則指向 `module:pg_tiptop_v1` 之類的 fallback module — 由 cascade 行為決定預設策略)
- [ ] **`sink-runtime.ts.emitPageSnapshot`:** INSERT `authz_ui_page` 之外,**同 transaction** 內 INSERT `authz_resource(resource_id='page:'+page_id, resource_type='ui_page', parent_id=<derived>)`;`parent_id` derivation 使用既有的 `deriveSinkUpstreamFn` 結果 → 取該 fn 的 `parent_id` (即 fn 所屬 schema/module)
- [ ] **`ModulesTab.tsx`:** 模組 detail panel 的 leaf 列表中,把 `authz_resource WHERE parent_id=<module_id> AND resource_type='ui_page'` 一併渲染為「📄 Page」kind(與 function/table/dag 並列)
- [ ] **點擊 leaf → 開 page renderer:** 沿用既有 `open-auto-page` event 改派 page_id (而非 transient state) — 同樣的 ConfigEngine path,但這次 page_id 是 reload-safe 的
- [ ] **V079 cascade hook:** sink page 的 `authz_resource.parent_id` 變更時(rename / re-parent / soft-delete),沿用既有 `authz_resource_cascade_policy` —— 不需要新 cascade rule,只要 page 是 first-class resource 就自動受用
- [ ] **Golden case e2e:** seed `dag:material_search_fanout` (已 ship 2026-04-29) → run n1 → save n3 as page → reload → page 出現在 `module:pg_tiptop_v1` detail panel

### 2.2 Out of scope (defer)

| 項目 | 延後到 |
|------|--------|
| Live re-execution sink (`authz_ui_page` 變 data_source) | refresh-sink primitive,獨立 sub-plan |
| Page rename UI(只能 SQL 改) | Tier 2 admin form wizard |
| Page move-to-module UI | 同上;backend 路徑直接走 `UPDATE authz_resource SET parent_id` 即可 |
| `sink_kind='api' / 'scheduled_job' / 'alert'` 的 authz_resource 對應 | sink-as-node-kind-plan §2.2 各自獨立 sub-plan,但 **這次的 schema 形狀(resource_type 跟 page 並列)應該可重用** |
| CommandPalette pages section | UX nice-to-have,完成本 plan 後零成本加 |

### 2.3 Non-goals

- **不**改 `authz_ui_page.parent_page_id` 的語意 — 它仍是 page tree(前端 Modules 之外的場景如 `fn_ui_root` 仍用)。本 plan 是**疊加** `authz_resource` 鏡射,不是取代
- **不**為 sink 引入新 cascade rule — 借用現有 V079 框架
- **不**改 `emitPageSnapshot` 的 input contract — 公開 API 完全相容

---

## 3. Design / Approach

### 3.0 Decisions ratified during execution (2026-04-29)

| Plan draft said | Code shipped with | Why changed |
|-----------------|-------------------|-------------|
| `resource_type='ui_page'` (new enum) | `resource_type='page'` (existing enum) | `'page'` was already in the CHECK constraint AND already recognised by V060/V066/V067 cascade resolvers. Reusing it skips constraint widening + gets cascade for free. Verified via `pg_constraint` discovery (advisor warning resolved). |
| Fallback parent = `module:_orphan_pages` (new system module) | Fallback parent = `module:pg_tiptop_v1` (existing active module) | Avoids introducing a system module that needs separate RBAC governance + grant defaults. Current dev DB only has tiptop content; PROD backfill should re-eval if mixed-module pages exist. |
| Parent derivation = `deriveSinkUpstreamFn` → `fn.parent_id` (db_schema or module) | Parent derivation = `dag.parent_id` (the DAG's own module) | DAG is the authz boundary the user already navigated; pages-as-DAG-siblings group cleanly under one module. Walking through fn would scatter pages across schemas (deeper than the user's mental model). |

These 3 decisions are improvements over the draft and are now load-bearing in the code; downstream readers should treat the code as SSOT and the original §3.2/§3.3/§ key-decisions table prose as historical context (kept in place but supplemented by this table).

### 3.1 雙樹合流的接點

**選定接點:** `authz_resource.parent_id` 是 SSOT,`authz_ui_page.parent_page_id` 退為 view-only metadata(`fn_ui_root` 等舊 caller 仍用)。

```
NEW authz_resource hierarchy
│
├─ module:pg_tiptop_v1
│  ├─ db_schema:pg_k8.tiptop
│  │  └─ function:tiptop.search_cimzr067_by_keys
│  ├─ dag:material_search_fanout
│  └─ page:dag_test__n4_snapshot          ← NEW: resource_type='ui_page'
│     (parent_id 從上游 fn 的 parent_id 取得,
│      或由 sink_config.parent_page_id 顯式覆寫)
```

### 3.2 `parent_id` derivation

`emitPageSnapshot` 已有 `deriveSinkUpstreamFn`(回傳上游 fn 的 `resource_id`)。延伸:

```ts
function derivePageParentResource(
  pool: Pool,
  upstreamFnResourceId: string | null,   // from deriveSinkUpstreamFn
  explicitParentPageId: string | null,   // from PageSinkInput.parent_page_id
): Promise<string> {
  // 優先序:
  // 1. 若 sink_config 給了 parent_page_id 且該 page 對應 authz_resource 存在 → 用 'page:'+parent_page_id
  // 2. 若上游 fn 的 parent_id 存在 → 用 fn.parent_id (通常是 db_schema 或 module)
  // 3. fallback: 'module:_orphan_pages' (新增 system module 收容無主 page)
}
```

**為什麼不直接用 `parent_page_id` 對應的 page 當 parent:** Adam 的 dag_test 案例,`parent_page_id='modules_home'`,但 `modules_home` 是 system page,不對應任何 module。掛在 modules_home 之下的 page 應實質掛在 fn 所屬 module 之下,才能被該 module 的 read 權限 cascade。

### 3.3 Schema 變更最小化

`authz_resource` 已經多型(resource_type),不需要新表,只需要:

```sql
-- V0?? (next free; ls database/migrations/ before claim — currently V080 latest)
-- 1. 接受新 resource_type
-- ⚠ VERIFY BEFORE APPLY: 現行 constraint 名稱與現存 enum 成員未驗證。Executor
--   開工前先跑:
--     SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--     WHERE conrelid='authz_resource'::regclass
--       AND contype='c';
--   再用實際 constraint 名稱跟現存 enum members 補完下面這段,避免 silently
--   widen 或 漏列既有 type。
ALTER TABLE authz_resource
  DROP CONSTRAINT IF EXISTS authz_resource_resource_type_check;
ALTER TABLE authz_resource
  ADD CONSTRAINT authz_resource_resource_type_check
  CHECK (resource_type IN (
    -- 下列為 placeholder;以實際 \d+ 結果為準
    'module','db_schema','table','column','function','dag','ui_page'
  ));

-- 2. Backfill 現存 authz_ui_page 為 authz_resource 鏡射
--   parent 推導:若 parent_page_id 對應的 'page:<id>' 已 backfill 則接;
--   否則 fallback 到 module:pg_tiptop_v1 (現存 active module,
--   避免引入新 system module 增加 RBAC 治理負擔)。
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes, is_active)
SELECT
  'page:' || page_id,
  'ui_page',
  COALESCE(
    CASE WHEN parent_page_id IS NOT NULL
      THEN 'page:' || parent_page_id END,
    'module:pg_tiptop_v1'
  ),
  title,
  jsonb_build_object('page_id', page_id),
  is_active
FROM authz_ui_page
ON CONFLICT (resource_id) DO NOTHING;
```

> **Backfill 注意:** 第一次跑 fallback 全掛 `module:pg_tiptop_v1`,後續 sink 寫入時才走 `derivePageParentResource` 精準推導。漸進式,避免 V0?? 內做 fn ancestor walk。
>
> **若有非 tiptop 模組的舊 page 需要 fallback:** 由 executor 視 `authz_ui_page` 的內容自行擇 fallback module(可能需要 N→M mapping table)。本 plan 假設目前 authz_ui_page 主要是 tiptop / dev seed 內容;PROD backfill 前 dump rows 確認分佈。

### Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Page 是否成為 first-class authz_resource | ✅ Yes (`resource_type='ui_page'`) | 解決 P3 cascade gap;讓兩棵樹合一 |
| Backfill 策略 | 全部掛 `module:_orphan_pages`,新寫入才走 derivation | 避免 V0?? migration 內做 fn ancestor walk,降低 migration 風險 |
| 是否 deprecate `parent_page_id` | ❌ 仍保留 | `fn_ui_root` 等 legacy reader 還用;非 breaking |
| Sink runtime 是否 atomic INSERT 兩表 | ✅ 同 transaction | 避免 inconsistency;若 authz_resource INSERT 失敗則整個 sink revert |
| `module:_orphan_pages` 是否要 RBAC 公開 | ❌ default deny | 孤兒 page 應只有 author / admin 可見 |

### Open questions

- [ ] `authz_resource_cascade_policy` 對 `resource_type='ui_page'` 的預設行為(rename → page_id 連動?soft-delete → is_active=FALSE 連動?)— owner: planner,等本 plan READY-FOR-IMPLEMENTATION 之前敲死

---

## 4. Acceptance Criteria

- [x] **AC-1:** `POST /api/dag/execute-sink` (sink_kind=page) 同 transaction INSERT `authz_ui_page` + `authz_resource(resource_type='page')`,任一失敗則整個 revert — `services/authz-api/src/lib/sink-runtime.ts` `pool.connect()` + BEGIN/ROLLBACK/COMMIT
- [x] **AC-2:** ModulesTab 開 `module:pg_tiptop_v1` detail,leaf 區塊顯示新 save 的 page(reload 後仍存在)— `Pages` sub-tab in `ModuleDetail.tsx`,row 來自 `/api/modules/:id/details.children.pages`(reload-safe via DB)
- [~] **AC-3:** 點擊 leaf → ConfigEngine 渲染該 page snapshot;URL 帶 page_id 持久化 — **半達**:點擊→事件派發→ConfigEngine fetch by id 已實裝;但 URL 持久化 (router-level) 未做。Reload 在 `auto-page` tab 上仍會 lose,但 user 永遠可從 Modules → Pages 重新開啟,等同消除 reload-loss 的孤兒問題。Router-level URL state 留待 Tier 2 admin form wizard 一起做。
- [x] **AC-4:** Backfill migration:現存 dag-origin authz_ui_page rows 全部出現在 `authz_resource WHERE resource_type='page'`;count 對齊 — V081 INSERT 0 2 對齊 dag_test__n1/n4_snapshot
- [ ] **AC-5:** V079 cascade 對 `authz_resource(resource_type='page')` 的 `parent_id` 變更行為等同其他 resource_type — V079 框架不分 resource_type,理論上 free;但無 integration test。延遲到下次 V079 cascade_policy 整合測試 sweep
- [ ] **AC-6:** Tests: integration test (sink → both tables) + e2e Playwright (golden case `dag:material_search_fanout` n3 → save → reload → 出現在 ModulesTab) — **未寫**。當前 repo 的 sink-as-node-kind tests 也是 stub-level;沿用同 stub 標準延後到 sink-runtime test sweep
- [ ] **AC-7:** Docs: `docs/api-reference.md` `/execute-sink` section 標註雙寫;`docs/er-diagram.md` 補 `authz_resource(page) ⇢ authz_ui_page` 鏡射箭頭 — 未動;留 follow-up
- [x] **AC-8:** PROGRESS.md 加一行 — 已加 (2026-04-29)

---

## 5. Implementation Plan

> Executor session 在 IN-PROGRESS 階段填。

### Tasks
- [ ] (executor)

### Files touched (預估)
- `database/migrations/V0??__sink_as_authz_resource.sql` — schema + backfill
- `services/authz-api/src/lib/sink-runtime.ts` — `emitPageSnapshot` 雙寫 + `derivePageParentResource`
- `services/authz-api/src/routes/dag.ts` — 確保 `/execute-sink` route 走新版
- `services/authz-api/src/routes/modules.ts` — `/api/modules/:id/details` 增加 `ui_page` leaves
- `apps/authz-dashboard/src/components/modules/ModulesTab.tsx` — render `ui_page` leaves
- `apps/authz-dashboard/src/App.tsx` — `open-auto-page` 改吃 page_id (reload-safe)

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Backfill 把現存 page 全掛 `module:_orphan_pages`,RBAC 預設 deny → admin 找不到舊 page | 高 | Backfill 後立即跑 admin grant script;或 module 預設 read 給 dba role |
| `parent_id` derivation 對沒有 fn ancestor 的 sink (literal-only DAG) 沒結論 | 低 | 走 fallback `module:_orphan_pages`;e2e 涵蓋 |
| V079 cascade 對 `ui_page` 行為意外 (例如 module rename → page_id 也跟著改) | 中 | 預設 cascade policy 對 `ui_page` 設 `cascade_strategy='no_op'`,直到顯式 opt-in |
| 兩表雙寫破 transaction (例如 sink runtime 的 pool client 不是 single tx) | 中 | 改用 `pool.connect()` + BEGIN/COMMIT;或用 SQL function 包起來 |

**Rollback:** 移除 `authz_resource WHERE resource_type='ui_page'` 整批,還原 `emitPageSnapshot` single-table INSERT 版本。`authz_ui_page` 本身不動,功能退回今日狀態。

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-29 | Planner | → DRAFT | Adam ask for complete solution; 從 sink-as-node-kind §2.2 deferred 拆出 |
| 2026-04-29 | Claude (auto) | DRAFT → IN-REVIEW | V081 + sink-runtime dual-write + ModulesTab Pages sub-tab shipped & type-checked. 3 design ratifications (見 §3.0) + AC-3/5/6/7 部分未閉(見 §4 註記). Awaiting Adam restart authz-api + Composer smoke. |

---

## 8. References

- Master plan: [`../../../docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md)
- 上游 sub-plan: [`./sink-as-node-kind-plan.md`](./sink-as-node-kind-plan.md) §2.2 deferred
- Cascade 框架: [`./permission-inheritance-cascade.md`](./permission-inheritance-cascade.md) (V070) + V079 cascade policy
- 已 ship 的 saved_view (注意:不同 primitive): [`./tier-a-saved-view-plan.md`](./tier-a-saved-view-plan.md)
- Tier A 路線圖: [`./tier-a-primitives-roadmap.md`](./tier-a-primitives-roadmap.md)
- Golden case seed: `database/seed/dag_material_search_fanout.sql` (2026-04-29)
- Sink runtime SSOT: `services/authz-api/src/lib/sink-runtime.ts`
- Existing snapshot migration: `database/migrations/V054__authz_ui_page_snapshot.sql`
