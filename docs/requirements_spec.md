# 通用型系統設計平台 — 需求規格書

**版本**:v1.0
**日期**:2026-04-21
**定位**:以 DB 為核心、支援組合與 DAG、LLM 輔助設計的通用型系統設計平台

---

## 1. 專案願景與定位

### 1.1 一句話描述
一個讓系統設計師能以 **DB (table / view / function)** 為最小積木,**視覺化組合**成服務、流程、DAG,並由**地端 LLM 協助產出第一版設計**的通用型平台。

### 1.2 目標使用者
| 角色 | 主要任務 |
|------|---------|
| 系統架構師 | 設計系統、建模業務流程、審視整體架構 |
| DB Admin | 審核 schema、調校效能、把關資料品質 |
| 領域專家 | 描述業務需求、驗證設計符合現實 |
| 資深工程師 | 將設計落地為可執行系統 |

### 1.3 使用情境
- **系統設計為主**(非單純 BI / ETL / ML)
- 多方(DBA、領域專家、工程師)協作建模
- 從零設計新系統,或為現有系統反向建模
- 需要即時驗證設計的正確性與一致性

### 1.4 差異化定位
| 對標產品 | 我們多做什麼 |
|---------|-------------|
| draw.io / Lucidchart | 活的架構、可驗證、可連 DB |
| Retool / Supabase | 系統設計抽象、非只是內部工具 |
| Airflow / Dagster | 視覺化建模、LLM 輔助、面向設計而非執行 |
| Hasura / PostgREST | 支援多層抽象、系統設計語意 |

---

## 2. 核心概念

### 2.1 五層抽象模型
```
Layer 5 — 業務流程 (Business Flow)
Layer 4 — 服務 / 領域 (Service / Domain)
Layer 3 — API / 事件 (Interface)
Layer 2 — 邏輯 / 函數 (Logic)
Layer 1 — 資料 (Data: Table / View / Function)
```
每一層都由下一層組成;平台必須支援**多層級切換檢視**(類似 C4 Model)。

### 2.2 節點 (Node) 統一模型
所有 DB 物件、邏輯、服務在平台中都是**節點**,具備:
- `id` — 唯一識別
- `type` — table / view / function / command / query / event / service / ...
- `inputs` / `outputs` — 具備型別的 I/O schema
- `side_effects` — none / reversible / irreversible
- `idempotent` — true / false
- `permissions` — RBAC 列表
- `metadata` — 分類、描述、版本等

### 2.3 組合關係
節點間可透過連線建立關係,平台必須支援:
- 線性 Pipeline(A → B → C)
- 分支與合併(Fan-out / Fan-in)
- 條件分支(Conditional DAG)
- 狀態機(State Machine,取代 cycle)
- 事件驅動(Pub/Sub、Event Feedback)

---

## 3. 功能需求

### 3.1 Metadata Registry (必備)

**目的**:集中管理所有 DB 物件與邏輯物件的描述。

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| MR-01 | 自動掃描 DB schema,提取 table / view / function 定義 | P0 |
| MR-02 | 支援手動補充語意資訊(業務分類、描述、使用場景) | P0 |
| MR-03 | 儲存 function 的參數、回傳型別、副作用、冪等性標記 | P0 |
| MR-04 | 提供 metadata 的 CRUD API | P0 |
| MR-05 | 支援版本控管(schema 演進歷史) | P1 |
| MR-06 | 支援多 DB 來源(PostgreSQL 優先,MySQL、SQL Server 次之) | P1 |

### 3.2 節點視覺化與編輯 (必備)

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| NV-01 | 節點列表檢視,可依類型、分類、標籤過濾 | P0 |
| NV-02 | 節點詳細頁:顯示 schema、參數、範例用法 | P0 |
| NV-03 | 自動產生單一節點的 UI:列表頁(table)、查詢頁(function)、報表頁(view) | P0 |
| NV-04 | 支援 table 到 UI 元件的自動對應(見附錄 A) | P0 |
| NV-05 | 支援 function 四大類別的不同 UI 模式(查詢/計算/動作/報表,見附錄 B) | P0 |

