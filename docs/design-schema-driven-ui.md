# Schema-Driven UI — Path A 的 bottom-up pivot

**Status:** DRAFT (2026-04-24, awaiting `/plan-eng-review`)
**Owner:** Adam
**Supersedes (in spirit):** `docs/config_driven_ui_requirements.md` 的「admin 是 author」假設
**Related:** `docs/plan-v3-phase-1.md` (這份是 v3 universal platform 的核心 enabler)

---

## 1. Thesis

整個專案的 bottom-up 承諾,目前只長到 L1/L2 政策層 (BU-01..07 完成)。
應用層 (UI、Module、Organization) 還是 top-down 手刻的。

Phison 的現實是:**沒有人會去填 metadata catalog**。
任何「先建 model → 再上 UI」的路在 Phison 內部死路一條,導入成本太高。

所以 Path A 的設計假設要 pivot:

| 舊假設 (現在) | 新假設 (這份 doc) |
|---|---|
| Admin 是 metadata **author** | Admin 是 metadata **reviewer / customizer** |
| `authz_ui_descriptor.columns` 由 SQL seed 寫死 | 由 schema introspector 自動推導 |
| 一張新 table 進來 → admin 手填 module config → UI 才出現 | 一張新 table 進來 → 30 秒內有可用 UI,admin 之後 override |
| Path A 是 config-driven UI (config 來源 = 人) | Path A 是 schema-driven UI (config 來源 = `pg_attribute` + `pg_constraint` + `pg_proc`) |

**核心 promise:** *資料來了,應用就出現了。*

---

## 2. Current State (從 codebase 探索回來的事實)

### 已經有的零件 (不重做)

**Backend:**
- `services/authz-api/src/routes/datasource.ts:532-565` — `information_schema` 掃描 (tables/columns/comments/functions),已 production
- `services/authz-api/src/lib/function-metadata.ts:52-64` — `classifyType(pgType): ParamKind` 把 PG type 映射到 `text|number|bool|date|datetime|array|json|unknown`
- `services/authz-api/src/lib/function-metadata.ts:68-141` — `parseFunctionArgs` + `parseReturnType` + `extractFunctionMetadata`,完整 function 簽名 parser
- `services/authz-api/src/db.ts:155-175` — `getDataSourcePool(sourceId)`,可以連任何已註冊的 data source (含 Oracle CDC)
- `services/authz-api/src/routes/config-exec.ts:114-125` — 已經會從 `information_schema.columns` 動態組 masked SELECT,**意思是「table → 可執行 query」這條路已經通了**

**Frontend:**
- `apps/authz-dashboard/src/components/shared/MetadataGrid.tsx` — **通用 descriptor-driven 表格**,讀 `{key, label, type, render_hint, sortable?, width?}` 陣列就能 render。20+ render hints 已實作 (mono / bold_mono / path_badges / type_badge / active_badge / mono_truncate ...)
- `apps/authz-dashboard/src/components/shared/MasterDetailLayout.tsx` — 通用 master/detail 容器
- `apps/authz-dashboard/src/components/shared/atoms/` — StatCard, EmptyState, PageHeader

**Database:**
- `authz_ui_page` (V022) — page 容器 (page_id, layout, data_table, resource_id, columns_override, filters_config)
- `authz_ui_descriptor` (V035) — section/columns/render_hints 容器 (page_id FK)
- `authz_resource` (resource_type='module') — module 樹本身就是 schema-aware 的 (V034 module_tree_stats matview 已經會 count children/tables/columns)
- `module_tree_stats` materialized view — children count,promoted resource 數量,已 refresh on trigger

### 缺的關鍵環節

