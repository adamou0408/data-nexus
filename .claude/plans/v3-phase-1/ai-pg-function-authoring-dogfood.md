# AI 輔助 PG Function 建立（Dogfood Phase）

- **Planner Owner:** Adam (本 session 起草)
- **Executor Owner:** TBD（Adam self 或下一個 executor session）
- **Status:** READY-FOR-REVIEW
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.4 / §2.5 / §3 Q1 2027（提前到 Q3 2026 dogfood）
- **Target:** 2026-Q3 dogfood（Adam 自用 PG function authoring 加速器）
- **Created:** 2026-04-28
- **Last updated:** 2026-04-28

---

## 1. Problem / Why

Adam 在 Phase 1 自己寫/改 PG function 是 hot path：discover-and-promote 之外，也常常為了 Flow Composer 拼一條工作流而手刻 `CREATE OR REPLACE FUNCTION ...`。

**痛點：**
- 每個 function 要先查 schema、cast 型別、決定 `parsed_args` 寫法、選 volatility — 純 boilerplate
- 寫錯一段就 deploy 失敗，回頭修 → 重 deploy 循環
- semantic_type / kind 標註是純記憶力活
- DataQueryTab 的 `AuthorPanel` 已經有 textarea + Deploy 按鈕，但是空白起點，沒有起草輔助

**為什麼現在做：**
- `authz_ai_provider` / `authz_ai_usage` 已 V052 落地（template 已 seed）
- DataQueryTab AuthorPanel + `/api/data-query/functions/deploy` 已就緒，AI 只需在「寫 SQL」這層注入
- Adam 自己每天用，等於 Phase 1 自己加速 Phase 1
- Constitution Article 11 草稿已寫，sandbox→diff→human review 規範可直接套用

**對 master plan 的偏移：**
- 官定 AI 側欄 排程是 **Q1 2027**，本 plan 提前 ~9 個月，但 **scope 鎖極小**：只在 DataQueryTab AuthorPanel 內、只 Adam 自用、不上 suggestion-card UX、不開中央 chat
- 不影響 G1（M4 prod-ready Q3 2026）/ G2（Tier 2 alpha Q4 2026）/ G3（LLM SLO Q1 2027 demo gate）— 因為這條 dogfood **不列 demo path**，純內部自用工具
- master plan §1.2「AI SQL generator 全自動執行」仍排除 — 本 plan 不違反，因為 **Deploy 仍人工把關**

---

## 2. Scope

**In scope（dogfood phase）：**
- [ ] DataQueryTab AuthorPanel 加 AI 區塊：自然語言 textarea + Generate 按鈕 → 把 draft SQL 填入主 SQL textarea
- [ ] Refine 按鈕：對現有 SQL 加 instruction（「加 limit 100」「把 varchar cast 成 text」）→ 回新 SQL
- [ ] Explain 按鈕：對現有 SQL 產生 Markdown 解釋 / 列預期輸入輸出
- [ ] 後端 `routes/ai-assist.ts` 三個 endpoint（draft / refine / explain）
- [ ] AI 呼叫走 `authz_ai_provider`（`purpose_tags @> ['sql_authoring']`），usage 記到 `authz_ai_usage`
- [ ] Schema context builder：撈使用者 authz-visible 的 ds tables/columns（含 pgType + semantic_type）作為 system prompt 的 context block
- [ ] Audit log：每次 call 記 `actor_type='ai_assist'`, `agent_id=<provider_id>`, `model_id=<default_model>`, `consent_given='human_explicit'`（user clicked the button）