### 3.3 DAG 編輯器 (必備)

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| DAG-01 | 拖拉式畫布,可新增節點、建立連線 | P0 |
| DAG-02 | 連線時即時驗證 I/O 型別相容性,不相容以警示標示 | P0 |
| DAG-03 | 支援分支(一個 output 接多個 input) | P0 |
| DAG-04 | 支援合併(多個 output 進入單一 input) | P0 |
| DAG-05 | 支援條件節點(if / switch) | P1 |
| DAG-06 | 支援循環偵測,禁止非預期 cycle | P0 |
| DAG-07 | 支援 sub-DAG(節點內部可包含子流程) | P1 |
| DAG-08 | 畫布縮放 / 平移 / 迷你地圖 | P0 |

### 3.4 型別系統 (必備)

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| TS-01 | 定義統一型別系統(scalar、row、table、cursor、void) | P0 |
| TS-02 | 支援自訂 struct / enum 型別 | P1 |
| TS-03 | 提供內建轉換節點(scalar_to_table、filter、map、group_by) | P1 |
| TS-04 | I/O 不相容時提供「自動插入轉換節點」建議 | P2 |

### 3.5 設計驗證引擎 (差異化優勢)

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| DV-01 | 型別一致性檢查 | P0 |
| DV-02 | 事件閉環檢查(Publisher 必有 Subscriber) | P1 |
| DV-03 | 非預期循環偵測 | P0 |
| DV-04 | 死節點偵測(定義了但沒被引用) | P1 |
| DV-05 | 單點故障 / 關鍵路徑分析 | P2 |
| DV-06 | 權限矩陣檢查(跨節點權限一致性) | P1 |
| DV-07 | 副作用 / 冪等性警告(非冪等節點重試設計) | P1 |
| DV-08 | 自訂 lint 規則(團隊規範) | P2 |

### 3.6 LLM 協作輔助 (差異化優勢)

**目的**:讓地端 LLM 協助 DB Admin 產出第一版設計,縮短 DBA 與領域專家的協作迴圈。

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| LLM-01 | 整合地端 LLM(Ollama / vLLM 相容介面) | P0 |
| LLM-02 | 支援從自然語言產生 schema 草稿(DDL + ER 圖) | P0 |
| LLM-03 | 支援從自然語言產生 function 簽名與實作骨架 | P0 |
| LLM-04 | Prompt 範本庫(依業務領域分類) | P1 |
| LLM-05 | RAG 機制:餵入內部規範、歷史 schema、領域文件 | P1 |
| LLM-06 | LLM 產出的設計必須通過 lint / validation 後才能定版 | P0 |
| LLM-07 | 版本比較:LLM 新版 vs 舊版 diff | P1 |
| LLM-08 | 協作註解:DBA 與領域專家可於節點上留言對話 | P1 |
| LLM-09 | 支援推薦模型:Qwen 2.5 Coder 32B、DeepSeek Coder、Llama 3.3 70B、Codestral 22B | P0 |
| LLM-10 | 資料隔離:DB schema 與業務描述不離開地端 | P0 |

### 3.7 節點自動生成 UI (必備)

**table 類型節點的自動 UI**:
- 列表頁(可搜尋、篩選、分頁、匯出)
- 詳細頁(含關聯資料)
- 表單頁(新增 / 編輯)

**view 類型節點的自動 UI**:
- Dashboard / 報表檢視

**function 類型節點的自動 UI**(依子分類):
- 查詢型 → Query Tool 頁面(參數表單 + 結果表格)
- 計算型 → Inline Widget(嵌入其他表單)
- 動作型 → Action Button + 確認對話框
- 報表型 → Report Builder(參數 + 多種視覺化)

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| AUG-01 | 自動判別 function 子類型(依 metadata) | P0 |
| AUG-02 | 參數自動產生表單元件(見附錄 A) | P0 |
| AUG-03 | 結果展示支援表格 / 圖表 / 下鑽 | P0 |
| AUG-04 | 動作型 function 依危險度自動選擇確認流程(見附錄 C) | P0 |
| AUG-05 | 長時間執行的 function 自動切換為非同步 + 通知 | P1 |

### 3.8 動作安全框架 (必備)

