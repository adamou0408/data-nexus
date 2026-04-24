> **DRAFT — Article 8 Amendment Proposal, requires human approval**
>
> **Status**: Proposed (2026-04-22)，2026-04-24 修訂（去除 cross-team ghost path）
> **Target document**: `docs/constitution.md`
> **Amendment vehicle**: Article 8 procedure (per-article human sign-off)
> **Proposed insertion point**: New Article 11, between Article 7 and existing Article 8 (Appendix A reorders accordingly)
> **Source of record**: `docs/plan-v3-phase-1.md` §2.4 / §2.5 / §2.6 / §2.7 / §2.8
>
> 本草稿正文（§11.1–§11.8）為要併入 constitution 的條文，**不受純軟體開發 context
> 影響**（Article 11 的責任歸屬皆為 AI 代理 vs. Adam，不引入外部 team）。
> 下方 Migration Path / Rollout Timeline 是給 Adam 看的執行筆記，已於 2026-04-24
> 改寫為單人純軟體開發模式（無 DBA / backend / frontend / PM / LLM team 角色）。
>
> This file is a draft. Nothing here is binding until the user approves each
> sub-article individually and the content is merged into `docs/constitution.md`
> with a version bump.

---

## Article 11 — AI Agent 操作規範 (AI Agent Operations)

### 11.1 範圍 (Scope)

本章節 binding 於下列 AI 代理：

- 內部 LLM-powered agents（Tier 2/3 wizard 的 in-context AI、中央 chat 助理、
  side-panel 建議卡片產生器）
- Claude Code 及其 sub-agents
- 任何透過 LLM adapter 層（LiteLLM 或等價）存取 `authz_resource`、
  `authz_data_source`、或其下游資源資料的自動化流程

AI 代理操作 `authz_data_source` 時，**同時受 Article 1–7 約束**；本章節為 AI
獨有的額外規範，兩者衝突時以較嚴格者為準。

### 11.2 讀取權限 (Read Authorization)

**原則：使用者看不到 = AI 也看不到。**

- 所有 AI 讀取動作（SELECT、schema 檢索、sample query、embedding / retrieval
  index 查詢）**MUST** 以呼叫使用者身分通過 `authz_resolve(user)`，取得的
  subset 即為 AI 可見資料上限。
- AI **MUST NOT** 列舉、暗示、或於 prompt 上下文中洩漏使用者無權存取的
  resource_id、column、schema、dashboard、saved query。
- Retrieval / embedding index **MUST** 於建構時即依 authz subject 分片；
  不得以 post-filter 遮蔽作為唯一防線。
- 違反本條視同 Article 6 定義的 `agent_unauthorized` 事件。

### 11.3 寫入權限 (Write Authorization)

所有 AI 發起的寫入類動作 —— DDL、DML、`authz_resource` 增修刪、模組啟停、
dashboard / saved query 發布、`business_term` 變更、DB 連線改動 —— **MUST**
走 sandbox → diff → 人類審核 → blessed 的四段式流程：

1. AI 於使用者個人 sandbox 產出 artifact，**絕不**直接對 shared / production
   schema 套用。
2. 系統產生 diff（before/after），以人類可讀形式呈現（SQL、JSON patch、
   或 UI mock）。
3. 使用者（或 artifact 指定的 reviewer）以 UI 明確點按核可。
4. 核可後才寫入 blessed 區。Article 6 audit 格式同步記錄 `consent_given`。

**禁止**：AI auto-apply、silent write、以「低風險」或「高信賴度」為由繞過
人類審核。Phase 2 若評估放寬，**MUST** 透過 Article 8 再次修訂本條。

### 11.4 AI 產物生命週期 (AI Artifact Lifecycle)

AI 產出的 SQL、dashboard、Tier 2/3 artifact、`business_term` proposal 等
一律走三狀態 lifecycle：

