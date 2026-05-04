# UX-THREE-ASKS-V01 — Query Tool 二修 / Catalog 麵包屑 / Flow Composer 歷程

**狀態**：proposal · pending Adam review
**作者**：Claude (tech-lead Adam 指派)
**日期**：2026-05-04

---

## 0. Background

Adam 在 2026-05-04 提出三個 UX 訴求：

1. Query Tool 能讀取既有 function 的 SQL DDL，並支援「就地二修」或「複製後修改」。
2. Catalog → Pages（及其他 Catalog tabs）能用麵包屑顯示使用者在 sidebar 的位置。
3. Flow Composer 在執行後能看到**整條鏈**的歷程資訊，而非只有最後一個被點選的節點。

本 plan 涵蓋三個訴求的設計與依據；落地順序與切票方式留待 Adam 拍板。

---

## 1. 全局決策

### 1.1 不引入新表、不改 schema

**依據**：

- 三個訴求本質都是 UX 層強化，不涉及 SSOT（`authz_role_permission` / `authz_policy`）或 Tier B published_dag 結構。
- 現行 `authz_resource` (modules) + `last_result` (in-memory) 已足以驅動 breadcrumb 與 trace 面板，沒有持久化 run history 的硬需求；落地前無需 migration，符合 CLAUDE.md「純加性工作不要套 phase」精神。
- Run history 持久化（V0xx `dag_run_history` 表）在本 plan **明確列為非目標**，理由見 §4.5。

### 1.2 三個案件互不依賴，可獨立切票

**依據**：

- 案 1 動 `data-query.ts` route + `DataQueryTab.tsx`；案 2 動 shared atoms + Layout/PagesTab；案 3 動 `DagTab.tsx`。三者檔案不重疊。
- 即使其中一案被否決或延後，另外兩案仍可獨立上 dev。

### 1.3 一律不踩 hard gate

**依據**：CLAUDE.md 列的三個 hard gates（M4 prod-ready / Path A → Tier 2 form migration / 2027-05 demo）皆為基礎設施或不可逆遷移，本 plan 全屬 Consume 端 UX 加性工作，與其無關。

---

## 2. 案 1：Query Tool — Edit / Duplicate 既有 function

### 2.1 痛點

`apps/authz-dashboard/src/components/DataQueryTab.tsx` 目前 Run mode 只能執行；Author mode 只能從零或從 4 個 template 開始。要修一支既有 function，curator 必須去 PG client 拉 DDL、貼回 textarea、調整名稱再 deploy。

### 2.2 設計

#### 2.2.1 後端：新增 `GET /api/data-query/functions/:resource_id/ddl`

- 路徑：`services/authz-api/src/routes/data-query.ts`
- 行為：
  - 接 `?data_source_id=…`（同其他 endpoint 慣例）。
  - 從 `authz_resource` 撈 `(schema, function_name)`，再對 ds 連線跑 `pg_get_functiondef(p.oid)`。
  - 回 `{ resource_id, schema, function_name, ddl: string }`。
- 錯誤情境：
  - resource not found / inactive → 404
  - pg_proc 已被 drop（orphan）→ 404 + `error: 'orphaned'`，前端提示「此 function 在來源端已不存在」。

**依據**：
- `pg_get_functiondef` 已被 `/functions/lint-all`（line 370）使用、技術成熟、無新風險。
- 拆獨立 endpoint（而非把 DDL 包進 `/functions` list）是因為 list 用於 sidebar 列出，DDL 是逐一檢視 — 把 N 條 DDL 全進 list payload 會放大幾十倍流量。

#### 2.2.2 後端：權限沿用 `data_function_call` + steward gate

- 採 `requirePermission('data_function_call', resource_id)` 同既有 exec/validate。
- 額外要求 steward role（DDL 揭露實作細節，比 exec 更敏感）。

**依據**：
- exec 已 gate `data_function_call`，DDL 不能比 exec 更鬆。
- DDL 包含商業邏輯（如 SQL 中內嵌的判斷規則），洩漏風險高於單純 exec 的結果列。比照 PagesTab `requireRole('DATA_STEWARD')` 限制較合理。
- SYSADMIN bypass 同既有慣例。

