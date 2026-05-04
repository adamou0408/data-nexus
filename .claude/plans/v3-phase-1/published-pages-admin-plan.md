# Published Pages Admin (PUB-PAGES-ADMIN-V01)

- **Planner Owner:** Adam + Claude (2026-05-04 session)
- **Executor Owner:** Claude (same session — auto-mode)
- **Status:** IMPLEMENTED — pending Adam's E2E smoke pass
- **Linked from:** `docs/plan-v3-phase-1.md` (Tier B + Path A demo polish)
- **Sister primitives:** `dag-publish-v01-plan.md` (V086), `dag-subdag-embed-v01-plan.md` (V087/V088)
- **Target:** demo 級體驗（M4 之前），與 Adam 直接驗收
- **Created:** 2026-05-04
- **Last updated:** 2026-05-04

---

## 1. Problem / Why

`POST /api/dag/:id/publish` 把 DAG 凍成 Tier B page 後，**curator 沒有面板可以管理已發布的 page**：

1. **Publish dialog 的 `parent_page_id` 欄位讓 curator 困惑**。Adam 觀察到 page 出現在「Catalog → Modules → <module> → pages」（亦即 `authz_resource.parent_id` 樹），但 dialog 收的是 `authz_ui_page.parent_page_id`（legacy renderer drilldown），是兩條不同的父子線。Curator 填了也沒影響他看到的位置。
2. **發完後想改 title / 換 module / 重發 / 刪除**，目前要回 SQL。`PATCH /api/modules/pages/:page_id` 只支援 rename + move catalog parent，不能刪除、不能列清單、不能查影響範圍。
3. **Subdag 已上線 (V087)**，刪除一支被別人 embed 的 published_dag 會讓 parent publish 在下次重發時 404。沒有 UI 警示 — `/embedders` endpoint 存在但沒有任何 UI 消費它。
4. **Long-term ops 風險**：page 越多，沒有 inventory 面板就會變成「一堆 SQL 才能查到」的暗物質。對 demo 後接 Smart Analyst 2.0 是負擔。

對應 dag-publish-v01 plan §11 "Out-of-scope" 留下的兩個洞 — admin override + version history（這份 plan 不做 version history，只做 inventory + safe edit）。

---

## 2. Scope

**In scope (this plan = A+B+C+D+E):**

- [ ] **A.** Publish dialog 改用 module catalog 父節點 cascade（目前的 `parent_page_id` text input 改成 `parent_module_id` dropdown，預設帶 DAG 自己的 parent，breadcrumb 預覽）。`parent_page_id` 不暴露給 curator（內部固定塞 `modules_home` 或 NULL）。
- [ ] **B.** 新 sidebar 入口：**Catalog → Pages**（gate=`steward`，與 publish/PATCH 一致）。Table 列所有 published_dag pages：page_id、title、breadcrumb、handler kind、backing dag（可跳 Flow Composer）、last publish + author、embedders count。Filter：parent module / handler kind / 含 search。
- [ ] **C.** Modules tab 加「管理模式」toggle（steward only）：**先做 form picker**（row 內 inline edit `parent_module_id` + `display_order` numeric input，reuse `PATCH /api/modules/pages/:page_id`）。Drag-and-drop 列為 polish — 只在 A+B+D+E 完成且時間有餘時才開。
- [ ] **D.** Delete 保護 + soft-delete：
   - 新 endpoint `DELETE /api/modules/pages/:page_id` (steward gate，與既有 PATCH 同 namespace)。
   - 內部先呼叫既有 `/api/dag/published/:rid/embedders` 查 parent；非空就 409 + `blocking_parents` 列表（含 page_id + 可跳 Flow Composer 的 dag_id）。
   - 確認後 soft-delete：`authz_ui_page.is_active = FALSE` + `authz_resource.is_active = FALSE` (page mirror + bless gate)。**不**自動 revoke role_permission（保留 audit trail）。Cron purge 暫不做（plan 列為 out-of-scope；demo 級不需）。
   - admin audit row。
- [ ] **E.** Page 詳情/troubleshoot panel（Pages tab 點開 row 展開）：backing DAG link、dag_snapshot 摘要（node count, form fields, expected output schema）、embedders 清單、最近 30 天 audit log（who opened, what params）。

**Out of scope（先記清楚，避免 scope creep）：**