1. **Schema → descriptor generator** — 沒有 endpoint 把「table 名稱」轉成 `authz_ui_descriptor` 那種 JSON shape
2. **Default render hint 推導** — `classifyType` 知道 type,但沒有「PG type → render_hint default」的對照表 (e.g. `timestamptz` → `relative_time`,`numeric` → `mono` + 右對齊)
3. **Discover 上的 "Generate App" 動作** — `POST /api/discover/promote` 會建 module + reparent resource,但不會順便 generate ui_descriptor
4. **`<AutoTablePage>` 元件** — 嚴格說不需要新元件,`MetadataGrid` + 一個簡單的 `<AutoTableRoute>` wrapper (load descriptor + load data + 套權限) 就夠了

---

## 3. The Pivot — 什麼變、什麼不變

### 不變

- `authz_ui_page` / `authz_ui_descriptor` 的 schema **不動**。Pivot 的是「誰填 row」,不是「row 的 shape」。
- L0-L3 權限模型不動。`authz_check`、`authz_resolve`、Path B SQL rewrite 全部照舊。
- Module 樹結構 (`authz_resource` parent_id) 不動。
- 現有手刻的 `authz_ui_page` row (例如 modules_home) 繼續 work。Pivot 是**新增一條 derive 路徑**,不是廢掉舊路徑。

### 變

| 元件 | 舊 | 新 |
|---|---|---|
| `authz_ui_descriptor` row 來源 | SQL migration seed (e.g. V035 INSERT) | (a) schema introspector auto-generate (b) admin override (覆蓋特定欄位) |
| Admin workflow | 在 SQL 寫 INSERT (or future admin form) | Discover → "Generate App" → preview → tweak → confirm |
| `module_definition` (假想) | 不存在 / 部分散在各表 | 不需要新表;descriptor 就是 module definition |
| Discover promote 行為 | 建 module + reparent | 建 module + reparent + **auto-derive descriptor + 對應 ui_page** |

### 「override」的精確語意

新增一張表 `authz_ui_descriptor_override` (or 直接在 `authz_ui_descriptor` 加 `is_admin_override BOOLEAN` flag),記錄 admin 對 auto-derived descriptor 的修改:

- 改 column label (`order_no` → `訂單編號`)
- 隱藏欄位 (`internal_flag` 不顯示)
- 改 render hint (`numeric` 預設 `mono` → admin 想要 `currency`)
- 加 row drilldown (這欄點下去開另一個 page)

Schema introspector **每次重跑**都會重新 derive 一份 baseline,然後 merge override 上去。Schema 變了 (新欄位),admin 不會被覆蓋掉之前的 customization。

---

## 4. Architecture

```
                           ┌─────────────────────────────────┐
                           │   authz_data_source (註冊的 DB) │
                           └────────────────┬────────────────┘
                                            │
                         getDataSourcePool(sourceId)
                                            │
                                            ▼
            ┌───────────────────────────────────────────────────────┐
            │  Schema Introspector (NEW - lib/schema-to-ui.ts)      │
            │                                                       │
            │  1. SELECT * FROM information_schema.columns          │
            │  2. SELECT * FROM pg_constraint (PK/FK)               │
            │  3. SELECT * FROM pg_proc (functions on this table)   │
            │  4. classifyType(data_type) → semantic kind           │
            │  5. type → render_hint default (NEW table)            │
            │  6. Return UIDescriptor JSON                          │
            └───────────────────────┬───────────────────────────────┘
                                    │
                ┌───────────────────┴───────────────────┐
                ▼                                       ▼
      ┌──────────────────┐                 ┌──────────────────────┐
      │ Auto baseline    │ + admin merge   │ ui_descriptor row    │
      │ (regenerate any  │ ──────────────▶ │ (status: derived |    │
      │  time schema     │                 │  overridden | hybrid)│
      │  changes)        │                 └──────────┬───────────┘
      └──────────────────┘                            │
                                                      │
                                  ┌───────────────────┴────────────┐
                                  ▼                                ▼
                        ┌──────────────────┐          ┌────────────────────┐
                        │ POST /config-exec│          │ <AutoTableRoute/>   │
                        │ (existing)       │ ──────▶  │  loads descriptor   │
                        │  • authz_check   │          │  + data via         │
                        │  • masked SELECT │          │  config-exec        │
                        │  • L1/L2 applied │          │  + renders via      │
                        └──────────────────┘          │  <MetadataGrid/>    │
                                                      │  (existing)         │
                                                      └────────────────────┘
```

