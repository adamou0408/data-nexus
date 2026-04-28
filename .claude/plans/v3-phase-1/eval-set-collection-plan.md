# LLM Eval Set Collection Plan (Dogfood-Driven)

- **Owner:** Adam (tech lead, sole AuthorPanel user 階段)
- **Status:** in-progress (capture infra live 2026-04-28; AI-DOGFOOD-01 同期上線)
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.8, §3 Q3 2026, §6.1
- **Related:** [`ai-pg-function-authoring-dogfood.md`](./ai-pg-function-authoring-dogfood.md), Constitution §9.6 / §9.9
- **Target:** 100 筆 by Q3 2026 末 / 200 筆 by Q4 2026（capture from Adam's daily AuthorPanel use）

---

## Purpose

建立 Data Nexus 專屬的 eval set,用來:

1. 對 LLM team 交付的模型做驗收與回歸測試 (SLO: text-to-SQL ≥ 85%, recall@10 ≥ 0.90)
2. Constitution §9.8 model swap 比對 baseline (新模型上線前必過舊 eval set)
3. 持續追蹤 AuthorPanel AI 助理的 prompt 品質漂移

此集合是 LLM team 契約驗收的唯一標準。

---

## Sourcing Strategy (Dogfood Capture Loop)

> **Phase 1 是純軟體開發** — 無 cross-team interview / DBA nomination / PM 訪談。
> 所有 eval case 來自 Adam（與後續 invite 進來的 internal beta 用戶）日常使用
> AuthorPanel AI 助理時主動點擊 👍 / 👎 verdict 所累積的真實 prompt + response。

### 流程

```
1. Adam 在 DataQueryTab → AuthorPanel 用 AI 助理 (draft / refine / explain)
2. AI 回傳 SQL / Markdown
3. Adam 看結果好壞 → 點 👍 (good) 或 👎 (bad)
4. 前端 POST /api/ai-assist/eval-mark
   → 寫入 authz_eval_case（含 prompt 全文 + response 全文 + verdict）
   → 同步寫 authz_admin_audit_log AI_ASSIST_EVAL_MARK
5. 每週 Adam 跑一次 SQL 出表,看累積筆數 + good:bad ratio
```

### Constitution 對齊

- §9.6 carve-out + §9.9 Eval Case Capture：user-initiated 點擊才能寫全文,
  backend / agent **MUST NOT** 自動觸發
- 權限：使用者只能 mark 自己的 AI call (`authz_ai_usage.called_by = subject_id`)
- 同步 audit log 留軌跡 (`actor_type='human'`, `consent_given='human_explicit'`)

### 為什麼 dogfood-driven 比 cross-team interview 好

| 面向 | DBA / PM 訪談 (原 v1 草案) | Dogfood capture (現行) |
|------|-----------------------------|------------------------|
| 啟動成本 | 高（要寄信、訪談、整理 → 數週） | 0（infra 已 live） |
| 真實性 | 中（受訪者答的不一定是真會問的） | 高（真實 prompt + 真實 verdict） |
| 維運成本 | 高（每季要重啟訪談） | 低（每天有人用就有 case） |
| 對齊 §9 | 需另設 consent flow | 已內建（按鈕 = explicit consent） |
| 風險 | 收到 mock prompt 過 SLO 但 prod 漂移 | 收到的就是 prod prompt |

> 註: master plan v3 §2.8 / §6.1 提到的 "DBA 100 / Business 100" 拆法是
> v3 草案時期的 ghost path,現以本 plan 取代。後續若有 invite 第二位內測
> 用戶,會繼續用同一個 capture loop（不另起 cross-team workflow）。

---

## Format Spec (authz_eval_case → eval set export)

`authz_eval_case` schema (V071):

```sql
case_id        BIGSERIAL    -- eval-NNNN export id
ai_usage_id    BIGINT       -- FK → authz_ai_usage (ON DELETE SET NULL)
feature_tag    TEXT         -- pg_function_authoring, ...
provider_id    TEXT         -- 哪個 LLM provider
model_id       TEXT         -- 哪個模型版本
data_source_id TEXT         -- 對哪個 ds 提問（draft / refine 才有）
prompt_text    TEXT         -- 完整 system + user prompt
response_text  TEXT         -- 完整 LLM 回應
verdict        TEXT         -- 'good' | 'bad'
notes          TEXT         -- Adam 補充上下文
marked_by      TEXT         -- 誰按的
marked_at      TIMESTAMPTZ
```