- Version history（同 page_id 重發即覆蓋；要 history 改 page_id 加 v2，與 V086 對齊）。
- Multi-leaf publish（單 leaf 不變）。
- Hard delete + cron purge（demo 後再開）。
- 跨 dag 的批次操作（select all → bulk republish 等）。
- Cross-page lineage graph 視覺化（embedders 列表已夠 demo）。
- Form field admin override（dag-publish-v01 plan §11 已 deferred；這份不碰）。

---

## 3. Design / Approach

### 3.1 Two-tree mental model（Adam 必讀）

V086 publish 同時寫兩個 parent：

| Tree | Column | 誰看得到 | Curator 在意嗎 |
|------|--------|----------|----------------|
| Catalog tree | `authz_resource.parent_id` (page mirror row) | ModulesTab → 模組卡片 → pages 區塊 | **是** — 這是「我發的頁去哪裡了」的物理位置 |
| Page tree | `authz_ui_page.parent_page_id` | 老 ConfigEngine drilldown / fn_ui_root | 否 — 是 renderer internal |

**決策**：A 階段 dialog 只暴露 catalog parent。`parent_page_id` 由 server 預設成 `'modules_home'`（如果 caller 沒給），curator 看不到也不用管。

證據：
- `services/authz-api/src/routes/dag.ts:854` `pageParent = dagParent || 'module:pg_tiptop_v1'` — 目前完全靠 DAG `parent_id`，curator 無法選。
- `services/authz-api/src/routes/modules.ts:192-200` `childPages` 查 `authz_resource.parent_id`（catalog tree），不查 `authz_ui_page.parent_page_id`。
- `services/authz-api/src/routes/dag.ts:838-845` 已有 `parent_page_id` 存在性檢查。

### 3.2 API surface（新增 + 改）

| Method | Path | Gate | Why |
|--------|------|------|-----|
| **新** `GET` | `/api/modules/pages` | steward | Pages tab inventory。回 published_dag rows + dag_id + last_published_at + author + embedders_count（一次拉，避免 N+1）。**只列 published_dag**（snapshot pages 走 V081 sink 自己的管理面板）。 |
| **新** `GET` | `/api/modules/pages/:page_id` | steward | row 展開：dag_snapshot 摘要 + recent audit。 |
| **改** `PATCH` | `/api/modules/pages/:page_id` | steward | 既存 endpoint（routes/modules.ts:355-455）擴 description + display_order 欄位；既有 display_name + parent_id 邏輯不動。 |
| **新** `DELETE` | `/api/modules/pages/:page_id` | steward | Soft delete + embedder block（D 部分）。掛在同 routes/modules.ts。 |
| **改** `POST` | `/api/dag/:id/publish` | steward | payload 加 `parent_module_id?: string`；`parent_page_id` 不再是 user 輸入，server 固定填 `'modules_home'`（除非 caller 顯式給）。 |
| **既存 reuse** | `/api/dag/published/:rid/embedders` | reads via authz_check | D 部分前端在 confirm 之前先打這個。 |
| **既存 reuse** | `/api/admin/audit-logs?resource=page:xxx` | admin | E 部分 page audit 來源 (LIKE filter)。 |

**Namespace 決策**：全部掛在既有 `routes/modules.ts`（PATCH 已在那），不另開 `routes/admin/pages.ts` — 避免 namespace 分裂、import 樹更淺。

### 3.3 New sidebar tab

```
Catalog
├── Resources
├── Modules
├── Pages          ← 新（NavItem id='access-pages', requires='steward')
└── Raw Tables
```

不另開 group：與 Resources/Modules 同類，都是 catalog inventory。

### 3.4 Frontend file map

| Existing | 改動 |
|----------|------|
| `apps/authz-dashboard/src/components/DagTab.tsx` `PublishDagDialog` | A 部分：parent_module dropdown |
| `apps/authz-dashboard/src/components/Layout.tsx` | sidebar `Pages` entry |
| `apps/authz-dashboard/src/App.tsx` `TabId` + render switch | 新 tab 派發 |
| `apps/authz-dashboard/src/api.ts` | 新 4 個 admin/pages 端點 + dagPublish payload 擴 |

| New |
|-----|
| `apps/authz-dashboard/src/components/PagesTab.tsx` | B + E 主表 + 展開 |
| `apps/authz-dashboard/src/components/ParentModulePicker.tsx` | A + B 共用 module dropdown（C form picker 直接用同元件，不另起檔） |

### 3.5 Reorder (Part C)