#### 2.2.3 前端：Run mode 加「Edit」「Duplicate」兩鍵

位置：`DataQueryTab.tsx` 右側 detail card 的 button row（與 Run 同列），條件：`selectedFn` 存在且 user 為 steward+。

- **Edit**：
  1. fetch DDL → `setSql(ddl)`
  2. `setMode('author')`
  3. AuthorPanel 進場時偵測「sql 已預填」→ 渲染 banner：`正在修改 ${schema}.${function_name}（Deploy 將執行 CREATE OR REPLACE，覆蓋同名 function）`。
  4. 不改 function_name → Deploy 直接 REPLACE。

- **Duplicate**：
  1. fetch DDL
  2. 用 regex 找 `CREATE OR REPLACE FUNCTION ${schema}.${function_name}`，把 `${function_name}` 改為 `${function_name}_copy`（首個未撞名的 `_copy`、`_copy2`…）。
  3. `setSql(modified)` + `setMode('author')`
  4. banner：`複製為新 function：${schema}.${function_name}_copy（Deploy 將執行 CREATE，不會影響原始）`。

**依據**：

- 兩鍵分流的原因：Edit 與 Duplicate 對應兩種**心智模型完全不同**的工作流（修 vs 派生）。塞同一個按鈕需 modal 二選一，多一次 click 且容易誤操作覆寫 production fn。
- 自動加 `_copy` suffix 是 PG 的常見約定（也是 pgAdmin 的預設行為）；自動避撞名（`_copy2`…）需要 fetch 一次 functions list 比對，但 list 已在記憶體（`functions` state），零成本。
- 不在 backend 處理 rename 是為了讓 curator **看得到** rename 結果並可手動再調整（例如改名為 `_v2` 而非 `_copy`），避免黑魔法。
- AuthorPanel 既有的 lint debounce + Validate + Deploy 流程**完全沿用**，不需新增驗證邏輯。

#### 2.2.4 UI 細節

- Edit / Duplicate 都會跳到 Author mode；切回 Run mode 時若 sql 有未存改動，跳 confirm（沿用 template 切換的 `window.confirm` 模式，line 818）。
- 既有「+ New from template…」下拉**不動**；Edit/Duplicate 是另一條入口。
- Run mode 右上角小字註記 fn owner / 上次 deploy 時間（如有），讓 curator 確認自己改的不是別人剛 ship 的版本——**此項標為 stretch**，第一次出貨先不做，避免 scope creep。

### 2.3 變更檔案清單

| 檔案 | 動作 |
|---|---|
| `services/authz-api/src/routes/data-query.ts` | + 新 endpoint |
| `apps/authz-dashboard/src/api.ts` | + `dataQueryFunctionDdl(ds, rid)` |
| `apps/authz-dashboard/src/components/DataQueryTab.tsx` | + Edit/Duplicate 鍵 + AuthorPanel banner prop |

### 2.4 風險與緩解

| 風險 | 緩解 |
|---|---|
| Curator 不慎在 Edit mode 改了**正在被 published_dag 引用**的 fn → BI 端炸 | banner 加 hint：「若此 fn 被 published_dag 使用，REPLACE 會立即影響線上頁」。**不**在 backend 阻擋（rationale：tech lead self-sign 模式，audit 即可）。 |
| `pg_get_functiondef` 在某些 PG 擴充型別上出 SQLSTATE 42704 | catch → 回 422 + `error: 'cannot_serialize_function'`，前端提示用戶手動取 DDL。 |

### 2.5 測試

- 後端：`tests/data-query.spec.ts`（or 等價）+ 一個整合測：deploy fn → fetch ddl → 字串包含 `CREATE OR REPLACE FUNCTION`。
- 前端：手動 click-through（Adam 已豁免要求 AI 自跑 UI 驗證、見 feedback memory）。
- 不需要 e2e — 兩鍵都是 mode 切換 + 文字注入，沒有 race。

---

## 3. 案 2：Catalog Breadcrumb（統一抽取，非新做）

### 3.1 痛點

Adam 觀察到 PagesTab 平鋪一張表，看不出 page 在 module hierarchy 的位置。但 codebase 其實已有 **兩份重複實作**：

