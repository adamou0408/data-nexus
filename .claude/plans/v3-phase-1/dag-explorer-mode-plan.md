# DAG Explorer Mode — Pages 從結果頁進化為導航式探索

**Status**: planning (2026-05-04)
**Owner**: Adam + Claude
**Plan-of**: V086 published_dag primitive 的下一層 — 把 published page 從「DAG 跑完一張表」進化為「依 DAG 圖譜走訪資料」的互動探索介面。
**Depends-on**: DAG-PUBLISH-V01 (V086) shipped; DAG-PUBLISH-V01-FU (bidir exposure) shipping; **catalog-workspace-unified-design Phase 2 deletion of `_stubs.tsx`**(觸發條件,見 §12)。
**Demo target**: 同 V086 — `ds:pg_k8` tiptop ERP,真實業務資料。

---

## 0. Goal & Non-goals

### Goal
讓 Tier B(BI_USER)在一個 published page 上**依 DAG 走訪資料**:從 root entry 表開始,點 output column 中的某個 cell → 該 cell 值 seed 進對應下游 fn 的 input → 載入下游節點的結果並 push 進導航 stack;有 breadcrumb / 返回。

### Non-goals
- 不重新做 DAG executor。重用 V086 + FU 的 `executeDagAsPublished` + `meta.outputs`。
- 不引入新的 authz 概念。`read on published_dag:<rid>` 仍是唯一閘門。
- 不引入 schema migration。`dag_snapshot` 是 jsonb,新增欄位零成本。
- 不放寬 tabular mode 的 single-leaf 限制。**僅** explorer mode 內放寬。
- 不做 trace 分享(deep-link 到一條探索路徑)。Out of scope,見 §9。
- 不做 server-side downstream-only re-exec(MVP 整圖重跑)。見 §5、§9。

---

## 1. Why now / why not earlier

V086 shipped 後 Pages 是「single-table results」。FU(bidir exposure)讓中間 fn 可被 expose,`meta.outputs` map 是多表回傳的基礎建設。**explorer 是這層基礎建設的自然消費者**:已經會回 N 個 node 的 rows,只差「在 N 之間切換」這層 UX。

不能更早的原因:catalog-workspace-unified-design 正在重構 `PublishedDagPage` 進 `catalog/DetailView.tsx`。如果在 refactor 前實作 explorer,等於把功能塞進注定被刪的 `ConfigEngine.tsx`,然後再次搬家。**等 catalog refactor 的 Phase 2 落地**(刪 `_stubs.tsx`、刪 `ConfigEngine.tsx` 內 `PublishedDagPage`),explorer 就在新的位置上長出來。

**為什麼**:tech debt — 避免一次寫兩次;ops cost — 零(可以平行設計、序列實作);UX — 不變(end user 不感知重構)。

---

## 2. Design principle (first-principles)

> **DAG 是地形圖,不是漏斗。Page 是這張地形圖上的導航 app。**

V086 的心智模型是「DAG = pipeline,輸出一個結果」。explorer 的心智模型是「DAG = 可走訪空間,使用者按 admin 制定的路徑探索」。

具體推論:
- Composer 是 admin 用來**制定可走訪範圍**的工具(可走的邊、可達的節點、可看的 output)。
- Page 是 end user **依該範圍尋找想看資料**的應用。
- 「primary output」這個概念在 explorer mode 不再具邏輯意義 — 沒有「the answer」,只有「current frame」。
- multi-leaf 不再是錯誤 — 多個葉子等於多條路徑可走,使用者一次走一條。

**為什麼**:tech debt — 把「multi-leaf 拒絕」這條 V086 為了快速出貨而留的硬規,合理化為「mode-conditional」;ops — 零;UX — admin 不再被迫把 DAG 收斂成單葉、end user 看到的不再是「跑完這條結束」而是「可以繼續看」。

---

## 3. UX flow

### 3.1 入口
Page 載入,渲染 `form_schema` 表單。使用者填值 → Submit。同今日。

### 3.2 第一個 frame
DAG 跑完(整圖),回傳 `meta.outputs` map(已 expose 的所有 node 的 rows)。explorer mode 額外從 `meta.display_mode === 'explorer'` 判定要走 explorer renderer。

