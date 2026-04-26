---
paths:
  - "apps/authz-dashboard/src/components/ConfigEngine.tsx"
  - "apps/authz-dashboard/src/RenderTokensContext.tsx"
  - "services/authz-api/src/routes/config-exec.ts"
  - "services/authz-api/src/routes/dag.ts"
  - "services/authz-api/src/routes/ui.ts"
  - "database/migrations/V022__config_ui_engine.sql"
  - "database/migrations/V053__ui_render_token.sql"
  - "database/migrations/V054__authz_ui_page_snapshot.sql"
  - "database/migrations/V0**__*ui*.sql"
---

# Metadata-Driven UI 標準

> **Tier A 平台 own renderer + widget catalog;Tier B 應用由 Curator 用 metadata 配出來。**
> 配套:[`.claude/plans/v3-phase-1/two-tier-platform-model.md`](../../.claude/plans/v3-phase-1/two-tier-platform-model.md)

## 0. 一句話總結

UI 樹**不是**寫在 .tsx 裡。它是 PG function `fn_ui_page()` 從 `authz_ui_page` 表回傳的 JSON。前端有一份固定的 widget / handler / icon registry,renderer 讀 JSON 查 registry 渲染。

---

## 1. 思路鏈(從 0 到能寫 widget)

### Step 1 — UI 是「組件樹」

```tsx
function CustomerPage() {
  return <div><h1>Acme</h1><table>...</table></div>;
}
```
樹寫死。每個客戶要新 component。不能 scale。

### Step 2 — 把資料拉出來

```tsx
function CustomerPage({ customer, products }) {
  return <div><h1>{customer.name}</h1><table>{products.map(...)}</table></div>;
}
```
1 個 component 服所有客戶。但**樹形狀仍寫死**。

### Step 3 — 把整棵樹也變資料

```json
{ "type": "table", "rows": [["PS5021","MP"], ...] }
```
+ universal renderer:
```tsx
function render(node) {
  if (node.type === 'table') return <table>...</table>;
  if (node.type === 'h1')    return <h1>{node.text}</h1>;
}
```
**這就是 metadata-driven UI 的本體。** 樹從 DB / API 來。

### Step 4 — 互動用「名字」當 handle

```json
{ "type": "button", "label": "Promote", "onClick": "promoteState" }
```
```tsx
const ACTIONS = { promoteState: (ctx) => api.promote(ctx.id), ... };
<button onClick={() => ACTIONS[node.onClick](ctx)}>{node.label}</button>
```
JSON 純資料(可存 DB / 可審 / 可 LLM 生);**會跑的程式都在 registry 裡**,平台 team 控制名單。

### Step 5 — 用 widget catalog 控制詞彙

```ts
const WIDGETS = { card_grid: CardGrid, table: DataTable, detail: DetailView, ... };
```
**有限詞彙、無限組合**。Curator 拼 Lego,不寫 React。

### Step 6 — Nexus 已實作

| 概念 | Nexus 實作 |
|---|---|
| Metadata 從 DB 出來 | `services/authz-api/src/routes/config-exec.ts:60` `fn_ui_page($1)` |
| 順手帶 AuthZ + masked data | `config-exec.ts:73` `authz_check` + `:121` `buildMaskedSelect` |
| Layout dispatch | `apps/authz-dashboard/src/components/ConfigEngine.tsx:669` `layout === 'card_grid'` / `'table'` |
| Handler registry(完全自訂 React) | `ConfigEngine.tsx:109` `HANDLER_REGISTRY` |
| Icon registry | `ConfigEngine.tsx:85` `ICON_MAP` |
| Status color registry | `ConfigEngine.tsx:120` `STATUS_COLORS` |

---

## 2. 現有 widget catalog

### Layout

| Layout | Renderer | 用途 | 設定點 |
|---|---|---|---|
| `card_grid` | `<CardGrid>` (ConfigEngine.tsx ~669) | 卡片網格,點 drilldown | `config.components` |
| `table` | `<DataTable>` (~676) | 表格 + 篩選 + drilldown | `config.columns` + `config.filters` |
| (handler-mode) | `HANDLER_REGISTRY[name]` (:109) | 完全自訂 React 接管 | `config.handler_name` |

目前已註冊 handler:
- `modules_home_handler` → `<ModulesTab>`
- `audit_home_handler` → `<AuditTab>`

### Cell render(`columns[i].render`)

`code` / `badge` / `date` / `datetime` / `currency` / ...(完整列表看 `ConfigEngine.tsx` cell renderer 區塊)

### Icon(`config.icon`)

從 `authz_ui_render_token` (V053) 取,Tier B Curator 可自由 INSERT。Tier A platform 維護 `LUCIDE_ICON_CATALOG` (ConfigEngine.tsx 的 lucide imports) 作為 PascalCase → React component 的對照。Curator 寫進 metadata 的是 kebab-case `token_key` (e.g. `package`),DB 對到 PascalCase `value` (`Package`),前端解析到 catalog 拿 component。

**新增一個 icon (Curator):**
```sql
INSERT INTO authz_ui_render_token (category, token_key, value)
VALUES ('icon', 'wrench', 'Wrench');
```
若 `Wrench` 已在 `LUCIDE_ICON_CATALOG`,立即可用;若還沒,前端 fallback 為 `Database` 圖示,Tier A 補一行 import 即生效(零 schema 改動)。

### Status / Phase / Gate color (`render: 'status_badge' | 'phase_tag' | 'gate_badge'`)

也來自 `authz_ui_render_token` (V053),`category` 分別是 `status_color` / `phase_color` / `gate_color`,`value` 直接是 tailwind class string。Curator 可自由 INSERT 新 status / 新顏色,**沒有任何 React bundle 限制**(不像 icon 需要 component import)。

