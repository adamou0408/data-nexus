# DAG-SUBDAG-EMBED-V01 — Sub-DAG embedding（DAG 互相引用 / shared upstream）

**Status**: planned (2026-04-30)
**Owner**: Adam + Claude
**Plan-of**: V086 + DAG-PUBLISH-V01-FU 主軸「AuthZ-as-Composition」的下一個 composability primitive。
**Demo target**: 同 V086，`ds:pg_k8` 真 tiptop。

---

## 1. Goal

讓一個已 publish 的 DAG 可以作為 **node** 嵌進另一個 DAG。共用 upstream 鏈不必每次重複拉 fn。

舉例：「active cimzr067 part lookup」這條鏈（search → filter non-empty）已 publish 為 `dag:active_parts`。下一條業務 DAG「BU 級彙整」要建在這個鏈之上，admin 在 Composer 加一個 **sub-DAG node**，pick `dag:active_parts`，後面接自己的 aggregate fn。

論述：DAG = 授權單位，也是 reuse 單位。Embed = 把「已 bless 的 building block」拼成新的 building block，lineage 由結構直接帶出。

### Family-tree shape v01 顯式覆蓋

| 形態 | v01 怎麼處理 |
|------|---|
| **1 parent → N children** | 一個 parent 放 N 個 subdag node，各自 inline，prefix 不撞 |
| **N parents → 1 child** | 同一個 child published_dag 可被任意數量的 parent ref，每個 parent 各 inline 一份 |
| **多代 (grandparent → parent → child)** | 透過 publish event 自動扁平：child 自身 publish 時已 flat，parent 用的是 child 已 flat 的 snapshot，孫輩自動繼承 |
| **Inverse lookup (child → embedders)** | 透過新 endpoint `GET /api/dag/published/:rid/embedders` 查詢（見 §5） |
| **Cascade impact UI / family tree UI / re-publish notify** | v01 backend 提供 data，UI 在 FU |

## 2. Non-goals

- ❌ **跨 datasource**：v01 強制 parent 與 child 同一個 `data_source_id`（fork D）。跨源由 Cross-Source Discovery plan 另行處理。
- ❌ **遞迴深度 > 2 層**：v01 限制 child 自身的 dag_snapshot **不能再含未解析的 subdag node**。因為 inline-expand 在 parent publish 時做，child 必然是 flat 的（child 自己 publish 時也已經 inline 過自己的 sub-DAG）。所以「深度」概念其實只在 author time 存在。
- ❌ **Live update**：child 重新 publish 不影響已 publish 的 parent。Parent 必須 explicit re-publish 才會 pull 新 child snapshot。
- ❌ **Sub-DAG 的 sink 跟著 expand**：child 的 sink（如 `sink_kind='page'`）是 child 自己 publish 的產物，不重複 emit。Inline 時 sink node 直接丟掉。
- ❌ **Sub-DAG output column rename / project**：用 `op:project` 串在 sub-DAG node 後面解決，不在 sub-DAG primitive 裡開。
- ❌ **Schema migration**：`dag_snapshot` jsonb 內加新 node type + 欄位即可，無 V0xx。

## 3. Real forks

### Fork A — Snapshot moment

| 選項 | 取捨 |
|---|---|
| (a) **Parent publish 時 inline-snapshot child** | Reproducible。Child 重 publish 不動 parent。Lineage by construction。Audit 容易（parent snapshot 自包含）。代價：snapshot 體積較大、parent 拿不到 child 的 bug fix |
| (b) Reference-only，exec 時 resolve | 自動跟著 child 升級。代價：parent 行為被 child 改動，違反「published_dag = bless 凍結」直覺；audit 必須 join child snapshot |

**Default = (a)**。理由：lineage by construction 是 Data Nexus 主軸；child re-publish 應該是 explicit 升級事件，不能默默生效。Parent admin 想升級 → 重 publish。

### Fork B — Sub-DAG output 選哪個