第一個渲染的節點 = **root entry node**:
- 規則:topological 排序中**第一個** `expose_output=true` 且**沒有 inbound edge from another exposed node** 的節點(亦即在 exposed 子圖中是 source)。
- 退化情形:若整圖只有一個 leaf 被 expose,也適用此規則(它就是 entry)。
- 平手:若有多個候選,取 topo order 最早的一個。

**為什麼**:tech debt — 規則純粹由 `dag_snapshot` 結構推導,前後端任一邊都能算;ops — 零;UX — 進入頁面看到的就是「最上游」的查詢表,符合「從上游走下游」的直覺。

### 3.3 Drilldown
渲染 root frame 的 rows 表。每個 column 的 header / cell 是否可 click 由規則決定:

> **column `c` 在 node `n` 可 click ⇔ 存在 edge `e` 滿足 `e.source = n AND e.sourceHandle = c AND e.target` 是 exposed 節點。**

點 cell:
- 找出所有符合上述條件的 edges。
- **單一 outbound** → 直接 push 下個 frame,seed 該 edge 的 `targetHandle` 為 cell 值。
- **多個 outbound**(同一 column 餵到多個下游)→ 顯示小 popover 列出候選下游,使用者選一個。

push 進 frame 時的 stack 元素:
```
{
  nodeId: <下游 node>,
  seededParams: { [targetHandle]: cellValue, ...inheritedFromForm },
  fromBreadcrumb: { sourceNodeId, sourceColumn, cellValueDisplay }
}
```

**為什麼**:tech debt — drill 規則 100% 由 `edges` 的現有結構推導,不需新欄位;ops — 零;UX — admin 在 Composer 連邊就決定 end user 可不可走,規則對齊符合 §2 的設計原則。

### 3.4 Re-exec on drill
MVP:**整圖重跑** with seeded params merged into `formInputs`。下游節點會吃到 `seededParams`(因為 `buildFnBinding` 第 1 步「explicit bind / form input」優先);上游節點也會跑(浪費,但簡單)。

從 `meta.outputs` 拿出當前 frame 的 `nodeId` 對應的 block,渲染那張表。

**為什麼**:tech debt — 重用 `executeDagAsPublished` 的全部行為,零分支;ops — 同 today,沒有新 endpoint;UX — drill 一次的延遲 = full DAG exec time,在 tiptop demo 規模(~3 fn)無感。downstream-only re-exec 是 P2,見 §9。

### 3.5 Breadcrumb
顯示已走過的 frame 鏈:
```
[search results] → [shipment_history: M001] → [aging: SO-123]
```

每段可 click → pop 至該層。後退按鈕 = pop 一層。

整個 explorer breadcrumb 是 page-detail frame **內**的 widget,不是 catalog `<Breadcrumbs>` 的延伸 — outer catalog breadcrumb 仍只顯示 `Catalog › Pages › <page title>`,不會被 explorer 內部走訪污染。

**為什麼**:tech debt — explorer stack 內聚於 PageDetailFrame 的 viewState,不洩漏到 catalog 層;ops — 零;UX — 兩層導航各司其職:catalog 走訪是「page 之間」,explorer 走訪是「page 內 DAG 之間」,語意清楚。

### 3.6 Multi-leaf DAG
explorer mode 下,DAG 可有多 leaf。每個 leaf 是某條探索路徑的可能終點。end user 一次只在一條路徑上,因此「the output」這個 V086 假設不存在 — 永遠只有 current frame。

---

## 4. Where it lives (catalog refactor integration)

### 4.1 Frame 策略:**discriminator on `PageDetailFrame`,不新增 `page-explorer` kind**

具體做法:
- explorer 是 published_dag page 的「子顯示模式」,不是另一種 frame kind。
- `dag_snapshot` 多 `display_mode: 'tabular' | 'explorer'`(預設 `tabular`)。
- server `config-exec.ts` 把它放進 `meta.display_mode`。
- `DetailView.tsx` 的 PageDetailBody 在「published_dag 分支」內再 branch:`meta.display_mode === 'explorer'` → 走 explorer renderer;否則維持今日 PublishedDagBody。
- 探索 stack 存在 `DetailViewState` 內(現有 `formValues` 旁加 optional `explorerStack`)。stack-back 自然恢復探索進度。