- `apps/authz-dashboard/src/components/modules/ModuleDetail.tsx:14-22` — `buildBreadcrumb(moduleId, nodes)`，walk parent_id 鏈
- `apps/authz-dashboard/src/components/DagTab.tsx:3143-3155` — publish dialog 的 `parentBreadcrumb`，同樣邏輯
- `apps/authz-dashboard/src/components/ConfigEngine.tsx:506+` — `NavigationBar`，但這是**另一種** breadcrumb（page-stack 而非 module-tree）

**真正缺的是**：（a）共用 atom；（b）PagesTab 沒有用；（c）Auto-page renderer 沒有 module 位置感。

### 3.2 設計

#### 3.2.1 抽取 `shared/atoms/ModuleBreadcrumb.tsx`

- props：
  ```ts
  type Props = {
    moduleId: string | null;       // null → "Catalog" 起點
    modules: ModuleTreeNode[];      // 由呼叫者帶入（避免每處重抓）
    leaf?: { label: string };       // 末段非 module 的當前頁
    rootLabel?: string;             // default 'Catalog'
    onClickModule?: (id: string) => void;  // 可 click 跳 ModuleDetail
  };
  ```
- 內部沿用 `ModuleDetail.tsx` 的 walk 邏輯，搬入 atom；舊 `buildBreadcrumb` 改 import。
- DagTab 的 `parentBreadcrumb` 同樣替換成 atom 呼叫。

**依據**：

- 兩份重複實作 + 第三份（PagesTab 缺）= 抽取的時機到了。**不抽取 → 案 2 等於再多寫第四份**。
- 不把 ConfigEngine 的 page-stack `NavigationBar` 一起合併：兩者語義不同（一是 module 位置，一是用戶 drilldown 軌跡），合併會混淆。

#### 3.2.2 落地點

| 落地點 | 內容 | 依據 |
|---|---|---|
| **PagesTab.tsx PageHeader 上方** | `Catalog › Pages`（固定二段） | PagesTab 是「列出所有 published Tier B pages」，不依屬單一 module；只標出 Catalog 群組即可。 |
| **PagesTab 展開列 (LineagePanel) 內** | `Catalog › Modules › {parent} › {page title}` | 此處有具體 row context，可顯示真正的 module 鏈，補強對 row 的位置感。 |
| **Auto-page renderer (ConfigEngine 非 modules-tab 路徑)** | 在 PageHeader 上方加 module 麵包屑 | BI 用戶從 Modules tab drilldown 進 Tier B page 後，目前只剩 ConfigEngine 自己的 page-stack 麵包屑，看不出在 sidebar 的哪個 module 群組——這是 Adam 直接點到的痛。 |
| **ModuleDetail.tsx** | 替換既有 inline 為 atom | 重構，不改外觀。 |
| **DagTab.tsx publish dialog** | 同上 | 重構，不改外觀。 |

#### 3.2.3 不在 sidebar 群組 label（"Catalog"）加 click

**依據**：sidebar 群組 label 在 Layout.tsx 是純文字（`navGroups.label`），不是路由。把它改成 click 會打開「群組首頁」的問題（Catalog 沒有首頁、只是 IA 分組）。麵包屑的「Catalog」段保留為 label，**不可 click**——與 sidebar IA 一致。

### 3.3 變更檔案清單

| 檔案 | 動作 |
|---|---|
| `apps/authz-dashboard/src/components/shared/atoms/ModuleBreadcrumb.tsx` | + 新 atom |
| `apps/authz-dashboard/src/components/modules/ModuleDetail.tsx` | 替換為 atom |
| `apps/authz-dashboard/src/components/DagTab.tsx` | publish dialog 改用 atom |
| `apps/authz-dashboard/src/components/PagesTab.tsx` | + breadcrumb @ PageHeader + LineagePanel |
| `apps/authz-dashboard/src/components/ConfigEngine.tsx` | + breadcrumb @ auto-page header（條件：page 有 `parent_module_id`） |

### 3.4 風險與緩解

