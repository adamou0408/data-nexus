# Design: v3 Phase 1 — Data Nexus Universal Platform

**狀態:** Locked (2026-04-22 透過 8 輪 AskUserQuestion 決議)
**Owner:** Adam Ou (adam_ou@aixmoment.com)
**Demo target:** Q2 2027 (2027-05 ± 2 週)
**Runway:** 12 個月 (2026-05 → 2027-05)

本文件是 v3 Phase 1 交付計畫，方向為 **BI + AI**（Tier 1/2/3 BI 產品線 + AI 助理 + Path A 辦死）。

> **與 `docs/requirements_spec.md` 的關係：** requirements_spec.md 描述的「通用型系統設計平台」（Retool / Lucidchart 取向）已於 2026-04-21 會議定為 **誤導 / 需重寫**。本 Phase 1 plan 為新的 SSOT，requirements_spec.md 待 Phase 2 規劃時重新整理或正式 deprecate。

---

## 1. Phase 1 範圍

### 1.1 做什麼

| 工作流 | 成果 |
|--------|------|
| **M4 production-ready** | SEC-06 secrets / Helm chart / Keycloak SSO / LDAP CronJob / Redis cache — Q3 2026 上線，go-live 條件滿足 |
| **Constitution 修訂** | 直接修訂 `docs/constitution.md` 加入 AI Agent 章節（不開 sister doc） |
| **Path A 辦死** | Config-SM 遺表項目、Pool 生命週期頁、Modules tab 轉 Tier 2 `admin 表單模式`。**One-way door，受 G2 gate 管制**（見 §6.2）：Tier 2 admin 表單 Q4 2026 alpha 必須跑過 3-5 個 pilot ≥ 2 週主動使用，gate 通過才能開 migration |
| **BI Tier 1** | 業務 dashboard（自建，連基本引擎都自己寫） |
| **BI Tier 2 雙模式** | 分析 wizard（拖拉 → 視覺化）+ admin 表單 wizard（拖拉 → CRUD UI 與審核流程） |
| **BI Tier 3** | Query Tool（SQL 高手自由查詢，含 AI 輔助、歷史記錄） |
| **AI 傑側欄** | 側欄浮現建議，使用者點接受才動 canvas；AI 產物走 sandbox → 人類審核 → blessed |
| **依賴清查** | 模組/DB 停用時，兩級級聯（有狀態物件人工確認 30d sandbox + 無狀態物件自動取消） |
| **Semantic layer** | 擴充 `authz_resource` 加 `business_term` 欄位 |

### 1.2 不做什麼 (Phase 1 scope out)

- JMP-like SPC / distribution chart（Phase 2，但 ECharts 已選所以路徑通）
- AI SQL generator 的全自動執行（讀取即時執行、寫入一定要人工審核）
- Smart Analyst 2.0（要等 M4 go-live 才解鎖）
- 新建獨立 `bi_semantic_model` 表（延用 `authz_resource`）
- Path A `developer config toolkit` 的保留路線（辦死就辦死）

---

## 2. 架構決策（全部鎖定）

### 2.1 平台取向

- **v3 主線** + M4 minimal freeze（M4 只做 prod-readiness，不加 feature）
- **資料主權：** 資料不上 GCP / AWS 等公有雲；內網 LLM team 的 log 可接受（不含 raw prompt，只 hash）
- **Language：** UX 中文；AI 內部 prompt / retrieval 英文（text-to-SQL 準確率在英文 prompt 高 5-10%）

### 2.2 BI Tier 產品哲學

| Tier | 使用者 | 介面 |
|------|--------|------|
| 1 — 業務 dashboard | 主管、例行觀察者 | 讀取為主，篩選器 + 卡片 + 圖表組合 |
| 2 — 拖拉 wizard | PM、分析師 | 分析模式：維度/度量拖拉 → 視覺化；Admin 表單模式：欄位拖拉 → CRUD UI + 審核流程 |
| 3 — Query Tool | DBA、資料工程師、SQL 高手 | 自由 SQL + AI 輔助 + 歷史記錄 |

三 Tier 共用 design system、semantic layer、authz；但使用者互動完全不同。Tier 2 `雙模式` 的兩個子產品共用同一個 PM + tech lead。

### 2.3 技術選型

| 類別 | 選項 |
|------|------|
| Design system | shadcn/ui + Tailwind + 自訂 Phison 主題 token |
| Chart engine | Apache ECharts（覆蓋到 Phase 2 SPC）|
| Semantic layer | `authz_resource` + `business_term` / `definition` / `formula` / `owner_user_id` 欄位 |
| LLM 整合 | 另一組人 owns GPU + LLM ops；Data Nexus 是 consumer |
| AI visibility | `使用者看不到 = AI 也看不到`（schema list 走 authz_resolve 後的 subset） |
| AI PII | 使用者身分走 authz_check，他看不到的 AI 也看不到；LLM team 不記 raw prompt，只記 hash |