| 狀態 | 可見範圍 | 誰可轉入 |
|------|----------|----------|
| `sandbox` | 僅 artifact owner | AI 自動生成即為此狀態 |
| `under_review` | owner + 指派 reviewer | owner 明確送審 |
| `blessed` | 依 authz_resolve 的對應讀取範圍 | blessing 權責角色（`business_term` 為 DBA；dashboard 為資料域 owner） |

- 每個 artifact **MUST** 有單一 `owner_user_id`；AI 不可作為 owner。
- `blessed` artifact 不得被 AI 直接改寫；任何修改重啟本流程（sandbox →
  review → blessed）。
- Deprecation 走 §2.6 兩級級聯（有狀態 30 天 sandbox + owner 通知）。

### 11.5 Canvas 互動 (Canvas Interaction)

AI 改動使用者 canvas（Tier 1 dashboard、Tier 2 wizard、Tier 3 Query Tool UI
狀態）的**唯一合法路徑**：

1. AI 於側欄列出 1–3 個建議卡片（suggestion card），每張卡片含明確意圖
   描述與 preview。
2. 使用者按下 ✓（接受）才套用；按 ✗（駁回）或不動作即不套用。
3. 套用後 canvas **不留 AI 標記**（與手動操作視覺一致）。

禁止：
- 中央 chat 介面直接改動 canvas 狀態
- In-context 按鈕跳過 suggestion card 直接 mutate
- 無使用者互動的自動建議 auto-apply
- 以連續彈窗「nag」使用者接受

### 11.6 PII / Prompt Log

- LLM team 的 log **MUST NOT** 留存 raw prompt 或 raw model output；僅留
  prompt hash（SHA-256）、metadata（model id, timestamp, token count,
  latency）、及 SLO 相關 metric。
- 使用者能取得的資料範圍已由 §11.2 約束；prompt 中不得夾帶 authz_resolve
  subset 以外的資料。
- 每季至少一次由 Data Nexus owner 抽查 LLM log sample（hash、metadata），
  確認無 raw payload 外洩；抽查結果記入 `authz_audit`。
- 違反本條視為合規事故，**MUST** 立即通報使用者並暫停該 AI 功能線。

### 11.7 Audit Log

- 所有 AI 動作（讀取、寫入 proposal、suggestion card 呈現與使用者決策、
  artifact 狀態轉移、model swap、SLO 違反）**MUST** 記入 `authz_audit`，
  格式對齊 Article 6。
- AI 相關 audit row **永不刪除**，亦不套用 TimescaleDB compression 導致
  個別 row 無法還原的 retention policy。
- Audit row 欄位擴充：
  - `actor_type`: `ai_agent | human | system`
  - `agent_id`: LLM adapter 指派的 agent identifier
  - `model_id`: 當下使用的模型 identifier
  - `consent_given`: `human_explicit | human_via_suggestion_card | agent_auto_read | agent_unauthorized`
- §2.6 級聯動作（無狀態取消、有狀態 30 天 sandbox）同樣以 audit row 留存。

### 11.8 模型更換 (Model Swap)

LLM team 替換或升級底層模型時，**MUST**：

1. 至少提前 5 個工作日通知 Data Nexus owner。
2. 重跑現行 eval set（text-to-SQL 200 筆 + embedding retrieval set），達到
   §2.8 SLO（accuracy ≥ 85%、recall@10 ≥ 0.90、p99 latency ≤ 3s SQL gen /
   ≤ 500ms embedding）。
3. 任一 SLO fail → **拒收**，回退上一版模型；Data Nexus 保留 AI 功能線的
   緊急停用權。
4. 通過 SLO 的新模型上線時，於 `authz_audit` 留 `model_swap` event，並於
   使用者中央 chat 以一次性 banner 告知。

Eval set 每季增補 20–50 筆（§2.8）；model swap 時以最新 eval set 為準，
LLM team 不得挑舊版 eval set 以利其結果。

---

## Amendment Impact Analysis

### 受影響既有 Article