| 風險 | 緩解 |
|---|---|
| `modules` state 在 ConfigEngine 內目前**沒抓** | 若 page 沒在 PageConfig 裡帶 `parent_module_id`，breadcrumb 隱藏（fallback 為純 ConfigEngine NavigationBar）。再決定是否補後端 fn。 |
| 抽取兩份既有實作的回歸風險 | 兩處（ModuleDetail / DagTab publish dialog）都有 testid (`publish-page-breadcrumb` 等)，e2e 仍可掃 — 但本案不寫新 e2e、靠 manual。 |

### 3.5 測試

- ModuleBreadcrumb atom 的 unit test（純 function `buildBreadcrumb` 已有等價邏輯，可直接 port）。
- 視覺迴歸由 Adam manual 一次。

---

## 4. 案 3：Flow Composer Run Trace 面板

### 4.1 痛點

`DagTab.tsx:1907-2220` 的 Inspector 只顯示 `selected.data.last_result`。實務上 curator 跑完 leaf 後，要回看「filter 那層被刷掉幾筆？search fanout 撈到哪些 material？」必須一個一個點 node、再看右側面板——資訊散在 N 次點擊裡。

**已存在但不足**：
- 節點 body 已顯示 `row_count / elapsed_ms` 小字（line 309/457），但**沒有順序、沒有 lineage、沒有點擊反查結果**。
- `last_result` 留在每個 node 上（持續到 session 結束 / DAG reload），資料其實都在，只是沒有聚合視圖。

### 4.2 設計

#### 4.2.1 新增 collapsible「Run trace」底部面板

- 位置：canvas 下方，預設收起（不擠 canvas 空間）。展開時佔約 200px 高，可拖動分隔線。
- 觸發：
  - 主動：點 「Run trace」toggle（在現有 toolbar 加按鈕，旁邊放 row count badge ≧ 0）。
  - 被動：每次 `executeNode` / `executeSink` 完成後，若面板收起，toggle 旁的 badge 數字 +1（不強迫展開，避免打斷 flow）。

#### 4.2.2 面板內容（一列一次執行）

欄位（依 columns，左到右）：

| 欄 | 來源 | 依據 |
|---|---|---|
| `#` | session-local 累計序號 | curator 看「先後」的最低成本訊號。 |
| node label | `n.data.label` | 不顯示 `resource_id`（太長）。 |
| status | ok / error | 沿用 `last_result` 在則 ok；error 改進另記 `last_error`（**新欄位**）。 |
| rows | `last_result.row_count` | 既有。 |
| ms | `last_result.elapsed_ms` | 既有。 |
| inputs hint | 從 `last_result.lineage` 取前兩筆 `input ← source` | 既有，已有資料只是沒聚合。 |
| 動作 | "select" / "view rows" | select 把右側 Inspector focus 到該 node；view rows 跳出 modal 看 sample（rows 已存）。 |

#### 4.2.3 順序定義

每次 `executeNode` 把當前 timestamp 記到 `n.data.last_run_seq` 與 `last_run_at`。面板按 `last_run_seq` 倒序（最新在頂）。

**依據**：
- 原本的 trace 是 chronological（先後執行），把序號當 sort key、不另存 list 是為了**避免 list 與 node state 雙寫**——node 被 delete 時 trace 自然消失，與 canvas 真實狀態保持一致。
- 倒序顯示是因為「剛跑完最關心」，比照大部分 IDE 的 Run console。

#### 4.2.4 不做：error trace 持久化、跨 session 歷史

**依據**：

- 如 §1.1，這是 UX 加性，不上 migration。
- Adam 還沒提「想看上週的 run」，跳過避免 overengineering（CLAUDE.md「Don't design for hypothetical future requirements」）。
- 若以後真的要持久化（例如要做 Smart Analyst 2.0 的 prompt 調試 replay），開新 plan、加 `dag_run_history` 表即可，本 plan 留接點不留實作。

#### 4.2.5 加強 canvas 內節點顯示（小幅）

- 在 node body 既有的 `row_count / ms` 旁加 `#${last_run_seq}` 小徽章。
- 點該徽章 = `select` + scroll 到對應 trace row。