### 2.4 AI UX 雙軌

- **中央 chat：** 使用者打開側邊 AI 助理，純 Q&A + 建議 SQL / module
- **In-context augmentation：** Tier 2 wizard / Tier 3 Query Tool 裡的按鈕（「幫我加 group by」「幫我選圖表」）
- **半連結：** In-context 按鈕的指令會寫入中央 chat 歷史，使用者可回看。但 chat 不能直接改 canvas。
- **AI 動 canvas 的唯一路徑：** AI 在側欄列 1-3 個建議卡片 → 使用者按 ✓ → 才套用。canvas 上不留 AI 標記（接受後跟手動一致）。

### 2.5 AI Authz（Constitution 新章節要寫的）

- **讀取類**（SELECT、schema 檢索、sample 查詢）：走 `authz_resolve(user)` → 自動執行
- **寫入類**（DDL、DML、module 增修刪、DB 連線改動）：走 sandbox → 產生 diff → 人類審核 → blessed 後才執行
- **AI 產物：** 一律先進使用者個人 sandbox；要發布到全公司需走 business_term / dashboard blessing 流程
- **Audit log：** AI 動作全記，永不刪除

### 2.6 依賴清查級聯規則

| 類型 | 例子 | 停用時行為 |
|------|------|------------|
| **無狀態** | Path A 遺表項目、Path B API routes、AI retrieval index、scheduled jobs | 自動取消 / 移除 / 暫停 |
| **有狀態** | 使用者存的 dashboard、saved SQL function、Tier 2 / Tier 3 artifacts | 30 天 sandbox + owner 通知 + 其他使用者訪問影響預覽 + 30 天後自動歸檔 |
| **Audit log** | 所有級聯動作 | 永遠保留 |

### 2.7 Semantic layer 生命週期

- **Schema：** `authz_resource` 加 `business_term / definition / formula / owner_user_id / status` 欄位
- **Status：** draft → under_review → blessed → deprecated
- **流程：** DBA 獨變（gatekeeper），業務 propose ticket 提出需求；業務不能直接改 blessed term
- **消費：** Tier 2/3 wizard 只顯 blessed；sandbox 可看 draft
- **Audit log：** 每次變動都記

### 2.8 LLM team 契約

Data Nexus 不持有 GPU / LLM ops，但用 SLO 契約約束品質：

| 項目 | SLO |
|------|-----|
| text-to-SQL 準確率 | ≥ 85% on Data Nexus eval set (200 筆) |
| Embedding recall@10 | ≥ 0.90 on Data Nexus retrieval set |
| p99 latency | ≤ 3s (SQL gen) / ≤ 500ms (embedding) |
| Model swap | 需通知 + 重跑 eval set，fail = 不接收 |

**Eval set 交付：**
- DBA 100 筆（從現有 Path B / Tier 3 真實 SQL pattern 收集）
- 業務員 100 筆（PM 說人話的問句 + 期待 SQL + 期待結果）
- 2026-08 交付（Phase 1 前 2 個月）
- 以後每季增補 20-50 筆

---

## 3. 實作順序（12 個月）

### Q3 2026（2026-05 → 2026-09）— **基座 + M4**

**最高優先：M4 production-ready 收尾。**

| Work | Owner |
|------|-------|
| SEC-06 secrets（Vault / external-secrets）| SRE |
| Helm chart | SRE |
| Keycloak SSO（取代 X-User-Id header）| SRE + authz-api |
| LDAP CronJob | identity-sync |
| Redis cache | authz-api |
| Constitution v2（加 AI 章節）| Adam + 法務/安全 |
| Design system (shadcn/ui + Tailwind token) 第一批基礎元件 | frontend |
| `authz_resource` schema migration（加 business_term 欄位）| DBA |
| 依賴清查 schema（`resource_cascade_policy` 表 + cleanup jobs）| backend |
| eval set 200 筆蒐集 | DBA + PM |

**M4 Q3 2026 結尾上線 → Smart Analyst 2.0 roadmap 解鎖。**

### Q4 2026（2026-10 → 2026-12）— **Tier 2 分析 wizard MVP**

| Work | Owner |
|------|-------|
| Tier 2 分析模式 wizard（維度/度量/filter 拖拉）| Tier 2 PM + frontend |
| ECharts 整合（line / bar / pivot / heatmap）| frontend |
| `business_term` governance workflow（DBA 獨變 + 業務 ticket）| backend + DBA |
| Path A migration 工具（Config-SM schema → Tier 2 admin 表單草稿）| backend |
| Tier 2 dashboard 存取（save / share / 權限注入）| backend |