**Out of scope（後續排定）：**
- 中央 AI chat docked panel（master plan §2.4 — Q1 2027）
- Tier 2 wizard / Tier 3 Query Tool 內 in-context augmentation buttons（Q1 2027）
- Suggestion-card UX（✓/✗ 卡片，非 textarea 直填）— Q1 2027
- RAG / vector retrieval / semantic_layer-aware retrieval — 等 eval set 200 筆就緒（Q3 2026 末）
- Flow Composer (DagTab) 內 AI 建議下一個 function — Phase 2
- AI auto-deploy / blessing workflow — Constitution §11.3 明文禁止；要走 Article 8 修訂
- PII hash placeholder — dogfood 階段先不做，prompt 只送 schema metadata（無 row data），標 TODO

---

## 3. Design / Approach

### 3.1 UX Flow（DataQueryTab AuthorPanel 內）

```
┌─ Author new function ────────────────────────────────┐
│ ▸ AI helper（可摺疊）                                │
│   [自然語言描述... textarea]                         │
│   [Generate ▼ provider: ai:phison_internal_main]     │
│   ─────────                                          │
│   [Refine: 對下方 SQL 加 instruction] [Explain]      │
├──────────────────────────────────────────────────────┤
│ SQL (CREATE OR REPLACE FUNCTION ...)                 │
│ [textarea — AI 產出填這裡，Adam 仍可手改]            │
│                                                      │
│ [Deploy ▶]  ← 既有按鈕，仍人工確認                   │
└──────────────────────────────────────────────────────┘
```

- AI 產出**永不**直接 deploy；填回 textarea 後等 Adam 點 Deploy + window.confirm
- 可摺疊區塊預設展開；藏 collapse state in localStorage

### 3.2 Backend API

| Endpoint | Body | Response |
|----------|------|----------|
| `POST /api/ai-assist/function-draft` | `{ data_source_id, prompt }` | `{ sql, rationale, provider_id, model_id, usage }` |
| `POST /api/ai-assist/function-refine` | `{ data_source_id, current_sql, instruction }` | `{ sql, diff_summary, provider_id, model_id, usage }` |
| `POST /api/ai-assist/function-explain` | `{ sql }` | `{ markdown, provider_id, model_id, usage }` |

所有 endpoint：
1. `requireAuth` middleware（已有）
2. resolve provider：`SELECT * FROM authz_ai_provider WHERE 'sql_authoring' = ANY(purpose_tags) AND is_active=TRUE ORDER BY is_fallback DESC LIMIT 1`
3. build schema context（draft/refine 用，explain 不用）
4. call provider via `lib/ai-call.ts`（OpenAI-compatible chat/completions）
5. extract SQL from response（regex 抓 `CREATE [OR REPLACE] FUNCTION` block）
6. write `authz_ai_usage` row + `authz_admin_audit_log` row
7. return JSON

### 3.3 Schema Context Builder（`lib/ai-context.ts`）

input: `userId`, `dataSourceId`, `maxTables=50`
output: prompt block（英文 system prompt 友善）

```
You are helping author a PostgreSQL function for data source `<ds_short_id>`.
Available tables (authz-filtered for user `<userId>`):

- schema.table_a (column_x text [semantic: customer_id], column_y int)
- schema.table_b (...)

Existing functions in same schema:
- search_xxx_by_keys(p_key text) → SETOF (...)

Conventions:
- Function naming: snake_case, prefix with intent (search_, get_, fn_)
- Return SETOF or RECORD; declare RETURNS TABLE(...) when multi-column
- Use parsed_args style: p_<param> with explicit types
- SECURITY INVOKER (default)
```

策略：
- tables: `SELECT resource_id, attributes FROM authz_resource WHERE resource_type='table' AND attributes->>'data_source_id'=$1` 再走 `authz_check(userId, 'select', resource_id)` filter
- 上限 50 tables（避免 prompt 爆 token）；超過 50 給警告「請描述更具體 schema 名稱」
- 不送 row data；不送 row counts；不送 PII column 值

### 3.4 Provider Resolution

優先 `purpose_tags @> ['sql_authoring']`，缺則 fallback `is_fallback=TRUE`，仍缺則回 503。

