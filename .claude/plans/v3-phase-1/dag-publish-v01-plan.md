# DAG-PUBLISH-V01 — Composer → Tier B 端使用者表單

**Status**: in-progress (2026-04-30)
**Owner**: Adam + Claude
**Plan-of**: §3.4 C primitive — admin → end-user pipeline 最後一段
**Demo target**: `ds:pg_k8` (Greenplum 6.23) tiptop ERP — 真實業務資料，無 mock
**Sister primitives**: SAVED-VIEW-V01 (V080), BIZ-TERM-V01 (V044), SINK-AS-AUTHZ-RESOURCE (V081), FEEDBACK-V01 (V082)

---

## 1. Goal

讓 admin 在 Flow Composer 把多支 PG functions 串成 DAG 後，按一鍵把它**發布**成 Tier B 頁面：BI_USER 在頁面上看到 admin 標記為「user_input」的那些 `bound_params` 變成表單欄位、按 Submit → 後端**用 BI_USER 自己的 authz 身分** live 跑這條 DAG（mask/RLS 重新套用、不是 snapshot）。

## 2. Existing pieces we reuse

| 元件 | 角色 |
|---|---|
| `DiscoverTab` | admin 看 schema |
| `DataQueryTab` AuthorPanel + AI assist | 寫/部署 PG function（已可用 §9.3/§9.6） |
| `DagTab` + `/api/dag/save`+`/validate`+`/execute-node` | 組 DAG（client-side walk） |
| `authz_ui_page` (snapshot 路徑) | 既有 sink="page" 寫 snapshot |
| `ConfigEngine` | 跑 page、套 mask、saved-view 整合 |
| `authz_resolve()` + `authz_check()` | 終端使用者的 per-row mask |

## 3. New pieces (this primitive)

| 件 | 類別 | 約略 LOC |
|---|---|---|
| `database/migrations/V086__dag_publish.sql` | DB | 30 |
| `services/authz-api/src/lib/dag-exec.ts` | 新 server-side DAG orchestrator | 250 |
| `services/authz-api/src/routes/dag.ts` `+/publish` | route | 130 |
| `services/authz-api/src/routes/config-exec.ts` `published_dag` branch | route | 80 |
| `apps/authz-dashboard/src/components/DagTab.tsx` user_input toggle + Publish 按鈕 | UI | 130 |
| `apps/authz-dashboard/src/components/ConfigEngine.tsx` form renderer | UI | 160 |
| **總計** | | **~780 LOC** |

> 比我原本估的 400-500 多。advisor 點出 server-side DAG executor 不存在（目前 client-side walk），這條一定要寫，是這個 primitive 最大的單一塊。

## 4. Two real forks (default 已選，Adam 可隨時改向)

### Fork A — BI_USER 怎麼通過 authz 跑 published DAG？

| 選項 | 描述 | 取捨 |
|---|---|---|
| (a) Publish 時 auto-grant BI_USER execute on each fn | 簡單但**擴大 BI_USER 的攻擊面**，BI_USER 直接從 DataQueryTab 也能跑那支 fn | ❌ |
| **(b) Published DAG 本身是 gated resource — BI_USER 需要 `read` on `published_dag:<rid>`，server 在 published-run context 內 bypass per-fn execute** | "publish = bless" 語意，與 V044 blessed 模式一致；BI_USER 拿不到散裝 fn 權限 | ✅ **default** |
| (c) Manual grant per-fn execute 給 BI_USER | 最嚴 但 ops 麻煩 | ❌ |

**Default = (b)**：published 等於對 BI_USER 群體開放這個查詢場景；散裝 fn 權限不變。Server 端在 `executeDagAsPublished()` 入口檢查 `read on published_dag:<rid>` 一次後，內部 fn 執行不再 per-fn `authz_check(execute,...)`，但 column-level mask 仍依 BI_USER 身分套用（mask 是 read-side 概念，與 execute 不衝突）。

### Fork B — Server-side executor 怎麼選 output node？

DAG 可能多 leaf。published page 對外只一張表。

