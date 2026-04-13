# Phison Data Nexus — Config-Driven UI 需求規格書

## 文件資訊

| 項目 | 說明 |
|------|------|
| 專案代號 | phison-data-nexus |
| npm scope | @nexus/* |
| Helm chart | nexus-platform |
| 版本 | v0.1-draft |
| 目標讀者 | AI 開發模型（Claude / GPT / Copilot）、前後端工程師 |
| 前提假設 | 讀者已理解本專案的 AuthZ 架構 v2.3（16 章）、Casbin RBAC+ABAC、3-path SSOT、PG function-only 後端模式 |

---

## 第一章：為什麼要做這件事 — 背景故事

### 1.1 數據穀倉的現實

群聯電子（Phison）是一家 fabless 半導體公司。產品從 NPI（新產品導入）到量產，橫跨 Wafer Start、Die Sort、CP Test、FT Test、Packing、Shipping 等多個階段。每個階段有各自的系統、各自的資料庫、各自的報表工具。

這就是「數據穀倉」（Data Silo）：

- 想查一個 lot 的完整歷程？要開三個系統。
- 想看某個 product combo 的良率趨勢？要匯出 Excel 再人工拼湊。
- 想讓 AI 自動判斷異常？AI 根本不知道有哪些資料可以問。

### 1.2 兩階段戰略

**第一階段：數位化與集中** — 建立客製化系統，把分散在各系統的資料集中到 PostgreSQL，透過統一的 PG function 提供存取，前端用 Config-Driven UI 快速組裝頁面。

**第二階段：AI Agent 智能化** — AI Agent 讀取同一份 config，就知道「有哪些 API 可以呼叫、參數是什麼、回傳什麼」，達到決策自動、快速、準確、合理。

本文件聚焦的就是第一階段的核心引擎：**Config-Driven Drill-Down UI**。

---

## 第二章：核心概念 — Config-as-State-Machine

### 2.1 一句話描述

> 前端不寫死頁面。每一個畫面都是一個 PG function 回傳的 `{ config, data }` 組合。config 定義「怎麼畫」，data 定義「畫什麼」。使用者點擊某一列，該列的某些欄位值成為下一個 PG function 的 input，回傳新的 `{ config, data }`，如此遞迴迭代，形成一個狀態機。

### 2.2 運作循環

```
使用者進入頁面
  → 前端呼叫 fn_ui_root()
  → PG 回傳 { config₁, data₁ }
  → React 渲染引擎根據 config₁.layout 選擇元件，填入 data₁
  → 使用者點擊表格中某一列
  → 從 config₁.row_drilldown.param_mapping 取出該列的欄位值
  → 呼叫 config₁.row_drilldown.fn(params)
  → PG 回傳 { config₂, data₂ }
  → React 渲染引擎根據 config₂.layout 選擇元件，填入 data₂
  → ... 無限遞迴
```

### 2.3 為什麼不是傳統的「前端路由 + 寫死頁面」

| 面向 | 傳統方式 | Config-Driven |
|------|----------|---------------|
| 新增頁面 | 寫新的 React component + route | 在 DB 新增一筆 config + 一個 PG function |
| 前端開發參與度 | 每頁都需要 | 只需維護渲染引擎（一次性） |
| AI Agent 整合 | 需要額外建 tool catalog | config 本身就是 tool catalog |
| 頁面間的資料傳遞 | 手動管理 state/URL params | config 的 param_mapping 自動處理 |
| 聚合/探勘 | 每個需求都要寫新頁面 | config 定義 group_by + agg_functions，前端或 PG 即時處理 |

---

## 第三章：Config 結構規格

### 3.1 頂層結構

每個 PG function 回傳的 JSON 遵循以下結構：

```jsonc
{
  "config": {
    "page_id": "string",           // 唯一識別碼，用於 breadcrumb 和 AI Agent 參考
    "title": "string",             // 頁面標題
    "subtitle": "string | null",   // 頁面副標題
    "layout": "string",            // 渲染引擎選擇哪個 layout component
    "columns": [],                 // 表格欄位定義（見 3.2）
    "filters": [],                 // 篩選條件定義（見 3.3）
    "row_drilldown": {},           // 列級 drill-down 定義（見 3.4）
    "aggregations": {},            // 聚合定義（見 3.5）
    "permissions": {}              // 權限定義，對接 Apache Ranger（見 3.6）
  },
  "data": []                       // 該頁面的資料，格式由 layout 決定
}
```

### 3.2 Column 定義

每一個 column 物件描述表格中的一欄：

```jsonc
{
  "key": "yield_pct",              // 對應 data 中的 key
  "label": "良率 %",               // 顯示名稱
  "sortable": true,                // 是否可排序（可選，預設 false）
  "align": "right",                // 對齊方式：left | center | right
  "render": "yield_bar"            // 特殊渲染器名稱（見 3.2.1）
}
```

#### 3.2.1 內建渲染器（Render Registry）

渲染引擎必須內建以下渲染器，並支援擴充：

| render 值 | 說明 | 範例 |
|-----------|------|------|
| `"phase_tag"` | 製程階段標籤，帶顏色 | CP Test（藍色 badge） |
| `"yield_bar"` | 良率進度條 + 數值 | ████░ 96.2% |
| `"status_badge"` | 狀態標籤 | 量產（綠）/ NPI（黃） |
| `"risk_indicator"` | 風險燈號 | ● High（紅） |
| `"trend_arrow"` | 趨勢箭頭 | ↑（綠）/ ↓（紅） |
| `"gate_badge"` | NPI Gate 階段標籤 | G3_EVT（藍色 badge） |
| `null` / 未指定 | 純文字顯示 | 直接 toString() |

### 3.3 Filter 定義

```jsonc
{
  "field": "platform",                           // 對應 data 中的 key
  "type": "select",                              // select | multi_select | date_range | text_search
  "options": ["All", "BGA-316", "TSOP-48"],      // select 類型的選項
  "default": "All"                               // 預設值
}
```

篩選邏輯：當 `type` 為 `"select"` 且值為 `"All"` 時不篩選；否則嚴格匹配 `row[field] === filterValue`。

### 3.4 Row Drilldown 定義 — 支援多參數

這是本架構的核心機制。定義「點擊表格中的一列時，如何組裝參數並呼叫下一個 PG function」。

```jsonc
{
  "fn": "fn_lot_full_context",        // 下一層要呼叫的 PG function 名稱
  "param_mapping": {
    "lot_id": "$row.lot_id",           // 取該列的 lot_id 欄位值
    "phase":  "$row.phase",            // 取該列的 phase 欄位值
    "grade":  "$row.grade",            // 取該列的 grade 欄位值
    "combo":  "$row.combo"             // 取該列的 combo 欄位值
  }
}
```

#### 3.4.1 param_mapping 語法規則

| 語法 | 說明 | 範例 |
|------|------|------|
| `"$row.xxx"` | 從被點擊的那一列取 `xxx` 欄位的值 | `"$row.lot_id"` → `"L-0891"` |
| 字面值 | 直接傳入固定值 | `"status": "active"` |
| `"$group_keys"` | （聚合模式專用）自動收集所有 group-by 欄位的值作為參數 | 見 3.5 |

#### 3.4.2 多參數的意義

單一參數只能做「往下一層鑽」；多參數能做「帶著完整上下文鑽」。

舉例：使用者在 lot 表格點擊了一列，前端不是只傳 `lot_id`，而是同時傳 `lot_id + phase + grade + combo` 四個值。下一層的 PG function 可以：

- 用 `lot_id` 查這個 lot 的歷程
- 用 `combo` 查同 combo 的其他 lot 做比較
- 用 `phase + grade` 查同 phase 同 grade 的統計數據

這讓「交叉參考」成為可能 — 一個頁面可以同時提供多個不同維度的 drill-down 按鈕，每個按鈕傳入不同的參數子集。

#### 3.4.3 後端對應的 PG Function 簽名

```sql
-- 單參數（舊模式）
CREATE OR REPLACE FUNCTION fn_combo_detail(p_combo_id TEXT)
RETURNS JSONB AS $$ ... $$;

-- 多參數（新模式）
CREATE OR REPLACE FUNCTION fn_lot_full_context(
    p_lot_id TEXT,
    p_phase  TEXT,
    p_grade  TEXT,
    p_combo  TEXT
) RETURNS JSONB AS $$ ... $$;
```

前端呼叫 API 時傳入的 JSON：

```jsonc
POST /api/config-exec
{
  "fn": "fn_lot_full_context",
  "params": {
    "lot_id": "L-0891",
    "phase": "CP_Test",
    "grade": "A",
    "combo": "PS5021-E21T"
  }
}
```

後端收到後執行：

```sql
SELECT fn_lot_full_context(
    p_lot_id := 'L-0891',
    p_phase  := 'CP_Test',
    p_grade  := 'A',
    p_combo  := 'PS5021-E21T'
);
```

### 3.5 Aggregation 定義 — 動態 GROUP BY

這是資料探勘的關鍵能力。使用者可以在前端動態選擇要按哪些欄位做分組，以及要用哪些聚合函數。

```jsonc
{
  "aggregations": {
    "group_by_options": [
      { "key": "phase",    "label": "Phase" },
      { "key": "grade",    "label": "Grade" },
      { "key": "combo",    "label": "Product Combo" },
      { "key": "platform", "label": "Platform" },
      { "key": "week",     "label": "Week" }
    ],
    "agg_functions": [
      { "field": "qty",       "fn": "SUM",   "label": "總數量" },
      { "field": "qty",       "fn": "AVG",   "label": "平均數量" },
      { "field": "qty",       "fn": "COUNT", "label": "批次數" },
      { "field": "yield_pct", "fn": "AVG",   "label": "平均良率" },
      { "field": "yield_pct", "fn": "MIN",   "label": "最低良率" },
      { "field": "yield_pct", "fn": "MAX",   "label": "最高良率" }
    ],
    "drilldown": {
      "fn": "fn_lot_agg_detail",
      "param_mapping": "$group_keys"
    }
  }
}
```

#### 3.5.1 聚合的兩種執行模式

**模式 A：前端即時聚合**（適用於資料量 < 10,000 筆）

PG function 回傳原始明細資料，前端 JavaScript 執行 GROUP BY + AGG。好處是使用者切換 group-by 欄位時不需要重新呼叫 API，體驗流暢。

**模式 B：PG function 聚合**（適用於資料量 > 10,000 筆）

前端把使用者選擇的 group-by 欄位和 agg 函數送到後端，PG function 執行聚合後回傳結果。

```sql
-- 模式 B: 後端動態聚合
CREATE OR REPLACE FUNCTION fn_lot_agg(
    p_group_by TEXT[],        -- ['phase', 'grade']
    p_agg_defs JSONB,         -- [{"field":"qty","fn":"SUM"}, ...]
    p_filters  JSONB DEFAULT '{}'
) RETURNS JSONB AS $$
DECLARE
    v_sql TEXT;
    v_result JSONB;
BEGIN
    -- 動態組裝 SQL
    v_sql := format(
        'SELECT %s, %s FROM lots WHERE 1=1 %s GROUP BY %s',
        array_to_string(p_group_by, ', '),
        -- 動態組裝 agg expressions from p_agg_defs
        ...,
        -- 動態組裝 WHERE from p_filters
        ...,
        array_to_string(p_group_by, ', ')
    );
    EXECUTE v_sql INTO v_result;
    RETURN v_result;
END;
$$ LANGUAGE plpgsql;
```

#### 3.5.2 聚合後的 Drill-Down

當 `param_mapping` 設為 `"$group_keys"` 時，前端自動收集使用者選擇的 group-by 欄位在被點擊那一列的值作為參數。

舉例：使用者選了 GROUP BY `phase` + `grade`，表格顯示：

| Phase | Grade | SUM(qty) | AVG(yield) |
|-------|-------|----------|------------|
| CP_Test | A | 5000 | 96.2 |
| CP_Test | B | 10500 | 86.7 |

使用者點擊第二列，前端自動組裝：

```jsonc
{
  "fn": "fn_lot_agg_detail",
  "params": { "phase": "CP_Test", "grade": "B" }
}
```

下一層的 PG function 就用 `WHERE phase='CP_Test' AND grade='B'` 回傳明細。

#### 3.5.3 支援的聚合函數

| fn | SQL 對應 | 說明 |
|----|----------|------|
| `"SUM"` | `SUM(field)` | 加總 |
| `"AVG"` | `AVG(field)` | 平均（前端保留 2 位小數） |
| `"COUNT"` | `COUNT(*)` | 計數 |
| `"MIN"` | `MIN(field)` | 最小值 |
| `"MAX"` | `MAX(field)` | 最大值 |

未來可擴充：`MEDIAN`、`STDDEV`、`PERCENTILE`。

#### 3.5.4 SQL Preview

當聚合模式啟動時，前端應該在工具列下方顯示對應的 SQL 語句（唯讀），讓使用者理解「這個操作等同於什麼 SQL」。這同時也是 AI Agent 的 reasoning trace。

```
SELECT phase, grade, SUM(qty), AVG(yield_pct) FROM lots WHERE platform='BGA-316' GROUP BY phase, grade
```

### 3.6 Permissions 定義（對接 Apache Ranger）

```jsonc
{
  "permissions": {
    "page_access": "MFG_READ",           // LDAP group，有此 group 才能看到此頁面
    "column_mask": {
      "yield_pct": {
        "policy": "MASK_SHOW_LAST_4",
        "except_groups": ["QA_ADMIN"]     // QA_ADMIN 可以看到完整值
      }
    },
    "row_filter": "fn_row_filter_by_dept" // PG function，依使用者部門過濾可見資料
  }
}
```

此定義在前端作為 UI 控制（隱藏頁面、遮蔽欄位），在後端由 Apache Ranger 做強制執行。兩層一致，不存在只靠前端的安全假象。

---

## 第四章：Layout 類型規格

渲染引擎的核心是一個 layout registry — 根據 `config.layout` 的值選擇對應的 React component。

### 4.1 已定義的 Layout 類型

| layout 值 | 說明 | 使用場景 |
|-----------|------|----------|
| `"card_grid"` | 卡片式宮格 | 首頁、入口頁，每張卡片一個 drilldown |
| `"table"` | 標準資料表格 | 明細頁、列表頁 |
| `"agg_table"` | 帶聚合工具列的表格 | 探勘頁，支援動態 GROUP BY |
| `"split"` | 左右分割：左表格 + 右圖表 | 主從式頁面（master-detail） |
| `"timeline"` | 時間軸 | lot 歷程、事件追蹤 |
| `"context_panel"` | 多參數接收展示 + 交叉參考按鈕 | 全維度上下文頁 |
| `"ai_report"` | AI Agent 分析報告 | AI 診斷結果展示 |

### 4.2 各 Layout 的 config 結構

#### card_grid

```jsonc
{
  "layout": "card_grid",
  "components": [
    {
      "type": "metric_card",
      "label": "產品線總覽",
      "icon": "□",
      "value": "12 Product Lines",
      "drilldown": { "fn": "fn_product_lines", "params": {} }
    }
  ]
}
```

#### table

使用頂層 `columns`、`filters`、`row_drilldown`。

#### agg_table

在 `table` 的基礎上增加 `aggregations` 區塊（見 3.5）。同時保留 `row_drilldown`（原始資料模式的 drill-down）和 `aggregations.drilldown`（聚合模式的 drill-down）。

#### split

```jsonc
{
  "layout": "split",
  "left": {
    "type": "table",
    "columns": [...],
    "row_drilldown": { ... }
  },
  "right": {
    "type": "chart_stack",
    "charts": [
      { "kind": "bar",  "title": "各 Phase 分布", "data_key": "phase_distribution" },
      { "kind": "line", "title": "良率趨勢",      "data_key": "yield_trend" }
    ]
  }
}
```

#### timeline

使用 `columns` 定義欄位，data 為事件陣列。可附帶 `ai_insight` 按鈕觸發 AI 分析。

```jsonc
{
  "layout": "timeline",
  "columns": [...],
  "ai_insight": {
    "fn": "fn_ai_lot_analysis",
    "param_mapping": { "lot_id": "L-0891" },
    "label": "🤖 AI Agent 分析此批次"
  }
}
```

#### context_panel

專為「接收多參數後展示全維度上下文」設計。data 結構包含：

```jsonc
{
  "params_received": { "lot_id": "...", "phase": "...", "grade": "...", "combo": "..." },
  "timeline": [...],
  "cross_ref": [
    { "label": "同 Combo 其他批次",      "fn": "fn_lot_agg_detail", "params": { "combo": "PS5021-E21T" } },
    { "label": "同 Phase + 同 Grade",   "fn": "fn_lot_agg_detail", "params": { "phase": "CP_Test", "grade": "B" } },
    { "label": "同 Phase 所有 Grade",    "fn": "fn_lot_agg_detail", "params": { "phase": "CP_Test" } }
  ]
}
```

每個 `cross_ref` 項目都是一個可點擊的按鈕，傳入不同的參數組合做交叉探勘。

#### ai_report

AI Agent 回傳的分析結果展示：

```jsonc
{
  "summary": "批次 L-0891 在 CP Test 階段 Bin2 比例偏高 ...",
  "findings": [
    { "severity": "warning",  "text": "Bin2 佔比 11.6% — 高於 UCL 8.0%" },
    { "severity": "critical", "text": "建議檢查 CP_v3.2.1 的 Vmin 參數" }
  ],
  "recommendation": "建議 Hold 此批次 ...",
  "confidence": 0.87,
  "next_actions": [
    { "label": "發起 Hold 通知", "fn": "fn_action_hold", "params": { "lot_id": "L-0891" } },
    { "label": "查看同 Wafer Lot",  "fn": "fn_combo_detail", "params": { "combo_id": "C001" } }
  ]
}
```

---

## 第五章：前端渲染引擎架構

### 5.1 整體結構

```
<ConfigDrilldownEngine>
  ├── NavigationBar          // ⌂ Home, ← Back, Breadcrumb, Depth indicator
  ├── SqlTraceBar            // 顯示當前 PG function 呼叫語句
  ├── ContentArea
  │   ├── PageHeader         // title + subtitle
  │   └── LayoutRouter       // 根據 config.layout 選擇 component
  │       ├── CardGrid
  │       ├── DataTable
  │       ├── AggTable
  │       ├── SplitLayout
  │       ├── TimelineLayout
  │       ├── ContextPanel
  │       └── AIReport
  └── FooterBar              // 架構標籤 + Depth level
```

### 5.2 狀態管理：Stack 模型

前端維護一個 drill-down stack：

```typescript
type StackEntry = {
  fn: string;              // 呼叫的 PG function 名稱
  params: Record<string, string>;  // 傳入的參數
  config: PageConfig;      // 回傳的 config
  data: any;               // 回傳的 data
};

const [stack, setStack] = useState<StackEntry[]>([]);
```

- **Drill-down**：push 新的 entry 到 stack
- **Back**：pop 最後一個 entry
- **Home**：清空 stack，只留 root
- **Breadcrumb 點擊**：slice stack 到被點擊的位置

### 5.3 參數解析引擎

這是 drill-down 機制的核心邏輯。當使用者點擊一列時：

```typescript
function resolveParams(
    paramMapping: Record<string, string>,
    row: Record<string, any>,
    groupByKeys?: string[]
): Record<string, string> {
    // 情況 1: $group_keys — 聚合模式，自動收集 group-by 欄位的值
    if (paramMapping === "$group_keys") {
        const params: Record<string, string> = {};
        groupByKeys.forEach(k => { params[k] = String(row[k]); });
        return params;
    }

    // 情況 2: 明確的 key-value mapping
    const params: Record<string, string> = {};
    for (const [paramName, source] of Object.entries(paramMapping)) {
        if (typeof source === "string" && source.startsWith("$row.")) {
            // 從被點擊的列取值
            params[paramName] = String(row[source.slice(5)]);
        } else {
            // 字面值
            params[paramName] = String(source);
        }
    }
    return params;
}
```

### 5.4 API 呼叫層

所有前端對後端的呼叫都走同一個 endpoint：

```typescript
// 唯一的 API endpoint
async function callConfigExec(fn: string, params: Record<string, string>) {
    const response = await fetch("/api/config-exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fn, params })
    });
    return response.json(); // { config, data }
}
```

後端收到後：

1. 檢查 Casbin 權限：使用者是否有權呼叫此 function
2. 從 `fn` 對應到 PG function 名稱（白名單校驗）
3. 執行 `SELECT fn(p1 := ..., p2 := ..., ...)`
4. 回傳 `{ config, data }`

### 5.5 聚合工具列 UI

AggTable layout 在表格上方顯示一個工具列，包含：

1. **GROUP BY 選擇器**：根據 `config.aggregations.group_by_options` 渲染多選按鈕
2. **聚合函數選擇器**：根據 `config.aggregations.agg_functions` 渲染多選按鈕
3. **WHERE 篩選器**：根據 `config.filters` 渲染
4. **SQL Preview**：唯讀顯示當前聚合對應的 SQL 語句

當 GROUP BY 和聚合函數都有選取時，表格從原始資料模式切換為聚合模式：
- 欄位動態變成 group-by 欄位 + 筆數 + 聚合結果欄位
- 列的 drill-down 改用 `aggregations.drilldown`，以 `$group_keys` 語法自動收集參數

---

## 第六章：後端 PG Function 規範

### 6.1 設計原則

遵循專案既有架構約束：

1. **PG function 是唯一的業務邏輯層** — 前端和 API 層不包含業務邏輯
2. **每個 function 回傳 JSONB** — 包含 `config` + `data` 兩個頂層 key
3. **READ 與 WRITE 分離** — 本文件的 function 全部是 READ-only
4. **Producer/Consumer 清晰定義** — 每個 function 標註它消費哪些表

### 6.2 Function 命名慣例

| 前綴 | 用途 | 範例 |
|------|------|------|
| `fn_ui_` | UI 頁面 config+data 提供者 | `fn_ui_root`, `fn_ui_lot_explorer` |
| `fn_agg_` | 聚合查詢 | `fn_agg_lot_by_phase_grade` |
| `fn_detail_` | 明細查詢 | `fn_detail_lot_history` |
| `fn_ctx_` | 上下文查詢（多參數） | `fn_ctx_lot_full` |
| `fn_ai_` | AI Agent 分析入口 | `fn_ai_lot_analysis` |

### 6.3 範例 Function

```sql
CREATE OR REPLACE FUNCTION fn_ui_lot_explorer()
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN jsonb_build_object(
        'config', jsonb_build_object(
            'page_id', 'lot_explorer',
            'title', 'Lot 探勘引擎',
            'layout', 'agg_table',
            'columns', jsonb_build_array(
                jsonb_build_object('key', 'lot_id', 'label', 'Lot ID'),
                jsonb_build_object('key', 'phase',  'label', 'Phase', 'render', 'phase_tag'),
                jsonb_build_object('key', 'grade',  'label', 'Grade'),
                jsonb_build_object('key', 'qty',    'label', 'Qty', 'align', 'right'),
                jsonb_build_object('key', 'yield_pct', 'label', 'Yield %', 'align', 'right', 'render', 'yield_bar')
            ),
            'aggregations', jsonb_build_object(
                'group_by_options', jsonb_build_array(
                    jsonb_build_object('key', 'phase', 'label', 'Phase'),
                    jsonb_build_object('key', 'grade', 'label', 'Grade')
                ),
                'agg_functions', jsonb_build_array(
                    jsonb_build_object('field', 'qty', 'fn', 'SUM', 'label', '總數量'),
                    jsonb_build_object('field', 'yield_pct', 'fn', 'AVG', 'label', '平均良率')
                ),
                'drilldown', jsonb_build_object(
                    'fn', 'fn_detail_lot_by_filter',
                    'param_mapping', '$group_keys'
                )
            ),
            'row_drilldown', jsonb_build_object(
                'fn', 'fn_ctx_lot_full',
                'param_mapping', jsonb_build_object(
                    'lot_id', '$row.lot_id',
                    'phase',  '$row.phase',
                    'grade',  '$row.grade',
                    'combo',  '$row.combo'
                )
            )
        ),
        'data', (
            SELECT jsonb_agg(row_to_json(t))
            FROM (
                SELECT lot_id, combo, phase, grade, qty, yield_pct, platform, week
                FROM lots
                ORDER BY updated_at DESC
                LIMIT 1000
            ) t
        )
    );
END;
$$;
```

---

## 第七章：AI Agent 整合藍圖

### 7.1 Config 即 Tool Catalog

AI Agent 不需要另外維護 tool 定義。它只需要：

1. 呼叫 `fn_ui_root()` 取得首頁 config
2. 解析 `config.components[].drilldown` 得知有哪些 function 可以呼叫
3. 對每個 function 解析其 `param_mapping` 得知需要什麼參數
4. 遞迴解析每一層的 config 得知完整的探勘路徑圖

### 7.2 Agent 的決策流程

```
使用者問：「PS5021 的 CP Test 良率最近是不是在下降？」

Agent 思考：
  1. 從 fn_ui_root → 找到 fn_yield_dashboard
  2. 從 yield_dashboard 的 data 找到 PS5021 → combo_id = C001
  3. 用 row_drilldown 呼叫 fn_combo_detail(combo_id='C001', platform='BGA-316')
  4. 從回傳的 yield_trend 數據判斷趨勢
  5. 如果需要更深入，用 fn_lot_full_context 帶入多參數查看個別 lot
  6. 組合所有資訊回答使用者
```

### 7.3 Agent 的聚合能力

Agent 也可以讀取 `aggregations` config 來決定如何做資料分析：

```
使用者問：「哪個 Grade 的良率最差？按 platform 分開看」

Agent 思考：
  1. 從 fn_lot_explorer 取得 aggregation config
  2. 選擇 group_by: ["grade", "platform"]
  3. 選擇 agg: AVG(yield_pct), MIN(yield_pct)
  4. 呼叫後端或前端聚合
  5. 排序結果，找到最差的
  6. 用 $group_keys drill-down 到明細確認
```

---

## 第八章：實作優先順序

### Phase 1：最小可行引擎

1. 實作 `/api/config-exec` endpoint（白名單 + Casbin 檢查 + PG function 呼叫）
2. 實作 React 渲染引擎（LayoutRouter + DataTable + CardGrid）
3. 實作 `param_mapping` 解析器（支援 `$row.xxx` 多參數）
4. 實作 Stack 導航（drill-down / back / home / breadcrumb）
5. 建立 3~5 個 PG function 作為 seed data

### Phase 2：聚合探勘

6. 實作 AggTable layout + 聚合工具列 UI
7. 實作前端即時聚合引擎（AGG_FNS）
8. 實作 `$group_keys` 參數收集
9. 實作 SQL Preview 顯示
10. 實作 PG 端動態聚合 function（大數據量場景）

### Phase 3：進階 Layout

11. 實作 SplitLayout（左表格 + 右圖表）
12. 實作 TimelineLayout
13. 實作 ContextPanel（多參數展示 + 交叉參考）
14. 實作 AIReport layout

### Phase 4：AI Agent 整合

15. 實作 Agent tool catalog 自動生成（從 config 提取）
16. 實作 Agent 聚合決策（讀取 aggregations config）
17. 實作 Agent reasoning trace（SQL Preview 作為 chain-of-thought）

---

## 第九章：與現有架構的整合點

| 現有架構元件 | 整合方式 |
|------------|---------|
| AuthZ v2.3 / Casbin RBAC+ABAC | `/api/config-exec` 在執行 PG function 前檢查 Casbin policy |
| 3-path SSOT (Config-SM / Trad Web / DB Direct) | Config-Driven UI 走 Config-SM path |
| 4-layer 粒度 (L0-L3) | config 的 drill-down stack depth 自然對應 L0→L3 |
| Apache Ranger | config.permissions 對接 Ranger policy，column mask + row filter |
| PG LISTEN/NOTIFY | config 或 data 變更時觸發 NOTIFY，前端收到後自動重新拉取當前頁面 |
| Redis L1 + Session L2 cache | 高頻頁面（如 fn_ui_root）的回傳結果快取在 Redis |
| K8s Helm (nexus-platform) | 渲染引擎和 API 作為 nexus-platform 的一個 service 部署 |
| Monorepo (Nx/Turborepo) | 渲染引擎放 `@nexus/config-ui-engine`，PG functions 放 `@nexus/db-functions` |

---

## 第十章：關鍵設計約束（給 AI 開發模型的提醒）

1. **PG function 是唯一的業務邏輯層**。前端和 API 層不做業務判斷，只做 config 解析和渲染。
2. **READ 和 WRITE 分離**。本文件所有 function 都是 READ-only。WRITE 操作（如 fn_action_hold）走另一套流程。
3. **config 回傳必須自描述**。每個 PG function 回傳的 config 必須包含足夠的資訊讓渲染引擎和 AI Agent 不需要額外 metadata 就能運作。
4. **多參數是常態，不是例外**。設計新的 drill-down 時，預設傳入足夠的上下文（3~5 個參數），而不是只傳主鍵。
5. **聚合定義在 config 裡**。不需要為每個聚合需求寫新的 function，而是透過 config 的 `aggregations` 區塊讓同一份資料支援多種聚合視角。
6. **權限雙層執行**。前端根據 config.permissions 做 UI 控制，後端由 Casbin + Ranger 做強制執行。
7. **產出要求是 production-ready**。不是 sketch 或 placeholder，而是可以直接跑的程式碼。
8. **單一檔案偏好**。盡量把相關的 SQL 放在一個檔案、React 放在一個檔案，不碎片化。