**為什麼(三軸)**:
- tech debt: 加新 kind 要動 5 處(`types.ts` union、`FRAME_TO_VIEWMODE`、`urlSync.ts` parser、`CatalogWorkspace` switch、`makeDefaultViewState`)且還要重做 page-metadata fetch / breadcrumb / FeedbackButton / saved-view。discriminator 動 1-2 處。**B 勝**。
- ops cost: tie(都是純前端決定)。
- UX: explorer 是「page 內的子導航」不是「workspace 之間的導航」,outer catalog breadcrumb 應保持乾淨。**B 勝**。

### 4.2 檔案位置
新增:
- `apps/authz-dashboard/src/components/catalog/PublishedDagExplorer.tsx`(新檔)
  - 註:目前 `catalog/` 沒有 `views/` 子目錄,所有 view 平鋪在 `catalog/` 下(`DetailView.tsx`、`SchemaView.tsx`、`HandlerHost.tsx`、`GridView.tsx`、`TreeView.tsx`)。**選擇**:延續平鋪慣例,放 `catalog/PublishedDagExplorer.tsx`,不新增 `views/` 子目錄。
  - 為什麼:tech debt — 不為單一檔開新目錄;ops — 零;UX — 無關。

修改:
- `apps/authz-dashboard/src/components/catalog/types.ts`
  - `DetailViewState` 加 optional `explorerStack?: ExplorerFrame[]`。
- `apps/authz-dashboard/src/components/catalog/DetailView.tsx`
  - `PageMeta` type 加 `display_mode?: 'tabular' | 'explorer'`。
  - PageDetailBody 在 published_dag 分支內判斷 `display_mode`,explorer 走新 renderer。
- `apps/authz-dashboard/src/api.ts`
  - `configExecPage` 的 meta type 加 `display_mode?`。
- `apps/authz-dashboard/src/components/DagTab.tsx`(見 §5.4)— 加 publish modal 上的 display_mode toggle。

刪除:無。

---

## 5. Backend changes (minimal)

目標:server 改最少。explorer 的核心執行行為**完全重用** V086 + FU。

### 5.1 `dag_snapshot.display_mode`(新欄位,jsonb,無 migration)
publish handler 接收 `display_mode: 'tabular' | 'explorer'`(預設 `'tabular'`),寫進 `dag_snapshot`。

### 5.2 Single-leaf 放寬(call-site 條件)
**不改 `findSingleLeaf` signature**。在 `services/authz-api/src/routes/dag.ts` publish handler step 2 改寫條件邏輯:

```
// 偽碼,僅描述分支
if (display_mode === 'explorer') {
  // explorer 需要 leaf 來當「primary placeholder」(audit + back-compat 用)
  // 取 topo 中第一個 outdegree=0 的非 sink 節點;若仍無 leaf 才報錯
  outputNodeId = pickFirstLeafOrThrow(nodes, edges);
} else {
  outputNodeId = findSingleLeaf(nodes, edges);  // 舊行為:多葉拒絕
}
```

`pickFirstLeafOrThrow` 是新的小 helper(可內聯),邏輯:
- 取 outdegree=0 的非 sink 節點。
- ≥1 個就回第一個(deterministic by topo order)。
- 0 個才 throw。

**為什麼安全**:explorer mode 沒有「the primary output」語意 — `output_node_id` 在 explorer 只是 audit log + V086 back-compat field 的 placeholder,實際渲染由前端 stack 決定。

**為什麼三軸**:
- tech debt: `findSingleLeaf` 不動,call-site 一個 if;**最小**。
- ops: 零。
- UX: admin 不必為了 publish 強行收斂 DAG;explorer mode 多葉合法。

### 5.3 `exposed_node_ids` 在 explorer mode 的預設

explorer 的探索範圍 = 已 expose 的子圖。為了讓使用者真的能走完整圖,publish 時 explorer mode 預設把**全部非 sink 節點**塞進 `exposed_node_ids`(除非 admin 在 Composer 明確 unexpose 某節點)。

實作位置:`routes/dag.ts` publish handler step 4,build `exposedNodeIds` 的迴圈外加分支:

```
// 偽碼
if (display_mode === 'explorer') {
  // 全部非 sink 節點預設 exposed,除非 admin 顯式設 expose_output=false
  exposedNodeIds = nodes
    .filter(n => n.type !== 'sink')
    .filter(n => n.data?.expose_output !== false)
    .map(n => n.id);
} else {
  // 既有邏輯:leaf + admin-flagged intermediates
}
```

**為什麼**:tech debt — 沿用 `expose_output` 既有欄位的反向語意;ops — 零;UX — admin 切到 explorer mode 不必逐個勾選 expose,改為「逐個 unexpose 不想給看的」(opt-out vs opt-in,合 explorer 的「全圖可走」精神)。

### 5.4 `routes/config-exec.ts` 把 display_mode 接出來
published_dag exec 分支多 1 行:`meta.display_mode = dagSnapshot.display_mode || 'tabular'`。

### 5.5 DagTab Publish modal 加 mode toggle
`apps/authz-dashboard/src/components/DagTab.tsx` PublishDagDialog:加 radio button 或 select:
- `Tabular page (single result table)` — default
- `Explorer page (navigate the DAG)` — new

值塞進 publish payload。

### 5.6 不需要的 server 變更
- ❌ 不改 `executeDagAsPublished` 的 signature 或 body。
- ❌ 不加 downstream-only re-exec endpoint(MVP 重跑全圖,見 §9 P2)。
- ❌ 不加 schema migration。
- ❌ 不改 authz。

---

## 6. Frontend (renderer logic)

### 6.1 ExplorerFrame state shape

```ts
// catalog/PublishedDagExplorer.tsx
type ExplorerFrame = {
  nodeId: string;                              // 當前渲染哪個 exposed node 的 rows
  seededParams: Record<string, unknown>;       // 來自上游 cell click 的 seed
  origin?: {                                   // breadcrumb display + back 用
    sourceNodeId: string;
    sourceColumn: string;
    cellValueDisplay: string;                  // truncated for breadcrumb chip
  };
};
```

stack 存在 `DetailViewState.explorerStack`(`types.ts` 修改)。

### 6.2 解 drill 規則

```ts
function findOutboundEdges(
  edges: DagEdge[],
  exposedSet: Set<string>,
  fromNode: string,
  column: string,
): DagEdge[] {
  return edges.filter(e =>
    e.source === fromNode &&
    e.sourceHandle === column &&
    exposedSet.has(e.target)
  );
}
```

點 cell `(node, col, value)`:
1. `outboundEdges = findOutboundEdges(...)`
2. `outboundEdges.length === 0` → cell 不可 click(在 render 前就應該標 disabled,實作時 column header 預先計算 `clickableColumns: Set<string>`)。
3. `=== 1` → 直接 push:
   ```ts
   const edge = outboundEdges[0];
   stackApi.setViewState(prev => addExplorerFrame(prev, {
     nodeId: edge.target,
     seededParams: { ...inheritedFormValues, [edge.targetHandle!]: value },
     origin: { sourceNodeId: node, sourceColumn: col, cellValueDisplay: truncate(value) },
   }));
   triggerReExec({ ...inheritedFormValues, [edge.targetHandle!]: value });
   ```
4. `> 1` → 顯示 popover:`{edge.target} via {edge.targetHandle}` 的選項列表;使用者選一個後同 step 3。

### 6.3 inheritedFormValues
push frame 時帶下去的不只是新 cell 值,還包含**目前表單**的所有 form values(否則上游節點重跑會缺 input)。

```
inheritedFormValues = { ...currentFrame.seededParams, ...formValuesFromForm }
```

### 6.4 Breadcrumb pop
explorer stack 從 index 0 顯示:
```
[root: search] → [shipment_history: M001] → [aging: SO-123]
```

每段 click → 把 stack 截到該 index,觸發 re-exec(因為 seededParams 不同)。
`pop()` = 截到 length-1。

### 6.5 Re-exec 觸發
任何 stack 變更(push / pop / goTo)都呼叫:
```
api.configExecPage(pageId, mergedFormValuesAtTopFrame)
```
回傳的 `meta.outputs[currentFrame.nodeId]` 是要渲染的 block。