| 選項 | 取捨 |
|---|---|
| (a) Parent 一定接 child 的 primary（leaf） | 簡單；但 child 既然已支援 multi-output（FU），這裡只用 primary 浪費了 |
| (b) Parent 可指定 child 的任一 `exposed_node_ids` | 與 FU 完全對齊；admin opt-in 過的 child node 才能被消費，沒有 leaky 風險 |
| (c) 完全不限 | 會暴露未 expose 的中間 frame，破壞 child admin 的 expose 控制 |

**Default = (b)**：parent 的 sub-DAG node Inspector 顯示 child 的 `exposed_node_ids` 下拉，預設 = child 的 `primary_output_node_id`。

### Fork C — Sub-DAG input 怎麼餵到 parent form

| 選項 | 取捨 |
|---|---|
| (a) Child 全部 `user_input_params` 自動 surface 到 parent form | 簡單但失控；parent admin 想鎖死某些 child input 沒手段 |
| (b) Parent admin 用 checkbox 選 child 哪些 user_input 要 surface；剩下 demoted 為 bound_params（用 child snapshot 的 default 或 parent admin override） | 與 fn node 的 `user_input_params` 機制完全平行；admin 控制力強 |
| (c) Parent 必須 explicit map 每個 child input ↔ parent input | 嚴格但繁瑣；parent form 同名語意不一致時更安全 |

**Default = (b)**：parent admin 用 checkbox。Dedup-by-name 政策延用 V086（admin 責任避免同名歧義）。

### Fork D — Cross-datasource embed

| 選項 | 取捨 |
|---|---|
| (a) **強制同 ds**：`child.data_source_id === parent.data_source_id`，不同就 publish 拒收 | 簡單；frame 不必在 PG pool 之間 marshal |
| (b) 允許跨 ds | 需要中介 frame layer + cross-pool join 語意，超出 v01 |

**Default = (a)**。

### Fork E — Authz transitive check at publish

| 選項 | 取捨 |
|---|---|
| (a) Parent author 必須有 `read on published_dag:<child rid>` 才能 publish parent | DATA_STEWARD 一般可 read 全部 published_dag；若未來細粒度，這個 gate 必須在 |
| (b) 不檢（信任 admin 角色） | 開放，但細粒度 authz 上線後要回頭補 |

**Default = (a)**。一行 authz_check，預防勝於治療。

### Fork F — Inlined node id 命名

| 選項 | 取捨 |
|---|---|
| (a) Prefix child node id：`<subdagNodeId>__<childNodeId>` | 可讀、debug friendly、collision-proof |
| (b) UUID rewrite | 沒重複但 audit 看不懂哪來的 |
| (c) Force admin pick 唯一 id | 把 collision 推給 admin |

**Default = (a)**。Audit context 加 `embedded_subdag_rids` 仍可回查原 child rid。

## 4. Schema changes

**無 SQL migration**。`dag_snapshot` jsonb 內新增 / 擴充：

### 新 node type: `'subdag'`（**author-time only**）

Author DAG attributes（`authz_resource(resource_type='dag')`）裡會看到：

```jsonc
{
  "id": "n_subdag_active_parts",
  "type": "subdag",
  "data": {
    "label": "Active parts (shared)",
    "resource_id": "published_dag:dag:active_parts",
    "subdag_source_output_node_id": "n_leaf",        // child 的哪個 exposed output 進 parent edge
    "subdag_user_inputs": ["p_keywords"],             // child 哪些 user_input 留作 parent form 欄位
    "bound_subdag_params": {                          // child user_input 不留的，由 parent 給死值（覆蓋 child snapshot 預設）
      "p_limit": 100
    }
  },
  "position": { "x": 0, "y": 0 }
}
```

### Published parent snapshot（`authz_ui_page.dag_snapshot`）= **flat**