### 資料流的四條路徑 (happy / nil / empty / error)

**Happy:** Discover 看到 `lot_status` → "Generate App" → introspector 抓到 8 欄、PK = `lot_id` → 寫 ui_descriptor + ui_page → admin 看到 preview → confirm → URL `/path-a/lot_status` 出現可用 UI,SELECT 自動帶 mask。

**Nil:** Resource 不存在 / data source 連不上 → introspector 回 `{error: 'data_source_unreachable', resource_id}` → Discover UI 顯示「無法生成,連線失敗」+ retry 按鈕。**不寫 partial descriptor**。

**Empty:** Table 存在但 0 columns (極端 case,view 可能) → introspector 回 `{warning: 'no_columns_found'}` + descriptor 仍寫入但 `columns: []` → 前端 render 顯示「此資料源無可顯示欄位」。

**Error (上游):** `pg_attribute` query throw → catch + log full context (sourceId, tableName, error class) + 回 500 with `{error: 'introspection_failed', detail}` → admin 看到具體錯誤,不是 silent。

---

## 5. POC Scope (第一刀)

**目標:** 任何在 Discover 看到的 table,按一個鈕,30 秒內出現可用 list + filter + 細節頁,權限自動套用。

### Backend (3 個新檔)

1. **`services/authz-api/src/lib/schema-to-ui.ts`** (~150 行)
   - `introspectTable(pool, schema, tableName): Promise<UIDescriptor>`
   - 用 `information_schema.columns` 抓欄位 (reuse 現有 query pattern from `datasource.ts`)
   - 用 `pg_constraint` 抓 PK/FK
   - 套 `classifyType` + 新增 `defaultRenderHint(pgType, columnName)` 推導 render hint
   - 推導規則 (v1):
     - `text` + 欄位名含 `email` → `email_link`
     - `text` + 欄位名含 `id`/`code`/`no` → `mono`
     - `numeric|int*|float*` → `mono` + right-align
     - `timestamptz|timestamp` → `relative_time`
     - `bool` → `active_badge`
     - `jsonb|json` → `json_truncate`
     - 預設 → `text`
   - PK 欄位自動標 `sortable: true, width: 'narrow'`
   - 回傳 `{ page_id, title, columns: [...], filters_config: [...], render_hints: {...} }`

2. **`services/authz-api/src/routes/discover.ts`** (extend,~80 行新增)
   - 新 endpoint `POST /api/discover/generate-app`
   - Input: `{ resource_id, source_id, schema, table_name, target_module_id? }`
   - 流程:
     1. `authz_check(user, 'admin', resource:auto_app_generate)` — admin only
     2. Call `introspectTable()`
     3. Upsert `authz_ui_page` (page_id = `auto:<table>`)
     4. Upsert `authz_ui_descriptor` (status = 'derived')
     5. 如果 `target_module_id` 給了,把 resource reparent 到該 module (reuse 現有 promote 邏輯)
     6. Audit log: `AUTO_GENERATE_APP`
     7. Return `{ page_id, descriptor_id, preview_url }`

3. **`database/migrations/V048__ui_descriptor_status.sql`**
   - `ALTER TABLE authz_ui_descriptor ADD COLUMN status TEXT DEFAULT 'manual' CHECK (status IN ('manual', 'derived', 'overridden', 'hybrid'))`
   - `ALTER TABLE authz_ui_descriptor ADD COLUMN derived_at TIMESTAMPTZ`
   - `ALTER TABLE authz_ui_descriptor ADD COLUMN derived_from JSONB` (記錄 source_id + table_name + introspection 時的 schema hash)

