# DAG-PUBLISH-V01-FU — Bidirectional exposure（中間 input + 中間 output）

**Status**: in-progress (2026-04-30)
**Owner**: Adam + Claude
**Plan-of**: V086 published-DAG primitive 的 follow-up — 把「使用者只看到 leaf」放寬成「可看任意層」、把「只能 expose leaf 的 input」放寬成「可 expose 任意 fn node 的 input」。
**Demo target**: 同 V086，`ds:pg_k8` 真 tiptop。

---

## 1. Goal

V086 為了求 spine 簡單，鎖了兩條：
1. published page 只暴露 **leaf node** 的 rows（中間 fn 的結果是 transient）
2. user 表單欄位只來自任何 fn node 的 `user_input_params`，但 UI 練習場景多半在 leaf

這個 FU 兩件事一起放寬：

| Fork | 放寬什麼 |
|---|---|
| **(C) input @ any layer** | DagTab 的 user_input checkbox 已經可以勾任何 fn node 的 input；deriveFormSchema 也已經 iterate 全部 fn nodes。**這條後端零成本，只需確認 + 新測試**。 |
| **(1) output @ any layer** | admin 在 Composer 把任意 node 標記 `expose_output: true`；published page 的 PublishedDagPage 為每一個 exposed node render 一個結果區塊，leaf 永遠是 primary。 |

合在一起 = "DAG 的進出兩端都可由 admin 自由打孔給 Tier B 看"。

## 2. Non-goals

- ❌ Multi-leaf publish — 仍然 single-leaf check，避免 "primary output is which?" 的歧義
- ❌ Function swap by end-user — Tier B 不再選 function（屬於 fork B，需單獨 spec）
- ❌ Per-output column-mask — phase 2 才做（V086 也還沒做）
- ❌ Schema migration — `dag_snapshot` 是 jsonb，新增 `exposed_node_ids` 欄位無需 V0xx

## 3. Real forks

### Fork D — Leaf 是不是自動 expose？

| 選項 | 取捨 |
|---|---|
| (a) Leaf 自動含進 `exposed_node_ids`，admin 不必勾 | UX 直觀（leaf 必出現、不用想；中間才是 opt-in） |
| (b) Admin 必須 explicit 勾 leaf 才 expose | 一致但繁瑣，多 1 click 沒收益 |

**Default = (a)**：leaf 自動 + Composer 對 leaf 的 expose checkbox 顯示 disabled+checked（視覺提示「這條一定會 expose」）。

### Fork E — Form input dedup 政策（C 衍生）

兩個 fn node 都用 `p_keywords`：

| 選項 | 取捨 |
|---|---|
| (a) **同名共用同一個欄位**（現行 `deriveFormSchema` dedup-by-name 行為） | 表單簡潔；同義語意自然合一；但若 admin 不小心讓兩個 fn 的 `p_keywords` 語意不同，會踩雷 |
| (b) 每個 node 的 input 各自一個欄位（key = `node_id.name`） | 嚴格但醜，且 form 大量重覆 |

**Default = (a)**（不變）：保留 V086 的 dedup-by-name；admin 責任避免同名歧義。docstring 加註說明。

## 4. Schema changes

**無 SQL migration**。`dag_snapshot` jsonb 內新增：

```jsonc
{
  "data_source_id": "ds:pg_k8",
  "nodes": [...],          // unchanged shape; 各 node 的 data 內 optional 加 expose_output: boolean
  "edges": [...],
  "output_node_id": "n_leaf",        // unchanged: primary
  "exposed_node_ids": [               // NEW: leaf + admin-flagged 中間 nodes，dedup
    "n_leaf",
    "n_middle_1"
  ]
}
```

`form_schema` 結構不變（仍是 `PublishedFormField[]`，per-name dedup）。

## 5. Code changes