需要 Adam 在 dashboard AIProvidersTab 註冊一個 active provider（template 目前 inactive）。可以：
- Phison 內網 LLM team 端點（provider_kind='openai' 走 OpenAI-compatible）
- 或外部 OpenAI key（dogfood 階段）— 但要符合 master plan §2.1 資料主權（schema metadata 不算 raw data，但若用外部 provider 要 Adam 確認）

### 3.5 Key Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| 提前 Q3 2026 dogfood vs. 等 Q1 2027 | 提前 dogfood | Adam 自用，scope 鎖小，不影響 G1/G2/G3；master plan §3 Q3 2026 「基座 + M4」階段加一條 dogfood 不擠 M4 |
| Suggestion-card UX vs. textarea 填回 | textarea 填回 | dogfood 簡化；Q1 2027 再上正規 ✓/✗ 卡片 |
| 中央 chat vs. inline-only | inline-only | Q1 2027 才開中央 chat；dogfood 不需要 cross-tab persistence |
| RAG vs. flat schema dump | flat schema dump | eval set 還沒 200 筆，retrieval 沒得評估；先驗證 happy path |
| PII hash placeholder | TODO，先不做 | dogfood 只送 schema metadata；row data 不離 DB |
| Provider 來源 | Adam 在 AIProvidersTab 自註冊 | 不寫死 endpoint；走 V052 既有 registry |
| feature_tag for usage log | `pg_function_authoring` | 對齊 master plan eval set 命名 |
| Audit log `consent_given` 值 | `human_explicit` | user 點 button = explicit consent |
| 中文 UX vs. 英文 prompt | 中文 button label / 英文 prompt body | master plan §2.1 |

### 3.6 Open Questions

- [ ] 是否需要把 generated SQL 過 `pg_catalog.format` / dry-run validate（不 deploy 只 PARSE）— 建議 **是**，能在 client 端就抓掉 syntax error。實作放 §5。Owner: Executor session 自決
- [ ] Refine 是否要保留 history（最近 5 次 sql + instruction）— 建議 **localStorage 即可**，後端不存。
- [ ] 是否限制 Adam 自用（hardcode `userId === 'adam_ou'`）— **不**，走 `requireRole('AUTHZ_ADMIN', 'ADMIN')`，跟既有 deploy endpoint 對齊。

---

## 4. Acceptance Criteria

- [ ] **AC-1:** Adam 在 DataQueryTab → 選 tiptop ds → 在 AI textarea 輸入「給我一個函式，輸入料號，回最近 5 筆出貨」→ 按 Generate → 主 SQL textarea 出現完整 `CREATE OR REPLACE FUNCTION ...`
- [ ] **AC-2:** 點 Refine → 描述「改成 10 筆 + 加 ORDER BY date DESC」→ SQL 更新
- [ ] **AC-3:** 點 Explain → 跳出 Markdown panel 列出 inputs / outputs / 大致流程
- [ ] **AC-4:** 點既有 Deploy → window.confirm → function 寫入 `authz_resource` AND grant ADMIN execute（路徑不變）
- [ ] **AC-5:** 沒有 Deploy 按鈕被自動觸發；AI 不會 silent write
- [ ] **AC-6:** `SELECT * FROM authz_ai_usage WHERE feature_tag='pg_function_authoring' ORDER BY called_at DESC LIMIT 5` — 應有 entries with non-zero token count
- [ ] **AC-7:** `SELECT * FROM authz_admin_audit_log WHERE action='AI_ASSIST_FUNCTION_DRAFT' ORDER BY timestamp DESC LIMIT 5` — 應有 entries with `actor_type='ai_assist'`, `consent_given='human_explicit'`, `model_id` 非 null
- [ ] **AC-8:** 沒有 active 的 `sql_authoring` provider 時，3 個 endpoint 回 503 + clear message「Register an AI provider with purpose_tags including 'sql_authoring' first」
- [ ] **AC-9:** Schema context 不包含使用者 `authz_check` 拒絕的 table（authz-aware）
- [ ] **AC-10:** Tests: backend integration test for 3 endpoints（mock provider 回固定 SQL）+ 1 frontend smoke test
- [ ] **AC-11:** Docs: 在 `docs/api-reference.md` 列 3 個新 endpoint；`docs/PROGRESS.md` 加條目；本 plan README.md 列入 status table
- [ ] **AC-12:** Constitution §11.2 / §11.3 / §11.6（讀取/寫入/audit）對齊 — implementation comment 引用對應條文