**依據**：用順序徽章把 canvas 與 trace panel **視覺對齊**，避免「看了 panel 還要回頭找哪個是 #3」。

### 4.3 不採方案 + 依據

| 不採 | 為何不採 |
|---|---|
| 在 Inspector 顯示「整鏈 result」（前案 C） | Inspector 是 320px 寬的 detail 區，不適合塞列表；換成滑出 drawer 等於另起 panel——既然要起 panel，不如直接用 trace panel。 |
| Auto-execute 整條 DAG 並收集 trace | 已有 `executeNode` 的 upstream gather，重做會跟既有 stepwise 模式衝突；且 user_input 必須由 curator 鍵入，無法純 auto。 |
| 持久化 run history（DB 表） | §4.2.4 已述。 |

### 4.4 變更檔案清單

| 檔案 | 動作 |
|---|---|
| `apps/authz-dashboard/src/components/DagTab.tsx` | + `last_run_seq` / `last_error` on node data + Run trace panel + node body badge |
| `apps/authz-dashboard/src/components/shared/atoms/RunTracePanel.tsx`（可選） | 若 DagTab 已 3258 行，抽 panel 進獨立檔比較好維護 |

### 4.5 測試

- Manual 跑 3-node chain 看 trace 顯示順序、select 連動。
- Unit：`last_run_seq` 在 executeNode 後遞增、delete node 後 trace 列消失。

---

## 5. 出貨順序建議

依**體積/收益比**排序（先做小而高的）：

1. **案 2 Breadcrumb（最小，且解兩份重複）**
   - 估時：0.5 天（atom + 4 處替換 + auto-page 條件渲染）。
   - 依據：抽取本身就值得做（消重）；對 BI 用戶定位感的提升 / 投入比最高。

2. **案 1 Edit / Duplicate**
   - 估時：1 天（後端 endpoint + 前端兩鍵 + banner）。
   - 依據：明確功能落差（curator 工作流卡點）；改動範圍可控。

3. **案 3 Run Trace 面板**
   - 估時：1.5 天（panel + node 徽章 + state 設計）。
   - 依據：體積最大；DagTab 已 3258 行，新功能要小心 regression。建議排序最後，並抽 panel 進獨立檔。

**全部完成 ≈ 3 天。** 不踩 hard gate、可拆 PR、可獨立切票。

---

## 6. 待 Adam 拍板的決策點

請在 review 時逐項表態（沿用 default-driven workflow，AI 已下預設值，只回覆「同意 / 改 X」即可）：

| # | 決策 | AI 預設 | 變更代價 |
|---|---|---|---|
| D1 | 三案都做？ | 是（順序如 §5） | 否決個別案件不影響其他 |
| D2 | 案 1 是否限 steward+？ | 是（DDL 比 exec 敏感） | 改 `'admin'` 即可 |
| D3 | 案 1 Edit banner 是否警告 published_dag 引用 | 警告但不阻擋（self-sign 風格） | 加阻擋需多一支 query parents endpoint |
| D4 | 案 2 抽 atom 順帶重構 ModuleDetail / DagTab publish | 是 | 不重構 → 留 3 份重複，未來必還債 |
| D5 | 案 2 Auto-page breadcrumb 是否需要後端補 `parent_module_id` 給 ConfigEngine | 不補（fallback 隱藏即可） | 補 → 多動 page-config endpoint |
| D6 | 案 3 trace panel 抽進獨立檔 | 是（DagTab 已 3258 行） | 不抽 → DagTab 漲到 ~3500 行 |
| D7 | 案 3 是否上 `last_run_seq` 持久化（DAG save 時寫入） | 否（session-local） | 上 → 多動 DAG save payload 與 schema |

---

## 7. 不做（明確 out-of-scope）

- 不做 run history 持久化（§4.2.4）。
- 不做 Tier B 頁面的權限變更或 Path A/B 變遷。
- 不做 Query Tool 的 schema-aware autocomplete（另案）。
- 不做 sidebar 群組 label 變 clickable（§3.2.3）。
- 不動 CLAUDE.md / docs/PROGRESS.md（這是 Adam tech-lead 的決策權，本 plan 落地後再補一條 PROGRESS 即可）。
