# Phison Data Nexus — Data Mining Engine 執行計畫

## 文件資訊

| 項目 | 說明 |
|------|------|
| 專案代號 | phison-data-nexus |
| 版本 | v1.0 |
| 建立日期 | 2026-04-15 |
| 文件定位 | **可立即執行的最小可行方案（Thin Slice）**，驗證核心假設後再擴展 |
| 長期願景 | [`design-data-mining-vision.md`](design-data-mining-vision.md)（完整設計 + 觸發條件） |
| 前提假設 | 讀者已理解 Config-SM 架構（V022）、三路徑 SSOT、authz_resolve() 權限引擎 |

---

## 目錄

1. [策略：為什麼先做最小切片](#第一章策略為什麼先做最小切片)
2. [Phase 0：Custom SQL Function 支援](#第二章phase-0custom-sql-function-支援)
3. [Phase 0.5：前端聚合模式](#第三章phase-05前端聚合模式)
4. [DB Schema](#第四章db-schema)
5. [API 變更](#第五章api-變更)
6. [實作檢查清單](#第六章實作檢查清單)
7. [維運與監控](#第七章維運與監控)
8. [觀察指標與升級觸發](#第八章觀察指標與升級觸發)

---

## 第一章：策略 — 為什麼先做最小切片

### 1.1 現狀

- Milestone 4（Production-Ready）尚有 4 項未完成（Redis cache、Helm、Policy Simulator、LDAP CronJob）
- Config-SM 引擎已運作（V022 `authz_ui_page` + `fn_ui_page` / `fn_ui_root` + ConfigEngine.tsx）
- 現有 8 個 page config，全部走 `data_table` 模式（`buildMaskedSelect` 直接查表）
- **真實使用者數量：0。** 所有 UX 假設未經驗證

### 1.2 核心假設

整個 Data Mining Engine 的價值建立在一個假設上：

> **Custom SQL function + Config-SM 渲染 = 使用者願意用的資料探勘工具**

如果這個假設不成立（使用者偏好 Metabase、偏好 Excel、偏好直接寫 SQL），後續的 AI 輔助、探勘鏈、快捷流程全部沒有意義。

### 1.3 Thin Slice 策略

**只做能驗證核心假設的最小功能，其餘延後。**

```
Thin Slice（本文件，3-5 天）
├── Phase 0：data_fn 欄位 + config-exec 分支（1-2 天）
│   驗證：custom SQL function 在 Config-SM 中能正常渲染
└── Phase 0.5：agg_table 前端聚合（2-3 天）
    驗證：使用者需要動態 GROUP BY 嗎？

長期願景（design-data-mining-vision.md，觸發後再做）
├── Template 生命週期、版本控制
├── AI 輔助 SQL function 產生
├── 自由鏈式探勘
├── 後端動態聚合
├── 探勘軌跡持久化
└── 快捷流程
```

### 1.4 什麼時候砍掉什麼

| 砍掉的功能 | 為什麼現在不做 | 什麼條件下加回來 |
|-----------|--------------|---------------|
| Template 生命週期 | 8 個 template 不需要版本控制 | Template > 25 且出過改錯事件 |
| AI 輔助 SQL 產生 | 地端模型未部署，Admin 手寫更可靠 | 模型部署完成 + Admin 反映手寫是瓶頸 |
| 自由鏈（User 勾選匹配） | UX 假設未驗證，固定鏈覆蓋 80% | 收到 ≥ 3 次「沒有預設路徑可跳」反饋 |
| 探勘軌跡儲存 | Navigation Stack breadcrumb 已夠用 | Admin 需要分析使用者探勘模式 |
| 快捷流程 | 0 使用者不需要快捷方式 | 觀察到使用者重複走同路徑 ≥ 3 次/週 |
| `authz_data_fn` 註冊表 | Admin 直接在 PG 管理 function 更簡單 | Function 數量 > 15 且需集中管理 |
| 後端動態聚合 API | 資料量 < 10K，前端 JS 夠快 | 實際 table > 10K 筆且前端卡頓 |

---

## 第二章：Phase 0 — Custom SQL Function 支援

### 2.1 目標

讓 Admin 可以手寫一個 PG function，綁定到 `authz_ui_page`，Config-SM 引擎執行它並渲染結果。

**不需要**：function 註冊表、驗證規則、AI 產生、生命週期。Admin 直接 `CREATE FUNCTION` 到 PG，在 `authz_ui_page` 填 function 名稱。

### 2.2 DB 變更

在 `authz_ui_page` 新增一個欄位：

```sql
-- V032__data_fn_support.sql
ALTER TABLE authz_ui_page ADD COLUMN data_fn TEXT;
-- NULL = 走現有 data_table + buildMaskedSelect 路徑（向後相容）
-- 非 NULL = 執行 SELECT {data_fn}(params) 取得 {config, data}
COMMENT ON COLUMN authz_ui_page.data_fn IS
  'Custom PG function name. When set, config-exec calls this function instead of buildMaskedSelect.';
```

**一個 ALTER TABLE，沒有新表。** 現有 8 個 page config 的 `data_fn` 為 NULL，行為不變。

### 2.3 SQL Function 規範

Admin 手寫的 function 必須遵循以下規範：

```sql
-- 命名：fn_{業務描述}，例如 fn_yield_trend_weekly
-- 回傳：JSONB，格式為 { "config": {...}, "data": [...] }
-- 特性：STABLE（無副作用）、SECURITY DEFINER

CREATE OR REPLACE FUNCTION fn_yield_trend_weekly(
    p_product_line TEXT DEFAULT NULL,
    p_grade        TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_config JSONB;
    v_data   JSONB;
BEGIN
    -- config 定義 UI 渲染方式
    v_config := jsonb_build_object(
        'page_id',    'yield_trend_weekly',
        'title',      '每週良率趨勢',
        'layout',     'table',
        'columns',    jsonb_build_array(
            jsonb_build_object('key', 'product_line', 'label', '產品線', 'sortable', true),
            jsonb_build_object('key', 'week',         'label', '週次',   'sortable', true),
            jsonb_build_object('key', 'avg_yield',    'label', '平均良率', 'render', 'yield_bar',
                               'sortable', true, 'align', 'right'),
            jsonb_build_object('key', 'lot_count',    'label', '批次數', 'align', 'right')
        ),
        'filters', jsonb_build_array(
            jsonb_build_object('field', 'product_line', 'type', 'select')
        ),
        'row_drilldown', jsonb_build_object(
            'page_id', 'lot_explorer',
            'param_mapping', jsonb_build_object(
                'product_line', '$row.product_line',
                'week',         '$row.week'
            )
        )
    );

    -- data 查詢
    SELECT jsonb_agg(r ORDER BY r->>'product_line', r->>'week' DESC)
    INTO v_data
    FROM (
        SELECT jsonb_build_object(
            'product_line', product_line,
            'week',         to_char(date_trunc('week', created_at), 'IYYY-IW'),
            'avg_yield',    round(avg(yield_pct)::numeric, 2),
            'lot_count',    count(*)
        ) AS r
        FROM lot_status
        WHERE (p_product_line IS NULL OR product_line = p_product_line)
          AND (p_grade IS NULL OR grade = p_grade)
        GROUP BY product_line, date_trunc('week', created_at)
    ) sub;

    RETURN jsonb_build_object(
        'config', v_config,
        'data',   COALESCE(v_data, '[]'::jsonb)
    );
END;
$$;
```

**Admin 寫好後**，只需在 `authz_ui_page` 新增一筆記錄：

```sql
INSERT INTO authz_ui_page (page_id, title, layout, data_fn, resource_id, icon, description, display_order)
VALUES ('yield_trend_weekly', '每週良率趨勢', 'table',
        'fn_yield_trend_weekly',               -- 綁定 function
        'module:mrp.lot_tracking',             -- 權限控制
        'trending-up', '按產品線與週次統計平均良率', 20);
```

### 2.4 config-exec 後端變更

在現有 `config-exec.ts` 加一個分支（約 30 行）：

```typescript
// POST /api/config-exec — 新增 data_fn 分支

// 現有：取得 page config
const pageConfig = await getPageConfig(pageId);

// 現有：權限檢查
if (pageConfig.resource_id) {
  const allowed = await authzCheck(userId, groups, 'read', pageConfig.resource_id);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
}

let result;

if (pageConfig.data_fn) {
  // ===== 新增：custom SQL function 模式 =====

  // 1. 白名單驗證 function 名稱格式
  if (!/^fn_[a-z][a-z0-9_]*$/.test(pageConfig.data_fn)) {
    return res.status(400).json({ error: 'Invalid function name' });
  }

  // 2. 組裝 named parameters
  const paramEntries = Object.entries(params || {});
  const paramPlaceholders = paramEntries.map((_, i) =>
    `p_${paramEntries[i][0]} := $${i + 1}`
  ).join(', ');
  const sql = `SELECT ${pageConfig.data_fn}(${paramPlaceholders}) AS result`;

  // 3. 執行
  const { rows } = await pool.query(sql, paramEntries.map(([, v]) => v));
  const fnResult = rows[0]?.result;

  // 4. data_fn 回傳的 config 可覆寫 page config 的部分欄位
  result = {
    config: { ...pageConfig, ...fnResult?.config },
    data: fnResult?.data || [],
    meta: { source: 'data_fn', fn: pageConfig.data_fn }
  };

} else if (pageConfig.data_table) {
  // ===== 現有：table 直接查詢模式 =====
  result = await buildMaskedSelect({ /* 現有邏輯不變 */ });

} else {
  // ===== 現有：card_grid 無資料模式 =====
  result = { config: pageConfig, data: [] };
}

return res.json(result);
```

### 2.5 前端變更

**零。** ConfigEngine.tsx 不需要改動。

原因：`data_fn` 模式回傳的 `{config, data}` 與現有 `data_table` 模式的回傳格式完全相同。ConfigEngine 只看 `config.layout` 決定渲染方式，不關心資料來源是 `buildMaskedSelect` 還是 custom function。

### 2.6 驗證方式

1. 手寫 2-3 個 SQL function（良率趨勢、product combo 統計、跨表 JOIN 查詢）
2. 在 `authz_ui_page` 綁定，設定 `data_fn`
3. 在 ConfigEngine 中確認：卡片出現 → 點入 → 表格正常渲染 → drilldown 正常
4. 確認權限控制：無權限的使用者看不到卡片 / 進不去頁面

---

## 第三章：Phase 0.5 — 前端聚合模式

### 3.1 目標

在 ConfigEngine 中增加 `agg_table` layout，使用者可以動態選擇 GROUP BY 欄位和聚合函數。**全部在前端用 JavaScript 計算，不需要後端 API。**

### 3.2 觸發方式

Template 的 `agg_config`（存在 `authz_ui_page` 的現有 JSONB 欄位 `columns_override` 中，或另用 `filters_config`）定義可用的聚合選項：

```jsonc
// authz_ui_page.filters_config 擴展（或 columns_override 中新增 agg 區塊）
{
  "aggregations": {
    "group_by_options": [
      { "key": "product_line", "label": "產品線" },
      { "key": "grade",        "label": "等級" },
      { "key": "phase",        "label": "製程階段" }
    ],
    "agg_functions": [
      { "field": "qty",       "fn": "SUM",   "label": "總數量" },
      { "field": "qty",       "fn": "COUNT", "label": "批次數" },
      { "field": "yield_pct", "fn": "AVG",   "label": "平均良率" },
      { "field": "yield_pct", "fn": "MIN",   "label": "最低良率" },
      { "field": "yield_pct", "fn": "MAX",   "label": "最高良率" }
    ]
  }
}
```

### 3.3 前端實作

在 ConfigEngine.tsx 中：

1. **偵測**：當 `config.aggregations` 或 page config 帶有 agg 定義時，工具列顯示「聚合」按鈕
2. **選擇**：使用者勾選 GROUP BY 欄位 + 聚合函數
3. **計算**：在 browser memory 中對 `data[]` 做 JavaScript GROUP BY + AGG
4. **渲染**：聚合結果用現有的 DataTable component 顯示
5. **鑽取**：聚合模式下點擊行，自動用 `$group_keys` 收集 group-by 值作為 drilldown params

```typescript
// 前端聚合核心邏輯（約 40 行）
function aggregateData(
  data: Record<string, unknown>[],
  groupBy: string[],
  aggFns: { field: string; fn: string; label: string }[]
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();

  // 1. 分組
  for (const row of data) {
    const key = groupBy.map(k => String(row[k] ?? '')).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  // 2. 聚合
  return Array.from(groups.entries()).map(([, rows]) => {
    const result: Record<string, unknown> = {};
    // group-by 欄位值
    for (const k of groupBy) result[k] = rows[0][k];
    // 聚合值
    for (const agg of aggFns) {
      const vals = rows.map(r => Number(r[agg.field]) || 0);
      const alias = `${agg.fn.toLowerCase()}_${agg.field}`;
      switch (agg.fn) {
        case 'SUM':   result[alias] = vals.reduce((a, b) => a + b, 0); break;
        case 'AVG':   result[alias] = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2); break;
        case 'COUNT': result[alias] = rows.length; break;
        case 'MIN':   result[alias] = Math.min(...vals); break;
        case 'MAX':   result[alias] = Math.max(...vals); break;
      }
    }
    return result;
  });
}
```

### 3.4 UI 呈現

```
┌──────────────────────────────────────────────────────────────┐
│  Lot Status Explorer                                          │
├──────────────────────────────────────────────────────────────┤
│  [篩選 ▾]  [聚合 ▾]                                          │
│  ┌── 聚合設定 ──────────────────────────────────────────────┐│
│  │ 分組：[✓ 產品線] [✓ 等級] [  製程]                       ││
│  │ 計算：[✓ 總數量] [✓ 平均良率] [  最低良率]               ││
│  │ [套用]                                                   ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌──────────────┬───────┬──────────┬────────────┐           │
│  │ product_line │ grade │ 總數量    │ 平均良率    │           │
│  ├──────────────┼───────┼──────────┼────────────┤           │
│  │ SSD          │ A     │ 12,500   │ ████░ 95.3 │           │
│  │ SSD          │ B     │  8,200   │ ███░░ 87.1 │           │
│  │ eMMC         │ A     │  6,800   │ ████░ 93.8 │           │
│  └──────────────┴───────┴──────────┴────────────┘           │
│                                                              │
│  4 組（原始 1,200 筆）                  [取消聚合] [匯出 CSV] │
└──────────────────────────────────────────────────────────────┘
```

### 3.5 不做的事

- **不做後端聚合 API**（`fn_dynamic_aggregate`）— 目前 `row_limit` 預設 1000，前端算 1000 筆聚合是毫秒級
- **不做 SQL Preview** — 先讓功能可用，SQL 預覽是錦上添花
- **不做 `agg_table` 專屬 layout** — 直接在現有 `table` layout 上加聚合工具列，減少新增 component

### 3.6 ConfigEngine 拆分建議

ConfigEngine.tsx 目前 643 行。新增聚合功能前，建議先拆分：

```
ConfigEngine.tsx (643 行)
  ↓ 拆分
ConfigEngine.tsx (~150 行，主框架 + 路由)
  ├── components/CardGrid.tsx   (~80 行)
  ├── components/DataTable.tsx  (~200 行)
  ├── components/FilterBar.tsx  (~60 行)
  ├── components/AggPanel.tsx   (~80 行，新增)
  ├── components/NavBar.tsx     (~50 行)
  └── lib/aggregation.ts        (~40 行，新增)
```

這不是額外工作，是**在加功能之前讓程式碼可維護的必要步驟**。

---

## 第四章：DB Schema

### 4.1 唯一的 migration：V032

```sql
-- V032__data_fn_support.sql
-- 在 authz_ui_page 上新增 data_fn 欄位
-- 支援 custom SQL function 綁定

ALTER TABLE authz_ui_page ADD COLUMN IF NOT EXISTS data_fn TEXT;

COMMENT ON COLUMN authz_ui_page.data_fn IS
  'Custom PG function name (e.g. fn_yield_trend_weekly). '
  'When set, /api/config-exec calls this function instead of buildMaskedSelect. '
  'Function must return JSONB with {config, data} structure. '
  'NULL = use existing data_table + buildMaskedSelect path (backward compatible).';
```

**就這樣。一個 ALTER TABLE，沒有新表。**

### 4.2 不建立的表（以及為什麼）

| 不建的表 | 原因 | 什麼時候建 |
|---------|------|---------|
| `authz_data_fn`（function 註冊表） | Admin 直接在 PG 管理 function，`\df fn_*` 就能列出 | Function > 15 個且需要集中管理元數據時 |
| `authz_exploration_trail`（軌跡表） | 前端 Navigation Stack 已提供 breadcrumb | Admin 需要分析使用者行為模式時 |
| `authz_shortcut_flow`（快捷流程表） | 無真實使用者，無法觀察重複模式 | 觀察到重複探勘路徑時 |

---

## 第五章：API 變更

### 5.1 修改的端點（1 個）

**POST `/api/config-exec`** — 新增 `data_fn` 分支

```
現有流程：
  page_id → fn_ui_page() → config
  config.data_table → buildMaskedSelect() → data

新增分支：
  page_id → fn_ui_page() → config
  config.data_fn → SELECT data_fn(params) → {config, data}
```

### 5.2 不新增的端點（以及為什麼）

| 不建的端點 | 原因 |
|-----------|------|
| `/api/templates/*`（CRUD 7 個） | Template 用 SQL seed 管理，不需要 REST API |
| `/api/data-fn/*`（CRUD + test + deploy 6 個） | Function 直接在 PG 管理 |
| `/api/ai/*`（generate + refine 2 個） | AI 模型未部署 |
| `/api/config-exec/aggregate` | 前端聚合，不需要後端 API |
| `/api/config-exec/chain-targets` | 只做固定鏈（Admin 預設 drilldown） |
| `/api/exploration/*`（trail 3 個） | 不做軌跡持久化 |
| `/api/shortcuts/*`（CRUD + execute 5 個） | 不做快捷流程 |

**總計砍掉 26 個端點，只改 1 個。**

---

## 第六章：實作檢查清單

### Phase 0：Custom SQL Function（1-2 天）

- [ ] DB：V032 migration — `authz_ui_page` 新增 `data_fn` 欄位
- [ ] Backend：`config-exec.ts` 新增 `data_fn` 分支（~30 行）
- [ ] Backend：function 名稱白名單驗證（`/^fn_[a-z][a-z0-9_]*$/`）
- [ ] Backend：named parameter 組裝 + SQL injection 防護
- [ ] SQL：手寫 2-3 個示範 function（良率趨勢、combo 統計等）
- [ ] Seed：在 `ui-config-seed.sql` 新增對應的 `authz_ui_page` 記錄
- [ ] 驗證：ConfigEngine 中卡片出現 → 點入 → 表格渲染 → drilldown 正常
- [ ] 驗證：無權限使用者看不到卡片 / 進不去頁面

### Phase 0.5：前端聚合（2-3 天）

- [ ] 重構：ConfigEngine.tsx 拆分為子元件（CardGrid、DataTable、FilterBar、NavBar）
- [ ] 新增：`lib/aggregation.ts` — 前端 GROUP BY + AGG 邏輯
- [ ] 新增：`AggPanel.tsx` — 聚合選項 UI（group-by 勾選 + agg 函數勾選）
- [ ] 整合：DataTable 加「聚合」按鈕，開啟 AggPanel
- [ ] 整合：聚合模式下 column headers 動態更新
- [ ] 整合：聚合行 drilldown 使用 `$group_keys` param_mapping
- [ ] Seed：在一個現有 page config 中加入 `aggregations` 定義
- [ ] 驗證：聚合切換流暢（< 100ms for 1000 rows）
- [ ] 驗證：聚合後鑽取參數正確

---

## 第七章：維運與監控

### 7.1 Custom SQL Function 的維運

| 情境 | 處理方式 |
|------|---------|
| DB schema 變更（加/改/刪欄位） | 手動檢查引用該 table 的 function 是否需要更新。<br>可用 `SELECT proname FROM pg_proc WHERE prosrc LIKE '%table_name%'` 查找 |
| Function 執行超時 | PG 層設定 `statement_timeout`（建議 5s）。<br>超時回傳 500，前端顯示「查詢逾時，請縮小查詢範圍」 |
| Function 回傳格式錯誤 | config-exec 加防禦性檢查：<br>`if (!result?.config \|\| !Array.isArray(result?.data))` → 400 |
| 想知道哪些 function 存在 | `SELECT proname, prosrc FROM pg_proc WHERE proname LIKE 'fn\_%' ORDER BY proname;` |
| 想知道 function 被哪些 page 引用 | `SELECT page_id, data_fn FROM authz_ui_page WHERE data_fn IS NOT NULL;` |

### 7.2 監控建議

Phase 0 不需要額外監控基礎設施。利用現有的：

- **PG `pg_stat_user_functions`**：追蹤每個 function 的呼叫次數和平均執行時間
- **Express 存取日誌**：`/api/config-exec` 的 response time
- **前端 console**：聚合計算時間（可在 aggregation.ts 中 `console.time`）

### 7.3 回滾方案

| 問題 | 回滾方式 |
|------|---------|
| V032 migration 有問題 | `ALTER TABLE authz_ui_page DROP COLUMN data_fn;` |
| 某個 function 寫壞了 | `DROP FUNCTION fn_xxx;` + 將 page 的 `data_fn` 設回 `NULL` |
| 聚合功能 bug | 前端只是新增元件，不影響現有 DataTable。移除 AggPanel import 即可 |

---

## 第八章：觀察指標與升級觸發

### 8.1 Phase 0 上線後觀察什麼

在 Phase 0 完成後，觀察以下指標來決定下一步：

| 觀察項目 | 方法 | 期望結果 |
|---------|------|---------|
| 使用者是否進入 data_fn 頁面 | `pg_stat_user_functions` 的 `calls` 欄位 | 日均呼叫 > 10 次 = 有人在用 |
| 使用者是否使用聚合 | 前端埋點（console.log 或簡單計數） | 週均 > 5 次 = 有需求 |
| Admin 建了幾個 function | `SELECT count(*) FROM pg_proc WHERE proname LIKE 'fn\_%'` | 每月穩定增加 |
| 使用者反饋 | 口頭 / Slack / helpdesk | 收集具體需求 |

### 8.2 升級決策樹

```
Phase 0 + 0.5 上線運行 2-4 週後：

Q1: data_fn 頁面有人用嗎？
├── 沒人用 → 調查原因（不好用？不知道？不需要？）→ 可能整個方向需要重新評估
└── 有人用 ↓

Q2: Admin 寫 SQL function 是否感到痛苦？
├── 是 → 評估 AI 輔助（vision §4），但先確認地端模型就緒
└── 否 → 維持手寫 ↓

Q3: 使用者是否要求跨 template 跳轉？
├── 是（≥ 3 次反饋）→ 評估探勘鏈（vision §5），先從 Admin 預設更多固定鏈開始
└── 否 → 固定鏈已足夠 ↓

Q4: Function 數量是否管理困難？
├── 是（> 15 個）→ 建立 authz_data_fn 註冊表（vision §10.3）
└── 否 ↓

Q5: 需要分析使用者行為嗎？
├── 是 → 建立探勘軌跡表（vision §7.1）
└── 否 → 維持現狀
```

### 8.3 觸發條件速查表

> **完整觸發條件**見 [`design-data-mining-vision.md` 附錄 D](design-data-mining-vision.md#附錄-d功能啟動觸發條件)

| 功能 | 觸發信號 | Vision 章節 |
|------|---------|------------|
| Template 生命週期 | Template > 25 + 改錯事件 | §3 |
| Template 版本控制 | 改壞 active template 且無法回滾 | §3.3 |
| AI 輔助 SQL 產生 | 地端模型就緒 + Admin 反映手寫是瓶頸 | §4 |
| 自由鏈式探勘 | ≥ 3 次「沒路可跳」反饋 | §5.2 模式 B |
| 後端動態聚合 | Table > 10K 筆 + 前端卡頓 | §6.1.3 |
| 探勘軌跡持久化 | Admin 需要分析使用者探勘模式 | §7.1 |
| 快捷流程 | 使用者重複同路徑 ≥ 3 次/週 | §7.3 |
| Function 註冊表 | Function > 15 + 需集中管理 | §10.3 |
| Admin Template 管理 UI | Admin 拒絕直接改 DB | §8.2 |

---

## 附錄：與現有文件的關係

| 文件 | 關係 |
|------|------|
| [`design-data-mining-vision.md`](design-data-mining-vision.md) | 完整長期願景（Template Pool、AI 輔助、探勘鏈、軌跡、快捷流程的完整設計 + 觸發條件） |
| [`config_driven_ui_requirements.md`](config_driven_ui_requirements.md) | Config-SM 原始需求規格（layout、column、filter、aggregation 定義） |
| [`phison-data-nexus-architecture-v2.4.md`](phison-data-nexus-architecture-v2.4.md) | 三路徑架構全貌 |
| [`wishlist-features.md`](wishlist-features.md) | 功能許願清單（Data Mining 模組是當前開發焦點之一） |
| [`PROGRESS.md`](PROGRESS.md) | 進度追蹤（Milestone 4 進行中） |

---

*本文件為可執行計畫。長期願景見 [`design-data-mining-vision.md`](design-data-mining-vision.md)。*