- **Article 1 — Protected Scope**：Article 11 不擴充 protected scope
  定義，但於 §11.3 讓 `authz_resource`、`authz_role_permission` 等原本
  「agents may CRUD freely」的表在 **AI 寫入路徑** 改為需經 sandbox →
  review → blessed。人類工程師直接 commit 走 code review 的路徑不受影響。
- **Article 2 — Operations Requiring Consent**：不衝突。AI 對
  `authz_data_source` 的 Class A 操作 **同時** 適用 Article 2 與 §11.3
  的四段式流程，以較嚴格者為準（實務上兩者等效或 §11.3 更嚴）。
- **Article 6 — Audit Trail**：§11.7 擴充 audit row schema
  （`actor_type`、`agent_id`、`model_id`、新 `consent_given` enum 值）。
  需配套 DB migration 向後相容舊 row。
- **Article 7.4 — Agent-to-agent delegation**：§11.1 明確將 LLM-powered
  sub-agents 納入範圍，與 Article 7.4 一致且更具體。
- **Appendix A — Quick Reference**：Appendix 需新增 AI 決策樹或指引至
  Article 11；視正式 ratify 時再擴充。

### 既有 code / agent 遵循路徑 (Migration Path)

Phase 1 是單人純軟體開發，所有 owner 皆為 Adam。

| 現況 | 合規動作 |
|------|----------|
| Claude Code 目前可直接 UPDATE `authz_resource` | 加 sandbox schema + diff preview + 人類核可 UI；Claude Code prompt 追加 §11.3 強制條款 |
| `authz_audit` 表無 `actor_type` / `agent_id` / `model_id` 欄位 | 新 migration V0xx 加欄位 + backfill 舊 row 為 `actor_type='human'` |
| LLM adapter 尚未建置 | 於 Q1 2027 建置時直接內建 §11.2 authz 注入與 §11.6 hash-only log |
| Retrieval index 無 authz 分片 | 建置前即依 authz subject 分片；不追溯既有 index（Phase 1 前無 prod index） |
| Suggestion card UI 尚未建置 | Q1 2027 設計階段即依 §11.5 實作，禁止 auto-apply 與 nagging |
| Eval set 未成形 | 2026-08 前 Adam 自蒐 200 筆（query log + 既有文件），與 §11.8 model swap 流程同步上線 |

### Rollout Timeline（對齊 plan-v3-phase-1.md §3）

| 階段 | 動作 |
|------|------|
| **2026-04-22 → 2026-05-06**（Week 1–2）| 本草案走 Article 8 逐條審議；通過條文併入 `docs/constitution.md` v2.0 |
| **Q3 2026** | `authz_audit` migration 上線；LLM adapter 設計時即內建 §11.6 / §11.8 約束（無外部契約） |
| **Q4 2026** | Design system 導入 suggestion card 原型（非 AI，先打 UX 模式）；eval set 完成 200 筆 |
| **Q1 2027（AI 上線）** | §11.2 / §11.3 / §11.4 / §11.5 於 AI 側欄與 Tier 2/3 wizard 首發同步生效；§11.8 model swap 流程於 G3 gate 自我驗收 |
| **Q2 2027 Demo** | Article 11 全面 enforce；demo path 不依賴繞過規則的功能 |
| **Phase 2（2027 下半）** | 評估是否放寬 §11.3（高信賴度 auto-apply）或 §11.4（AI 可作為 draft owner）；任何放寬 **MUST** 重走 Article 8 |

### 風險與未解項

- **Suggestion card UX 的 one-way door**：§11.5 禁止 canvas 留 AI 標記，
  若未來需要 AI 貢獻追溯，改動需 Article 8 修訂。建議於 audit log 側記錄
  artifact 的 suggestion_card origin，而非 UI 標記。
- **Hash-only log 的 debug 代價**：§11.6 會讓 LLM team debug 困難；已於
  §2.8 eval set + SLO 作為替代可觀測路徑，但需 Q1 2027 實測驗收。
- **人類審核 bottleneck**：§11.3 的四段式流程若量大，reviewer 成瓶頸。
  Phase 1 先觀察實際量；Phase 2 評估分域 reviewer pool。