**Default**：publish 時要求 DAG 必須單一 leaf（用拓樸排序找 outdegree=0 的 fn/operator 節點，>1 拒絕並要 admin 在 Composer 收斂）。日後可加 `is_output: true` 顯式標記，目前 keep simple。

## 5. Smaller decisions (AI default — 不阻塞)

- **`bound_params` 怎麼標 user_input**：在 node attributes 旁加 `user_input_params: string[]`（parallel array，不入侵 `bound_params` 形狀，dag-validate / DagTab inspector 改最少）。
- **`authz_ui_page` 不加 `kind` 欄位**：用 `published_dag_id IS NOT NULL` 當 discriminator（已選）。`fn_ui_page` 補 select 新欄位即可。
- **Form schema 來源**：publish 時從 DAG 的 fn `parsed_args` + `user_input_params` 推 `{name, type, required, default, help_text}` 寫入 `form_schema`。日後可加 admin 編輯 override。
- **Greenplum `text[]` 參數**：node-postgres 透過 named-notation `:=` 已驗證可送 `text[]`（current `/execute-node` 路徑跑得通）；smoke-test 用 `search_cimzr067_by_keys(p_keywords text[])` fail-fast。

## 6. Schema (V086)

```sql
ALTER TABLE authz_ui_page
  ADD COLUMN published_dag_id text REFERENCES authz_resource(resource_id),
  ADD COLUMN dag_snapshot     jsonb,           -- frozen DAG-JSON at publish time
  ADD COLUMN form_schema      jsonb;           -- [{name, type, required, default, help_text}]

-- 一張頁要嘛是 snapshot 要嘛是 published_dag，互斥（既有 snapshot_data 不動）
ALTER TABLE authz_ui_page
  ADD CONSTRAINT authz_ui_page_publish_mode_check
  CHECK (
    NOT (snapshot_data IS NOT NULL AND published_dag_id IS NOT NULL)
  );

-- published_dag_id 設了，dag_snapshot 與 form_schema 就一定要有
ALTER TABLE authz_ui_page
  ADD CONSTRAINT authz_ui_page_published_dag_complete_check
  CHECK (
    published_dag_id IS NULL OR (dag_snapshot IS NOT NULL AND form_schema IS NOT NULL)
  );

-- fn_ui_page() 補 select 三個新欄位（CREATE OR REPLACE）
```

> 註冊 published page 對應的 `authz_resource(resource_type='ui_page')` 已由 V081 處理，這裡 publish 時順便寫一筆 `published_dag:<rid>` resource 並 grant BI_USER read。

## 7. Server-side executor (lib/dag-exec.ts)

```
executeDagAsPublished({
  dagSnapshot,         // frozen JSON: {nodes, edges, data_source_id}
  userId,              // caller — 用於 mask resolution
  groups,              // caller groups
  formInputs,          // {p_material_no: 'M001', ...}
  publishedDagRid,     // 'published_dag:tiptop_material_search'
}): { columns, rows, lineage }
```

- 拓樸排序 → 對每個 fn / operator 節點呼叫既有的 `runOperator()` / fn 執行邏輯（從 `/execute-node` 抽出來），把 upstream frame 餵下去
- fn 節點：published context 內 **跳過** `authz_check(execute, fn:rid)`，因為 publish 時已經 bless
- column-level mask：在 leaf 節點輸出後套 `buildMaskedSelect()` 等價邏輯（或直接 leverage `authz_resolve()` 對輸出 columns 套 mask function）
- form input 注入：`bound_params[k]` 的 key 若在 `user_input_params` → 用 `formInputs[k]` 覆蓋
- 失敗回滾：任一節點丟 → 整個 published-run 回 4xx，audit `dag_published_exec` decision='deny' + 失敗 node_id

## 8. UI changes

### DagTab.tsx
- 節點 inspector：每個 `bound_params` 欄位旁邊加 ☑️ 「Expose as form input」checkbox → 寫 `user_input_params`
- 底部 toolbar：既有「Save as page」按鈕旁加「Publish」按鈕（DATA_STEWARD only）
- Publish modal：page_id（auto-slug from dag display_name）、title、parent_page_id、確認 user_input 清單

