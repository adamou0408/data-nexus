# Phison Data Nexus — 功能許願清單

**文件類型**：使用者需求備忘  
**撰寫日期**：2026-04-12  
**來源**：以 Phison 內部實際使用者角度進行的功能缺口分析  
**定位**：本文件不修改核心架構設計，僅記錄各角色在日常使用中的實際需求，供後續 sprint planning 參考。

---

## 目錄

- [IT Admin 需求](#it-admin-需求)
- [部門主管需求](#部門主管需求)
- [一般員工需求](#一般員工需求)
- [DBA 需求](#dba-需求)
- [優先排序總結](#優先排序總結)

---

## IT Admin 需求

### W-IT-01　Policy 變更的完整審計紀錄

**目標角色**：IT Admin / AUTHZ_ADMIN

**問題描述**

目前 `authz_audit_log` 只記錄「誰存取了哪筆資料」（資料面事件），但不記錄「誰修改了哪條 policy / permission / pool profile」（管理面事件）。Pool Management 的所有 CRUD 操作、未來的 policy 編輯操作，目前均無審計紀錄。

當發生「Sales 突然看得到成本欄位」這類異常，IT Admin 查 Audit 頁面什麼都找不到，因為那是 policy 被人改了，不是資料存取事件。這在合規審查時是明顯缺口。

**建議做法**

在以下位置加入 `audit()` 呼叫，action_id 使用 `policy_update`、`permission_grant`、`permission_revoke`、`pool_profile_update`、`credential_rotate` 等管理動詞：

- `routes/pool.ts` 的所有 POST / PUT / DELETE handler
- 未來 policy CRUD API 的所有寫入操作

不需要新增資料表，沿用現有 `authz_audit_log` 即可，`access_path` 填 `'B'`（管理介面走 Path B）。

**預估工作量**：小（在現有 route handler 中各加一行 `audit()` 呼叫）

**業務影響**：安全合規必要項目，缺此功能在 ISMS 審查時會被標記缺失。

---

### W-IT-02　Role Assignment 的批次匯入

**目標角色**：IT Admin

**問題描述**

目前在 Pool Management 頁面新增 Assignment，需要手動逐筆輸入 subject_id（如 `user:wang_pe`），沒有任何輔助選單。

遇到新產線上線或組織改組，一次需要新增 20-30 筆 assignment，目前做法是重複操作表單，耗時且容易輸入錯誤。未來 Policy Admin CRUD 頁面也會面臨同樣問題。

**建議做法**

兩個互補方案：

1. **短期**：Assignment 的 Subject 輸入欄改為下拉選單，選項從 `GET /api/browse/subjects` 撈取，支援模糊搜尋（如 `PE_SSD` 即可過濾出 `group:PE_SSD`）。
2. **中期**：新增批次匯入功能，支援貼入多行 subject_id（一行一個）或上傳 CSV。

**預估工作量**：小（短期方案：改 PoolTab 的 Assignment 表單元件，後端已有 `/api/browse/subjects`）

**業務影響**：日常維運效率，減少人工輸入錯誤，新人 onboarding 時尤其明顯。

---

### W-IT-03　SSOT Drift 主動告警

**目標角色**：IT Admin / DBA

**問題描述**

`v_pool_ssot_check` view 已能偵測 pool 靜態設定與 SSOT 推導結果的差異（`has_drift = TRUE`），但目前只有在使用者主動進入 Pool Management 頁面時才能觀察到，沒有主動提醒機制。

若 DBA 直接修改 DB schema 新增欄位，或有人手動更改 pool `denied_columns`，drift 可能靜默存在數週無人察覺，導致 Path C 的欄位限制與其他路徑不一致，違反 SSOT 原則。

**建議做法**

在 Overview（首頁）Dashboard 加一個「SSOT 健康狀態」卡片：

```sql
SELECT count(*) FROM v_pool_ssot_check WHERE has_drift = TRUE;
```

若結果 > 0，卡片顯示紅色警示，並列出有 drift 的 profile_id 清單，點擊跳轉到 Pool Management。若全部一致，顯示綠色「All paths in sync」。

**預估工作量**：小（Overview tab 加一個 API call 和顯示邏輯，後端加 `GET /api/pool/ssot-check` endpoint）

**業務影響**：直接預防 OPS-2 已知風險（GRANT 漂移），讓 drift 從「等到出事才發現」變成「主動可見」。

---

### W-IT-04　Role Assignment 到期預警

**目標角色**：IT Admin / 部門主管

**問題描述**

`authz_subject_role` 有 `valid_until` 欄位支援有期限授權，但目前沒有任何 UI 顯示哪些授權快要到期。

常見場景：某員工借調期間被授予額外 role（如臨時給 PE 看 Sales 資料），3 個月後授權自然失效，員工在某天突然無法存取資料，開始打 helpdesk ticket，IT Admin 還要花時間查「這是 bug 還是預期行為」。

**建議做法**

Overview Dashboard 加「近期到期授權」卡片，顯示 7 天內將到期的 subject_role 記錄：

```sql
SELECT subject_id, role_id, valid_until
FROM authz_subject_role
WHERE is_active = TRUE
  AND valid_until IS NOT NULL
  AND valid_until BETWEEN now() AND now() + interval '7 days'
ORDER BY valid_until;
```

每筆記錄旁邊加「延期」快捷按鈕，點後跳到對應的 assignment 編輯頁。

**預估工作量**：小（新 SQL query + Overview 卡片元件）

**業務影響**：預防突發失權事件，讓 IT 和當事人都能提前處理，而不是等到出問題才反應。

---

## 部門主管需求

### W-MGR-01　我的團隊能看什麼——Permission Summary

**目標角色**：部門主管（PE Lead、PM Lead 等）、HR

**問題描述**

目前要確認某個 LDAP 群組的完整權限，需要：進 Browser tab → 找到 group → 追 roles → 開 Matrix tab 查 role-resource 對應 → 再查哪些 L1/L2 policy 適用。過程繁瑣，且最終結果還是 JSON 格式，非技術主管難以判讀。

常見場景：PE Lead 有新人到職，想快速確認「王工的帳號權限設定是否正確，能看到 SSD 資料但看不到成本欄位」，目前需要請 IT 協助確認。

**建議做法**

在 Browser tab 的 Subject 詳細頁面，加一個「Permission Summary」區塊，直接呼叫 `authz_resolve()` 並將結果轉換為人話：

```
王工（PE-SSD）目前的授權狀態
━━━━━━━━━━━━━━━━━━━━━━━━━━
可存取的功能模組：
  ✅ Lot Tracking（讀取、寫入）— 僅 SSD 資料
  ✅ Yield Analysis（讀取）— 僅 SSD 資料
  ❌ Sales Order — 無存取權

欄位限制：
  🔒 lot_status.unit_price — 隱藏
  🔒 lot_status.cost — 隱藏
```

**預估工作量**：中（新的 React 元件，`authz_resolve()` 已有所有資料，主要是 UI 呈現邏輯）

**業務影響**：減少 IT helpdesk 票量，讓主管能自助確認下屬權限，縮短新人 onboarding 確認流程。

---

### W-MGR-02　臨時授權申請流程

**目標角色**：部門主管、一般員工

**問題描述**

目前若員工需要臨時存取非本角色的資料（如 PE 需短期查看 Sales 報表），唯一方式是請 IT Admin 直接修改 DB，沒有自助申請管道，IT 也沒有標準的審核流程。

常見場景：SSD 發生客戶品質問題，PE Lead 需要緊急查看本週的客戶訂單資料，但他沒有 SALES role。目前做法是傳訊息給 IT，IT 手動改 DB，無法追溯審批紀錄。

**建議做法**

最小可行版本（不需要複雜工作流引擎）：

1. 在 Check tab 或 Permission Summary 頁加「申請存取」按鈕
2. 點後填寫：需要的 role、理由、到期日
3. 送出後建立一筆 `authz_subject_role`（`is_active = FALSE`，等待審核），同時在 `authz_audit_log` 記錄申請事件
4. IT Admin 在 Overview Dashboard 的「待審申請」卡片看到通知，點擊審核（`is_active = TRUE`）或拒絕
5. 結果透過任意通知方式告知申請人（Slack / email / 在 Dashboard 顯示）

**預估工作量**：中（需新增 pending 狀態的 subject_role、前端申請表單、IT Admin 的審核 UI）

**業務影響**：建立可稽核的存取申請流程，同時讓 IT 不再需要口頭交辦，符合 ISMS 要求。

---

## 一般員工需求

### W-USER-01　「為什麼我看不到這個？」權限說明

**目標角色**：所有員工

**問題描述**

員工在 Workbench 頁面看不到某些資料或欄位，目前只顯示欄位被移除（`[DENIED]` 或 column 不出現），沒有任何解釋。員工不知道這是 bug、網路問題、還是權限設定，通常的反應是打 helpdesk 票。

RLS 篩選掉資料的情況更隱性——員工以為自己看到全部資料，其實只看到一部分，因為沒有任何提示說「本表有 X 筆，你只能看到 Y 筆」。

**建議做法**

兩層說明：

1. **欄位層**：在隱藏欄位的位置顯示 tooltip 或說明文字，例如：
   `unit_price: 依授權政策隱藏（聯絡 IT Admin 申請存取）`

2. **資料列層**：在 Workbench 資料表底部加一行統計：
   `顯示 12 筆（共 45 筆，33 筆依 RLS 篩選排除）`
   資料來自 `filtered_count` 和 `total_count`，`rls-simulate` API 已回傳這兩個數值。

**預估工作量**：小（前端 UI 邏輯，所有所需資料 API 已回傳）

**業務影響**：大幅降低使用困惑，每週可能減少 5-10 張「為什麼我看不到資料」的 helpdesk 票。

---

### W-USER-02　My Access Card——我的當前授權狀態

**目標角色**：所有員工

**問題描述**

員工登入後，Overview 頁面目前顯示的是系統統計（subjects 數量、roles 數量等），沒有「我個人現在有哪些授權」的摘要。

當員工從一個部門調到另一個部門，或借調期間，他無法自行確認「我現在到底能看哪些資料」，只能靠試錯或詢問 IT。

**建議做法**

在 Overview tab 的頂部加「我的存取概覽」卡片，登入後自動以當前使用者身份呼叫 `authz_resolve()`，顯示：

- 我的角色：`PE`
- 可存取的模組：Lot Tracking（讀/寫）、Yield Analysis（讀）
- 資料範圍：僅限 SSD 產品線
- 欄位限制：unit_price, cost 隱藏
- 授權到期日：如有 `valid_until` 則顯示倒數天數

`authz_resolve()` 已有所有資料，只差 UI 把 JSON 轉成人話。

**預估工作量**：小（ResolveTab 已有類似邏輯，提取並簡化為 Overview 卡片）

**業務影響**：員工自助了解授權狀態，降低 IT 被動回覆查詢的次數；員工調職後能立即知道新的存取範圍。

---

## DBA 需求

### W-DBA-01　pgbouncer Config 一鍵部署

**目標角色**：DBA / 基礎設施工程師

**問題描述**

目前 Pool Management 的「Generate pgbouncer Config」按鈕只是把 `pgbouncer.ini` 文字內容顯示在畫面上，不會實際更新設定或重啟 pgbouncer。DBA 還需要手動 SSH 進去貼文字、執行 `reload` 指令，才能讓設定生效。

這個「最後一公里」斷點讓 Path C 的整個管理流程仍是半手動的——Pool 設定和 pgbouncer 實際運作狀態不會自動同步。

**建議做法**

在 Sync Ops 頁面加「Apply & Reload」按鈕，後端 API 執行：

1. 呼叫 `authz_sync_pgbouncer_config()` 取得設定文字
2. 將設定寫入 pgbouncer container 的設定檔（Docker volume mount 已在 `docker-compose.yml` 設置，路徑為 `./pgbouncer/pgbouncer.ini`）
3. 對 pgbouncer 發送 `SIGHUP`（或透過 pgbouncer admin console 執行 `RELOAD`）
4. 回傳 reload 結果

開發環境可透過 Docker SDK / exec 實現；K8s 環境則更新 ConfigMap 並 rollout restart。

**預估工作量**：中（需後端新增 deployment 操作 API，因環境差異需區分 local/K8s 模式）

**業務影響**：打通 Path C 管理流程的最後一步，讓「改設定 → 生效」從 2 步變 1 步，避免忘記 reload 導致舊設定繼續生效。

---

### W-DBA-02　pgbouncer 連線池即時監控

**目標角色**：DBA / 運維人員

**問題描述**

pgbouncer 在 port 6432 運行，但 dashboard 完全看不到任何連線狀態：有幾個 active connection、哪個 pool 快到上限、有沒有認證失敗、平均查詢時間是多少。

當 BI Team 跑大量報表導致 `nexus_bi_ro` pool 滿載（max_connections = 5），新查詢會開始排隊或失敗，但 DBA 沒有任何 dashboard 可以即時觀察，只能等到用戶投訴才知道。

**建議做法**

在 Pool Management 頁面加「Connection Monitor」子頁籤，後端透過 pgbouncer admin console 查詢統計資料：

```sql
-- 連接到 pgbouncer 的 pgbouncer 管理資料庫
SHOW POOLS;   -- 每個 pool 的 active/waiting/idle 連線數
SHOW STATS;   -- 每個 pool 的查詢數、流量統計
SHOW CLIENTS; -- 當前活躍的客戶端連線
```

前端顯示每個 pool 的 active / waiting / max 連線數進度條，waiting > 0 時亮警示色。

**預估工作量**：中（後端需建立 pgbouncer admin 連線，前端新增監控面板）

**業務影響**：從「出事才知道」改為「即時可見」，讓 DBA 在 pool 達到瓶頸前就能處理，避免 BI 報表無預警失敗。

---

### W-DBA-03　建立 Pool Profile 時自動提示初始化 Credential

**目標角色**：DBA

**問題描述**

目前建立新 pool profile（如 `pool:qe_readonly`）和設定對應的 pgbouncer 憑證（`authz_pool_credentials`）是兩個完全分開的操作，中間沒有任何引導。

新手 DBA 或不熟悉流程的人建完 profile 後，忘記去 Credentials 頁面設定初始密碼，pgbouncer 認證就會失敗，而且失敗訊息（`password authentication failed for user "nexus_qe_ro"`）並不直觀，難以快速定位到「喔，credential 沒設」這個根因。

**建議做法**

兩個互補措施：

1. **短期**：建立 Profile 成功後，在 UI 顯示提示訊息：
   > ✅ Profile `pool:qe_readonly` 建立成功。⚠️ 請前往 Credentials 頁面設定 `nexus_qe_ro` 的初始密碼，否則 pgbouncer 無法驗證此連線。

2. **中期**：在 Create Profile 表單中加入「初始密碼」選填欄位，填寫後在 API 中連同 `authz_pool_credentials` 一起插入，一步完成。

**預估工作量**：小（短期方案：改 PoolTab 的 create 成功 callback；中期：後端 API 擴充一個 optional 欄位）

**業務影響**：防止新手操作失誤，避免建完 Profile 卻無法連線的困惑，縮短 Path C 新 pool 的上線時間。

---

### W-DBA-04　Credential 輪替到期提醒

**目標角色**：DBA

**問題描述**

`authz_pool_credentials` 記錄了 `last_rotated` 和 `rotate_interval`（預設 90 天），但 Credentials 頁面目前只顯示 `last_rotated` 的絕對時間，沒有計算剩餘天數或標示哪個憑證快到期。

若 DBA 忘記輪替，憑證過期後（視 pgbouncer 設定而定）可能導致所有 pool 連線失敗，影響 BI 報表和 ETL 流程。

**建議做法**

在 Credentials 列表加「到期狀態」欄位：

```sql
SELECT
  pg_role,
  last_rotated,
  rotate_interval,
  EXTRACT(DAY FROM (last_rotated + rotate_interval - now())) AS days_remaining
FROM authz_pool_credentials;
```

- `days_remaining > 30`：顯示綠色「正常」
- `days_remaining 7-30`：顯示橘色「即將到期」+ 天數
- `days_remaining < 7`：顯示紅色「請盡快輪替」+ 天數
- `days_remaining < 0`：顯示深紅色「已逾期」

**預估工作量**：小（後端 API 加一個計算欄位，前端加顯示邏輯和色彩）

**業務影響**：預防憑證逾期導致 Path C 全面失效，將被動的「出事才輪替」改為主動管理。

---

### W-MGR-03　L3 Composite Action — 核簽工作流

**目標角色**：部門主管、IT Admin、一般員工

**問題描述**

DB 已有 `authz_composite_action` 表（定義核簽鏈：target_action + target_resource + approval_chain + preconditions + timeout_hours），`authz_resolve()` 已查詢並回傳 `L3_actions`，前端 ResolveTab / CheckTab 已能顯示 approval chain 步驟。但目前資料為 0 筆，整個 L3 層是空殼——沒有「發起申請」的機制、沒有「審批紀錄」的儲存、沒有「待辦通知」的入口、`authz_check()` 碰到 L3 action 不會攔截。

業務場景：NPI 閘門審核（E28 SSD 的 G2→G3 需 PE Lead → QA Lead → VP 三步核簽）、Lot Hold/Release（營運請求 → PE 核准）、Price Change（Sales 提案 → Finance 審核 → VP 批准）。這些流程目前全靠口頭或 email，無法在系統內追蹤和稽核。

**建議做法**

#### 第 1 層：DB — 流程狀態追蹤

新增兩張表：

```sql
-- 核簽申請單
CREATE TABLE authz_workflow_request (
    request_id      BIGSERIAL PRIMARY KEY,
    composite_action_id  BIGINT NOT NULL REFERENCES authz_composite_action(id),
    requester       TEXT NOT NULL,              -- 發起人 subject_id
    target_record   JSONB NOT NULL DEFAULT '{}', -- 針對哪筆資料 e.g. {"gate_id": 5}
    current_step    INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected/cancelled/expired
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ                -- 根據 timeout_hours 算出
);

-- 每一步的審批紀錄
CREATE TABLE authz_approval_record (
    record_id       BIGSERIAL PRIMARY KEY,
    request_id      BIGINT NOT NULL REFERENCES authz_workflow_request(request_id),
    step_number     INTEGER NOT NULL,
    approver        TEXT NOT NULL,              -- 審批人 subject_id
    decision        TEXT NOT NULL,              -- approved / rejected
    comment         TEXT,
    decided_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### 第 2 層：API — 核簽流程端點

| Endpoint | 誰用 | 功能 |
|----------|------|------|
| `POST /api/workflow/request` | 發起人 | 提交核簽申請 |
| `GET /api/workflow/my-pending` | 審批人 | 我的待審清單 |
| `GET /api/workflow/:id` | 相關人 | 查看申請詳情 + 審批鏈進度 |
| `POST /api/workflow/:id/approve` | 審批人 | 核准當前步驟 |
| `POST /api/workflow/:id/reject` | 審批人 | 駁回（整條鏈中止） |
| `POST /api/workflow/:id/cancel` | 發起人 | 撤回申請 |

關鍵改動：修改 `authz_check()` — 當 action 命中 `authz_composite_action` 時，回傳 `requires_approval` 而不是直接 allow/deny。

#### 第 3 層：Dashboard UI — 3 個新功能區塊

**A. 審批收件匣（Approval Inbox）**
- sidebar 加「Approvals」入口，帶紅色 badge 顯示待審數量
- 列表顯示：申請人、動作、資源、目前步驟、到期時間
- 一鍵 Approve / Reject + 填寫意見

**B. 申請提交（觸發點整合）**
- 嵌在業務操作中，非獨立頁面
- 例如：在 NPI Gate Checklist 點「Pass Gate」→ 系統檢查到這是 L3 action → 跳出核簽申請 modal
- 例如：在 Lot 管理點「Hold Lot」→ 同樣攔截

**C. 流程進度追蹤**
- 視覺化 step progress bar（Step 1: PE ✅ → Step 2: QA ⏳ → Step 3: VP 🔒）
- 在申請詳情頁和相關業務頁面都能看到

#### 第 4 層：整合 — 讓卡控真正生效

| 整合點 | 做什麼 |
|--------|--------|
| Path A (Config-SM UI) | 按鈕渲染前先檢查 L3，顯示「需核簽」而非直接執行 |
| Path B (API middleware) | middleware 攔截 L3 action，回 `403 { reason: "approval_required" }` |
| 過期處理 | 排程檢查 `expires_at`，自動將過期申請標記為 expired |
| Audit 整合 | 核簽過程寫入 `authz_audit_log`，誰在什麼時候簽了什麼 |

**預估工作量**：大（DB 2 張新表 + API 6 個新 endpoint + middleware 改動 + 前端 3 個新元件 + 業務整合）

**業務影響**：高。將目前口頭/email 的核簽流程系統化，可稽核、可追蹤、可自動到期，是 ISMS 合規和流程管控的關鍵功能。

---

## 優先排序總結

以「實作工作量 vs. 解決的業務痛點」排序，同工作量者以影響範圍大者優先。

### 當前開發焦點（2026-04-14 決定）

以下三項為目前優先推進的功能方向，其餘項目暫緩：

| 焦點 | 對應項目 | 說明 |
|------|---------|------|
| **Admin 連線管理** | Data Source Registry UI 完善 | Admin 可在 Dashboard 設定、測試、管理外部資料庫連線資訊 |
| **Data Mining 模組** | Config-SM 商業邏輯頁面 | 以 module 為單位的資料探勘功能，metadata-driven 動態頁面。執行計畫：[`design-data-mining-engine.md`](design-data-mining-engine.md)、長期願景：[`design-data-mining-vision.md`](design-data-mining-vision.md) |
| **Metabase BI 自助開發** | Metabase 整合強化 | 讓 BI 使用者能在 Metabase 自由建立儀表板和報表，降低進入門檻 |

### 完整優先排序

| 優先順序 | 功能 ID | 功能名稱 | 工作量 | 業務影響 | 直接解決的問題 |
|---------|--------|---------|-------|---------|-------------|
| ⭐ 1 | W-USER-01 | 「為什麼看不到？」說明 | 小 | 高 | 每週最多 helpdesk 票的根因 |
| ⭐ 2 | W-IT-01 | Policy 變更審計紀錄 | 小 | 高 | 合規必要、管理面事件完全空白 |
| ⭐ 3 | W-IT-03 | SSOT Drift 告警 | 小 | 高 | 預防 OPS-2 已知風險 |
| ⭐ 4 | W-IT-04 | Role 到期預警 | 小 | 中 | 避免突發失權事件 |
| ⭐ 5 | W-USER-02 | My Access Card | 小 | 中 | 員工自助查詢，降低被動詢問 |
| ⭐ 6 | W-DBA-04 | Credential 到期提醒 | 小 | 中 | 預防 Path C 全線斷線 |
| ⭐ 7 | W-DBA-03 | 建 Profile 自動提示 | 小 | 中 | 防止新手操作造成的 15 分鐘故障診斷 |
| 8 | W-IT-02 | Assignment 批次匯入 | 小 | 中 | 維運效率，組織異動時最有感 |
| 9 | W-MGR-01 | Permission Summary | 中 | 中 | 減少 IT 查詢負擔，主管自助化 |
| 10 | W-DBA-01 | pgbouncer 一鍵部署 | 中 | 高 | Path C 最後一公里，現在仍是半手動 |
| 11 | W-DBA-02 | pgbouncer 連線監控 | 中 | 高 | 生產可視性，從被動變主動 |
| 12 | W-MGR-02 | 臨時授權申請流程 | 中 | 中 | 建立可稽核的存取申請機制 |
| 13 | W-MGR-03 | L3 核簽工作流 | 大 | 高 | NPI 閘門、Lot Hold 等核簽流程系統化 |

**建議優先執行 1-7**：全部是「小工作量」，合計約 2-3 天工程量，但能解決最常見的使用者痛點和現有的合規缺口。

**功能 10-11**（pgbouncer 操作與監控）雖然業務影響高，但涉及 Docker/K8s API 整合，建議在 Milestone 4（Production-ready）時一起規劃。

**功能 13**（L3 核簽工作流）工作量最大，但業務價值高。建議在三個當前焦點項目穩定後再啟動，作為下一階段的重點功能。

---

## 未來方向：AI Agent 整合（Phase 2 — 數據中心上線後啟動）

> **來源**：2026-02-11 內部信件討論（KS Pua → Kelvin → Adam 等），主旨：企業流程 AI 自動化方向研究  
> **決策**：先完成數據中心（Data Nexus）上線，累積資料與經驗後，再啟動「智能分析師 2.0」計畫  
> **狀態**：待啟動（blocked on Data Nexus production 上線）

### 背景

內部討論參考了多 Agent 架構在企業流程自動化的應用案例（如 Intuit QuickBooks 的 AI 財稅平台），該類平台利用多個專責 Agent 協作完成自動化操作、系統整合、AI 分析報告等任務。討論中歸納出一套通用的技術組合：LLM + Ontology + RAG + RPA + HITL（人機協作）。

### 與 Data Nexus 的關係

Data Nexus 作為 Phison 內部數據中心的授權管理層，是未來 AI Agent 整合的前置基礎設施：

1. **資料存取授權**：AI Agent 需要存取企業資料時，需通過 Data Nexus 的三條路徑（Path A/B/C）進行權限控管
2. **資料來源整合**：Data Source Registry 提供了多資料源連線管理能力，未來 Agent 需要整合多種 ERP、資料庫時可復用此架構
3. **稽核追蹤**：AI Agent 的每次資料存取都能透過 audit log 記錄，滿足合規需求
4. **欄位級控管**：denied_columns + column masking 可控制 Agent 能取得哪些欄位，避免敏感資料外洩

### 未來可能的 Agent 整合項目

以下為信件中提及的方向，待數據中心上線後再行評估：

| # | 方向 | 說明 | Data Nexus 關聯 |
|---|------|------|----------------|
| 1 | 自動化操作 | 將人員手動操作流程拆解為 Agent 可承接的任務 | Agent 需 Path B 存取權限 |
| 2 | 系統整合 | 整合多種 ERP、外部資料源 | 復用 Data Source Registry |
| 3 | AI 分析報告 | 自動產生 BI 儀表板和分析報告 | 復用 Metabase BI 整合（Path C） |

### 相關人員

| 角色 | 人員 | 職責 |
|------|------|------|
| 決策 | KS Pua | 提出企業 AI 自動化方向 |
| 協調 | 詹清文 (Kelvin) | 轉發並評估內部應用轉換 |
| 規劃 | 歐瀝元 (Adam) | 應用端 solution 分派、定調「數據中心先行」策略 |
| 研究 | 梁志玄 (zhixuan_liang) | 多 Agent 架構研究、競品分析 |
| 研究 | 王昱筌 (Ricky) | 應用端 solution 研究 |

---

*本文件由工程團隊維護，如有功能變更或優先順序調整，請直接更新本文件並於 git commit message 中說明變更原因。*