```sql
INSERT INTO authz_ui_render_token (category, token_key, value)
VALUES ('status_color', 'cancelled', 'bg-rose-100 text-rose-700');
```

---

## 3. Curator 食譜:新增一個 page

假設要為 `customers` 表加列表頁:

1. 確認 resource 已存在
   ```sql
   SELECT * FROM authz_resource WHERE resource_id = 'table:customers';
   ```
2. 確認權限(走 default-by-convention preset 或手動 grant)
3. INSERT 一筆 metadata:
   ```sql
   INSERT INTO authz_ui_page (page_id, parent_page_id, title, config, is_active)
   VALUES (
     'customer_list',
     'customers_home',
     'Customers',
     jsonb_build_object(
       'layout',      'table',
       'data_table',  'customers',
       'resource_id', 'table:customers',
       'columns', jsonb_build_array(
         jsonb_build_object('key','id',    'label','ID',     'render','code'),
         jsonb_build_object('key','name',  'label','Name'),
         jsonb_build_object('key','state', 'label','Status', 'render','badge')
       ),
       'row_drilldown', jsonb_build_object(
         'page_id',       'customer_detail',
         'param_mapping', '{"id":"id"}'::jsonb
       )
     ),
     TRUE
   );
   ```
4. Refresh dashboard。新 page 可用。**零 React 改動**。

---

## 4. Tier A 食譜:新增一個 widget

當 Curator 抱怨「我需要 timeline」而 catalog 沒有,平台 team 動作:

1. 寫 `<Timeline>` React component,只接 `{ config, data }` props(**不接** `entity_type` 之類)
2. 在 `ConfigEngine.tsx` layout dispatch 加分支:
   ```tsx
   {current.config.layout === 'timeline' && current.config.events && (
     <Timeline config={current.config} data={current.data} />
   )}
   ```
3. 在本文件 §2 widget catalog 表加一列
4. 寫 sample metadata 給 Curator 抄
5. PR 走 Tier A 審查(Two-Tier Platform Model 規範)

---

## 5. 禁止反模式

| 反模式 | 為什麼擋 | 正解 |
|---|---|---|
| `ConfigEngine.tsx` 寫 `if (config.data_table === 'customers') { ... }` | Tier B 業務邏輯洩進 Tier A | 加 generic widget,Curator 用 metadata 表達差異 |
| `App.tsx` 加新 tab 給某業務場景 | Tier B 應該是 metadata 不是 code | INSERT `authz_ui_page` |
| Widget props 接 `entity_type: 'eco'` | Widget 該只接通用 props (`config` + `data`) | Curator 在 metadata 表達意圖 |
| icon list / status color list 寫死 | Curator 想新增要動 code = 平台脆 | Phase 1 動態化 |

---

## 6. 為什麼這樣設計

- **AuthZ 與 UI 統一強制點:** `config-exec.ts` 拿 metadata 後立即 `authz_check`,任何 page 自動受 SSOT 保護
- **Column mask 自動套:** `buildMaskedSelect` 讀 `authz_resolve` 的 mask 結果,Curator 不需在 metadata 寫 mask 邏輯
- **AI agent 可生 metadata:** JSON 受 widget catalog 約束 → LLM 輸出可驗證 → Constitution §9 同意流可審
- **改 widget 一次,所有 page 受惠:** 反之每個 page 寫死 = 改一處要動 N 處

---

## 6.5 Snapshot pages (DAG → Tier B page, Path A)

V054 加 `authz_ui_page.snapshot_data jsonb`,讓 DAG 任一 node 的 result 可凍存成 Tier B 頁面。Curator workflow loop:run DAG → 「Save as page」按鈕 → page 立刻可看。

**Shape:**
```jsonc
snapshot_data = {
  "columns": [{"key","label","data_type","render"?,"semantic_type"?}],
  "rows":    [...],
  "origin":  {"kind":"dag","dag_id":"dag:...","node_id":"n3",
              "bound_params":{...},"captured_by":"user:...","captured_at":"..."}
}
```

**Renderer:** `config-exec.ts` step 3a — `snapshot_data` 非空時 short-circuit,直接回 cached rows + columns(跳過 information_schema scan、跳過 buildMaskedSelect)。

**Endpoint:** `POST /api/dag/save-as-page`(`dag.ts`),body 含 `page_id` / `title` / `parent_page_id` / `dag_id` / `node_id` / `bound_params` / `columns` / `rows` / `overwrite?`。

**未來 Path B:** live re-execution(每次開頁都 re-run DAG,每位 viewer 重新套 mask)。需在 `config-exec.ts` 對 `data_source` 加 `dag:` 前綴 dispatch。Path A 是純 snapshot — 結果是 captured_by 那一刻的 view,後續 viewer 看到的是同一份。

---

## 7. 已知 gap(進 Tier A backlog)

- ~~`ICON_MAP` 寫死~~ ✅ 動態化 2026-04-26 (V053 + RenderTokensContext, RENDER-TOKEN-01)
- ~~`STATUS_COLORS` 寫死~~ ✅ 同上;`PHASE_COLORS` / `GATE_COLORS` 一併動態化
- 沒有 `timeline` / `ai_report` / `agg_table` widget → 排程加入
- 沒有「Curator 改 metadata 即時預覽」的 UI(BU-08 是相關但不完整)
- Widget catalog 沒有自動 doc → 補 `/api/widget-catalog` endpoint 給 LLM 用
- 4 個 platform primitive(help_text / saved_view / feedback / subscription)尚未 ship,見 Two-Tier sub-plan