Parent publish 時 inline-expand：
- Subdag node 從 parent.nodes 移除
- Child snapshot 的所有 nodes 加入 parent.nodes，id prefix 成 `<subdagNodeId>__<childNodeId>`
- Child sinks 丟掉（不 expand）
- Edge 重接：
  - 原本指向 subdag node 的 inbound edge → 重接到 prefixed child output node
  - 原本從 subdag node 出去的 outbound edge → 從 prefixed child output node 出
- Child 的 fn nodes 被改寫：`user_input_params` 過濾為 `subdag_user_inputs`，被剔除的 input 把值寫進 `bound_params`

結果：parent dag_snapshot 跟一條手刻出的 flat DAG 完全等價。**dag-exec.ts 完全不必變**。

### Inverse-lookup metadata：`dag_snapshot.embedded_subdags`（**新欄位**）

為了支援「哪些 parent 在 embed child X」的反向查詢（family-tree v01），inline-expand 時在 dag_snapshot 裡多寫一筆：

```jsonc
"dag_snapshot": {
  "data_source_id": "ds:pg_k8",
  "nodes": [...flat...],
  "edges": [...],
  "output_node_id": "n_count",
  "exposed_node_ids": ["n_count"],
  "embedded_subdags": [                           // NEW v01: current-state inverse-lookup index
    {
      "subdag_node_id": "n_subdag_active_parts",
      "child_rid": "published_dag:dag:active_parts",
      "child_output_node_id": "n_filter",         // which exposed_node_id of child got consumed
      "child_user_inputs_surfaced": ["p_keywords"]
    }
  ]
}
```

Audit log **同時**記一份 `embedded_subdag_rids` 在 `audit_log.context`（forensic、append-only）；dag_snapshot 上的這個欄位是「**parent 當前真在 embed 誰**」的可查詢索引（parent 重新 publish 後會被覆寫）。

兩份的職責：
- `dag_snapshot.embedded_subdags`：**current state**，inverse-query endpoint 唯讀掃這個。
- `audit_log.context.embedded_subdag_rids`：**append-only history**，「parent 過去某次 publish 用過誰」的歷史軌跡。

### Author-time parent DAG（`authz_resource(resource_type='dag')`）

Subdag node 保留原樣（`type='subdag'` + `resource_id='published_dag:...'`）。**只有 publish 才 expand**。重新 author 時 parent 看到的還是 subdag node（不是被攤平的 ~30 個 fn node）。

## 5. Code changes

| 件 | 變更 |
|---|---|
| `services/authz-api/src/lib/dag-subdag-resolver.ts` (**new**) | `expandSubdags(parentNodes, parentEdges, opts) → { nodes, edges, embeddedRids }`：fetch child published_dag、prefix node ids、rewrite edges、demote unchosen user_inputs。Cycle detection（child 內含未解析 subdag → throw，理論上不會發生但守一層）。 ~150 LOC |
| `services/authz-api/src/routes/dag.ts` | Publish handler：第 1 步驗 single-leaf **之前**先 `expandSubdags`，得到 flat nodes/edges，後續流程不變。Authz transitive check：對每個 subdag node，`authz_check(read, published_dag:<rid>, parentAuthor)`，403 on miss。Audit context 加 `embedded_subdag_rids`。 ~50 LOC |
| `services/authz-api/src/lib/dag-exec.ts` | **零變更**。Sub-DAG 在 published snapshot 已是 flat。 |
| `apps/authz-dashboard/src/components/DagTab.tsx` | 新 node kind `'subdag'`：palette 加 button、Inspector 加 - published_dag picker（dropdown，filter by user 可 read 的 published_dag list）- output picker（child 的 `exposed_node_ids` radio）- input checklist（child user_inputs，勾 = surface to parent form，未勾 = bind to constant）- bound override 編輯（unchosen input 的 default 可改）。 ~250 LOC |
| `apps/authz-dashboard/src/components/ConfigEngine.tsx` | **零變更**。Published page 只看 flat snapshot，subdag 概念在 publish 時消滅。 |
| `services/authz-api/src/routes/dag.ts`（list endpoint） | 新增 `GET /api/dag/published-list?data_source_id=<id>`：列出 parent author 可 read 的 published_dag（過濾同 ds）。供 DagTab dropdown 用。 ~30 LOC |
| `services/authz-api/src/routes/dag.ts`（snapshot fetch） | 新增 `GET /api/dag/published/:rid/snapshot-meta`：回 `data_source_id`, `exposed_node_ids`, `form_schema`（DagTab Inspector 渲染要用）。 ~40 LOC |
| `services/authz-api/src/routes/dag.ts`（**inverse query**） | 新增 `GET /api/dag/published/:rid/embedders`：JSONB query `WHERE dag_snapshot->'embedded_subdags' @> '[{"child_rid":"<rid>"}]'` over `authz_ui_page`，回 `{ parents: [{ parent_page_id, parent_published_dag_rid, parent_title, embedded_at_node_id, child_output_node_id, blessed_by, blessed_at }] }`。Authz：caller 必須對 child rid 有 `read`（與其他 published_dag endpoint 一致）。**這是 family-tree v01 的 backend SSOT**——後續 cascade impact UI / re-publish notify 都吃這條。 ~30 LOC |