所有「動作型」節點必須納入統一的安全框架(見附錄 C 分級)。

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| AS-01 | 四級危險度分級(safe / moderate / dangerous / critical) | P0 |
| AS-02 | 依級別觸發對應確認流程 | P0 |
| AS-03 | 所有動作自動寫入 audit log | P0 |
| AS-04 | 可逆動作提供 undo 機制(時限內) | P1 |
| AS-05 | 不可逆動作要求明確驗證(輸入名稱 / 2FA) | P0 |
| AS-06 | 失敗處理:錯誤訊息本地化、不暴露 SQL 錯誤 | P0 |

### 3.9 執行與編排 (可選)

若平台不只是設計工具、也要可執行,則需:

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| EX-01 | 整合現有 orchestrator(建議 Dagster 或 Temporal,不自建) | P2 |
| EX-02 | 同步執行 / 非同步執行 / 排程觸發 | P2 |
| EX-03 | 失敗重試策略(依副作用標記) | P2 |
| EX-04 | Saga 補償機制 | P2 |
| EX-05 | Checkpoint:失敗後從斷點續跑 | P2 |
| EX-06 | Lineage 追蹤:資料血緣視覺化 | P2 |

### 3.10 協作功能

| 需求 ID | 描述 | 優先級 |
|--------|------|--------|
| CO-01 | 多人同時檢視同一設計 | P1 |
| CO-02 | 設計的版本控制與 diff | P0 |
| CO-03 | 節點層級的註解與討論 | P1 |
| CO-04 | 影響分析:改 A 會影響哪些 B | P1 |
| CO-05 | 範本庫:CQRS、Saga、Event Sourcing、Pub/Sub 等 pattern | P1 |

---

## 4. 非功能需求

### 4.1 效能
- 節點數量支援:單一設計檔至少 500 個節點流暢運作
- DAG 驗證延遲:500 節點內 < 1 秒
- LLM 回應延遲:可接受 5–30 秒(地端模型)

### 4.2 資料安全
- DB schema 與業務描述**不得離開地端**
- 敏感欄位標記與自動遮罩
- 所有動作寫入 audit log
- RBAC 權限至欄位層級

### 4.3 擴充性
- 節點類型可透過 plugin 擴充
- LLM 模型可替換(Ollama 相容介面)
- DB 來源可擴充(優先 PostgreSQL)

### 4.4 可用性
- 使用者無須會 SQL 也能使用(針對領域專家)
- DBA 可隨時下降到 SQL 層級查看 / 編輯
- 中文 UI(繁體中文優先)

---

## 5. 技術棧建議

### 5.1 前端
| 類別 | 選型 |
|------|------|
| 框架 | React 或 Vue 3 |
| DAG 編輯器 | React Flow(reactflow.dev) |
| 圖表 | D3.js / Cytoscape / ECharts |
| Code Editor | Monaco Editor |
| UI 元件庫 | 依團隊熟悉度(Ant Design / shadcn/ui) |

### 5.2 後端
| 類別 | 選型 |
|------|------|
| API | GraphQL(推薦)或 REST |
| 資料庫 | PostgreSQL 15+(含 metadata + 使用者資料) |
| 事件 | NATS / Redis Streams / Kafka |
| Orchestrator(選配) | Dagster / Temporal |
| 快取 | Redis |

### 5.3 DSL / Schema
| 類別 | 選型 |
|------|------|
| Schema 描述 | JSON Schema / YAML |
| API 描述 | OpenAPI + AsyncAPI |
| 架構描述 | Structurizr DSL(參考) |

### 5.4 LLM 整合
| 類別 | 選型 |
|------|------|
| 推論框架 | Ollama(入門)/ vLLM(生產) |
| 推薦模型 | Qwen 2.5 Coder 32B(首選)、DeepSeek Coder V2 16B、Llama 3.3 70B |
| RAG | LangChain / LlamaIndex / 自建 |
| 向量 DB | pgvector(整合 PostgreSQL) |

### 5.5 硬體(地端 LLM)
- 最低:單張 RTX 4090 24GB(可跑 14B–22B 量化模型)
- 推薦:2× RTX 4090 或 1× A100 40GB(可跑 32B)
- 進階:A100 80GB / H100(可跑 70B)