- 既有欄位 `authz_ui_page.display_order INT DEFAULT 0`（V022:26）已存在但未被任何 ORDER BY 引用 — 直接用它，不要重造。
- ModulesTab `childPages` query（modules.ts:192-200）目前 `ORDER BY r.display_name`；改成 `LEFT JOIN authz_ui_page p ON p.page_id = r.resource_id ORDER BY COALESCE(p.display_order, 0), r.display_name`。
- 證據：grep 確認 `children.pages` 在 dashboard 只被 `apps/authz-dashboard/src/components/modules/ModuleDetail.tsx` 消費（line 101 count、line 239 empty state、line 253 render）— 改 ORDER BY 影響面已封閉。
- PATCH endpoint 寫 `authz_ui_page.display_order`（單一來源），**不**寫 `authz_resource.attributes.display_order`。
- **Form picker 先做（C 主目標）**：row 內顯示 parent module dropdown + display_order numeric input + Save 按鈕。Save 直接呼叫 `PATCH /api/modules/pages/:page_id`。
- **Drag-and-drop 是 polish**：A+B+D+E 收尾後若時間還夠才開；不開也能 ship demo（form picker 已可達成「我要把這頁排到第 1 位」）。

### Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Sidebar 位置 | Catalog group | 與 Modules / Resources 同性質 — 都是 catalog inventory |
| Gate | `steward` | 與 `requireDagPublisher` (DATA_STEWARD) + `PATCH /api/modules/pages` 一致；admin SYSADMIN 走 god-mode bypass |
| Publish dialog 是否保留 `parent_page_id` 欄位 | **不保留**，只暴露 `parent_module_id` | 避免 two-tree confusion；`parent_page_id` server 自動補 `modules_home` |
| Soft vs hard delete | Soft (`is_active=FALSE`) | 保留 audit trail；published_dag 是 bless gate，硬刪會讓既存 audit row 變孤兒；demo 級不需要 cron purge |
| 是否自動 revoke `role_permission` on delete | **不自動 revoke** | role_permission 仍存（is_active=TRUE）但 resource is_active=FALSE 會讓 authz_check 拒絕；harder to audit-trace 「誰被 revoke 過 read」如果 cascade revoke。Cleanup 留 V088-style migration |
| display_order 存哪裡 | `authz_ui_page.display_order` (V022 既有 column，目前未被 query) | 不重造；JOIN cost 可忽略；單一來源避免雙寫不一致 |
| Published page audit source | `authz_admin_audit_log WHERE resource_id LIKE 'published_dag:%' OR resource_id LIKE 'page:%'` | reuse 既有 V049 audit log；不新增 audit channel |
| Embedder block mechanism | 前端 confirm 前打 `/api/dag/published/:rid/embedders`；後端 DELETE 也做一次 (defense-in-depth) | 前端先擋給好的 UX；後端擋避免 race / 直接打 API |

### Open questions

- [ ] ModulesTab 既有 childPages 排序改 ORDER BY 會不會破壞別的 callers？
   - 自答：grep 確認 `children.pages` 在 dashboard 只被 `apps/authz-dashboard/src/components/modules/ModuleDetail.tsx` 三處消費（line 101 count、239 empty、253 render）。後端 `childPages` 來自 `/api/modules/details` response.children.pages — 唯一 caller。改 ORDER BY 安全。
- [ ] PagesTab inventory 用 SSE / polling / 純 fetch？
   - 自答：純 fetch + manual refresh button。published_dag 變動頻率低（人工 publish），不值得 SSE 開銷。
- [ ] Display_order 衝突（兩人同時 reorder）→ last-write-wins 即可（demo 級）。

---

## 4. Acceptance Criteria

