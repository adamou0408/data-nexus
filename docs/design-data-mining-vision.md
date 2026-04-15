# Phison Data Nexus — Data Mining Engine 長期願景

> **文件定位**：本文件是 Data Mining Engine 的**完整願景參考**，描述最終目標形態。
> **不是立即實作的規格書。** 實際執行計畫見 [`design-data-mining-engine.md`](design-data-mining-engine.md)。
>
> 各章節的啟動時機見本文件底部的[功能啟動觸發條件](#附錄-d功能啟動觸發條件)，
> 以及主計畫文件的「觀察指標與升級觸發」章節。

## 文件資訊

| 項目 | 說明 |
|------|------|
| 專案代號 | phison-data-nexus |
| 版本 | v1.0-vision |
| 建立日期 | 2026-04-15 |
| 目標讀者 | 開發團隊、AI 開發模型、Admin/DBA |
| 前提假設 | 讀者已理解 Config-SM 架構（V022）、三路徑 SSOT、authz_resolve() 權限引擎 |
| 相關文件 | `design-data-mining-engine.md`（執行計畫）、`config_driven_ui_requirements.md`、`phison-data-nexus-architecture-v2.4.md` |

---

## 目錄

1. [設計目標與核心理念](#第一章設計目標與核心理念)
2. [整體架構 — 狀態機全景圖](#第二章整體架構--狀態機全景圖)
3. [Template Pool — 模板庫與生命週期](#第三章template-pool--模板庫與生命週期)
4. [AI 輔助 SQL Function 產生器](#第四章ai-輔助-sql-function-產生器)
5. [探勘鏈 — 多欄位組合串接](#第五章探勘鏈--多欄位組合串接)
6. [聚合與進階查詢](#第六章聚合與進階查詢)
7. [探勘軌跡追溯與快捷流程](#第七章探勘軌跡追溯與快捷流程)
8. [Admin 視角 — 前置準備 UX](#第八章admin-視角--前置準備-ux)
9. [User 視角 — 資料探勘 UX](#第九章user-視角--資料探勘-ux)
10. [DB Schema 設計](#第十章db-schema-設計)
11. [API 設計](#第十一章api-設計)
12. [實作路線圖](#第十二章實作路線圖)

---

## 第一章：設計目標與核心理念

### 1.1 一句話描述

> Admin 透過 AI 輔助建立 SQL function + UI template，使用者在 Config-SM 引擎中自由組合欄位、逐層鑽取、動態聚合，每一步都可追溯、可存為快捷流程，整個過程不需要寫任何前端程式碼。

### 1.2 五項設計原則

| 原則 | 說明 |
|------|------|
| **Config-as-State-Machine** | 每一個探勘步驟 = 一個狀態（template + params → {config, data}），使用者的操作 = 狀態轉移 |
| **SSOT** | Template 定義、SQL function、權限控制、探勘軌跡全部存在 PostgreSQL，前端只做渲染 |
| **Admin 準備 × User 探索** | Admin 負責「鋪路」（建 template、審核 SQL function），User 負責「走路」（選欄位、鑽取、聚合） |
| **AI 是工具不是主角** | AI 輔助 Admin 寫 SQL function，但最終由 Admin 審核、測試、發佈，AI 不直接面對 User |
| **漸進式複雜度** | 簡單場景（單表瀏覽）零配置可用；複雜場景（多表聯查 + 聚合 + 鏈式探勘）按需疊加 |

### 1.3 與現有系統的關係

```
現有 Config-SM 引擎（V022）
├── authz_ui_page          → 擴展為 Template Pool（加入生命週期 + 版本）
├── fn_ui_page / fn_ui_root → 不變，繼續作為 config 讀取入口
├── /api/config-exec        → 擴展支援 custom SQL function 執行 + 聚合 + 探勘鏈
├── ConfigEngine.tsx        → 擴展支援 agg_table、exploration_panel 等新 layout
└── buildMaskedSelect()     → 不變，繼續處理 column masking + RLS
```

**關鍵決策：擴展，不重建。** 現有 `authz_ui_page` 表已包含 layout、columns_override、filters_config、row_drilldown 等欄位，本設計在其基礎上擴展 template 生命週期與 SQL function 關聯，而非建立平行系統。

---

## 第二章：整體架構 — 狀態機全景圖

### 2.1 完整狀態流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Admin 準備階段（鋪路）                              │
│                                                                     │
│  ① Admin 選擇目標 table                                             │
│     ↓                                                               │
│  ② 系統自動提供 DDL + sample rows 給 AI                             │
│     ↓                                                               │
│  ③ AI 產生 SQL function（回傳 {config, data} 格式）                  │
│     ↓                                                               │
│  ④ Admin 審核 + 測試 + 調整                                         │
│     ↓                                                               │
│  ⑤ Admin 選擇/建立 UI template，綁定 SQL function                   │
│     ↓                                                               │
│  ⑥ Template 發佈（draft → active）                                  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                    User 探勘階段（走路）                              │
│                                                                     │
│  ⑦ User 進入探勘首頁 → 看到 active templates 卡片牆                 │
│     ↓                                                               │
│  ⑧ 點入 template → 執行 SQL function → 看到資料表格                 │
│     ↓                                                               │
│  ⑨ 選取欄位組合 → 作為下一個 SQL function 的 input                  │
│     ↓                                                               │
│  ⑩ 新的 {config, data} → 新的 UI 畫面                               │
│     ↓                                                               │
│  ⑪ 可繼續鑽取 / 切換聚合模式 / 存為快捷流程                         │
│     ↓                                                               │
│  ⑫ 整條探勘路徑被記錄（可追溯、可重放）                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 狀態機定義

每一個使用者操作都是一次狀態轉移：

```
State = { template_id, params, config, data, agg_mode }

Transition = User Action:
  - drill_down(row, param_mapping)     → 新 State（鑽取）
  - aggregate(group_by, agg_fns)       → 新 State（聚合）
  - select_fields(fields) → chain()    → 新 State（欄位組合串接）
  - back()                             → 前一個 State（回退）
  - home()                             → 根 State（回首頁）
  - save_shortcut(name)                → 將當前 State 鏈存為快捷流程
```

---

## 第三章：Template Pool — 模板庫與生命週期

### 3.1 概念

Template Pool 是所有 UI template 的中央管理庫。每個 template 定義了一個「資料探勘的起點或中繼站」— 它描述了「用什麼 SQL 取資料、用什麼 layout 畫面、哪些欄位可以當作下一步的 input」。

### 3.2 Template 生命週期

```
                    ┌──────────┐
         建立       │  draft   │  Admin 建立草稿，可自由編輯
                    └────┬─────┘
                         │ submit_review
                    ┌────▼─────┐
         審核       │  review  │  等待另一位 Admin 審核（選配，可跳過）
                    └────┬─────┘
                         │ approve / self_publish
                    ┌────▼─────┐
         上線       │  active  │  User 可見、可使用
                    └────┬─────┘
                         │ deprecate
                    ┌────▼──────┐
         過渡       │ deprecated│  仍可使用，但不再出現在探勘首頁
                    └────┬──────┘
                         │ archive
                    ┌────▼─────┐
         封存       │ archived │  不可使用，僅供歷史查詢
                    └──────────┘

任何狀態 → edit（僅 draft 可直接編輯，active 版本需 clone 為新版本編輯）
```

### 3.3 版本控制

| 欄位 | 說明 |
|------|------|
| `template_id` | 邏輯 ID，跨版本不變（例：`tpl:lot_explorer`） |
| `version` | 整數版本號，每次編輯 active template 時 +1 |
| `is_current` | 只有一個版本為 `TRUE`，該版本被 User 使用 |

Admin 編輯 active template 時，系統自動：
1. 將當前 active 版本的 `is_current` 設為 `FALSE`
2. Clone 一份新版本（version +1），狀態為 `draft`
3. Admin 在新版本上編輯
4. 發佈時新版本成為 `active` + `is_current = TRUE`

### 3.4 Template 分類

```
Template Pool
├── 📁 基礎瀏覽（Simple Browse）
│   ├── 單表全欄位瀏覽
│   └── 單表篩選瀏覽
├── 📁 聚合分析（Aggregation）
│   ├── 動態 GROUP BY
│   └── 統計摘要
├── 📁 鏈式探勘（Chain Exploration）
│   ├── 主從式鑽取（lot → detail）
│   └── 交叉參照（lot → 同 combo 比較）
├── 📁 多表聯查（Multi-Table Join）
│   ├── 關聯式探勘
│   └── 跨模組分析
└── 📁 自訂（Custom）
    └── Admin 自建的特殊 template
```

分類以 `category` TEXT 欄位實作，不建獨立分類表，保持簡潔。

### 3.5 Template 與 SQL Function 的關係

```
authz_ui_template（模板定義）
  │
  ├── data_fn TEXT          → SQL function 名稱（例：fn_lot_browse）
  ├── data_fn_version INT   → 綁定的 function 版本
  ├── data_table TEXT       → 簡單模式：直接指定 table（與現有 authz_ui_page 相容）
  │
  └── 二擇一：
      - data_fn 不為 NULL → 執行 custom SQL function
      - data_table 不為 NULL → 走現有 buildMaskedSelect() 路徑
```

**向後相容**：現有的 `authz_ui_page` 記錄（data_table 模式）無需修改即可繼續運作。

---

## 第四章：AI 輔助 SQL Function 產生器

### 4.1 設計理念

Admin 不一定是 SQL 專家。AI（地端模型）的角色是「SQL 寫手」— Admin 用自然語言描述需求，AI 根據 table schema 和 sample data 產生 SQL function，Admin 審核後發佈。

**安全邊界**：AI 只產生 `SELECT`-only 的 function（`LANGUAGE sql STABLE` 或 `LANGUAGE plpgsql STABLE`），不允許 DML/DDL。

### 4.2 AI 接收的參考資料

當 Admin 選擇目標 table 後，系統自動組裝以下資料作為 AI 的 context：

```
┌─────────────────────────────────────────────────────────────┐
│  AI Context Package                                         │
│                                                             │
│  1. Table DDL（從 information_schema 自動擷取）              │
│     CREATE TABLE lot_status (                               │
│         lot_id TEXT PRIMARY KEY,                            │
│         product_line TEXT,                                  │
│         grade TEXT,                                         │
│         ...                                                 │
│     );                                                      │
│                                                             │
│  2. Sample Rows（隨機取 10-20 筆，脫敏後提供）               │
│     lot_id  | product_line | grade | status   | qty         │
│     L-0891  | SSD          | A     | active   | 500         │
│     L-0892  | eMMC         | B     | shipped  | 300         │
│     ...                                                     │
│                                                             │
│  3. 關聯表資訊（FK 關係 + 關聯表 DDL，選配）                 │
│     lot_status.product_line → product.product_line          │
│                                                             │
│  4. 現有 Template 範例（讓 AI 理解 output 格式）             │
│     { config: { layout: "table", columns: [...] },          │
│       data: [...] }                                         │
│                                                             │
│  5. Admin 的自然語言需求                                     │
│     「我要查詢每個 product_line 每週的良率趨勢，              │
│       可以按 grade 篩選，點擊後看明細」                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 AI 產出格式

AI 必須產生符合以下規範的 SQL function：

```sql
-- ===== AI Generated Function =====
-- Description: 各產品線每週良率趨勢
-- Input params: p_product_line TEXT (optional), p_grade TEXT (optional)
-- Output: JSONB { config, data }
-- Generated: 2026-04-15 by local-model
-- Reviewed: pending

CREATE OR REPLACE FUNCTION fn_yield_trend_weekly(
    p_product_line TEXT DEFAULT NULL,
    p_grade        TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_data   JSONB;
    v_config JSONB;
BEGIN
    -- Config 定義 UI 渲染方式
    v_config := jsonb_build_object(
        'page_id',    'yield_trend_weekly',
        'title',      '每週良率趨勢',
        'subtitle',   '按產品線與週次統計平均良率',
        'layout',     'table',
        'columns',    jsonb_build_array(
            jsonb_build_object('key', 'product_line', 'label', '產品線',   'sortable', true),
            jsonb_build_object('key', 'week',         'label', '週次',     'sortable', true),
            jsonb_build_object('key', 'avg_yield',    'label', '平均良率', 'sortable', true,
                               'render', 'yield_bar', 'align', 'right'),
            jsonb_build_object('key', 'lot_count',    'label', '批次數',   'sortable', true,
                               'align', 'right'),
            jsonb_build_object('key', 'min_yield',    'label', '最低良率', 'sortable', true,
                               'align', 'right'),
            jsonb_build_object('key', 'max_yield',    'label', '最高良率', 'sortable', true,
                               'align', 'right')
        ),
        'filters',    jsonb_build_array(
            jsonb_build_object('field', 'product_line', 'type', 'select'),
            jsonb_build_object('field', 'week',         'type', 'select')
        ),
        'row_drilldown', jsonb_build_object(
            'page_id', 'lot_explorer',
            'param_mapping', jsonb_build_object(
                'product_line', '$row.product_line',
                'week',         '$row.week'
            )
        )
    );

    -- Data 查詢
    SELECT jsonb_agg(row_data ORDER BY product_line, week DESC)
    INTO v_data
    FROM (
        SELECT jsonb_build_object(
            'product_line', product_line,
            'week',         to_char(date_trunc('week', created_at), 'IYYY-IW'),
            'avg_yield',    round(avg(yield_pct)::numeric, 2),
            'lot_count',    count(*),
            'min_yield',    round(min(yield_pct)::numeric, 2),
            'max_yield',    round(max(yield_pct)::numeric, 2)
        ) AS row_data
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

### 4.4 AI 產出的驗證規則

系統在 Admin 審核前自動執行以下驗證：

| # | 驗證項目 | 方法 | 失敗處理 |
|---|---------|------|---------|
| 1 | 只有 SELECT（無 DML/DDL） | 對 function body 做 AST 解析或關鍵字掃描 | 拒絕，要求 AI 重新產生 |
| 2 | 回傳格式為 `{config, data}` | 試執行 function，檢查 jsonb_typeof | 拒絕，顯示實際回傳結構 |
| 3 | config.layout 在已知清單中 | 比對 layout registry | 警告，允許 Admin 覆寫 |
| 4 | config.columns[].key 對應 data 中的 key | 交叉比對 | 警告，標示不匹配的欄位 |
| 5 | function 為 STABLE（無副作用） | 檢查 function volatility | 拒絕，非 STABLE 不可部署 |
| 6 | 執行時間 < 5 秒 | 試執行 + `statement_timeout` | 警告，建議優化 |

### 4.5 SQL Function 的版本管理

```
authz_data_fn（SQL Function 註冊表）
  │
  ├── fn_id TEXT PRIMARY KEY       → 'fn:yield_trend_weekly'
  ├── fn_name TEXT                 → 'fn_yield_trend_weekly'（PG function 實際名稱）
  ├── version INT                  → 版本號
  ├── description TEXT             → 描述
  ├── input_params JSONB           → [{"name":"p_product_line","type":"TEXT","required":false}]
  ├── output_columns JSONB         → [{"key":"product_line","type":"TEXT"}, ...]
  ├── source_tables TEXT[]         → ['lot_status']（引用的 table 清單）
  ├── fn_body TEXT                 → 完整的 CREATE FUNCTION SQL
  ├── status TEXT                  → draft | testing | active | deprecated
  ├── ai_generated BOOLEAN         → 是否由 AI 產生
  ├── ai_prompt TEXT               → Admin 的原始自然語言需求
  ├── created_by TEXT              → 建立者
  ├── reviewed_by TEXT             → 審核者
  ├── created_at TIMESTAMPTZ
  └── updated_at TIMESTAMPTZ
```

### 4.6 Admin ↔ AI 互動流程

```
Admin                        系統                         AI（地端模型）
  │                            │                             │
  ├─ 選擇 table ──────────────►│                             │
  │                            ├─ 擷取 DDL + sample rows ───►│
  │                            │                             │
  ├─ 輸入自然語言需求 ─────────►├─ 組裝 context package ─────►│
  │                            │                             │
  │                            │◄── 回傳 SQL function ───────┤
  │                            │                             │
  │◄── 顯示 SQL + 預覽結果 ────┤                             │
  │                            │                             │
  ├─ 「調整：加上日期篩選」────►├─ 帶歷史 context 重送 ─────►│
  │                            │                             │
  │                            │◄── 回傳修改後的 SQL ────────┤
  │                            │                             │
  │◄── 顯示更新的 SQL + 預覽 ──┤                             │
  │                            │                             │
  ├─ 「確認，送出審核」────────►├─ 驗證 + 儲存 fn_body ──────│
  │                            ├─ 狀態: draft → testing      │
  │                            │                             │
  ├─ 「測試通過，發佈」────────►├─ 部署 function to PG ──────│
  │                            ├─ 狀態: testing → active     │
  └                            └                             └
```

---

## 第五章：探勘鏈 — 多欄位組合串接

### 5.1 核心概念

現有 Config-SM 的 `row_drilldown` 是「整列鑽取」— 點擊一列，固定的 `param_mapping` 決定傳哪些欄位值給下一層。

**探勘鏈**擴展為「使用者自選欄位組合」：

```
現有：點擊一列 → 固定的 param_mapping → 下一頁
擴展：勾選多個欄位值 → 使用者選擇目標 template → 下一頁
```

### 5.2 兩種串接模式

#### 模式 A：固定鏈（Admin 預設）

與現有 `row_drilldown` 相同，Admin 在 template 中預設好 param_mapping，User 點擊即鑽取。適合已知的探勘路徑。

```jsonc
{
  "row_drilldown": {
    "page_id": "lot_detail",
    "param_mapping": {
      "lot_id": "$row.lot_id",
      "product_line": "$row.product_line"
    }
  }
}
```

#### 模式 B：自由鏈（User 自選）

User 勾選表格中的欄位值 → 系統列出「可接收這些欄位作為 input 的 template」→ User 選擇目標 → 執行。

```
User 在 lot_status 表格中勾選：
  ☑ product_line = "SSD"
  ☑ grade = "A"

系統查詢：哪些 template 的 input_params 包含 product_line 和/或 grade？

顯示可串接的 template：
  → 同產品線良率趨勢（需要 product_line）
  → 同 Grade 批次比較（需要 grade）
  → 同產品線同 Grade 明細（需要 product_line + grade）

User 選擇 → 執行 → 新畫面
```

### 5.3 欄位選擇 UI

```
┌─────────────────────────────────────────────────────────────────┐
│  Lot Status Explorer                                 [聚合] [探勘] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ lot_id │ product_line │ grade │ status │ qty │ yield_pct │  │
│  ├────────┼──────────────┼───────┼────────┼─────┼───────────┤  │
│  │ L-0891 │ [✓] SSD      │ [✓] A │ active │ 500 │ 96.2%     │  │
│  │ L-0892 │    eMMC      │    B  │ shipped│ 300 │ 88.1%     │  │
│  │ L-0893 │    SSD       │    A  │ active │ 450 │ 94.7%     │  │
│  └────────┴──────────────┴───────┴────────┴─────┴───────────┘  │
│                                                                 │
│  已選條件：product_line = "SSD", grade = "A"                     │
│                                                                 │
│  ┌─── 可串接的探勘路徑 ──────────────────────────────────────┐  │
│  │ ● 良率週趨勢（product_line → fn_yield_trend_weekly）       │  │
│  │ ● 同 Grade 批次比較（grade → fn_grade_comparison）         │  │
│  │ ● 產品線 + Grade 明細（全部 → fn_lot_filtered_detail）     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  [執行探勘 →]                                                    │
└─────────────────────────────────────────────────────────────────┘
```

### 5.4 串接匹配演算法

```sql
-- 給定 User 選擇的欄位名稱集合，找出可串接的 template
-- 匹配邏輯：template 的 input_params 是 User 選擇欄位的子集

SELECT t.template_id, t.title, f.input_params,
       -- 匹配程度：完全匹配 > 部分匹配
       CASE
         WHEN matched_count = total_params THEN 'full_match'
         ELSE 'partial_match'
       END AS match_type
FROM authz_ui_template t
JOIN authz_data_fn f ON t.data_fn = f.fn_id AND f.status = 'active'
CROSS JOIN LATERAL (
    SELECT
        count(*) FILTER (WHERE p->>'name' = ANY(p_selected_fields)) AS matched_count,
        count(*) AS total_params
    FROM jsonb_array_elements(f.input_params) p
    WHERE (p->>'required')::boolean = true
) match_info
WHERE t.status = 'active'
  AND match_info.matched_count > 0
ORDER BY match_type, t.display_order;
```

### 5.5 鏈式探勘的狀態機表示

```
State₁ {template: lot_explorer, params: {}}
  → user selects: product_line="SSD", grade="A"
  → user picks target: yield_trend_weekly

State₂ {template: yield_trend_weekly, params: {product_line: "SSD", grade: "A"}}
  → user clicks row: week="2026-W15"
  → fixed drilldown to lot_detail

State₃ {template: lot_detail, params: {product_line: "SSD", week: "2026-W15"}}
  → user selects: combo="PS5021-E21T"
  → user picks target: combo_analysis

State₄ {template: combo_analysis, params: {combo: "PS5021-E21T"}}
  ...

Navigation Stack: [State₁, State₂, State₃, State₄]
Breadcrumb: Home > Lot Explorer > 良率趨勢 > Lot 明細 > Combo 分析
```

---

## 第六章：聚合與進階查詢

### 6.1 聚合模式設計

在現有 `config_driven_ui_requirements.md` §3.5 的基礎上，定義完整的聚合實作方案。

#### 6.1.1 聚合觸發方式

Template config 中定義可用的聚合選項：

```jsonc
{
  "aggregations": {
    "enabled": true,
    "group_by_options": [
      { "key": "product_line", "label": "產品線" },
      { "key": "grade",        "label": "等級" },
      { "key": "phase",        "label": "製程階段" },
      { "key": "site",         "label": "廠區" }
    ],
    "agg_functions": [
      { "field": "qty",       "fn": "SUM",   "label": "總數量" },
      { "field": "qty",       "fn": "COUNT", "label": "批次數" },
      { "field": "yield_pct", "fn": "AVG",   "label": "平均良率" },
      { "field": "yield_pct", "fn": "MIN",   "label": "最低良率" },
      { "field": "yield_pct", "fn": "MAX",   "label": "最高良率" }
    ],
    "execution_mode": "auto",
    "drilldown": {
      "page_id": "lot_explorer",
      "param_mapping": "$group_keys"
    }
  }
}
```

#### 6.1.2 兩種執行模式的自動切換

```
execution_mode: "auto"
  │
  ├── data.length ≤ 10,000 → 前端即時聚合（Mode A）
  │   - 資料已在 browser memory
  │   - 切換 group_by 不需要 API call
  │   - 即時回應，體驗流暢
  │
  └── data.length > 10,000 → 後端 PG 聚合（Mode B）
      - 發送 group_by + agg_fns 到 /api/config-exec/aggregate
      - PG 執行 GROUP BY + AGG
      - 回傳聚合結果
```

#### 6.1.3 後端聚合安全實作

```sql
-- 安全的動態聚合 function
-- 所有欄位名稱經 information_schema 驗證，防止 SQL injection

CREATE OR REPLACE FUNCTION fn_dynamic_aggregate(
    p_table       TEXT,
    p_group_by    TEXT[],
    p_agg_defs    JSONB,        -- [{"field":"qty","fn":"SUM","alias":"total_qty"}]
    p_where       JSONB DEFAULT '{}',
    p_user_id     TEXT DEFAULT NULL,
    p_user_groups TEXT[] DEFAULT '{}'
) RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_valid_columns TEXT[];
    v_group_cols    TEXT;
    v_agg_exprs     TEXT;
    v_where_clause  TEXT := '';
    v_sql           TEXT;
    v_result        JSONB;
BEGIN
    -- 1. 從 information_schema 取得有效欄位名稱（SSOT 驗證）
    SELECT array_agg(column_name)
    INTO v_valid_columns
    FROM information_schema.columns
    WHERE table_name = p_table AND table_schema = 'public';

    -- 2. 驗證所有 group_by 欄位都是有效欄位
    IF NOT (p_group_by <@ v_valid_columns) THEN
        RAISE EXCEPTION 'Invalid group_by columns: %',
            array_to_string(
                ARRAY(SELECT unnest(p_group_by) EXCEPT SELECT unnest(v_valid_columns)),
                ', '
            );
    END IF;

    -- 3. 驗證聚合欄位
    -- 4. 組裝 SQL（使用 format() 的 %I identifier quoting）
    -- 5. 注入 RLS filter（呼叫 authz_filter）
    -- 6. 執行並回傳

    RETURN v_result;
END;
$$;
```

### 6.2 支援的進階語法

| 類別 | 語法 | 說明 | 範例 |
|------|------|------|------|
| **基礎聚合** | SUM, AVG, COUNT, MIN, MAX | 標準 SQL 聚合 | `AVG(yield_pct)` |
| **條件聚合** | FILTER (WHERE ...) | 帶條件的聚合 | `COUNT(*) FILTER (WHERE grade = 'A')` |
| **視窗函數** | OVER (PARTITION BY ...) | 排名、累計、移動平均 | `ROW_NUMBER() OVER (PARTITION BY product_line ORDER BY yield_pct DESC)` |
| **分位數** | PERCENTILE_CONT / PERCENTILE_DISC | 中位數、百分位 | `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY yield_pct)` |
| **統計** | STDDEV, VARIANCE, CORR | 標準差、變異數、相關係數 | `STDDEV(yield_pct)` |
| **日期截斷** | date_trunc() | 按日/週/月分組 | `date_trunc('week', created_at)` |
| **HAVING** | HAVING agg_fn(col) > val | 聚合後過濾 | `HAVING AVG(yield_pct) < 90` |
| **ROLLUP** | GROUP BY ROLLUP(...) | 小計與總計 | 各層級小計行 |

**限制**：以上進階語法僅在 custom SQL function（AI 產生或 Admin 手寫）中使用。動態聚合 API 僅支援基礎聚合（SUM/AVG/COUNT/MIN/MAX），以確保安全性。

### 6.3 聚合結果的 UI 呈現

```
┌─────────────────────────────────────────────────────────────────┐
│  Lot Status Explorer — 聚合模式                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  分組依據：[✓ 產品線] [✓ 等級] [  製程] [  廠區]                │
│  聚合項目：[✓ 總數量] [✓ 平均良率] [  最低良率]                 │
│                                                                 │
│  ┌───────────────┬───────┬──────────┬────────────┐             │
│  │ product_line  │ grade │ 總數量    │ 平均良率    │             │
│  ├───────────────┼───────┼──────────┼────────────┤             │
│  │ SSD           │ A     │ 12,500   │ ████░ 95.3 │             │
│  │ SSD           │ B     │  8,200   │ ███░░ 87.1 │             │
│  │ eMMC          │ A     │  6,800   │ ████░ 93.8 │             │
│  │ eMMC          │ B     │  5,100   │ ██░░░ 82.4 │             │
│  └───────────────┴───────┴──────────┴────────────┘             │
│                                                                 │
│  SQL Preview:                                                   │
│  SELECT product_line, grade, SUM(qty), AVG(yield_pct)          │
│  FROM lot_status WHERE ... GROUP BY product_line, grade         │
│                                                                 │
│  顯示 4 組（原始 32,600 筆）       [鑽取選定行 →] [匯出 CSV]    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 第七章：探勘軌跡追溯與快捷流程

### 7.1 探勘軌跡（Exploration Trail）

每一次使用者的探勘操作都被自動記錄為一條軌跡：

```jsonc
{
  "trail_id": "trail:20260415-143022-wang_pe",
  "user_id": "wang_pe",
  "started_at": "2026-04-15T14:30:22Z",
  "steps": [
    {
      "step": 1,
      "action": "enter",
      "template_id": "tpl:lot_explorer",
      "params": {},
      "result_count": 1200,
      "timestamp": "2026-04-15T14:30:22Z"
    },
    {
      "step": 2,
      "action": "aggregate",
      "template_id": "tpl:lot_explorer",
      "group_by": ["product_line", "grade"],
      "agg_fns": ["SUM(qty)", "AVG(yield_pct)"],
      "result_count": 8,
      "timestamp": "2026-04-15T14:30:45Z"
    },
    {
      "step": 3,
      "action": "drill_down",
      "template_id": "tpl:lot_detail",
      "params": { "product_line": "SSD", "grade": "A" },
      "result_count": 156,
      "timestamp": "2026-04-15T14:31:02Z"
    },
    {
      "step": 4,
      "action": "chain",
      "template_id": "tpl:yield_trend_weekly",
      "params": { "product_line": "SSD" },
      "result_count": 24,
      "timestamp": "2026-04-15T14:31:30Z"
    }
  ]
}
```

### 7.2 軌跡追溯 UI

使用者在探勘過程中可隨時展開「軌跡面板」，查看完整的探勘路徑：

```
┌─── 探勘軌跡 ──────────────────────────────────────────────┐
│                                                            │
│  ① Lot Explorer（1,200 筆）                                │
│     │                                                      │
│     ├─ 聚合：GROUP BY 產品線, 等級                          │
│     ▼                                                      │
│  ② Lot Explorer — 聚合結果（8 組）                          │
│     │                                                      │
│     ├─ 鑽取：product_line="SSD", grade="A"                 │
│     ▼                                                      │
│  ③ Lot 明細（156 筆）                                      │
│     │                                                      │
│     ├─ 欄位串接：product_line="SSD" → 良率週趨勢           │
│     ▼                                                      │
│  ④ 良率週趨勢（24 筆）  ← 目前位置                         │
│                                                            │
│  [儲存為快捷流程]  [匯出軌跡]  [分享]                        │
└────────────────────────────────────────────────────────────┘
```

### 7.3 快捷流程（Shortcut Flow）

使用者可將一條探勘軌跡儲存為「快捷流程」，之後一鍵重放：

```jsonc
{
  "shortcut_id": "sc:ssd_yield_weekly",
  "name": "SSD 每週良率趨勢追蹤",
  "description": "從 Lot Explorer 出發，聚合後鑽取 SSD A 等級，查看週趨勢",
  "created_by": "wang_pe",
  "is_public": false,
  "steps": [
    { "template_id": "tpl:lot_explorer", "params": {} },
    { "action": "aggregate", "group_by": ["product_line", "grade"], "agg_fns": [...] },
    { "action": "drill_down", "params": { "product_line": "SSD", "grade": "A" } },
    { "action": "chain", "template_id": "tpl:yield_trend_weekly", "params": { "product_line": "SSD" } }
  ],
  "parameterized": {
    "product_line": { "label": "產品線", "default": "SSD", "type": "select" },
    "grade":        { "label": "等級",   "default": "A",   "type": "select" }
  }
}
```

#### 快捷流程的參數化

儲存時，使用者可選擇將某些值標記為「可變參數」：

```
儲存快捷流程
━━━━━━━━━━━
名稱：[SSD 每週良率趨勢追蹤          ]
說明：[從 Lot Explorer 出發...        ]

以下值要設為可變參數嗎？
  ☑ product_line = "SSD"  → 下次執行時可改選
  ☑ grade = "A"           → 下次執行時可改選

可見性：⊙ 僅自己  ○ 團隊可見  ○ 全公司

[儲存]
```

#### 快捷流程的重放

```
我的快捷流程
━━━━━━━━━━━
┌─────────────────────────────────────────────────┐
│ ★ SSD 每週良率趨勢追蹤                           │
│   4 步驟 · 上次執行 2 小時前                      │
│                                                   │
│   產品線：[SSD     ▾]  等級：[A ▾]                │
│                                                   │
│   [▶ 執行]  [🔗 分享]  [✏️ 編輯]  [🗑️ 刪除]      │
└─────────────────────────────────────────────────┘
```

重放時系統依序執行每一步，User 看到的是最終結果，但軌跡面板顯示完整路徑，可在任一步驟停下來修改方向。

### 7.4 軌跡與快捷流程的 SSOT 儲存

軌跡和快捷流程都存在 PostgreSQL（不是前端 localStorage），確保：
- 跨裝置可用
- Admin 可統計「哪些探勘路徑最常被使用」→ 優化 template 設計
- 合規要求：資料存取行為可追蹤

---

## 第八章：Admin 視角 — 前置準備 UX

### 8.1 Admin 的核心任務

Admin 的角色是「為 User 鋪路」— 準備好 template 和 SQL function，讓 User 可以自由探勘。

```
Admin 的工作流程
━━━━━━━━━━━━━━

1. 了解業務需求
   → 使用者想看什麼資料？想從哪些角度分析？

2. 檢視可用的資料來源
   → Data Source Registry 已有哪些 table？欄位是什麼？

3. 建立 SQL Function
   → 自己寫 or 用 AI 輔助產生
   → 測試、驗證

4. 建立 UI Template
   → 選擇 layout、設定 columns、filters、drilldown
   → 綁定 SQL Function

5. 設定探勘鏈
   → 哪些 template 之間可以互相串接？
   → 預設的 drilldown 路徑是什麼？

6. 發佈
   → Template 從 draft → active
   → User 可以開始使用
```

### 8.2 Admin Dashboard — Template 管理

```
┌─────────────────────────────────────────────────────────────────┐
│  Template Pool Management                          [+ 新建]     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  篩選：[全部狀態 ▾] [全部分類 ▾] [搜尋...              ]       │
│                                                                 │
│  ┌──────────────────┬─────────┬──────────┬──────┬────────────┐ │
│  │ Template          │ 分類     │ SQL Fn    │ 狀態  │ 操作       │ │
│  ├──────────────────┼─────────┼──────────┼──────┼────────────┤ │
│  │ Lot Explorer      │ 基礎瀏覽 │ (table)   │ 🟢    │ 編輯 | 複製│ │
│  │ 良率週趨勢        │ 聚合分析 │ fn_yield  │ 🟢    │ 編輯 | 複製│ │
│  │ Combo 分析        │ 鏈式探勘 │ fn_combo  │ 🟡    │ 審核 | 測試│ │
│  │ 供應商交期追蹤    │ 自訂     │ fn_vendor │ ⚪    │ 編輯 | 刪除│ │
│  └──────────────────┴─────────┴──────────┴──────┴────────────┘ │
│                                                                 │
│  🟢 active: 12  🟡 review: 2  ⚪ draft: 3  ⚫ deprecated: 1    │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 Admin Dashboard — SQL Function 工作台

```
┌─────────────────────────────────────────────────────────────────┐
│  SQL Function Workbench                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─── 步驟 1：選擇資料來源 ──────────────────────────────────┐ │
│  │ 資料來源：[nexus_data ▾]                                   │ │
│  │ 目標表：  [lot_status ▾]   [+ 新增關聯表]                  │ │
│  │                                                            │ │
│  │ DDL 預覽：                                                 │ │
│  │ ┌────────────────────────────────────────────────────────┐ │ │
│  │ │ CREATE TABLE lot_status (                              │ │ │
│  │ │   lot_id TEXT PRIMARY KEY,                             │ │ │
│  │ │   product_line TEXT NOT NULL,                          │ │ │
│  │ │   grade TEXT,                                          │ │ │
│  │ │   ...                                                  │ │ │
│  │ │ );                                                     │ │ │
│  │ └────────────────────────────────────────────────────────┘ │ │
│  │                                                            │ │
│  │ Sample Data（20 筆隨機取樣）：                              │ │
│  │ ┌─────────┬──────────────┬───────┬────────┬──────┐       │ │
│  │ │ lot_id  │ product_line │ grade │ status │ qty  │       │ │
│  │ │ L-0891  │ SSD          │ A     │ active │ 500  │       │ │
│  │ │ L-0892  │ eMMC         │ B     │ shipped│ 300  │       │ │
│  │ │ ...     │              │       │        │      │       │ │
│  │ └─────────┴──────────────┴───────┴────────┴──────┘       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─── 步驟 2：描述需求（自然語言 or 手寫 SQL）──────────────┐ │
│  │ ⊙ AI 輔助   ○ 手動撰寫                                   │ │
│  │                                                            │ │
│  │ 需求描述：                                                 │ │
│  │ ┌────────────────────────────────────────────────────────┐ │ │
│  │ │ 我要查詢每個 product_line 每週的良率趨勢，              │ │ │
│  │ │ 可以按 grade 篩選，點擊後看該產品線該週的明細批次       │ │ │
│  │ └────────────────────────────────────────────────────────┘ │ │
│  │                                                            │ │
│  │ [🤖 生成 SQL Function]                                     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─── 步驟 3：預覽與測試 ──────────────────────────────────┐  │
│  │                                                            │ │
│  │ SQL Function：                                             │ │
│  │ ┌────────────────────────────────────────────────────────┐ │ │
│  │ │ CREATE OR REPLACE FUNCTION fn_yield_trend_weekly(      │ │ │
│  │ │   p_product_line TEXT DEFAULT NULL,                     │ │ │
│  │ │   p_grade TEXT DEFAULT NULL                             │ │ │
│  │ │ ) RETURNS JSONB ...                                    │ │ │
│  │ └────────────────────────────────────────────────────────┘ │ │
│  │                                                            │ │
│  │ 驗證結果：                                                 │ │
│  │ ✅ 只有 SELECT（無 DML/DDL）                               │ │
│  │ ✅ 回傳格式正確（{config, data}）                          │ │
│  │ ✅ STABLE volatility                                       │ │
│  │ ⚠️ 執行時間 2.3 秒（建議 < 5 秒）                          │ │
│  │                                                            │ │
│  │ 預覽資料（前 10 筆）：                                     │ │
│  │ ┌──────────────┬─────────┬──────────┬──────────┐         │ │
│  │ │ product_line │ week    │ avg_yield│ lot_count│         │ │
│  │ │ SSD          │ 2026-W15│ 95.3     │ 42       │         │ │
│  │ │ SSD          │ 2026-W14│ 94.1     │ 38       │         │ │
│  │ └──────────────┴─────────┴──────────┴──────────┘         │ │
│  │                                                            │ │
│  │ [💬 「加上日期範圍篩選」]  [✏️ 手動修改]  [✅ 儲存]         │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 8.4 Admin 的效率設計

| 設計 | 說明 | 為什麼 |
|------|------|--------|
| **一鍵 clone** | 從現有 active template clone 為新 draft | 大部分新 template 是現有的變體 |
| **AI 對話歷史** | 產生 SQL function 的 AI 對話可回溯 | Admin 可延續上次的調整 |
| **批次測試** | 一鍵對所有 active template 執行健康檢查 | 確保 DB schema 變更後 template 仍正常 |
| **使用熱度** | 顯示每個 template 的使用次數 + 探勘鏈接入次數 | Admin 知道哪些 template 最有價值 |
| **自動 ID** | template_id 和 fn_id 自動產生 | 減少 Admin 命名負擔 |

---

## 第九章：User 視角 — 資料探勘 UX

### 9.1 User 的探勘入口

```
┌─────────────────────────────────────────────────────────────────┐
│  Data Mining                                                     │
├──────────────────┬──────────────────────────────────────────────┤
│                  │                                              │
│  ⊙ 探勘首頁      │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐   │
│  ○ 我的快捷流程   │  │ 📦   │  │ 📊   │  │ 🔧   │  │ 💰   │   │
│  ○ 最近探勘      │  │ Lot  │  │ 良率  │  │ NPI  │  │ 銷售  │   │
│                  │  │Explorer│  │ 分析  │  │ 追蹤  │  │ 訂單  │   │
│  ──────────────  │  └──────┘  └──────┘  └──────┘  └──────┘   │
│  分類篩選：       │  ┌──────┐  ┌──────┐  ┌──────┐             │
│  [全部        ▾] │  │ 📋   │  │ 🏭   │  │ 📈   │             │
│                  │  │ 品質  │  │ 供應商│  │ 產能  │             │
│                  │  │ 報告  │  │ 交期  │  │ 趨勢  │             │
│                  │  └──────┘  └──────┘  └──────┘             │
│                  │                                              │
│                  │  顯示 9 個可用探勘模組（共 12 個，3 個無權限） │
└──────────────────┴──────────────────────────────────────────────┘
```

### 9.2 核心互動模式

#### 模式 1：直覺瀏覽 → 鑽取

最簡單的路徑，適合「我知道要找什麼」的場景：

```
點入卡片 → 看到表格 → 點擊感興趣的行 → 看到明細
```

與現有 Config-SM 完全相同，不增加任何學習成本。

#### 模式 2：篩選 → 聚合 → 鑽取

適合「我想從某個角度看統計」的場景：

```
點入卡片 → 篩選條件 → 點「聚合」→ 選 GROUP BY 欄位 → 看聚合結果 → 點擊鑽取
```

新增的操作只有「聚合按鈕」和「GROUP BY 欄位選擇」。

#### 模式 3：自由鏈式探勘

適合「我想從 A 資料出發，連結到 B 資料」的場景：

```
點入卡片 → 看到表格 → 勾選欄位值 → 點「探勘」→ 選擇目標 → 看到新表格 → 繼續...
```

新增的操作是「勾選欄位值」和「選擇目標 template」。

#### 模式 4：快捷流程

適合「我每天都做同樣的分析」的場景：

```
我的快捷流程 → 調整參數 → 一鍵執行 → 直接看到最終結果
```

### 9.3 漸進式揭露（Progressive Disclosure）

使用者介面遵循「簡單在前，進階在後」的原則：

```
Level 1（預設）：表格 + 篩選 + 行鑽取
  ↓ 點擊「進階」
Level 2：+ 聚合模式 + SQL 預覽
  ↓ 點擊「探勘」
Level 3：+ 欄位選擇 + 跨 template 串接
  ↓ 點擊「軌跡」
Level 4：+ 完整軌跡面板 + 儲存快捷流程
```

預設只顯示 Level 1 的操作，進階功能透過明確的按鈕進入，不會干擾簡單使用場景。

### 9.4 探勘工具列設計

```
┌─────────────────────────────────────────────────────────────────┐
│  ◀ Back │ 🏠 │ Lot Explorer > 聚合結果 > Lot 明細               │
├─────────────────────────────────────────────────────────────────┤
│  [篩選 ▾]  [聚合 ▾]  [探勘 →]  [軌跡 📍]  |  [快捷 ⭐]  [匯出] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ... 資料表格 ...                                                │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  顯示 156 筆（共 1,200 筆，RLS 過濾 1,044 筆）  2 欄位遮蔽      │
│  探勘深度：第 3 層                                               │
└─────────────────────────────────────────────────────────────────┘
```

| 按鈕 | 功能 | 顯示時機 |
|------|------|---------|
| 篩選 | 下拉顯示 Filter 面板 | 永遠（Level 1） |
| 聚合 | 下拉顯示 GROUP BY + AGG 選項 | 當 template 啟用 aggregations 時 |
| 探勘 | 啟動欄位選擇模式 → 顯示可串接 template | 當有可串接的 template 時 |
| 軌跡 | 側邊展開完整探勘軌跡面板 | 探勘深度 ≥ 2 時 |
| 快捷 | 儲存當前路徑為快捷流程 / 開啟我的快捷 | 永遠 |
| 匯出 | 匯出當前資料為 CSV | 永遠 |

---

## 第十章：DB Schema 設計

### 10.1 設計策略：擴展 authz_ui_page

**決策**：不新建 `authz_ui_template` 表，而是在現有 `authz_ui_page` 上新增生命週期欄位。原因：

1. `authz_ui_page` 已包含所有 template 所需的核心欄位（layout, columns, filters, drilldown）
2. 現有的 `fn_ui_page()` / `fn_ui_root()` 可沿用
3. 避免雙系統維護
4. SSOT 原則：一個概念只有一個表

### 10.2 V033: Template 生命週期擴展

> V032 已被 Thin Slice（`design-data-mining-engine.md`）的 `data_fn_support` 使用。

```sql
-- V033__template_lifecycle.sql

-- 1. authz_ui_page 新增欄位
ALTER TABLE authz_ui_page
  ADD COLUMN status       TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft','review','active','deprecated','archived')),
  ADD COLUMN version      INT NOT NULL DEFAULT 1,
  ADD COLUMN is_current   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN category     TEXT DEFAULT 'custom',
  ADD COLUMN data_fn      TEXT,           -- custom SQL function 名稱（NULL = 走 data_table 模式）
  ADD COLUMN chain_config JSONB,          -- 自由鏈配置 {"input_fields": [...], "output_fields": [...]}
  ADD COLUMN agg_config   JSONB,          -- 聚合配置（從 config 提升為獨立欄位，便於查詢）
  ADD COLUMN usage_count  INT NOT NULL DEFAULT 0,
  ADD COLUMN created_by   TEXT,
  ADD COLUMN updated_at   TIMESTAMPTZ DEFAULT now();

-- 現有資料設為 active
-- (已有的 authz_ui_page rows 預設 status='active', version=1, is_current=TRUE)

-- 2. 確保每個邏輯 template 只有一個 is_current 版本
-- page_id 格式：{logical_id}__v{version}，is_current=TRUE 的版本只有一個
CREATE UNIQUE INDEX idx_ui_page_current
  ON authz_ui_page (page_id)
  WHERE is_current = TRUE;
```

### 10.3 V034: SQL Function 註冊表

```sql
-- V034__data_fn_registry.sql

CREATE TABLE authz_data_fn (
    fn_id           TEXT PRIMARY KEY,       -- 'fn:yield_trend_weekly'
    fn_name         TEXT NOT NULL UNIQUE,    -- 'fn_yield_trend_weekly'（PG 實際名稱）
    version         INT NOT NULL DEFAULT 1,
    description     TEXT,
    input_params    JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- [{"name":"p_product_line","type":"TEXT","required":false,"label":"產品線"}]
    output_columns  JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- [{"key":"product_line","type":"TEXT","label":"產品線"}]
    source_tables   TEXT[] NOT NULL DEFAULT '{}',
    fn_body         TEXT NOT NULL,           -- 完整 CREATE FUNCTION SQL
    status          TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','testing','active','deprecated')),
    ai_generated    BOOLEAN NOT NULL DEFAULT FALSE,
    ai_prompt       TEXT,
    created_by      TEXT NOT NULL,
    reviewed_by     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for template matching (find functions by input param names)
CREATE INDEX idx_data_fn_status ON authz_data_fn (status);
```

### 10.4 V035: 探勘軌跡與快捷流程

```sql
-- V035__exploration_trail.sql

-- 1. 探勘軌跡
CREATE TABLE authz_exploration_trail (
    trail_id    TEXT PRIMARY KEY DEFAULT 'trail:' || to_char(now(), 'YYYYMMDD-HH24MISS') || '-' || gen_random_uuid()::text,
    user_id     TEXT NOT NULL,
    steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
    step_count  INT NOT NULL DEFAULT 0,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE  -- 目前進行中的探勘
);

CREATE INDEX idx_trail_user ON authz_exploration_trail (user_id, started_at DESC);

-- 2. 快捷流程
CREATE TABLE authz_shortcut_flow (
    shortcut_id     TEXT PRIMARY KEY DEFAULT 'sc:' || gen_random_uuid()::text,
    name            TEXT NOT NULL,
    description     TEXT,
    created_by      TEXT NOT NULL,
    is_public       BOOLEAN NOT NULL DEFAULT FALSE,
    steps           JSONB NOT NULL,        -- 完整的步驟定義
    parameterized   JSONB DEFAULT '{}'::jsonb,  -- 可變參數定義
    usage_count     INT NOT NULL DEFAULT 0,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shortcut_user ON authz_shortcut_flow (created_by);
CREATE INDEX idx_shortcut_public ON authz_shortcut_flow (is_public) WHERE is_public = TRUE;
```

### 10.5 ER 關聯圖

```
authz_ui_page (擴展後)
  │
  ├── data_fn ──────────► authz_data_fn
  │                         │
  │                         ├── source_tables ──► information_schema
  │                         └── input_params ──► (串接匹配用)
  │
  ├── resource_id ──────► authz_resource (權限控制)
  │
  └── parent_page_id ───► authz_ui_page (自參照，頁面階層)

authz_exploration_trail
  │
  ├── user_id ──────────► authz_subject
  └── steps[].template_id ► authz_ui_page

authz_shortcut_flow
  │
  ├── created_by ───────► authz_subject
  └── steps[].template_id ► authz_ui_page
```

---

## 第十一章：API 設計

### 11.1 新增 / 擴展的 API 端點

#### Template Pool Management（Admin only）

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/templates` | 列出所有 template（支援 status/category 篩選） |
| POST | `/api/templates` | 建立新 template（draft） |
| PUT | `/api/templates/:id` | 更新 template（僅 draft 可編輯） |
| POST | `/api/templates/:id/publish` | 發佈：draft/review → active |
| POST | `/api/templates/:id/deprecate` | 下架：active → deprecated |
| POST | `/api/templates/:id/clone` | 複製為新 draft |
| GET | `/api/templates/:id/usage` | 查詢使用統計 |

#### SQL Function Workbench（Admin only）

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/data-fn` | 列出所有已註冊的 SQL function |
| POST | `/api/data-fn` | 註冊新 function（draft） |
| PUT | `/api/data-fn/:id` | 更新 function |
| POST | `/api/data-fn/:id/test` | 測試執行（SAVEPOINT 內執行，不影響 DB） |
| POST | `/api/data-fn/:id/deploy` | 部署到 PG（CREATE OR REPLACE） |
| POST | `/api/data-fn/:id/validate` | 執行自動驗證規則 |
| GET | `/api/data-fn/context/:table` | 取得 AI context package（DDL + sample rows） |

#### AI Assistant（Admin only）

| Method | Path | 說明 |
|--------|------|------|
| POST | `/api/ai/generate-fn` | AI 產生 SQL function |
| POST | `/api/ai/refine-fn` | AI 修改既有 function（帶對話歷史） |

#### Exploration（User）

| Method | Path | 說明 |
|--------|------|------|
| POST | `/api/config-exec` | 不變，擴展支援 data_fn 執行 |
| POST | `/api/config-exec/aggregate` | 動態聚合查詢 |
| POST | `/api/config-exec/chain-targets` | 查詢可串接的 template |
| GET | `/api/exploration/trails` | 我的探勘軌跡列表 |
| POST | `/api/exploration/trails` | 記錄探勘步驟（即時追加） |
| GET | `/api/exploration/trails/:id` | 查詢特定軌跡 |

#### Shortcut Flows（User）

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/shortcuts` | 我的快捷流程 + 公開流程 |
| POST | `/api/shortcuts` | 儲存快捷流程 |
| PUT | `/api/shortcuts/:id` | 更新快捷流程 |
| DELETE | `/api/shortcuts/:id` | 刪除快捷流程 |
| POST | `/api/shortcuts/:id/execute` | 重放快捷流程 |

### 11.2 擴展現有 config-exec 端點

```typescript
// POST /api/config-exec — 擴展後的邏輯

async function configExec(req, res) {
  const { page_id, params } = req.body;

  // 1. 取得 page config（不變）
  const config = await getPageConfig(page_id);

  // 2. 權限檢查（不變）
  if (config.resource_id) {
    const allowed = await authzCheck(user, 'read', config.resource_id);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  }

  // 3. 資料取得 — 根據模式分支
  let data;

  if (config.data_fn) {
    // === 新增：custom SQL function 模式 ===
    // 從 authz_data_fn 取得 function 定義
    const fn = await getDataFn(config.data_fn);
    // 執行 function，傳入 params
    data = await execDataFn(fn.fn_name, params);
    // data_fn 回傳的 {config, data} 中的 config 可覆寫 page config
  } else if (config.data_table) {
    // === 現有：table 直接查詢模式 ===
    data = await buildMaskedSelect({ table: config.data_table, params, user });
  } else {
    // === 現有：card_grid 模式（無資料） ===
    data = [];
  }

  // 4. 記錄探勘軌跡（新增）
  await recordTrailStep(user, page_id, params, data.length);

  return res.json({ config, data });
}
```

---

## 第十二章：實作路線圖

### Phase 1：Template Pool 生命週期（V033）

**目標**：讓 Admin 可以管理 template 的生命週期

| 項目 | 內容 |
|------|------|
| DB | V033 migration：authz_ui_page 新增欄位 |
| API | Template CRUD + publish/deprecate/clone 端點 |
| UI | Admin Dashboard → Template Pool Management 頁面 |
| 驗證 | 現有 template 不受影響（向後相容） |

### Phase 2：SQL Function 註冊與手動建立（V034）

**目標**：Admin 可以手動撰寫、註冊、測試、部署 SQL function

| 項目 | 內容 |
|------|------|
| DB | V034 migration：authz_data_fn 表 |
| API | Data-fn CRUD + test + deploy + validate 端點 |
| UI | SQL Function Workbench（手動模式） |
| 驗證 | 成功部署的 function 可被 template 引用並在 Config-SM 中執行 |

### Phase 3：AI 輔助 SQL Function 產生（整合地端模型）

**目標**：Admin 可以用自然語言描述需求，AI 產生 SQL function

| 項目 | 內容 |
|------|------|
| API | `/api/ai/generate-fn`、`/api/ai/refine-fn`、`/api/data-fn/context/:table` |
| 整合 | 地端模型 API 串接（LLM endpoint） |
| UI | SQL Function Workbench AI 模式 |
| 驗證 | AI 產生的 function 通過所有自動驗證規則 |

### Phase 4：探勘鏈 — 多欄位串接（config-exec 擴展）

**目標**：User 可以自選欄位值串接到其他 template

| 項目 | 內容 |
|------|------|
| API | `/api/config-exec/chain-targets` 端點 |
| UI | ConfigEngine 欄位選擇模式 + 目標 template 選單 |
| DB | authz_ui_page.chain_config 欄位使用 |
| 驗證 | 跨 template 串接正常運作 |

### Phase 5：聚合模式（agg_table layout）

**目標**：User 可以動態選擇 GROUP BY + AGG 函數

| 項目 | 內容 |
|------|------|
| API | `/api/config-exec/aggregate` 端點 + fn_dynamic_aggregate() |
| UI | ConfigEngine 聚合工具列 + agg_table layout component |
| 安全 | information_schema 驗證 + authz_filter 注入 |
| 驗證 | 前端聚合（< 10K rows）和後端聚合（> 10K rows）皆正常 |

### Phase 6：探勘軌跡與快捷流程（V035）

**目標**：探勘路徑自動記錄，可存為快捷流程

| 項目 | 內容 |
|------|------|
| DB | V035 migration：trail + shortcut 表 |
| API | Trail 記錄 + Shortcut CRUD + execute 端點 |
| UI | 軌跡面板 + 快捷流程管理頁 + 重放功能 |
| 驗證 | 儲存的快捷流程可成功重放 |

### 實作順序與依賴

```
Phase 1 (Template Pool)
  ↓ 必須先完成
Phase 2 (SQL Function Registry)
  ↓ 必須先完成
Phase 3 (AI 輔助)          Phase 4 (探勘鏈)     Phase 5 (聚合)
  │ 可並行                    │ 可並行              │ 可並行
  └──────────────────────────┴────────────────────┘
                              ↓ 全部完成後
                        Phase 6 (軌跡 + 快捷)
```

### 預估工作量

| Phase | 預估 | 說明 |
|-------|------|------|
| Phase 1 | 2-3 天 | DB migration + API + Admin UI |
| Phase 2 | 3-4 天 | Function registry + test/deploy pipeline |
| Phase 3 | 3-4 天 | AI 整合 + context package + validation |
| Phase 4 | 2-3 天 | Chain matching + UI field selection |
| Phase 5 | 3-4 天 | Dynamic aggregation + agg_table layout |
| Phase 6 | 2-3 天 | Trail recording + shortcut CRUD + replay |
| **合計** | **15-21 天** | Phase 3-5 可並行，最短路徑約 10-12 天 |

---

## 附錄 A：名詞對照

| 中文 | English | 說明 |
|------|---------|------|
| 模板庫 | Template Pool | 所有 UI template 的中央管理庫 |
| 生命週期 | Lifecycle | draft → review → active → deprecated → archived |
| 探勘鏈 | Exploration Chain | 使用者透過欄位值串接多個 template 的過程 |
| 固定鏈 | Fixed Chain | Admin 預設的 row_drilldown 路徑 |
| 自由鏈 | Free Chain | User 自選欄位值串接的路徑 |
| 探勘軌跡 | Exploration Trail | 自動記錄的完整探勘操作歷史 |
| 快捷流程 | Shortcut Flow | User 儲存的可重放探勘路徑 |
| 狀態機 | State Machine | Config-SM 的核心模型，每一步 = 一個狀態 |

## 附錄 B：安全考量

| 風險 | 緩解措施 |
|------|---------|
| SQL injection via dynamic GROUP BY | `fn_dynamic_aggregate` 所有欄位名經 `information_schema` 驗證 |
| AI 產生的 function 含 DML | 自動驗證規則 + function 必須為 `STABLE` |
| User 透過串接存取未授權資料 | 每次 config-exec 都執行 `authz_check` |
| 探勘軌跡洩漏其他人的操作 | Trail 查詢加 `WHERE user_id = current_user` |
| 快捷流程的參數被篡改 | 重放時每步都重新執行權限檢查 |

## 附錄 C：與 AI Agent（Phase 2）的銜接

本設計的以下元素為未來 AI Agent 整合預留了介面：

| 元素 | AI Agent 用途 |
|------|-------------|
| `authz_data_fn.input_params` | Agent 可讀取所有可用 function 的參數定義 → tool catalog |
| `authz_data_fn.output_columns` | Agent 知道每個 function 回傳什麼欄位 → reasoning input |
| Template 的 `chain_config` | Agent 可自動規劃探勘路徑 → multi-step tool use |
| Exploration Trail | Agent 可分析 User 的探勘模式 → 推薦探勘路徑 |
| Shortcut Flow | Agent 可自動產生快捷流程 → workflow automation |

---

## 附錄 D：功能啟動觸發條件

> 每個功能都有明確的「什麼時候該做」和「什麼時候確定不需要做」的判斷條件。
> 定期回顧此表（建議每 Sprint 檢查一次），決定是否推進。

| 功能 | 對應章節 | 啟動觸發條件 | 不需要做的信號 |
|------|---------|-------------|--------------|
| **Template 生命週期** (draft→active→archived) | §3 | active template 數量 > 25 個，且發生過「改錯 template 影響使用者」事件 | Template 數量長期 < 20，Admin 直接改 DB 沒出過問題 |
| **Template 版本控制** | §3.3 | 發生過 Admin 改壞 active template 且無法回滾的情況 | Admin 都用 git 管理 SQL，DB 層版本控制是多餘的 |
| **AI 輔助 SQL Function 產生** | §4 | (1) 地端 AI 模型已部署且 PL/pgSQL 品質達標 (2) Admin 反映手寫 SQL function 耗時是瓶頸 | Admin 都是 SQL 能力強的 DBA，手寫比審 AI 更快 |
| **自由鏈（User 自選欄位串接）** | §5.2 模式 B | 收到 ≥ 3 次「使用者想從 A template 跳到 B 但沒有預設路徑」的反饋 | 使用者滿足於 Admin 預設的固定鏈路徑 |
| **後端動態聚合 API** | §6.1.3 | 實際查詢的 table 超過 10,000 筆，前端聚合明顯卡頓 | 資料量小，前端 JS 聚合已足夠 |
| **進階聚合語法（窗函數、ROLLUP）** | §6.2 | 使用者需要排名、累計、小計等功能，且 Admin 手寫 custom function 無法滿足 | 所有進階需求都透過 custom SQL function 解決 |
| **探勘軌跡持久化** | §7.1-7.2 | Admin 明確需要分析「使用者最常走哪條探勘路徑」來優化 template 設計 | 前端 breadcrumb（Navigation Stack）已滿足追溯需求 |
| **快捷流程** | §7.3 | 觀察到使用者重複走同一條探勘路徑 ≥ 3 次/週 | 使用者探勘路徑每次都不同，或 Metabase saved questions 已覆蓋此需求 |
| **SQL Function 註冊表（authz_data_fn）** | §10.3 | custom function 數量 > 15 個，Admin 需要集中管理、查看使用狀況 | Function 數量少，直接在 PG 用 `\df` 管理即可 |
| **Admin Template 管理 UI** | §8.2 | Admin 不再接受直接改 DB，需要視覺化管理介面 | Admin 習慣直接操作 DB + seed SQL，UI 管理是多餘的 |

### 如何使用此表

1. **Sprint Planning 時**：逐項檢查觸發條件，有達標的就排入 sprint
2. **使用者反饋時**：對照此表看是否觸發某個功能的啟動條件
3. **架構回顧時**：檢查「不需要做」的信號，如果確認成立，將該功能從候選清單移除
4. **新人 Onboarding 時**：此表說明了「為什麼這些功能還沒做」

---

*本文件是長期願景參考。實際執行計畫見 [`design-data-mining-engine.md`](design-data-mining-engine.md)。*
*設計決策變更請直接更新本文件並於 git commit message 中說明變更原因。*