| 件 | 變更 |
|---|---|
| `services/authz-api/src/lib/dag-exec.ts` | `DagNode.data` 加 `expose_output?: boolean`；`DagExecResult` 改 shape：`outputs: Record<nodeId, { columns, rows, row_count, truncated }>`、`primary_output_node_id: string`、保留 `elapsed_ms`/`lineage`。 主迴圈不變（topo 仍跑全圖）；末段從 `frames` 抽出 `exposed_node_ids` 對應的 frame。 |
| `services/authz-api/src/routes/dag.ts` | Publish handler 第 4 步建 `dagSnapshot` 時，多一行 `exposed_node_ids = uniq([outputNodeId, ...nodes.filter(n => n.data.expose_output).map(n => n.id)])`。response payload 增 `exposed_node_ids`。 |
| `services/authz-api/src/routes/config-exec.ts` | published_dag exec 分支：`meta.outputs = result.outputs`、`meta.primary_output_node_id = result.primary_output_node_id`。`config.columns` / 回傳 `data` 仍填 primary 的（向後相容）。`form_schema` 不動。 |
| `apps/authz-dashboard/src/components/DagTab.tsx` | Inspector 加 node-level checkbox "Expose output to Tier B"，狀態存 `node.data.expose_output`。Leaf 自動勾 + disabled。Toolbar 摘要顯示 expose count。 |
| `apps/authz-dashboard/src/components/ConfigEngine.tsx` | `PageMeta.outputs?: Record<string, OutputBlock>`、`primary_output_node_id?: string`。`PublishedDagPage` 改成迴圈 render `Object.entries(meta.outputs)`，primary 第一、其他依 node id 排序，每段有 header（node id + 來源 fn name）、rows 表、row_count/truncated 標。沒有 `meta.outputs` 時 fall back 到舊 single-table（向後相容已 publish 但未 re-publish 的頁）。 |
| `apps/authz-dashboard/src/api.ts` | `dagPublish` response 多 `exposed_node_ids: string[]`、`configExecPage` meta 多 `outputs/primary_output_node_id`。 |

預估 ~350 LOC（明顯小於 V086，因為 schema 不動、authz 不動）。

## 6. Authz model（不變）

仍是 publish=bless（Fork A=(b)）。`exposed_node_ids` 沒有獨立的 authz 概念——通過 `read on published_dag:<rid>` 即可看到所有 exposed outputs。中間 node 不做額外 gate。理由：admin 在 publish 時已經 review 過整個 pipeline，blessing 涵蓋全部 exposed outputs。

> 風險：admin 不慎把含 PII 的中間 fn flag 為 expose。預防靠 publish 預覽（FU 之外）+ audit trail（已有 `published_dag` resource 記 blessed_by）。

## 7. Smoke test

新建 `database/seed/_test_publish_smoke_bidir.sql`：

1. 兩個 fn node 串成 DAG：
   - `n_search` → `tiptop.search_cimzr067_by_keys`（user_input: `p_keywords`）
   - `n_leaf` → 對 search 結果做後處理的 fn（或 op 節點：`filter` / `aggregate`）
2. `expose_output` 勾在 `n_search`（leaf 自動）
3. publish → 檢 `dag_snapshot.exposed_node_ids = [n_leaf, n_search]`
4. exec → `meta.outputs` 有 2 把 key、各自 rows
5. 前端：兩個結果區塊都 render

## 8. Out of scope（FU 之 FU）

- per-output column 名稱在 form_schema 外的 `output_meta`（label/desc）
- swappable function slots（fork B）
- per-output `read` authz 細粒度
- multi-leaf 真正放寬

## 9. Non-breaking 約定

- 已 publish 的舊 V086 頁（`dag_snapshot` 沒有 `exposed_node_ids`）：dag-exec 預設 `exposed_node_ids = [output_node_id]`，行為等於 V086。
- 前端 `PublishedDagPage` 沒收到 `meta.outputs` 時 fall back 到 V086 的 single-table 渲染。
- `data` 欄位（API response 第一級）仍填 primary rows——不破壞任何讀 `data` 的旁路。

---

## 驗收

- [ ] `_test_publish_smoke_bidir.sql` publish 成功，`exposed_node_ids` 正確
- [ ] exec 回傳 `outputs` map ≥ 2 個 key，每個都有 rows
- [ ] BI_USER (`tsai_bi`) 可看，nobody_user 仍 403
- [ ] 已 publish 的舊頁（V086 smoke test 那個）仍可正常 render（向後相容）
- [ ] TS check 雙端 pass
- [ ] 前端視覺驗證：標 unverified（per UI verification autonomy memory）