匯出成 LLM team 用的 YAML：

```yaml
id: eval-0001
source: dogfood
feature: pg_function_authoring
domain: tiptop|inferred-from-data_source_id
verdict: good|bad
prompt: |
  ...full system + user prompt...
response: |
  ...full LLM response...
model: gpt-4o-mini@2026-04
notes: |
  Adam 自評補充
```

匯出腳本 owner / 位置: TBD (Q3 2026 開頭實作; 預設放 `services/authz-api/scripts/export-eval-set.ts`)。

---

## Scoring Methodology

- **text-to-SQL accuracy ≥ 85%:**
  - 對每個 `verdict='good'` case,新模型 re-generate 後對比結果集 shape + row count + deterministic sample
  - Tolerate whitespace / alias / order; reject semantic 差異
- **recall@10 ≥ 0.90 (embedding retrieval):**
  - 對每個 case 的 prompt,檢查 gold `business_term` 是否在 top-10 retrieval
  - 待 RAG 上線（Q3 2026 末）才能跑
- **p99 latency:**
  - SQL gen ≤ 3s, embedding ≤ 500ms (per call)
- **Verdict regression check:**
  - 任何 `verdict='bad'` case 在新模型上仍是 bad → 視為未改善（不算 regress）
  - 舊模型 `verdict='good'` 在新模型變 bad → 視為 regress,blocking

---

## Milestones

- **2026-04-28 (now):** capture infra live (V071 + `POST /eval-mark` + UI 👍/👎)
- **2026-06 月底:** 累積到 30+ cases → 第一次跑現役模型 baseline,記下 score
- **2026-09 (Q3 末):** 100 cases milestone — 啟動 LLM team 初步對話,索取對方 baseline
- **2026-12 (Q4 末):** 200 cases milestone — 與 LLM team 正式簽 SLO 契約 (Gate G3 起跑點)
- **2027-03 (G3):** SLO 達成驗收

進度追蹤: 每週 `docs/PROGRESS.md` 寫一筆當週 case 累積數 + good:bad ratio。

### 驗收 SQL（Adam 每週一次）

```sql
SELECT
  feature_tag,
  COUNT(*) FILTER (WHERE verdict='good') AS good_n,
  COUNT(*) FILTER (WHERE verdict='bad')  AS bad_n,
  COUNT(*)                               AS total
FROM authz_eval_case
GROUP BY feature_tag
ORDER BY total DESC;
```

---

## Quarterly Augmentation Process

- 每季 review：超過 20 筆/季 = 健康；少於 = AuthorPanel 用得不夠
- Source: dogfood capture（持續）+ AI incident postmortem（出事的 prompt 補進 eval set）
- 版控：`eval-v1.0` @ Q4 2026, `eval-v1.1` @ Q1 2027, ...
- Augment 時 dedup（hash prompt_text）

---

## Acceptance Criteria

- 2026-04-28: capture infra live ✅ (V071 applied; `/eval-mark` + UI ready)
- Q3 2026: 100/200 collected, format-validated, 至少 30% verdict='good'
- Q4 2026: 200/200, dedup'd, signed off by LLM team as contract baseline
- 每筆 case 包含: prompt + response + verdict + model_id + ai_usage_id (可回查 audit)

---

## Open items

- [ ] 匯出腳本 `services/authz-api/scripts/export-eval-set.ts`（Q3 2026 開頭）
- [ ] 如何邀請第二位內測用戶（Adam 之外）— 待 AuthorPanel 穩定 1 個月後評估
- [ ] LLM team 初步對話的 owner / kickoff 時間（M4 prod-ready 後再啟動）
- [ ] PII sanitization：目前 dogfood 階段 prompt 不含 row data,僅 schema metadata,
      暫不需要；若未來 prompt 加入樣本資料,要補 hash 步驟
- [ ] Scoring harness CI 集成（Q3 2026 baseline 跑分時實作）