預估 ~530 LOC（前端 47%、後端 publish-time resolver 28%、新 endpoint 25%）。dag-exec/config-exec/PublishedDagPage 完全不動 — 主軸就是這個：**sub-DAG 是 publish-time 概念，runtime 仍是 flat DAG**。

## 6. Authz model

- **Author time**：parent admin 在 Composer 拖 sub-DAG node 時，published_dag dropdown 已過濾為「user 有 read 權限的 published_dag」。看不到的不能 embed。
- **Publish time**：對每個 subdag node，後端再驗一次 `authz_check(read, published_dag:<child rid>, parent.blessed_by)`，挡 race condition 或前端 bypass。
- **Exec time**：BI_USER 拿 parent published_dag 的 read 即可看完整輸出；child 的 access **不傳遞**到 BI_USER（child 已經被 inline，不再是獨立 resource）。
- **Audit trail**：audit_log.context.embedded_subdag_rids 記錄 inline 來源。配合 V044 cascade 可查「child rid X 被哪些 parent embed」。

> 風險 1：parent admin 把含 PII 的 child 嵌進 public-ish 的 parent。預防靠 publish 時 PII semantic_type 預警（FU-of-FU，不在 v01）。
>
> 風險 2：child 已 deprecate 但 parent 還在 ref。Parent 再 publish 時會跑 inline，child 若仍 active 就會 success；child 已 `is_active=FALSE` → 403 from authz_check。**可接受**：強制 parent admin 換 ref 或重新 author。

## 7. Smoke test

新建 `database/seed/_test_subdag_embed_smoke.sql`：

1. **Child** `dag:_test_subdag_active_parts`：
   - `n_search` → `tiptop.search_cimzr067_by_keys`（user_input: `p_keywords`、bound `p_limit=10`）
   - `n_filter` → op:filter `tc_ima001 ne ''`
   - leaf 是 `n_filter`
   - publish 為 page `_test_subdag_active_parts_pub`
2. **Parent** `dag:_test_subdag_embed`：
   - `n_subdag` → type:subdag, resource_id=`published_dag:dag:_test_subdag_active_parts`, source_output=`n_filter`, subdag_user_inputs=[`p_keywords`]
   - `n_count` → op:aggregate count(*) over subdag output
   - leaf 是 `n_count`
   - publish 為 page `_test_subdag_embed_pub`