---

## 6. 分階段交付

### Phase 1 — 資料層(2–3 個月)
**目標**:讓 DB 物件可被認識與單獨使用

- Metadata Registry(自動掃 DB)
- Function signature 提取
- 單一節點的自動 UI(列表、詳細、表單、Query Tool)
- 基本型別系統
- 動作安全框架 MVP

**交付標準**:可掃入既有 DB,為每張 table / view / function 自動生成可用的 UI 頁面。

### Phase 2 — 組合層(3–4 個月)
**目標**:節點可視覺化組合

- React Flow 畫布
- 節點間連線 + 型別驗證
- 線性 pipeline 執行
- 分支 / 合併支援
- DAG 驗證引擎

**交付標準**:使用者能拖拉 5–10 個節點組成 pipeline,型別錯誤立即提示。

### Phase 3 — 系統建模層(3–6 個月)
**目標**:支援系統設計抽象

- C4 Model 多層級檢視
- 結構性節點(Entity / Service / Bounded Context)
- 事件與 Command 概念
- Pattern 範本庫(CQRS、Saga、Event Sourcing)
- 版本控制與 diff

**交付標準**:可用平台完整描述一個中型系統(10+ service、50+ entity)。

### Phase 4 — LLM 協作(與 Phase 1–3 並行)
**目標**:地端 LLM 協助 DB 設計

- Ollama 整合
- 自然語言 → schema 草稿
- Prompt 範本庫
- RAG(內部規範餵入)
- LLM 產出與 lint 串接
- 三方協作流程(DBA / 領域專家 / LLM)

**交付標準**:DBA 可在 30 分鐘內基於自然語言描述產出可審核的第一版 schema。

### Phase 5 — 執行與智慧化(6 個月後)
- Orchestrator 整合
- Lineage 追蹤
- 影響分析
- Drift detection(設計 vs 實際同步)
- AI 架構建議

---

## 7. 關鍵決策點

在實作前需明確回答:

| 決策 | 選項 | 建議 |
|------|------|------|
| 設定方式 | DB metadata / 程式碼設定 | **DB metadata**(便於 UI 管理) |
| UI 客製化 | 完全自動 / 可覆寫 | **可覆寫**(80% 自動、20% 手動) |
| 權限粒度 | 頁面 / 欄位 / row-level | **欄位 + row-level**(企業需求) |
| 多租戶 | 單實例 / 租戶隔離 | 依規模決定,初期單實例 |
| 設計與執行 | 僅設計 / 僅執行 / 雙向 | **雙向**(最有價值) |
| DSL 真相來源 | 視覺化 / DSL 文字 | **DSL 為真相,視覺化為投影** |

---

## 8. 風險與緩解

| 風險 | 影響 | 緩解策略 |
|------|------|---------|
| LLM 產出錯誤 schema | 中 | 強制 lint 通過、DBA 審核、版本控制 |
| 500+ 節點時 UI 卡頓 | 中 | 分層檢視、動態過濾、虛擬化渲染 |
| 設計與實際系統 drift | 高 | 反向工程優先、定期 drift detection |
| 地端模型效果不足 | 中 | 允許接外部 API(但標記資料敏感等級) |
| 使用者學習曲線 | 高 | 提供範本、互動教學、從簡入繁 |

---

## 9. 成功指標

### 9.1 短期(Phase 1–2 完成)
- 某既有 DB(50+ tables)可在 1 天內完成掃描 + UI 生成
- 非 SQL 使用者可完成基本 CRUD 操作
- DAG 組合 20 個節點內無效能問題

### 9.2 中期(Phase 3–4 完成)
- DBA 產出第一版 schema 時間從 80 小時降至 30 小時(≥ 60% 效率提升)
- 領域專家可獨立完成需求描述 → 草稿驗證迴圈
- 設計 review 的迭代次數從 5–10 次降至 2–3 次

### 9.3 長期
- 平台可建模完整業務系統(含 ≥ 5 個 bounded context)
- 設計到可執行系統的路徑暢通
- 社群 / 團隊建立 pattern 範本庫

---

## 附錄 A:欄位型別 → UI 元件對應表