**里程碑：** Q4 2026 底 Tier 2 分析模式可對內 alpha。

### Q1 2027（2027-01 → 2027-03）— **AI + Path A 辦死**

| Work | Owner |
|------|-------|
| LLM adapter 層（LiteLLM 或自建）| backend |
| AI 傑側欄 UI（建議卡片 + ✓/✗）| frontend |
| AI schema visibility（authz-aware schema listing）| authz-api |
| Central chat + in-context augmentation buttons | frontend |
| **Gate G2 check：** Q4 2026 Tier 2 admin 表單 alpha 是否跑過 3-5 個 pilot ≥ 2 週主動使用 | Adam + Tier 2 sub-PM B |
| Tier 2 admin 表單模式（gate 通過後 Path A migration 開跑）| Tier 2 sub-PM B + frontend |
| Path A 遺表項目逐一轉 Tier 2 admin 表單（gate 通過後才開）| Tier 2 sub-PM B |
| eval set 驗收 + LLM SLO 簽契約 | Adam + LLM team |

**里程碑：** Q1 2027 底 Path A 辦死完畢，Tier 2 雙模式全上線。

### Q2 2027（2027-04 → 2027-05）— **Tier 3 + Tier 1 + Demo**

| Work | Owner |
|------|-------|
| Tier 3 Query Tool (SQL + AI 輔助 + 歷史記錄) | backend + frontend |
| Tier 1 自建 dashboard 引擎（篩選器、卡片、圖表組合、權限注入）| frontend |
| 首批 Tier 1 業務 dashboard（2-3 個核心 KPI）| Tier 2 PM + 業務 owner |
| End-to-end 演練 + bug bash | 全員 |
| Demo（2027-05）| Adam |

---

## 4. 團隊與擁有權

| 角色 | 人 | 範圍 |
|------|----|------|
| 總 owner | Adam Ou | Phase 1 整體、Constitution、跨團隊契約、demo |
| **Tier 2 sub-PM A**（分析 wizard）| **全量找新人**（2026-04 kick-off hiring，2026-08 前到位）| Tier 2 分析模式 wizard 端到端 owner |
| **Tier 2 sub-PM B**（admin 表單 + Path A migration）| **全量找新人**（2026-04 kick-off hiring，2026-08 前到位）| Tier 2 admin 表單模式 + Path A 遺表項目 migration |
| Tier 2 共用 tech lead | （待定，可從現有 frontend / backend 內升）| 兩位 sub-PM 共用，負責技術一致性 |
| SRE / infra | （另一組人）| M4 prod-ready（SEC-06 / Helm / Keycloak / Vault） |
| LLM ops | （另一組人）| GPU + 模型部署，對 Data Nexus 交 SLO |
| DBA | （現有 DBA 團隊）| business_term 獨變 + eval set 100 筆 |
| 業務員 / PM | （業務域 owner）| eval set 100 筆 + business_term propose |

> **Hiring critical path：** 兩位 sub-PM 從 JD 到到職 Phison 內部通常 3-6 個月。Tier 2 MVP Q4 2026 上線 = sub-PM 必須 2026-08 前報到 = **2026-04（now）就要丟 JD 給 HR**。延遲 1 個月 = Tier 2 MVP 至少 delay 1 個月，Q2 2027 demo 連動受壓。

---

## 5. 風險與應對

| 風險 | 機率 | 影響 | 應對 |
|------|------|------|------|
| **Tier 2 sub-PM hiring 延遲** | 高 | Tier 2 MVP delay → Q2 2027 demo 連動 delay | 2026-04 立刻丟 JD；2026-06 中若無候選人，啟動內升 + contractor plan B |
| **Path A 辦死是 one-way door** | 中 | Tier 2 admin 表單模式不夠成熟就遷，使用者反彈 | **Gate：** Tier 2 admin 表單 Q4 2026 alpha 必須跑 3-5 個 pilot 真實 admin 工作流 ≥ 2 週，使用者主動回來用 = 通過；通不過則 Path A 留命直到通過 |
| Tier 1 自建 scope 過大 | 高 | Q2 2027 demo 趕不上 | 維持自建決策；回退選項：Tier 1 暫用 Tier 2 拼出的 dashboard，真正的 Tier 1 引擎 Phase 2 再做 |
| LLM team 給的模型不達 SLO | 中 | AI 功能品質差，可能整個 AI 線退場 | eval set + SLO 契約已鎖定；fail = 不接收，要求回退上一版；Phase 1 demo 不依賴 AI 為核心 demo path |
| **LLM team GPU / 模型落地延遲** | 中 | Q1 2027 AI 上線 delay | 2026-09 前與 LLM team 簽 commitment 文件 + 季度同步；無模型則 demo 用 mock UI |
| Path A migration 漏掉使用中的頁面 | 中 | 某些 admin 工作流斷掉 | 先 inventory 現有 Path A 頁面（Q3 2026）→ Q1 2027 migration → Q2 2027 壓測 |
| business_term DBA 成 bottleneck | 中 | semantic layer 成長停滯 | 觀察 Phase 1 實際 ticket 量；Phase 2 評估是否鬆綁 |
| 資料 PII 洩漏到 LLM log | 低 | 法務/合規事故 | authz_check inheritance + hash-only prompt log；定期抽查 |

