# Composer Operator & Sink Primitives

- **Planner Owner:** Adam Ou
- **Executor Owner:** Adam (this session)
- **Status:** IN-PROGRESS — Now sprint DONE 2026-04-29(operator + agg + sink + AC-2 test lockdown);Next sprint = save-as-API sink
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.1 / [`./two-tier-platform-model.md`](./two-tier-platform-model.md)
- **Target:** Q3 2026 — Tier B authoring tool 補齊 operator + sink (rolling, no hard gate)
- **Created:** 2026-04-28
- **Last updated:** 2026-04-29

---

## 1. Problem / Why

Flow Composer (DagTab) 目前只有一種 node kind: `fn`(指向 `authz_resource(resource_type='function')`)。這代表:

- Curator 想做「過濾 row」、「常數輸入」、「型別轉換」、「聚合」都得**請 DBA 寫一個 SQL function**
- 平台 catalog 會被業務情境 fn 灌爆 — 估算 ~30 條 fn / 季 (10 DAG × 3 filter × 0.5 unique + agg/cast),~150 條新 `authz_role_permission` row、~5 hr DBA-Guardian 簽核時間
- DAG 的「最後變什麼」(page / API / 排程) 隱藏在 button 後,Curator 看不到 sink lifecycle

對照 `two-tier-platform-model.md`:這是 **Tier A primitive 缺失**,把 domain 邏輯逼到 Tier A catalog。對照 Power Query / Alteryx / Dataiku:operator(filter / aggregate / cast / projection)是平台 primitive,不是業務函式。

**這份 plan 把 operator 與 sink 變成 composer-native node kind,擋住 catalog bloat,把 Tier B authoring loop 補完。**

完整評估(14 features × user_value / days_to_ship / maint_cost,operator authz model,registry bloat 量化)見本 session 對話歷史。

---

## 2. Scope

**In scope (Now sprint, ~5 天) — DONE 2026-04-29:**
- [x] Multiplicity badge — `FunctionNode` header 顯示 scalar / table / setof / void / unknown (DagTab.tsx SHAPE_BADGE)
- [x] `dag-validate` 錯誤訊息升級 — `type_mismatch` 帶 `<handle>(<sem>/<pgType>)` 兩端 + hint;鎖在 `services/authz-api/scripts/test-validate.ts` 7/7 pass
- [x] Literal operator node — `node.type='literal'`,emit 單列常數
- [x] Filter operator node — `node.type='filter'`,upstream rows → 子集
- [x] Cast operator node — `node.type='cast'`,改一個 column 的 pgType
- [x] Operator runtime: server `dag.ts` 新增 operator dispatch path,**不過 `authz_check`**(權限繼承上游 fn 的 resource_id)

**In scope (Next sprint):**
- [x] Aggregator operator(`sum/count/min/max/avg` + group_by columns) — landed 2026-04-28 (COMPOSER-AGG-V01)
- [x] Sink-as-node-kind 重構 — `node.type='sink'`、`sink_kind ∈ { 'page' (MVP) | 'api'|'scheduled_job' }` — page kind landed 2026-04-29 (COMPOSER-SINK-V01),sub-plan: [`./sink-as-node-kind-plan.md`](./sink-as-node-kind-plan.md)。舊 Save-as-page button 保留作真 alias(advisor:真 alias 而非 spawn-on-click)。
- [ ] Save-as-API sink — 把 sink node 暴露成 REST endpoint(讀 origin DAG + bound_params + per-call authz_check) — 拆出獨立 sub-plan

**In scope (After saved_view + V075 stable):**
- [ ] Workflow trigger node — 綁 `authz_workflow_request` (V075)
- [ ] AI tool node — 整合 V061 ai-call
- [ ] Scheduled-job sink — 復用 V057 cron

**Out of scope (deferred / wishlist):**
- Projection / column rename node(row → row 變形大多可下游 fn 內處理)
- Join / fan-in node(複雜度高,證據不足)
- Fan-out / parallel branch(需求未證明)
- Sub-DAG / 引用另一個 DAG(等 ≥ 3 個重複 pattern 再做)
- Alert sink(等 subscription primitive,Q1 2027)
- Live re-execution snapshot page (Path B for DAG-SAVE-PAGE)— 等 saved_view primitive

---

## 3. Design / Approach

### 3.1 Operator node 模型

```
node = {
  id: 'op1',
  type: 'literal' | 'filter' | 'cast',  // 新增 (原本只有 'fn')
  data: {
    op_kind: 'literal' | 'filter' | 'cast',
    op_config: { ... },     // operator-specific
    inputs: [...],          // 從 op_kind 推
    outputs: [...],         // 從 op_kind + upstream 推
  }
}
```