- [ ] **AC-A1:** Publish dialog 出現「Publish under module」cascade，預設帶 DAG 當前 parent module，可改。
- [ ] **AC-A2:** Submit publish 後 `authz_resource.parent_id` 對齊 dialog 選項（不是 DAG 原 parent）；ModulesTab 該 module 的 pages 區塊看得到新 page。
- [ ] **AC-A3:** Dialog 不再出現 freeform `parent_page_id` 欄位。
- [ ] **AC-A4:** 上次選的 module 存 localStorage `nexus.publish.last_parent_module`，下次 dialog 開預設帶它。
- [ ] **AC-B1:** Sidebar Catalog 多一條 `Pages`（steward 才看得到）。
- [ ] **AC-B2:** PagesTab 列出所有 `published_dag_id IS NOT NULL` 的 active pages，欄位齊全（page_id, title, breadcrumb, dag_id, last_published_at, author, embedders_count）。
- [ ] **AC-B3:** Filter（parent module / search）+ refresh button 可用。
- [ ] **AC-B4:** Row 點 Open 跳對應 page；點 Edit 開 metadata dialog；點 Republish 跳 Flow Composer 載入 backing DAG。
- [ ] **AC-C1:** ModulesTab 加「管理模式」toggle（steward only）。
- [ ] **AC-C2:** 管理模式下 page row inline 出現 parent module dropdown + display_order input + Save。Save 後 ModulesTab 立即重 fetch，順序更新。
- [ ] **AC-C3:** ModulesTab `childPages` 排序改用 `authz_ui_page.display_order ASC, display_name`，當 display_order 都是 0 時等同舊行為（按 display_name）。
- [ ] **AC-C4 (polish):** Drag-and-drop 同 module 內或跨 module 拖移；只在 A+B+D+E 完工且還有時間時做。
- [ ] **AC-D1:** PagesTab Delete 按下後，先打 embedders；非空就出 modal 列阻擋的 parent dags（含 dag_id 跳鏈）+ 不允許 delete。
- [ ] **AC-D2:** Embedders 為空時，二段確認後打 `DELETE /api/modules/pages/:id`，is_active=FALSE，admin audit row 寫入。
- [ ] **AC-D3:** 後端 DELETE 端點本身也做 embedders check（defense-in-depth）。
- [ ] **AC-E1:** PagesTab row 點 ▸ 展開：dag_snapshot 摘要（node count, form_schema 欄位 + type）、embedders 清單、最近 30 天 audit。
- [ ] **AC-E2:** Audit 欄至少顯示：access path, subject_id, action_id, decision, created_at；可 jump 到 Audit tab 過濾完整列表。
- [ ] **AC-INT:** Type-check pass（dashboard + authz-api 各 `npm run typecheck`）。
- [ ] **AC-INT-2:** Smoke 測試走 demo flow：dag:test_publish 重發 → PagesTab 看到 → drag 到別 module → 試 delete（沒 embedder 通過 / 有 embedder 擋住）。
- [ ] **AC-DOC:** `docs/api-reference.md` 更新 4 個新 admin/pages route。

---

## 5. Implementation Plan

### Sequence（執行順序，rollback-friendly）

1. **A** Publish dialog parent_module dropdown — 隔離 PR 1 (~2-3h)。獨立可 ship。
2. **B + D backend** 新 endpoints (LIST + GET + DELETE，PATCH 既存擴 description/display_order) — PR 2 (~3-4h)。
3. **B + D frontend** PagesTab + delete UX — PR 3 (~4-5h)。
4. **E** lineage panel — PR 4 (~3h)。Tab row 展開即 inline，不另開 modal。
5. **C form picker** Modules admin mode + inline parent/display_order edit — PR 5 (~3h)。
6. **C drag (polish)** — 只在前 5 PR 完工 + 時間餘裕才開，不算 demo 必要。

### Migration / DB notes

無新 migration — `authz_ui_page.display_order` 已存在於 V022:26，僅 ORDER BY 改用它即可。如果 demo 後決定加 V090 提升正規化（role_permission cleanup on soft delete），那是後續 plan。

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `parent_module_id` 改後既存 page mirror（dag.parent_id 來源）資料不一致 | 中 | publish endpoint 收新欄但不破壞 default — 沒給 `parent_module_id` 時 fallback 到 dagParent，與既有行為相同 |
| Drag-and-drop 在 collapse 狀態 / 觸控設備上行為怪 | 中 | 先 desktop only；mobile 不開 admin mode（檢查 viewport） |
| Soft delete 後 published_dag resource 還在 → 既有 role_permission row 仍指向它，audit 看起來像 ghost | 低 | resource is_active=FALSE 後 authz_check 拒絕，等同 revoke 效果；audit 註明 page deleted on YYYY-MM-DD |
| ModulesTab `childPages` 排序改了影響別的 dashboard | 低 | grep `children.pages` 確認唯一 consumer 是 `apps/authz-dashboard/src/components/modules/ModuleDetail.tsx`（lines 101/239/253）；測試 ModulesTab 渲染 |
| Embedder check race（A 在前端確認 OK 的同時 B 在 Composer 加 embed）| 極低 | 後端 DELETE 再 check 一次；race 結果是 409，前端轉達 |