### ConfigEngine.tsx
- 偵測 `config.published_dag_id` → 渲染 `<PublishedDagForm form_schema={...} onSubmit={...} />`
- Submit → `POST /api/config-exec` `{page_id, params: formValues}`
- 回應的 columns/rows 走既有 grid 渲染（reuse Tier 2 table layout）
- Saved view bar 仍可用（save 表單值 + grid 設定）

## 9. Demo flow on `ds:pg_k8` (smoke test)

1. **Author**：DataQueryTab AI 產 `tiptop.fn_material_full_view(p_mat_no text)` → join cimzr067 + cxmzr115 + ima_file → Deploy
2. **Compose**：DagTab 拖 `search_cimzr067_by_keys` (root) → `fn_material_full_view` → `fn_cxmzr115_shipment_history_by_material_no` (leaf)
3. **Mark inputs**：`p_keywords` (text[])、`p_mat_no` (text) 標 user_input
4. **Publish**：page_id=`tiptop_material_search`、title="物料 360 查詢"、parent=`modules_home`
5. **Verify as BI_USER (`tsai_bi`)**：sidebar 在 modules_home 看到 card → 點進去看到表單「關鍵字」「物料號」→ 填值 Submit → live grid，column 套 BI_USER 的 mask
6. **Verify gate**：`tsai_bi` 直接打 `/api/dag/execute-node` 應 403（散裝 fn 權限沒變）

## 10. 與既有 primitive 的關係

- **SINK-AS-AUTHZ-RESOURCE-V081**：snapshot sink 仍存在（`save-as-page`），改 UI label "Export Snapshot"。published 是 live, snapshot 是 offline export。
- **SAVED-VIEW-V01**：BI_USER 在 published page 上的表單值 + grid 設定可存 `authz_user_view`。reuse 不另建表。
- **FEEDBACK-V01**：published page 也可用 FeedbackButton（已有 page-scoped feedback inbox）。
- **V044 BIZ-TERM blessed**：published_dag 走相似的 `bless = 對外公開` 心智模型。

## 11. Out-of-scope (deferred)

- 多 leaf 同頁（先強制單 leaf）
- Form schema admin 自訂 override（先全自動推）
- Published DAG version history（同 page_id publish 即覆蓋；要 history 就改 page_id 加 v2）
- Scheduled job sink、API sink（既有 sink-runtime 已留 hook，這次不開）
- Form 欄位的 enum/dropdown（先 free text，依 pg 型別給 hint）

## 12. Acceptance

- [ ] V086 migration 套用，`fn_ui_page()` 回傳新三欄
- [ ] `POST /api/dag/:rid/publish` 把 DAG-JSON 凍進 `dag_snapshot`、推導 `form_schema`、註冊 `published_dag:<rid>` resource、grant BI_USER read
- [ ] `POST /api/config-exec` 偵測 published_dag_id 走 live exec branch、bypass per-fn execute、保留 column mask
- [ ] DagTab 多 user_input toggle + Publish 按鈕（DATA_STEWARD only）
- [ ] ConfigEngine 偵測 published_dag 渲染表單
- [ ] Smoke test：tsai_bi 在 pg_k8 上跑出 tiptop 物料查詢
- [ ] Gate test：tsai_bi 不能直接 hit `/api/dag/execute-node` 上散裝 fn
- [ ] commit + push

## 13. Risks / Watch-outs

- **Greenplum 9.4 named-notation**：`fn_xxx(p_x := $1)` 已知支援（現有 `/execute-node` 跑得通），但 published exec 的 chain call 要做相同綁定；smoke test 必跑
- **Mask 套用點**：published exec 的 leaf 輸出要套 mask；buildMaskedSelect 目前針對 `data_table` 走，fn 輸出要走另一條（`authz_resolve()` 找 column-level rule）。先 column allow-list（leaf fn 宣告的 outputs.semantic_type vs BI_USER 可見集合），mask function 套用為 phase 2。
- **DAG 重新 publish**：覆蓋舊 page → 提示確認；snapshot vs published 互斥 constraint 檢查