**為什麼不放進 `authz_resource`?**
- Operator 不存取新資料源,不需要獨立 row 管控
- 註冊一個會反過來造成「每個 filter instance 一個 resource_id」, RBAC catalog 爆炸

### 3.2 Operator authz 模型

| 規則 | 內容 |
|---|---|
| Operator 不獨立 `authz_check` | filter / cast / literal 是純變形,不接觸新資料 |
| 權限繼承上游 | 上游通過 `authz_check(execute, fn:...)` = operator 通過 |
| Audit log 仍記 | `audit({ access_path:'B', action_id:'dag_op_<kind>', resource_id:<上游 fn>, context:{ op_node_id, op_config } })` |
| Literal node 例外 | 沒上游時 audit 用 `resource_id='operator:literal'`(沒實體 row,純佔位) |

理由:operator 之於 fn 等同於 SQL `WHERE` 之於 `SELECT * FROM tbl` — 不增加新存取面,只變形已通過的結果。

### 3.3 Operator runtime (server)

`POST /api/dag/execute-node` 目前只跑 PG fn:

```ts
if (node.type === 'fn' || !node.type) {
  // ... existing path ...
} else if (node.type === 'literal') {
  // emit single-row result from op_config.value
} else if (node.type === 'filter' || node.type === 'cast') {
  // read upstream rows (currently only row0 — extend to all rows)
  // apply predicate / cast / etc.
}
```

**重要的 runtime 升級**: 目前 `execute-node` 只把 upstream `row0` 餵下游 — 對 `fn` 夠用(scalar 綁定),但 operator 要看整個 row set。新增 `upstream[id].rows: Record<string, unknown>[]` 通道,operator 跑在這上面。

### 3.4 Multiplicity badge

`FunctionNode` header 加一個 chip:

```
┌────────────────────────────┐
│ fn_material_lookup [QUERY] │
│                  [⊞ table] │   ← 新 chip,scalar/table/setof
├────────────────────────────┤
```

來源是 `parsed_args` 已存在的 `return_shape.shape`(API 已 ship,只是 UI 沒用)。

### 3.5 Validate 訊息升級

當前:
```
Edge e1: 'p_material' → 'p_input' semantic types differ
```

改成:
```
Edge e1: 'p_material' (unknown / varchar) → 'p_input' (material_no / text):
  semantic_type mismatch (unknown vs material_no).
  Hint: insert a Cast node, or set semantic_type on upstream.
```

新增的 `unknown` 也要解釋意思(「此 column 還沒分類」)。

### Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Operator 是 composer-native vs SQL fn | composer-native | 防 catalog bloat ~30/季 |
| Operator authz | 繼承上游 | 不引入新 resource type / role 矩陣 |
| Runtime upstream | 從 `row0` 擴展到 `rows[]` | 沒這個 filter / aggregate 沒意義 |
| Filter predicate 語法 | DSL: `{ column, op, value }` (支援 `eq/ne/in/gt/lt/like`) | Phase 1 不上 SQL expression(injection 風險、parser 重) |
| Cast 範圍 | 一次一個 column 的 pgType | 多 column 用多個 cast node 串聯,簡單 |
| Literal 多輸出 | 不支援(只一個 output) | 多常數 = 多 literal node |

### Open questions

- [ ] 接 sink-as-node 後,DAG-SAVE-PAGE 既有 `save-as-page` button 是否保留作為 alias?(目前傾向保留至少一個 sprint,避免 break Curator muscle memory)
- [ ] Filter predicate 對 array 欄位(`text[]`)該支援哪些 op?(Next sprint 才碰 aggregator 時順便做)

---

## 4. Acceptance Criteria

### Now sprint — DONE 2026-04-29

- [x] **AC-1:** Multiplicity chip in `FunctionNode` header (DagTab.tsx SHAPE_BADGE,5 shapes inc. unknown)
- [x] **AC-2:** `dag-validate` `type_mismatch` 訊息含 `<handle>(<sem>/<pg>) → ...` 兩端 + 一行 hint;`scripts/test-validate.ts` 7/7 pass(semantic-strict + pgType-fallback 兩條 path 都鎖)
- [x] **AC-3:** Palette Operators section(Literal / Filter / Cast / Aggregate)+ Sink,點擊上 canvas
- [x] **AC-4:** Literal node Inspector(value + pgType)+ run 出單列(COMPOSER-OPERATOR-V01)
- [x] **AC-5:** Filter node Inspector(column + op + value)+ run 出子集(COMPOSER-OPERATOR-V01)
- [x] **AC-6:** Cast node Inspector(source_column + target_pgType)+ run 改 column pgType(COMPOSER-OPERATOR-V01)
- [x] **AC-7:** Operator 不過 `authz_check`,audit `dag_op_<kind>` 寫入(`dag.ts` operator dispatch + audit row 已驗)
- [x] **AC-8:** Save DAG 含 operator node 後 reload 結構保留;sink JSONB roundtrip 由 `test-sink.ts` Test 8 守
- [x] **AC-9:** `tsc -p` clean for authz-api 與 authz-dashboard(2026-04-29 verified)
- [x] **AC-10:** PROGRESS.md COMPOSER-OPERATOR-V01 / COMPOSER-AGG-V01 / COMPOSER-SINK-V01 三條 ship 記錄已落