**Rollback：** 5 個 PR 獨立切，任何 PR revert 都不破其他。Plan doc 標記為 ARCHIVED + revert PR。

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-05-04 | Adam → Claude | DRAFT → IN-PROGRESS | Auto-mode full A+B+C+D+E green-light |
| 2026-05-04 | Claude (advisor pass) | revised | namespace=`/api/modules/pages/*`; display_order 用 V022 既存 column；Part C form-picker first；ModuleDetail.tsx 唯一 consumer 已確認 |
| 2026-05-04 | Claude (auto-mode) | IMPLEMENTED | A+B+C+D+E 全部寫完。Type-check（dashboard + authz-api）皆 0。Backend smoke：GET /api/modules/pages 列出 test_publish row、display_order PATCH ↔ PG 雙向確認、childPages JOIN 帶 has_dag。Pending：Adam 手動 E2E（PagesTab UI、admin mode toggle、lineage expand、E2E delete with embedder block 已在 PR2 階段完成）。AC-DOC `docs/api-reference.md` 因檔案本身未涵蓋 `/api/dag` + `/api/modules`，列為 backlog。 |
| 2026-05-04 | Claude (advisor follow-up) | race-fix | Advisor 抓到 PagesTab 同步 dispatch `navigate-tab` + `flow-composer-load-dag` 會早於 DagTab listener 註冊（React 18 microtask render → useEffect 才註冊 listener）。3 處 dispatch 全套 `setTimeout(() => dispatch(loadEvent), 0)` macrotask defer：onRepublish、PageDeleteDialog blocker.Open、LineagePanel.openComposer。Type-check clean。 |
| 2026-05-04 | Adam smoke (sub-DAG inspector) → Claude | bug-fix | Adam 截圖 Sub-DAG inspector 顯示「Error: DAG not found」+「No published_dags on this data source yet.」。Root cause：`GET /api/dag/published-list` 被 L78 的 `/:id` route shadow，Express 把 `published-list` 當成 `id` 進入 `/:id` handler 回 404。修：把 `/published-list` 註冊提前到 `/:id` 之前，原處刪除重複定義並加註解警告。Curl 驗證修後 endpoint 回 `test_publish` + `fc_test_2` 兩筆，原 `/:id` 仍正常。 |
| 2026-05-04 | Adam smoke (test_subdag 4×400) → Claude | SUBDAG-HANDLE-V01 | Adam 截圖 flow_composer 跑 test_subdag 4 個 execute-node 400（`unknown op_kind 'subdag'` + `no inbound edge`）。Advisor 點出真正完整修法要 3-4 層，不只 /execute-node handler。選 (a) per-column source handles（與 fn 對稱）。實作四處：(1) `/api/dag/published/:rid/snapshot-meta` 多回 `exposed_outputs: Record<node_id, IO[]>`；(2) `/api/dag/execute-node` 加 `node.type==='subdag'` 分支：load child snapshot → authz_check read → `executeDagAsPublished({formInputs=bound_subdag_params})` → 回選定 exposed output 的 frame；(3) DagTab `SubdagNode` 改 `data.outputs` → per-column Handle（沿 FunctionNode pattern）；`addSubdagNode` 起始 `outputs=[]`；`updateSubdagData` 接受 `outputs`；`SubdagInspector` cache 多存 `exposed_outputs`，`pickRid` + auto-migration effect 將 `meta.exposed_outputs[chosenId]` 同步進 `node.data.outputs`；(4) `expandSubdags` 不需動 — publish 期 `source` rewrite 成 prefixed child output node id（fn type），其 row0 keys = column names，curator-supplied sourceHandle 直接吻合。Validator 不需動 — `kindFamily` 在 column-shape outputs 上自動覆蓋（測 `amount(numeric) → p_searchkey(varchar)` 正確報 `type_mismatch`，`code(varchar) → p_searchkey(varchar)` 正確靜音）。Backend smoke：subdag /execute-node 對 `published_dag:dag:fc_test_2` 回 7 columns / 多筆 rows。前後端 ts-check 0。Adam 待手動：開 test_subdag → 觀察 outputs 自動遷移成 7 columns → 刪掉舊 `__downstream` edge → 從欄位拉新 edge → run-all 驗 4 個 400 全消。 |

---

## 8. References

- Master plan: `docs/plan-v3-phase-1.md`
- `dag-publish-v01-plan.md` — V086 publish 流程 + Fork A bless 模型
- `dag-subdag-embed-v01-plan.md` — V087 subdag embed + embedders endpoint
- `services/authz-api/src/routes/dag.ts:697-1131` — current publish + embedders/list
- `services/authz-api/src/routes/modules.ts:355-455` — PATCH /api/modules/pages（reuse 模板）
- `database/migrations/V086__dag_publish.sql` — 兩個 publish constraints
- `apps/authz-dashboard/src/components/DagTab.tsx:2968-3155` — 現 PublishDagDialog