---

## 6. 下一步（2026-04-22 起立刻開始）

1. **本週（2026-04-22 → 2026-04-26）：**
   - 把本文件在週會上過給相關人（SRE / DBA / LLM team owner / HR）
   - **HR：丟兩個 Tier 2 sub-PM JD**（critical path，不能拖）
   - 把 `requirements_spec.md` 的 deprecated 註記直接寫到該檔頂部
2. **Week 1-2：** `authz_resource` 加 `business_term` 的 migration 草稿 + Constitution AI 章節草稿（走 Article 8 修訂程序）
3. **Week 3-4：** SEC-06 + Helm chart kick-off；LLM team 簽 commitment 文件
4. **Week 5-8：** Design system 第一批元件 + eval set 收集 kick-off（DBA 100 + 業務 100）
5. **Month 3（2026-07）：** M4 alpha（內部）+ sub-PM 候選人面試收尾
6. **Month 4（2026-08）：** sub-PM 報到 deadline；M4 prod-ready 收尾
7. **Month 5（2026-09）：** M4 上線 → Smart Analyst 2.0 解鎖

---

## 6.1 成功指標（每季 review）

| 指標 | Q3 2026 | Q4 2026 | Q1 2027 | Q2 2027 |
|------|---------|---------|---------|---------|
| M4 prod-ready 完成度 | ≥ 80% | 100% | — | — |
| Tier 2 sub-PM 到位 | hiring 中 | 2/2 到位 | — | — |
| Tier 2 分析 wizard pilot 使用者 | — | ≥ 5 個內部 alpha | ≥ 15 個 | ≥ 30 個 |
| Tier 2 admin 表單 pilot（Path A migration gate）| — | ≥ 3 個工作流 ≥ 2 週主動使用 | gate 通過 → migration 開跑 | Path A 辦死完成 |
| eval set 完成數 | 100/200 | 200/200 | — | — |
| LLM SLO 達成率 | — | — | text-to-SQL ≥ 85%, recall@10 ≥ 0.90 | 維持 |
| business_term blessed 數量 | — | ≥ 20 | ≥ 50 | ≥ 100 |

---

## 6.2 Milestone gates（沒過不能進下一階段）

- **G1（2026-09）：** M4 prod-ready 上線 → 才能開 AI / Smart Analyst 2.0 線
- **G2（2026-12）：** Tier 2 admin 表單 alpha 跑過 3-5 個 pilot ≥ 2 週主動使用 → 才能開 Path A migration
- **G3（2027-03）：** LLM SLO 簽契約達成 → 才能把 AI 列為 demo 主軸
- **G4（2027-04）：** Tier 1 自建引擎能 render 至少 1 個業務 dashboard 端到端 → 才能列為 demo 內容

---

## 7. 追蹤文件

- `docs/constitution.md` — 會被修訂加 AI 章節（走 Article 8 修訂程序）
- `docs/PROGRESS.md` — 每週更新 Phase 1 進度
- `docs/requirements_spec.md` — **Deprecated / 需重寫**（2026-04-21 定為誤導方向，本 Phase 1 plan 取代之）
- `docs/backlog-tech-debt.md` — Phase 1 新發現的 tech debt 進這裡
- `.claude/plans/v3-phase-1/` — 拆分後的實作子計畫（含 Path A migration、Tier 2 wizard 等）

---

## 附錄 A：Phase 2 預覽（不承諾，僅列方向）

- JMP-like SPC / distribution / control chart
- Tier 1 引擎深化（drill-down、cross-filter、real-time）
- AI 全自動寫入路徑（目前一定要人工審核；Phase 2 評估高信賴度類型可自動 apply）
- business_term 鬆綁（若 DBA 成 bottleneck，評估業務角色 co-own）
- requirements_spec.md 願景的重新評估（universal platform 仍在遠景，但要等 BI + AI 站穩）
- 跨 data source federation（目前 Phase 1 只到單一 PG + TimescaleDB）