### 6.6 渲染選哪個 output
`meta.outputs` 是 map,key = nodeId。explorer 拿 `outputs[currentFrame.nodeId]`(若 missing → 顯示 friendly empty state「該節點未在當前 exec 產出 frame — 可能是上游條件導致」,不要 throw)。

**為什麼三軸**(整體前端):
- tech debt: 100% reuse 現有 exec response,渲染邏輯內聚 1 檔。
- ops: 零。
- UX: 完整繼承 form-based 行為(refresh、saved view 不適用 — explorer 不存 saved view,見 §10 風險)。

---

## 7. Authz model

不變。

- `read on published_dag:<rid>` 仍是唯一閘門。
- 探索範圍 = `exposed_node_ids` 的子圖。admin 在 publish 時已 bless 整條 pipeline,explorer 把這個 bless 落實成「凡 exposed 都可看、凡 edge 連著就可走」。
- 不引入「per-node read」概念。

**為什麼**:tech debt — 零新 authz code;ops — 零新 audit shape(復用 `dag_published_exec`);UX — admin 心智模型不變(publish = 開放整個查詢場景)。

---

## 8. Smoke test outline

新建 `database/seed/_test_publish_smoke_explorer.sql`:

DAG 結構(沿用 `ds:pg_k8` tiptop):
```
n_search (search_cimzr067_by_keys, user_input: p_keywords)
   ↓ source: material_no  →  target: p_mat_no
n_history (fn_cxmzr115_shipment_history_by_material_no)
   ↓ source: order_no  →  target: p_order_no
n_aging (假想下游 fn_aging_by_order)
```

publish payload:
- `display_mode: 'explorer'`
- `parent_module_id`: 任一 active module(滿足 PUB-PAGES-ADMIN-V01)
- `expose_output` 不顯式設(explorer mode 預設全 exposed)

驗證步驟:
1. publish 成功(若還沒切 mode 之前 multi-leaf 會拒,**這正是要驗證** explorer mode 不拒)。
2. `dag_snapshot.display_mode === 'explorer'`、`exposed_node_ids` 含三個 node。
3. exec 一次:`meta.outputs` 三 key、`meta.display_mode === 'explorer'`。
4. 前端:
   - 進 page 看到 form「關鍵字」,填 `['物料']` Submit。
   - root frame = `n_search`,渲染 search 結果表。
   - 點某 row 的 `material_no` cell → frame 推進到 `n_history`,渲染 shipment 表。
   - 點某 row 的 `order_no` cell → frame 推進到 `n_aging`。
   - breadcrumb 顯示三段,中段 click pop 回 `n_history`。
   - 後退鍵 = breadcrumb pop one。
5. 同一 page 用 `tsai_bi` 跑通(authz 不變)。
6. 同一個 DAG 改用 `display_mode='tabular'` 重 publish(覆蓋 same `page_id` + `overwrite=true`)→ 應因 multi-leaf 被拒(tabular 不放寬)。

---

## 9. Out of scope (deferred)

- **Per-node column-mask 差異**(FU 的 FU)。
- **AI suggesting next drilldown**(基於使用者過往 trace 推薦下一步點哪個 cell)。
- **Server-side downstream-only exec**(P2):當 root → leaf 路徑很深、整圖重跑成本顯著時,server 接受 `from_node + seededParams`,只跑 from_node 起的子圖。MVP 不做;`ds:pg_k8` 的 ~3 fn 規模整圖重跑無感。
- **Explorer 內 saved view**:explorer 的 stack 本身就是「state」,saved view 在這語境下要重新定義(saved trace? saved entry params?)。MVP 直接停用 explorer mode 下的 SavedViewBar。

> **Trace deep-link 已從 deferred 移入 scope**(2026-05-04 鎖定),見 §13。

---

## 10. Risks & mitigations

### 10.1 Stale form values
使用者 drill 多層後改 root form 重 Submit → 原 stack 中的 seededParams 是舊資料的引用,可能與新結果不一致。
**Mitigation**:Submit 表單時 `explorerStack` reset 成只剩 root frame;UI 上提示「重新查詢將清空目前的探索路徑」(toast)。