### Frontend (2 個新檔 + 1 個 button)

1. **`apps/authz-dashboard/src/pages/AutoTablePage.tsx`** (~80 行)
   - Route: `/path-a/:pageId`
   - Loads `authz_ui_page` + `authz_ui_descriptor` via API
   - Loads data via existing `POST /api/config-exec`
   - Renders via existing `<MetadataGrid descriptor={...} data={...} />`
   - Empty state, error state, loading state

2. **`apps/authz-dashboard/src/components/discover/GenerateAppButton.tsx`** (~50 行)
   - 在 Discover 表格的 row action 多一顆 "Generate App"
   - 只對 unmapped table 顯示
   - 點下去 → confirm modal (顯示「這會自動生成 UI,可後續調整」) → call `/api/discover/generate-app` → toast + 提供 "Open preview" link

3. **`apps/authz-dashboard/src/components/DiscoverTab.tsx`** (extend,~10 行)
   - Wire up `<GenerateAppButton/>` in row actions

### Test Coverage

- **Unit:** `schema-to-ui.test.ts` — feed 一個 mock `information_schema` 結果,assert descriptor shape (含 PK 標記、render hint 預設、欄位順序)
- **Integration:** `bu08-e2e.ts` (沿用 BU-06 pattern) — Discover scan → generate-app on `lot_status` → assert ui_page row 存在 → call config-exec → assert 回傳的資料有 mask 套上去
- **Playwright (optional for POC):** Discover → Generate App 按鈕 → Open preview → 看到 table,3 步驟

### 預估成本

| 項目 | Human team | CC + gstack |
|---|---|---|
| schema-to-ui.ts | 1 day | 30 min |
| /generate-app endpoint | 4 hr | 15 min |
| V048 migration | 1 hr | 10 min |
| AutoTablePage.tsx | 4 hr | 20 min |
| GenerateAppButton.tsx | 2 hr | 10 min |
| Tests | 4 hr | 30 min |
| Wiring + smoke test | 2 hr | 15 min |
| **Total** | **~2.5 days** | **~2 hr** |

---

## 6. Beyond POC — Phase 2 / 3 / 4

### Phase 2: Function → Form Generator (~1 day human / ~1 hr CC)

- 新增 `introspectFunction(pool, fnOid): Promise<FormDescriptor>`
- `parseFunctionArgs` 已經把 `(p_material_no TEXT, p_limit INT DEFAULT 10)` 解析成結構化 args
- 每個 arg → form input (text/number/checkbox/datepicker)
- 結果 (TABLE return) → MetadataGrid render
- 串到現有 DAG (`dag:material_360_trace`) — 一個 function 一個 step,output bind input,自動生成 wizard

### Phase 3: Composition (~2-3 days human / ~3 hr CC)

- 多張 table 用 FK 關聯 → 自動建議「join view」 → 一個 dashboard
- e.g. `lot_status` + `lot_status_history` (FK lot_id) → 自動出「lot detail with timeline」
- 利用既有 `authz_ui_page.layout = 'split'` 或 `'context_panel'`

### Phase 4: Override Layer (~1 day human / ~1 hr CC)

- Admin UI 編輯 derived descriptor (改 label / 藏欄位 / 改 render hint)
- Override 寫到 `authz_ui_descriptor.overrides` JSONB
- Re-introspect 時 merge:`merged = baseline.merge(overrides)`
- Schema 改變 (新欄位) 不會洗掉 admin override

---

## 7. Pivot 對現有 Path A code 的衝擊

### 不會破

- 現有手刻的 `authz_ui_page` rows (modules_home 等) 繼續 work,因為 `status` 預設 `'manual'`
- `MetadataGrid` 已經是通用元件,不需要修改
- `config-exec.ts` 不需要動
- `authz_resource` / module 樹邏輯不變