3. 驗 parent 的 `dag_snapshot.nodes`：≥ 3 個 nodes（`n_subdag__n_search`, `n_subdag__n_filter`, `n_count`），edge `n_subdag__n_filter → n_count` 存在，原 `n_subdag` 已不見。
4. 驗 parent 的 `form_schema`：含 `p_keywords`（source_node_id = `n_subdag__n_search`）。
5. 驗 parent 的 audit_log.context.embedded_subdag_rids 含 child rid。
6. exec parent → 拿到 count，row_count = 1。
7. **Inverse query**：`GET /api/dag/published/dag:_test_subdag_active_parts/embedders` → 回 `parents` 至少含 `_test_subdag_embed_pub`、`embedded_at_node_id='n_subdag'`、`child_output_node_id='n_filter'`。
8. **Authz negative**：把 child 的 read 從 parent author 拿掉，再次 publish parent → 403。
9. **Cross-ds negative**：建 child on `ds:pg_k8`，parent 設 `data_source_id='ds:other'` → publish 拒收。

## 8. Out of scope（FU 之 FU）

- **Family-tree UI**：瀏覽 DAG 之間的 parent / child / sibling 關係視圖（用 v01 的 `embedders` endpoint 當 data source 即可開工）
- **Cascade impact view**：「我想 deprecate child X，會影響哪些 parent」清單 + 預警
- **Re-publish notify**：child 出新版時通知所有 embedding parents 的 admin
- **Diff view**：child 新版 vs parent 凍結的舊 inline snapshot 差在哪（協助 admin 決定是否 re-publish）
- Sub-DAG version pinning UI（pin 到 child 的某個歷史 publish version）
- Sub-DAG library tab（瀏覽可 reuse 的 published_dag 集中視圖）
- 跨 datasource embed
- PII propagation 預警
- Subdag node 在 parent 上的「expose internal output」— 等於 child 的 admin-flag 已決定哪些 internal node 暴露，parent 只能挑 child exposed 子集，沒必要再 expose 一次
- 透過 `op:project` rename child output column（已存在，純 admin 動作）

## 9. Non-breaking 約定

- 已 publish 的 V086/FU pages 完全不受影響（沒 subdag node 就走原 path）。
- Parent author DAG 沒用 subdag node 也完全不受影響。
- 新增 endpoint（published-list / snapshot-meta）是新 route，不改舊 route 行為。
- Audit log context 多一個 optional key，舊 reader 忽略即可。

## 10. 主軸對齊檢查

| 主軸論述 | v01 是否強化 |
|---|---|
| AuthZ-as-Composition：DAG 是授權單位 | ✅ Sub-DAG embed 必須通過 child 的 read authz |
| Lineage by construction | ✅ Inline expand 把 child 結構併入 parent，lineage 由 topo 直接帶出，不靠外部記錄 |
| Reproducibility | ✅ Snapshot moment = parent publish time，child 異動不影響已 publish parent |
| Composer = zero-code page builder | ✅ Sub-DAG 是 admin-time visual primitive，無 SQL/code |
| 不重複維護共用 upstream | ✅ 一個 child 可被任意 parent embed，author 一次、bless 一次、reuse N 次 |
| Inverse lineage (child → parents) | ✅ `dag_snapshot.embedded_subdags` 索引 + `embedders` endpoint，未來 family-tree UI 不必回頭加 data |

---

## 驗收

- [ ] `_test_subdag_embed_smoke.sql` publish 成功，flat snapshot 結構正確
- [ ] form_schema 透出 child user_inputs 並標 `source_node_id` 為 prefixed id
- [ ] audit context 記 `embedded_subdag_rids`，dag_snapshot 寫 `embedded_subdags` 索引
- [ ] `GET /api/dag/published/<child rid>/embedders` 回 parent 清單，含 `embedded_at_node_id` / `child_output_node_id`
- [ ] Authz negative test 確認 publish 403
- [ ] Cross-ds negative test 確認 publish 拒收
- [ ] BI_USER (`tsai_bi`) 對 parent 有 read 即可 exec 全程
- [ ] 已 publish 的舊頁（V086 / FU smoke）仍正常 render
- [ ] TS check 雙端 pass
- [ ] 前端視覺驗證：標 unverified（per UI verification autonomy memory）