### 10.2 Cycles
`dag_snapshot.edges` 已通過 `topoSort` 保證無環(`executeDagAsPublished` 有 cycle detection)。explorer drill 永遠沿 edge 方向,不會回到自己。

### 10.3 Audit log 沒有真正的 primary
`dag_published_exec` 寫 `primary_output_node_id`。explorer mode 下這只是「topo 第一個 leaf」,不是邏輯主輸出。
**Mitigation**:audit row 加 `display_mode` 欄位(放 details jsonb 內,無 schema migration)。MVP 接受此語意鬆動,標進文件。

### 10.4 「Cell 看起來可 click 但實際 click 後下游沒 row」
seeded param 在下游可能查不到對應資料。
**Mitigation**:下游 frame 顯示 friendly empty state「該值在下一層無對應資料」+ 一個「返回上層」按鈕。

### 10.5 Explorer 與 saved view 衝突
SavedViewBar 對 explorer mode 無意義。
**Mitigation**:explorer renderer 不渲染 SavedViewBar;tabular renderer 維持。

### 10.6 Drill 深度爆炸 / 使用者迷路
end user 連點 10 層後不知自己在哪。
**Mitigation**:breadcrumb 永遠可見;LRU 不適用(stack 全在記憶體中、cheap);提示框「目前在第 N 層」(P2 polish)。

---

## 11. Acceptance criteria

- [ ] `database/seed/_test_publish_smoke_explorer.sql` publish 成功,`dag_snapshot.display_mode === 'explorer'`、`exposed_node_ids` 含全部非 sink 節點。
- [ ] 同個 multi-leaf DAG 在 `display_mode='tabular'` publish 仍被拒(原邏輯保留)。
- [ ] exec response 帶 `meta.display_mode`、`meta.outputs` 含全部 exposed node 的 rows。
- [ ] 前端在 explorer mode 渲染 root frame;cell click 觸發 frame push + re-exec + 渲染下游。
- [ ] breadcrumb 反映 stack;click 中段 pop 至該 index;後退鍵 pop 一層。
- [ ] 多 outbound edge 從同 column 出去 → popover 選下游。
- [ ] tabular mode 完全不變(V086 + FU 既有 page 渲染、行為皆同)。
- [ ] BI_USER (`tsai_bi`) 可在 smoke page 跑完整探索;`nobody_user` 仍 403。
- [ ] TS check 雙端 pass;outer catalog breadcrumb 不被 explorer 內部走訪污染。
- [ ] DagTab Publish dialog 多 mode toggle,DATA_STEWARD 可選。

---

## 12. Coordination with catalog refactor

**硬阻擋條件**:本 plan 的實作**不可在以下條件成立前啟動**:

- `apps/authz-dashboard/src/components/catalog/_stubs.tsx` 已被刪除
- `apps/authz-dashboard/src/App.tsx` 已 mount `<CatalogWorkspace>`(catalog Phase 2 wiring 完成)
- `apps/authz-dashboard/src/components/ConfigEngine.tsx` 內的 `PublishedDagPage` 已被移除(避免兩處同時存在 published_dag renderer)

驗證指令(計畫實作 agent 先跑):
```
git ls-files | grep "catalog/_stubs.tsx"          # 應為空
grep -l "PublishedDagPage" apps/authz-dashboard/src/components/ConfigEngine.tsx
                                                   # 應為空
grep -l "CatalogWorkspace" apps/authz-dashboard/src/App.tsx
                                                   # 應有
```

三條都 pass 才開動。否則先協助 Adam 完成 catalog Phase 2,再回來。

**為什麼**:tech debt — 防止「explorer 寫進 ConfigEngine 然後再搬到 catalog」的二次成本;ops — 零;UX — 一次到位。

---

## 13. Trace deep-link (in scope, 2026-05-04 lock-in)

### 13.1 Goal
end user 可把目前的探索狀態(filled form + drill stack)複製成 URL 分享給同事,對方開啟 URL 看到**同一個 frame**(假設 source data 未變)。demo 流程包含「分享一條典型探索路徑」。

### 13.2 URL hash format

```
#explorer=<base64url(JSON.stringify(payload))>

payload = {
  v: 1,                              // schema version, bump when shape changes
  form: Record<string, unknown>,     // root form values
  stack: [
    { node: nodeId, seed: Record<targetHandle, value>, origin?: { from, col, val } },
    ...
  ]
}
```