---

## 5. Implementation Plan (Executor 填)

### Tasks

- [x] [Backend] 新增 `services/authz-api/src/lib/ai-call.ts`（thin wrapper：select provider, decrypt key, fetch chat/completions, parse, write usage） — ~190 行（含 destructive regex + extractSql）
- [x] [Backend] 新增 `services/authz-api/src/lib/ai-context.ts`（schema context builder）
- [x] [Backend] 新增 `services/authz-api/src/routes/ai-assist.ts`（3 endpoints） — ~190 行
- [x] [Backend] mount router in `services/authz-api/src/index.ts` under `/api/ai-assist`，require `AUTHZ_ADMIN`/`ADMIN`
- [x] [Backend] integration smoke test — `services/authz-api/scripts/test-ai-assist.ts`（21/21 assertions passed；改 script 而非 jest/vitest 因 repo 無 test framework）
- [x] [Frontend] 新增 `apps/authz-dashboard/src/components/AuthorPanelAIAssist.tsx` — ~200 行
- [x] [Frontend] 嵌入 `DataQueryTab.tsx` 既有 `AuthorPanel`（取代原 disabled 「Ask AI to draft」placeholder）
- [x] [Frontend] 新增 3 個 api 函式至 `apps/authz-dashboard/src/api.ts`
- [ ] ~~[Frontend] smoke test~~ — 跳過：repo 無 React test runner；後續 frontend test infra 上線時補
- [x] [Docs] 更新 `docs/api-reference.md`、`docs/PROGRESS.md`、`README.md` (sub-plans status table)

### Files touched

- `services/authz-api/src/routes/ai-assist.ts`（NEW）
- `services/authz-api/src/lib/ai-call.ts`（NEW）
- `services/authz-api/src/lib/ai-context.ts`（NEW）
- `services/authz-api/src/index.ts`（mount router）
- `services/authz-api/test/ai-assist.test.ts`（NEW）
- `apps/authz-dashboard/src/components/AuthorPanelAIAssist.tsx`（NEW）
- `apps/authz-dashboard/src/components/DataQueryTab.tsx`（embed）
- `apps/authz-dashboard/src/api.ts`（3 calls）
- `apps/authz-dashboard/src/components/__tests__/AuthorPanelAIAssist.test.tsx`（NEW）
- `docs/api-reference.md`（add endpoints section）
- `docs/PROGRESS.md`（progress entry）
- `.claude/plans/v3-phase-1/README.md`（status table row）

### Migration / DB notes

**No DB migration needed.** `authz_ai_provider` / `authz_ai_usage` / `authz_admin_audit_log` 已就緒（V052 / V049 / V065）。

Pre-flight check：Adam 需先在 AIProvidersTab UI 註冊一個 `is_active=TRUE` provider，`purpose_tags` 含 `'sql_authoring'`。此步驟非本 plan 程式碼涵蓋，列入 §5 「Manual prep」。

### Manual prep（Adam 開工前）