### 會調整 (Phase 2+,POC 階段不動)

- `TablesPanel.tsx`、`AccessPanel.tsx` 的 hardcoded column 列表 → 改為 fetch ui_descriptor 渲染 (refactor 機會,不是必需)
- ModuleDetail 的 `functions` sub-tab (現在 hardcoded inline) → 改用 MetadataGrid + descriptor (refactor)

### 風險點

1. **`authz_ui_descriptor` schema 加 column** — V048 migration 是 backward-compatible (新欄位有 default),但要驗證現有 seed 不會壞
2. **`/api/config-exec` 對 `auto:*` page_id 的處理** — 要驗 config-exec 會正確讀 derived descriptor 的 columns_override
3. **Page id collision** — `auto:lot_status` vs admin 之前手建的 `lot_status` page_id?加 `auto:` prefix 強制 namespace 隔離
4. **權限** — auto-generated page 預設 `resource_id = 'resource:table:<schema>.<table>'` (即 sensible default),admin 可後續調整

---

## 8. NOT in Scope (POC)

- Function → form generator (Phase 2)
- 多表 join → dashboard composition (Phase 3)
- Admin override editor UI (Phase 4)
- Cross-source app generation (e.g. Oracle table → UI) — 技術上 `getDataSourcePool` 支援,但 POC 限 Postgres
- Auto-detect FK relationships across tables (POC 只看單表)
- 自動生成 chart / aggregation (Phase 3+)
- Path C 直連場景 (Path A 自動生成的 UI 走 Path B SQL rewrite,Path C 不在範圍)
- LLM 推測欄位語意 (e.g. 「這欄看起來是金額,套 currency」) — Phase 4+ optional

---

## 9. 為什麼這個方向是對的 (CEO 角度的證據)

1. **Industry pattern** — Supabase Studio / Hasura / PostgREST / Django admin 都證明這條路通
2. **Phison 內部現實** — 你已經明說「top-down 導入成本太高」,這是來自第一線的 evidence
3. **既有 codebase 80% 對齊** — `MetadataGrid` 是通用 renderer,`config-exec` 已經會用 information_schema,`classifyType` 已經分好 type。POC 真的是 net 2 hr 的工
4. **政策層已經 bottom-up** (BU-06 完成),應用層補上後,「universal platform」這個 v3 訴求才有實質
5. **可漸進** — POC 不破壞既有 hand-crafted page,新增的 `auto:*` page 是平行存在,任何時候可以回退

---

## 10. Open Questions (給 `/plan-eng-review` 挑戰)

1. **Page id namespace** — `auto:<table>` 夠嗎?跨 source 要不要 `auto:<source>:<table>`?
2. **Re-introspect 時機** — schema 變了怎麼觸發?手動?Cron?LISTEN/NOTIFY on data source DDL? (傾向 admin 手動 + 顯示「上次 introspect」時間 + diff 預覽)
3. **多 source 同名 table** — 兩個 source 都有 `lot_status`,page_id 怎麼算?
4. **權限預設值** — auto-gen page 的 `resource_id` 預設 = `'resource:table:<schema>.<table>'`,夠 sensible 嗎?還是強制 admin 在 generate 時選?
5. **Materialized view / function 是否一視同仁?** — POC 限 base table,view 算不算?
6. **欄位順序** — `ordinal_position` 直接照搬?還是 PK 先、其他 alphabetical?
7. **大表 (1000+ columns)** — 邊界情況,要不要 cap default 顯示前 N 欄?
8. **i18n** — 自動 derive 的 column label 用英文 (column_name → Title Case)?還是查 `pg_description` 裡的 comment?

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | thesis confirmed via dialog with Adam, mode = HOLD SCOPE (POC clearly bounded) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | PENDING | Next step before POC implementation |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** CEO CLEARED — proceed to /plan-eng-review for architecture validation, then implement POC.