- 單 page URL 因此能 self-describe 整條 stack(不需 server-side trace store)。
- `v` 在 schema 變更時 bump → 舊 URL 進入 fallback 行為(見 §13.6)。

### 13.3 Mount-time hydration
PageDetailFrame 載入流程(explorer mode):
1. 解 `#explorer=...` → payload。
2. 若解碼失敗 → 走預設(空 form / root frame),console.warn 不 throw。
3. 解碼成功 → seed `formValues = payload.form`、`explorerStack = payload.stack`。
4. 呼叫一次 `configExecPage(pageId, mergedAtTopFrame)` → 渲染 top frame。
5. 若回傳 `outputs[topFrame.node]` missing → §10.4 friendly empty + URL 標 stale。

### 13.4 Stack 變更 → URL 同步
`useEffect(() => updateHash({form, stack}), [formValues, explorerStack])`,用 `history.replaceState`(不污染 browser history;back button 應仍由 catalog `useStack` 主導,explorer 內部走訪不入 history stack — 與 §3.5 breadcrumb 哲學一致)。

debounce 200ms(避免 form input 每個 keystroke rewrite hash)。

### 13.5 Authz model
hash 不繞 authz。`read on published_dag:<rid>` 仍是必要條件。對方若無 read 權限,開啟 URL 仍 403,hash 內容不洩漏。
audit log:`dag_published_exec` 標記 `entry_via='deep_link'`(放 details jsonb,無 schema migration)。

### 13.6 Idempotency / staleness handling
- **Source data 變更**:e.g. 上游 row 已被刪 → 下游 frame 沒資料。顯示 friendly empty(§10.4)+ toast「此連結中的部分結果已不可用,可從上層重新探索」。
- **DAG 結構變更**:publish 過新版本後 nodeId 可能變(目前 V086 nodeId 是 dag_snapshot 內字串 id,不會跨 republish 自動變,但 admin 手動改 id 會破)。fallback:nodeId 對不上 → 截斷 stack 至最後可解析的 frame,顯示 toast。
- **Schema version 不符**(`payload.v !== 1`):console.warn + 走預設行為(空 form / root frame)。

### 13.7 UI:複製連結按鈕
explorer renderer 右上角加「🔗 複製此探索路徑」按鈕,複製當前 hash URL 到 clipboard,toast「連結已複製」。

### 13.8 為什麼三軸
- **tech debt**:URL = JSON in hash,**零** server-side state、零新 schema、零 endpoint。schema versioning 用 `v` field 一次到位,未來變更不破舊 URL。
- **ops cost**:零(沒新表沒新 API)。
- **UX**:解鎖 demo 的「分享探索」場景;同事不必重新填表/重新點 cell。

### 13.9 Acceptance criteria(補充進 §11)
- [ ] hash 可解碼 → 自動 hydrate form + stack。
- [ ] 解碼失敗 → 走預設,不 throw、不污染 console error。
- [ ] form / stack 變更 → URL hash 同步(debounce 200ms)。
- [ ] 「🔗 複製此探索路徑」按鈕複製當前 URL,toast 確認。
- [ ] 對方無 read 權限 → 403,hash 內容不顯示。
- [ ] DAG 重 publish 後,nodeId 改名的 stack 自動截斷 + toast 提示。

---

## Locked decisions (2026-05-04)

(原 Open questions 已收斂,留紀錄)

| 議題 | 決定 | 備註 |
|------|------|------|
| Root entry node 規則 | **derive rule**(§3.2 既有規則:topo 中第一個 expose 且無 exposed inbound) | MVP 不加 `explorer_entry_node_id` 顯式欄位;若實作後實際 case 推導不直覺再加 |
| Mode toggle UX | **radio**(§5.5) | Publish modal 既有欄位後,預設 Tabular |
| Form reset 行為 | **auto reset + toast**(§10.1) | toast「已清空探索路徑」,不彈 confirm |
| Trace deep-link 進 Phase 1 | **YES** | 見 §13;為 demo「分享探索路徑」場景而保留 |

---

*End of design document.*