1. AIProvidersTab → New Provider → 填內網 LLM endpoint or OpenAI key
2. `purpose_tags`: `['sql_authoring','chat']`
3. `default_model`: e.g. `gpt-4o-mini` 或內網對應 model
4. Test 按鈕跑一次確認 ok
5. 記下 `provider_id` 給 backend ENV/config 參考（雖然 resolution 走 purpose_tags 動態查，記錄 audit 用）

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| AI 產 SQL 含 `DROP` / `TRUNCATE` 試圖偷渡 destructive 操作 | 中 | `ai-call.ts` 在 return 前 regex 黑名單拒絕（DROP/TRUNCATE/GRANT/REVOKE/COPY），命中則 raise；Constitution §11.3 寫入只准 CREATE OR REPLACE FUNCTION |
| Schema context 洩漏 user 看不到的 table | 中 | `ai-context.ts` 用 `authz_check(userId, 'select', resource_id)` filter；單元測試 cover |
| AI cost 失控 | 低 | `authz_ai_provider.monthly_budget_usd` + `rate_limit_rpm` 已存在；超量直接 reject |
| Adam 把 generated SQL 直接 deploy 而沒檢查 → bad function 進 prod | 中 | 既有 Deploy 已要 window.confirm；本 plan 不改變那條 path；Constitution §11.3 sandbox→review 對應現實上是 Adam 看 SQL+按 Deploy |
| 提前做擠掉 M4 工時 | 中 | dogfood scope 預估 ~2-3 天；放 Q3 2026 「基座 + M4」期間的非 SEC-06/Helm slot；超時 = 退回 Q1 2027 排程 |
| Provider 中斷 → 三個 endpoint 全死 | 低 | fallback：endpoint 503 + UI 顯示 retry / 聯絡 Adam；textarea 仍可手寫，degraded gracefully |
| eval set 沒就緒就 dogfood = 沒 SLO 數據 | 低 | dogfood 階段不簽 SLO；蒐集 Adam 自用實際 prompt → 反過來餵 eval set |

**Rollback：**
- Frontend: 把 `AuthorPanelAIAssist` 隱藏（feature flag in localStorage 或直接註解）
- Backend: 卸 `/api/ai-assist` mount → 三個 endpoint 404，AuthorPanel AI 區塊顯示「AI 助理離線」
- DB: 沒 schema 異動，無需 rollback

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-28 | Planner | → DRAFT | 起草，等 Adam 簽核「提前 dogfood」+ AC 鎖定 |
| 2026-04-28 | Adam | DRAFT → READY-FOR-IMPLEMENTATION | 「好，請執行開發」tacit approval；tech-lead self-sign per `feedback_tech_lead_governance` |
| 2026-04-28 | Executor (Claude) | → IN-PROGRESS | Implementation start：4 new files + 3 mod points |
| 2026-04-28 | Executor (Claude) | IN-PROGRESS → READY-FOR-REVIEW | All 11 plan tasks done. Smoke test `scripts/test-ai-assist.ts` passed 21/21 assertions against running authz-api（draft/refine/explain 200, audit + ledger correct, destructive guard 422, no-provider 503）。Frontend embedded in DataQueryTab AuthorPanel。Differs from plan: integration test 改為 runnable smoke script（無 jest/vitest 框架可用）；frontend smoke test 跳過（無 React test runner 設定，留待 Q3 2026 frontend test infra）。 |

---

## 8. References

- Master plan: [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.4 / §2.5 / §3 / §6.2
- Constitution Article 11 draft: [`./constitution-ai-chapter-draft.md`](./constitution-ai-chapter-draft.md)
- AI sidepanel plan (Q1 2027): [`./ai-sidepanel-plan.md`](./ai-sidepanel-plan.md)
- Tier 3 Query Tool plan (Q2 2027): [`./tier3-query-tool-plan.md`](./tier3-query-tool-plan.md)
- Provider registry migration: [`database/migrations/V052__ai_provider_registry.sql`](../../../database/migrations/V052__ai_provider_registry.sql)
- Existing function deploy path: `services/authz-api/src/routes/data-query.ts` line 377-488
- Existing AuthorPanel UI: `apps/authz-dashboard/src/components/DataQueryTab.tsx` line 479-625