| 資料型別 | UI 元件 |
|---------|--------|
| VARCHAR(短) | Input |
| TEXT(長) | Textarea / Rich Editor |
| INT / DECIMAL | Number Input / Slider |
| DATE / DATETIME | Date Picker |
| BOOLEAN | Toggle / Checkbox |
| ENUM / FK(少) | Radio / Select |
| FK(多) | Autocomplete / Modal Picker |
| JSON | 結構化表單 / Code Editor |
| BLOB / FILE | Upload / Preview |
| ARRAY | Tag Input / Multi-select |
| GEO | Map Picker |

---

## 附錄 B:Function 四大類別 UI 模式

### B.1 查詢型 (Query)
特徵:純讀、回傳資料集、有篩選參數
UI:Query Tool 頁(參數區 + 執行鈕 + 結果表格 + 匯出)
常用功能:儲存查詢條件、URL 分享、匯出 CSV、結果當下一 function 輸入

### B.2 計算型 (Calculation)
特徵:純讀、小物件、快速、常嵌入
UI:Inline Widget(嵌於其他表單即時計算)
常用功能:debounce、快取、失敗 fallback

### B.3 動作型 (Action / Mutation)
特徵:有副作用、改變狀態
UI:Action Button + 確認對話框
常用功能:危險度分級、audit、undo、權限檢查

### B.4 報表型 (Report)
特徵:彙總、跨表、可能慢
UI:Report Builder(參數 + 多視覺化 + 匯出 + 排程)
常用功能:表格↔圖表切換、下鑽、訂閱、排程寄送

---

## 附錄 C:動作危險度分級

```yaml
level_1_safe:        # 如編輯描述
  confirm: false
  undo: true
  audit: true

level_2_moderate:    # 如核准訂單
  confirm: simple_dialog
  undo: within_5min
  audit: true

level_3_dangerous:   # 如月結、批次刪除
  confirm: typed_confirmation
  undo: false
  require_reason: true
  audit: true

level_4_critical:    # 如永久刪除使用者
  confirm: typed_exact_match
  undo: false
  require_reason: true
  require_2fa: true
  notify_admin: true
  audit: true
```

---

## 附錄 D:協作流程 SOP

```
1. 需求收集(領域專家主導)
   └─ LLM 輔助:訪談整理、追問澄清

2. 第一版草稿(LLM 主導)
   └─ 產出:ER 圖、DDL、function 簽名草稿

3. DBA 審核
   ├─ 正規化、索引、約束、命名
   ├─ 效能、安全、合規
   └─ Lint 通過

4. 領域驗證
   ├─ 欄位語意
   ├─ 業務規則
   └─ 例外情境

5. 三方迭代
   └─ 每次修改 → LLM diff → DBA 審核 → 領域驗證 → 定版
```

---

## 附錄 E:常見系統設計 Pattern 範本

平台應內建以下 pattern 範本供一鍵套用:

1. **CRUD Service** — 基本讀寫服務
2. **CQRS** — 讀寫分離
3. **Event Sourcing** — 事件溯源
4. **Saga** — 長流程協調(含補償)
5. **Pub/Sub** — 事件廣播
6. **Request-Reply** — 同步請求回應
7. **State Machine** — 狀態機(訂單、工單等)
8. **Pipes & Filters** — 資料轉換鏈
9. **API Gateway** — 對外閘道
10. **Outbox Pattern** — 事務性訊息

---

## 附錄 F:與既有工具的整合考量

| 工具類別 | 整合方式 | 優先級 |
|---------|---------|--------|
| Git | 設計檔版本控制 | P0 |
| PostgreSQL | Metadata 與資料來源 | P0 |
| Ollama | 地端 LLM | P0 |
| Dagster / Temporal | 執行引擎(選配) | P2 |
| Backstage | 企業服務目錄同步 | P3 |
| OpenAPI / AsyncAPI | API / 事件規格匯出 | P1 |
| draw.io / Mermaid | 架構圖匯出 | P1 |

---

## 文件變更紀錄

| 版本 | 日期 | 變更說明 |
|------|------|---------|
| v1.0 | 2026-04-21 | 初版 |