### Next / After sprints

依序開新 sub-plan,或在本 plan 加章節。

---

## 5. Implementation Plan

### Now sprint tasks — DONE 2026-04-29

- [x] Sub-plan + README 更新
- [x] V0xx migration: 無(operator state 全在 `authz_resource.attributes` JSONB,sink 同樣 JSONB)
- [x] `apps/authz-dashboard/src/components/DagTab.tsx` — 加 operator + sink node types + palette + Inspector branches
- [x] `services/authz-api/src/routes/dag.ts` — execute-node 加 operator + sink dispatch
- [x] `services/authz-api/src/lib/dag-validate.ts` — 訊息升級(2-tier)+ operator passthrough + sink-only DAG 接受
- [x] `services/authz-api/src/lib/dag-operators.ts` (new) — operator runtime
- [x] `services/authz-api/src/lib/sink-runtime.ts` (new) — sink runtime + emitPageSnapshot + deriveSinkUpstreamFn
- [x] `services/authz-api/scripts/test-validate.ts` (new) — AC-2 spec lockdown 7/7 pass
- [x] `services/authz-api/scripts/test-sink.ts` (new) — sink runtime + JSONB roundtrip 8/8 pass
- [x] PROGRESS.md 加條(OPERATOR / AGG / SINK 三條)

### Files touched

- `apps/authz-dashboard/src/components/DagTab.tsx` (new node types, palette, Inspector)
- `services/authz-api/src/routes/dag.ts` (execute-node operator dispatch)
- `services/authz-api/src/lib/dag-validate.ts` (msg upgrade)
- `services/authz-api/src/lib/dag-operators.ts` (new)
- `.claude/plans/v3-phase-1/composer-operator-and-sink.md` (this file)
- `.claude/plans/v3-phase-1/README.md` (index row + status row)
- `docs/PROGRESS.md` (entry)

### Migration / DB notes

無 schema change。Operator state 存 `authz_resource.attributes->'nodes'` JSONB(現行 DAG 儲存通道)。

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Operator runtime 跟 fn runtime divergence,維護兩套 binding 邏輯 | 中 | 抽 `dag-operators.ts`,fn 那條走原 path 不動;operator 是 plugin |
| Predicate DSL 將來想升 SQL expr 時 schema 不相容 | 低 | `op_config` 是 JSONB,加 `expression_kind: 'dsl'` 欄位區隔,將來上 `'sql'` 時不破舊資料 |
| Authz 繼承模型被質疑(operator 漏掉新資料源) | 低 | operator 沒有 SQL injection 面、只在 row set 上跑;若將來新增 join 才需要重檢 |
| Save / load DAG 後 type unions(`fn` vs `literal`) 在 React Flow 出 type 錯 | 中 | TypeScript 嚴格 union;`nodeTypes` map 加每個 type 對應 component |

**Rollback:** Operator 是 additive — 移除 palette 入口 + execute-node operator dispatch 回原樣即可。已存 DAG 含 operator 的會在 reload 時看到 unknown node type;rollback 前先 `UPDATE authz_resource SET attributes = ... ` 清掉 operator nodes(SQL one-liner)。

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-28 | Adam | → DRAFT → IN-PROGRESS | 一人 session,planner = executor;直接開工 |
| 2026-04-29 | Adam | Now sprint DONE | multiplicity badge + AC-2 訊息(2-tier render)+ operator(literal/filter/cast/aggregate)+ sink(page kind)+ test-validate.ts 7/7 + test-sink.ts 8/8 + tsc clean × 2。Next:save-as-API sink |

---

## 8. References

- Master plan: [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md)
- Tier model: [`./two-tier-platform-model.md`](./two-tier-platform-model.md)
- Architecture: [`docs/phison-data-nexus-architecture-v2.4.md`](../../../docs/phison-data-nexus-architecture-v2.4.md)
- DAG-SAVE-PAGE-01 ship note: `two-tier-platform-model.md` Phase 2 entry (2026-04-26)
- React Flow node types: https://reactflow.dev/learn/customization/custom-nodes
- Power Query / Alteryx operator-as-primitive 模型 (industry reference)
