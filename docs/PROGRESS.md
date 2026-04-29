# Phison Data Nexus — Progress Tracker

> **This file is the SSOT for project progress (STATE).**
> **Plan SSOT (active Phase 1):** `docs/plan-v3-phase-1.md`
> **Sub-plans index:** `.claude/plans/v3-phase-1/README.md`
> All sessions should read this file first and update it when completing work.
> For feature requests detail: `docs/wishlist-features.md`
> For tech debt detail: `docs/backlog-tech-debt.md`
> Last updated: 2026-04-29

---

## This Sprint

> **Sprint is the unit of planning.** For non-main-path work (anything not touching the hard gates in `CLAUDE.md` §Status), don't apply phase / quarterly thinking — just queue the next migration/route/page.
> Demo target reference: 2027-05. Long-term track: `docs/plan-v3-phase-1.md`.

### This week (2026-04-26 → 2026-05-03)

**新近完成（本 session 落地）:**
- [x] **HELP-TEXT-V01 (Tier A primitive — column/filter help_text)** — 2026-04-29。`two-tier-platform-model.md` §82 列的 4 個 Tier A 平台 primitive 第一個落地。零 schema 變更走 JSONB-only convention:`authz_ui_page.columns_override.<col>.help_text?: string` + `authz_ui_page.filters_config[].help_text?: string`,backend `ColumnDef`(masked-query.ts)spread `...override` 自動穿越,filter 端 `resolveFilterOptions`(config-exec.ts)顯式 forward。Frontend `ConfigEngine.tsx` 新 `HelpIcon` 元件(lucide `HelpCircle` `?` icon + native `title` tooltip + aria-label,零 deps),wire 進 `DataTable` `<th>` column header 與 `FilterBar` label,空字串自動 render `null` 不留 DOM。Demo seed `database/seed/_demo/ui-config-seed.sql` 加 4 條 help_text(grade/status/lot_id columns + status filter on `lot_explorer` page、test_type/yield_rate columns on `test_results` page),示範 Curator 文案規範(中文短句、含閾值/格式/上下游 context)。**⚠️ Visibility caveat:** `_demo/` 資料夾不被 `init-db.sh` glob (`seed/*.sql` 非 recursive)自動 load,且現有 live migration 中 ConfigEngine-rendered ui_page 全為 handler-driven (V078 npi_gate_console / V050 audit_home / V033 modules_home) 或 descriptor-pattern (V036/V039 走 `authz_ui_descriptor`,非 `columns_override`)——目前 dev stack **無任何 live page 實際渲染 `?` icon**。primitive 本身 (HelpIcon component + types + 兩處 wire point) 已落地,seed→live 串接留待下個 sprint 真正 wire 進實際 ConfigEngine page (例如未來 Path A 業務 demo / Tier 2 admin form 第一輪)。**Advisor post-commit fix (HELP-TEXT-V01-FIX):** `HelpIcon` 加 `onClick={(e) => e.stopPropagation()}`,避免 sortable column header 上點 `?` icon bubble 觸發 sort(`lot_id` 等同時 sortable + help_text 的欄位實際會 trigger 此 bug)。Out-of-scope 顯式 defer:**頁面級 `description` 走 `?` icon**(現用作 subtitle、避免雙來源混亂)、**Tier 2 admin form wizard 整合**(等 Tier 2 自己 sprint)、**DAG inspector tooltip**(inspector 還沒上 UI)、**Markdown / 多行 / link**(PoC 階段 native title 夠用)。tsc clean × 2,test-validate 7/7 regression pass。Plan: `.claude/plans/v3-phase-1/help-text-primitive-plan.md` (DONE,單 session DRAFT→DONE)。
- [x] **COMPOSER-SINK-V01 (sink-as-node-kind, page sink MVP)** — 2026-04-29。Composer 第五個 node kind:`sink`,把 `Save as page` 從 Inspector button 升級成 canvas-visible terminal primitive。落地:(1) **Sub-plan** `.claude/plans/v3-phase-1/sink-as-node-kind-plan.md` 含 §3.7 10 個 key decisions(每個都列 rationale + 維運成本)、§3.4 four-pass UX validation、§7 一次性 4 天 + 持續成本估算 + 機會成本對比。(2) **Backend refactor** `services/authz-api/src/lib/sink-runtime.ts`(NEW)抽出 `emitPageSnapshot()` + `deriveSinkUpstreamFn()` + `SinkValidationError`;`/save-as-page` 改 thin-wrapper 行為等價,新 route `POST /api/dag/execute-sink` 走 sink_kind dispatch + DAG attributes walk → upstream fn ancestor authz_check + audit `action_id='dag_sink_page'`(authz 繼承同 operator §3.2)。(3) **Frontend** `apps/authz-dashboard/src/components/DagTab.tsx` 加 `SinkNode` slate 視覺 + 終端單 input handle no output + 「unsaved/saved · N rows」chip;palette `Sinks` section 含 `🗄 page snapshot`;Inspector sink branch(page_id/title/parent/description/overwrite + last_run 顯示);`addSinkNode` + `executeSink`(client 帶 upstream `last_result.columns/rows`,server 不 re-execute,維持「snapshot of what curator saw」契約)。(4) **舊 `Save as page` button 完全保留不動**(advisor 提醒:真 alias),既有 e2e `save + reload round-trip` 零修改。Smoke `scripts/test-sink.ts` 10/10 pass(create / bad page_id 400 / dup 409 / overwrite / fn-ancestor walk × 2 / `validateDag` accepts sink-only DAG / JSONB roundtrip 保留 type=sink + sink_config)。Playwright `e2e/05-flow-composer.spec.ts` 加 2 sink case(palette→inspector / no-upstream actionable error)+ 既有 4/4 (2 aggregate + 2 new sink) 全 pass;5 pre-existing fail 是 fn deploy 環境問題與此無關(baseline diff 確認)。TS authz-api + dashboard 兩 service clean。**Advisor pre-commit 三 blocker 已修:** (1) `dag-validate.ts` type/op_kind 註解過時 → 補完 `'sink' | 'aggregate'` 加入 union 註解(實際 logic 一直是 permissive 通過);(2) `runAll` 改 skip `n.type==='sink'` 並提示 `(skipped N sinks — use ▶ Execute Sink)` — sinks 是 explicit deliberate save(D8);(3) `/save-as-page` 與 `/execute-sink` body 改回傳 `result.status: 'created' | 'overwritten'` 而非永遠 `'ok'`,client `executeSink` 直接讀 `r.status` 不再用 overwrite flag 推導(避免 first-write-with-overwrite-checked 顯示錯誤狀態)。AC-8 改用 DB-level roundtrip test(env-independent),取代不穩定的 UI save+reload e2e。**未做 / 已記錄技術債:** D4 sink-as-authz_resource(saved_view sub-plan Q4 2026 統一處理)、舊 button deprecation(下個 sprint review 用真實 alias-vs-palette 採用率決定)。Plan: `.claude/plans/v3-phase-1/sink-as-node-kind-plan.md` (DONE)。
- [x] **COMPOSER-OPERATOR-V01 (Flow Composer operator + multiplicity badge + validate msg)** — 2026-04-28。Adam 提案 composer-operator-and-sink sub-plan (`.claude/plans/v3-phase-1/composer-operator-and-sink.md`,IN-PROGRESS),把 filter / cast / aggregate / literal 從「叫 DBA 寫 SQL fn」改成 composer-native node kind,擋 `authz_resource` catalog bloat ~30 fn/季。Now-sprint 落地三件:(1) **Multiplicity badge** — `FunctionNode` header 加 `⊞ rows / ≣ setof / • scalar / ∅ void` chip,源自 `parsed_args.return_shape.shape`(API 已 ship 只是 UI 沒用)。(2) **Validate 訊息升級** — `dag-validate.ts` `type_mismatch` 從 `'mat'(material_no) → 'p_fam'(product_family) semantic types differ` 升級為 `'mat' (material_no/text) → 'p_fam' (product_family/text) — semantic_type mismatch (material_no vs product_family). Hint: insert a Cast node, or align semantic_type on upstream output.`,並新增 pgType family fallback path(`number vs text` 之類,沒 semantic_type 也接得到);operator 邊(`__upstream`/`__downstream`/`semantic_type='__rowset'`)skip 嚴格檢查走 passthrough。(3) **Operator runtime** — 新檔 `services/authz-api/src/lib/dag-operators.ts`(`runOperator` + `coerceLiteral` + `applyPredicate` + `deriveOperatorResourceId`);`POST /api/dag/execute-node` 加 operator dispatch path,literal 不過 `authz_check`、filter/cast 繼承上游 fn 的 resource_id 做 authz check + audit(`action_id='dag_op_<kind>'`);frontend `DagTab.tsx` 加 `OperatorNode` 元件 + Operators palette section + `OperatorInspector`(literal: value+pgType+semantic_type / filter: column dropdown+op[eq/ne/in/gt/lt/like]+value / cast: source_column+target_pgType+target_semantic_type);upstream payload 從只給 `row0` 擴充到 `rows[]` + `upstream_resources` map;`addOperatorNode` 三 kind 共用。Authz 模型(plan §3.2):operator 不獨立 `authz_check`、權限繼承上游、audit 仍記。Smoke:`runOperator` 直跑 5 cases pass(literal/filter/cast/coerce/no-upstream-error)、`validateDag` 4 cases pass、TypeScript 兩 service clean、vite build 9.55s pass。Out-of-scope: aggregator / sink-as-node-kind / save-as-API → next sprint。Plan: `.claude/plans/v3-phase-1/composer-operator-and-sink.md`。
- [x] **CONSTITUTION-V2.2 + EVAL-CAPTURE-01 (Eval Case Capture loop)** — AI-DOGFOOD-01 follow-up,把 eval-set-collection 從原本 cross-team interview 路徑（DBA 100 / PM 訪談 100）改成 dogfood-driven capture loop,2026-04-28 同日落地。Constitution v2.1 → v2.2:§9.6 加 carve-out 段 + 新 §9.9 "Eval Case Capture" 完整規範(trigger conditions / 權限 / audit / 使用範圍 / 保留期 / 撤回),tech-lead self-sign per `feedback_tech_lead_governance` (internal dev governance, external review N/A for AI eval mechanics)。實作:V071 `authz_eval_case` table (FK→authz_ai_usage ON DELETE SET NULL, full prompt_text + response_text, verdict CHECK ('good','bad'), 4 indexes), `POST /api/ai-assist/eval-mark` endpoint (ownership check `authz_ai_usage.called_by = subject_id`,403 if not owner;同步寫 `AI_ASSIST_EVAL_MARK` audit `actor_type='human'` `consent_given='human_explicit'`),`logUsage` 改 return `Promise<number | null>` 透過 `RETURNING usage_id` 把 ledger row id 帶回前端,`api.ts` 新 `aiAssistEvalMark` + 三個 response type 加 `usage_id`。Frontend `AuthorPanelAIAssist.tsx` 加 `LastCall` state(每次成功後存 prompt_text + response_text + usage_id),draft/refine/explain 結果區下方多一條 👍/👎 verdict bar (ThumbsUp/ThumbsDown lucide icons, emerald/rose colour-coded, 點過後 disabled 防重複),refine 的 prompt_text 拼回 INSTRUCTION + 原 SQL 才完整。eval-set-collection-plan.md 整份重寫:STUB → in-progress,Mon-Fri 寄信 PM/DBA 的 ghost path 拿掉,改成 capture loop + 每週 SQL 統計 query + 100/200 milestone 改自 dogfood 累積。Plans: `.claude/plans/v3-phase-1/eval-set-collection-plan.md` (in-progress)。
- [x] **AI-DOGFOOD-01 (AuthorPanel AI 助理 — PG function authoring dogfood)** — Q1 2027 AI 側欄計畫提前到 Q3 2026 dogfood,Adam 自用先行驗證 AI workflow + 蒐集真實 prompt → eval set。落地:`services/authz-api/src/lib/ai-call.ts`(provider resolve by `purpose_tags='sql_authoring'` + AES-256 decrypt + OpenAI-compatible chat/completions + SHA-256 prompt hash → `authz_ai_usage` ledger + destructive regex `DROP/TRUNCATE/GRANT/REVOKE/COPY/DELETE/UPDATE/INSERT`)、`lib/ai-context.ts`(per-row `authz_check` filter,max 50 tables × 30 cols schema dump,§9.2 read auth)、`routes/ai-assist.ts` 3 endpoints(`/function-draft` + `/function-refine` + `/function-explain`),mounted under `requireRole('ADMIN','AUTHZ_ADMIN')`;每次呼叫額外 `logAdminAction(actor_type='ai_agent', agent_id=provider_id, model_id, consent_given='human_explicit')` 入 V049 audit log(§9.7)。Frontend `AuthorPanelAIAssist.tsx`(collapsible 紫色面板,Generate/Refine/Explain 三鈕,model_id+latency+cost+schema_truncated 元數據條,localStorage 收合狀態)嵌入 `DataQueryTab.tsx` AuthorPanel,**AI 從不 auto-deploy** — 產出 SQL 只填 textarea,Deploy 仍走原本 `window.confirm` + 人手按(§9.3)。Smoke test `services/authz-api/scripts/test-ai-assist.ts`(無 jest/vitest framework,故寫成 self-contained tsx script)21/21 assertions passed:3 endpoint 200 + ledger ≥3 rows status=ok feature_tag=`pg_function_authoring` + audit 三條 actor_type=ai_agent + 422 destructive guard + 503 no-provider。`logAdminAction` actor_type 用 `'ai_agent'`(plan 原寫 `'ai_assist'` 但 type union 不允許,取 §9.7 enum 內最近值)。Plan: `.claude/plans/v3-phase-1/ai-pg-function-authoring-dogfood.md` (READY-FOR-REVIEW)。
- [x] **DS-PERM-CASCADE-V070 (Permission Inheritance Cascade)** — Schema-as-resource + ancestor deny-walk 全部落地 2026-04-28。新增 `db_schema:pg_k8.tiptop` parent row + reparent 3 個 tiptop functions;`authz_check` SYSADMIN/default-allow/default-deny 三條 branch 全改用 `resource_ancestors` mat view 做 deny-walk(取代直接 match);allow-walk 在 default-deny branch 從 inline recursive CTE 換成 mat view 查表(語意一致、O(1));V067 SYSADMIN cross-join 加 `db_schema` resource_type 進 enumeration 列表。Verified 4/4 invariants:baseline allow / schema-deny blocks descendant function / SYSADMIN deny-wins / default-deny + schema-allow cascade 全部 pass。Plan/migration:`.claude/plans/v3-phase-1/permission-inheritance-cascade.md` (READY-FOR-REVIEW) + `database/migrations/V070__permission_inheritance_cascade.sql`。**Discovery auto-ensure 同步落地:** `services/authz-api/src/routes/datasource.ts` 加 schema row 自動 upsert + 把 tables/views/functions parent_id 設成 `db_schema:<ds>.<schema>` + commit 後 `REFRESH MATERIALIZED VIEW resource_ancestors`,新發現的 resource 直接掛上繼承鏈。
- [x] **FLOW-COMPOSER-UX-01 (DagTab 三件 fix)** — Adam 2026-04-28 從前端試 V070 + DAT-test DAG 反映:(1) outputs 多時看不到全部 handle (slice(0,6) hardcap)、(2) 拖拽 edge 沒有 compatibility 視覺提示、(3) `tc_ima001` (varchar) 連 `p_searchkey/p_material_no` (text) 對接不到。修法:移除 hardcap 改 `maxHeight: 220 + overflow-y-auto`(`.nodrag .nowheel`);新增 `DragSrcContext` + `onConnectStart/onConnectEnd` + `isValidConnection`,compatible input 發綠光 ring `rgba(34,197,94,0.45)` / 不相容 dim 0.25;新檔 `apps/authz-dashboard/src/utils/handleCompat.ts` 提供 `isCompatibleHandle` (semantic_type strict match / pgType kind family fallback — text/number/bool/date/array/json/any),寬鬆化 onConnect 阻擋邏輯。後端 `dag-validate.ts` 不需動(line 85 strict check 已 short-circuit when semantic_type undefined)。TypeScript 兩 service 都 clean。Plan:`C:\Users\adam_ou\.claude\plans\compressed-jingling-bear.md`。
- [x] **DS-PERM-V062-TECH-LEAD-PREAPPROVAL** — 30 條 V062 deny pattern 在 dev 已 apply(`SELECT COUNT(*) FROM authz_discovery_rule WHERE effect='deny'` = 30),enforcement loop verify-phase1 cell B7 14/14 passing。Adam 以 Phison Data Nexus tech lead 身份對 internal dev environment 範疇 self-sign 解封 deny pattern test cases:authz_admin_audit_log id=15,action=`V062_DENY_PATTERN_TECH_LEAD_PRE_APPROVAL`,details 註記 `pre_approval='tech_lead'` / `external_review_status='pending'` / `escalation_path='法遵+內稽'` / `scope='internal_dev_environment'`。Prod 推送仍待 法遵 + 內稽 正式 sign-off(AC-1.5 + AC-2.7 平行跑,不擋 dev/staging)。Plan AC-1.5 status 同步更新。

- [x] **PLATFORM-MODEL-01** — Two-Tier Platform Model framework 寫入 plan + standards (`.claude/plans/v3-phase-1/two-tier-platform-model.md` + `docs/standards/metadata-driven-ui.md`,master plan §2.1 鎖定為 4th architectural decision)
- [x] **AUDIT-AI-01** — Constitution §9.7 admin-audit columns(actor_type / agent_id / model_id / consent_given)落地 (V049 + admin-audit lib,commit dac27d6)
- [x] **Constitution v2.0** — Article 9 (AI Agent Operations) ratified (commit 82c6790)
- [x] **Plan §2.6/§5/§6 cross-team ghost paths 剔除** — commit d13618c
- [x] **DS-CASCADE-02** — fix /purge FK gaps (composite_actions + pool_credentials + sync_log,commit 50921ab)
- [x] **SEMANTIC-01** — V044 semantic-layer columns on authz_resource(business_term/definition/formula/owner_subject_id/status lifecycle/blessed_at/by);self-reviewed promote 2026-04-26
- [x] **RENDER-TOKEN-01** — ICON_MAP / STATUS_COLORS / PHASE_COLORS / GATE_COLORS 從 hardcoded 搬進 `authz_ui_render_token` (V053);新增 `RenderTokensContext` + `/api/ui/render-tokens` endpoint;Curator INSERT 新 token 零 React 改動(2026-04-26)
- [x] **DAG-SAVE-PAGE-01 (Path A)** — DAG 任一 node 跑完可一鍵存成 Tier B snapshot page;V054 加 `authz_ui_page.snapshot_data` JSONB + 更新 `fn_ui_page`;新 endpoint `POST /api/dag/save-as-page`;config-exec.ts step 3a short-circuit 直接回傳 cached rows + columns;DagTab Inspector 加「Save as page」按鈕 + dialog,save 後自動跳 auto-page tab 看頁(2026-04-26)
- [x] **DS-PERM-P1 (default-allow inversion pilot)** — V059..V064 + engine + verify-phase1 14/14。`authz_data_source.default_l0_policy` ENUM(deny|allow);`authz_check`/`authz_resolve` invert on 'allow' datasources;V061 `authz_discovery_rule.effect`;V062 +30 deny patterns(PII/PHI/SOX);V063 `authz_sync_db_grants` per-profile branch + 對稱 `ALTER DEFAULT PRIVILEGES` REVOKE(AC-1.7 rollback symmetry,pg_default_acl 3 → 0);V064 `authz_check` allow-branch widens deny override to also EXIST-test `authz_policy(effect='deny',status='active')` — 關 AC-1.5 approval loop。Discovery engine effect='deny' rules 寫 pending_review L0 deny policy;`/discover/suggestions` 加 effect 過濾 + 暴露 policy_effect/rule_effect。AC-1.1..1.7 + X.1 完成,X.2 docs(api-reference + architecture-diagram)落地,commit `85428df` + `eea5f4a`(2026-04-27)
  - **未完待 Adam:** V062 30 條 deny 樣板:Adam tech lead pre-approval 已簽核 2026-04-28(audit log id=15)→ dev/staging 解封;**prod 仍需 法遵/內稽 正式 sign-off**(平行跑,不擋 dev)
  - **AC-2.1 pilot use case 已定:** **物料狀況查詢**(2026-04-27);dev `ds:local` 需 seed mock 物料 schema 或等真實 ERP/MES onboard
  - **三大基線原則 (Adam 2026-04-27 指定):** ① 所有存取可追溯到個人 ② 所有 AI 決策可解釋 ③ 所有資料可遮罩。① ✓ `authz_audit_log.subject_id` 具備、② ✓ **V065 落地 2026-04-27** 加 `actor_type/agent_id/model_id/consent_given` 四欄 + actor_type CHECK + AI identity CHECK + idx_audit_actor_type partial index;4/4 constraint cells pass + verify-phase1 14/14 仍通過、③ ✓ V061 `column_mask` rule_type 機制存在
  - **AC-X.4 pilot SOP 已交付:** `.claude/plans/v3-phase-1/permission-default-allow-pilot-report.md` §7 逐日操作清單(D-7..D14),含 ROLLBACK 觸發點 + Adam 不能放手的 3 件事
- [x] **DS-PERM-SYSADMIN (V066 god-mode role + V067 UI cross-join)** — Adam 2026-04-27 插單,目標「減少初始 debug 白工」。AskUserQuestion Option B:allow-端 god-mode + V064 deny 仍擋 (PII/SOX/三原則 #1 紅線保留)。實作:V066 加 `SYSADMIN` role + `group:SYSADMINS` subject + 修 `authz_check` 最前面 short-circuit + 修 `authz_resolve` 加 `is_sysadmin` sidecar。V067 補 UX 缺口:authz_resolve() 在 is_sysadmin=true 時 cross-join 47 resources × ~9 actions = 407 L0_functional entries (~31KB payload),frontend `AuthzContext.some()` 自動全綠不需 redeploy。FK 設計坑:role_permission `*` 因 FK to authz_resource/authz_action 失敗 → 改用 function short-circuit。Verified 5/5 cells (V066) + 4/4 cells (V067) + verify-phase1 14/14 unchanged。Adam 已掛 SYSADMIN(`user:adam_ou`,authz_subject_role row 45) (commits `8939942`, `TBD`)
  - ~~**未完待 article 8**~~ ✅ constitution v2.1 ratified 2026-04-27 (commit `2fa8dee`)

**進行中(this week,可獨立完成):**
- [x] **V044 self-review & promote** — semantic layer columns 落地 `database/migrations/V044__authz_resource_business_term.sql`(2026-04-26)。修改:owner_user_id → owner_subject_id 對齊 V020;blessed_fields_check 鬆綁讓 deprecated 保留 audit history。Smoke-tested:lifecycle (draft→blessed→deprecated)、unique on blessed business_term、blessing invariants 全部通過。
- [x] **V079 cascade policy self-review & promote** — 原 V045 draft 因 V044 self-review 先落地而 park,2026-04-28 promote 為 V079(sequential 規則)。Table renamed `authz_resource_cascade_policy` 對齊 codebase prefix;`owner_user_id` → `owner_subject_id` + `ON DELETE SET NULL` 對齊 V020/V044 慣例;TEXT+CHECK cascade_mode(stateless_auto/stateful_sandbox_30d)取代 ENUM(對齊 V049 actor_type 模式);兩條 CHECK 守 sandbox invariants(stateless 不可有 sandbox 時間、stateful 入沙時 expire>enter);4 indexes:unique edge / upstream scan / owner-active partial / expiring partial。Promoted to dev,migration:`database/migrations/V079__authz_resource_cascade_policy.sql`。
- [x] **ARCH-01-FU-1 verify** — restart authz-api,`POST /api/rls/simulate {table:'lot_status'}` 走 nexus_data 回傳業務資料(2026-04-28)。同 session 修掉 `db.ts:resolveDataSource` 的 first-active-datasource fallback —— 沒掛 `data_source_id` 的 resource 之前會被靜默 route 到無關 remote DB;改成 return null 讓 caller 落 `getLocalDataPool()`(nexus_data),explicit beats implicit。
- [x] **COMPOSER-OPERATOR-V01 AC-7/AC-8 verified** — AC-7:filter operator 跑完寫 1 條 `dag_op_filter` audit row(`authz_audit_batch_insert` 1000ms TTL flush 後可見、actor=`group:SYSADMINS`、target_resource 繼承上游 fn)。AC-8:save→reload roundtrip,5 nodes(3 fn + 2 op)+ 4 edges 完全還原,`op_kind`/`op_config` 在 `attributes.nodes[*].data` 內持久化(2026-04-28)。
- [x] **COMPOSER-AGG-V01 (aggregator operator)** — 第四個 composer-native operator kind 落地。Backend `services/authz-api/src/lib/dag-operators.ts` 加 `aggregate` branch:支援 `group_by[]` + `aggregations: {fn:'sum'|'count'|'min'|'max'|'avg', column, alias?}[]`;SQL NULL semantics(skip nulls,all-null group → null,count(*)/count(col) 不算 null);type inference: count→bigint、avg→numeric、sum/min/max→inherit upstream pgType。Frontend `apps/authz-dashboard/src/components/DagTab.tsx` 加 `OpKind='aggregate'` + `OpConfig.aggregate` variant + amber Σ palette button + `OperatorInspector` aggregate 分支(group_by add/remove + aggregations row editor 含 fn dropdown / column dropdown / alias input);node summary `by col1,col2 | sum(x), count(*)` 自說明。Authz 模型同其他 operator(繼承上游 fn ancestor)。Smoke `services/authz-api/agg-smoke.ts` 7/7 pass(group-by 1 col + sum、all-null 群組 sum=null、group-by 2 cols + count+avg + 型別推斷、no group-by 1-row 全集計、empty aggregations throws)。TS 兩 service clean、vite build 9.41s。Plan 對齊 `.claude/plans/v3-phase-1/composer-operator-and-sink.md` operator-as-platform-primitive 主軸,擋 `authz_resource` catalog bloat。

**下一個 sprint 候選**(not commit yet) — **Tier A 統一排序見 [`.claude/plans/v3-phase-1/tier-a-primitives-roadmap.md`](../.claude/plans/v3-phase-1/tier-a-primitives-roadmap.md)**:
- ~~A) ICON_MAP / STATUS_COLORS 動態化~~ ✅ done (RENDER-TOKEN-01, 2026-04-26)
- ~~B) `help_text` primitive~~ ✅ done (HELP-TEXT-V01, 2026-04-29)
- **下一動作:Tier A roadmap §2.1 排序第 #2 = saved_view (~1 週,Q3 2026 後段)**;#1 default-perm pilot 已獨立 IN-PROGRESS plan
- C) business_term-driven column mask 自動化 — **gated**(blessed_term ≥ 10 才開,目前 = 0)
- E) page-level help_text — **deferred**(help_text plan §2,trigger 條件見 roadmap §3.6)
- A4 subscription — **gated**(named consumer ≥ 2-3 才開,Q1 2027 預留)

### Hard gates(only these warrant phase-style guarding — everything else is pure additive)

| Gate | Loose target | Exit criteria | Status |
|------|------|---------------|--------|
| **G1 — M4 prod-ready** | ~2026-09 | SEC-06 / Helm / Keycloak / LDAP Cron / Redis 上線 | 🟡 planning |
| **G2 — Tier 2 admin alpha** | ~2026-12 | admin 表單 alpha 自跑端到端 ≥ 1 個業務場景(取代 pilot) | ⏳ not started |
| **G3 — LLM SLO** | ~2027-03 | eval set 200 筆 + 自評 text-to-SQL ≥85%, recall@10 ≥0.90 | ⏳ eval set 待開工 |
| **G4 — Tier 1 dashboard** | ~2027-04 | 自建引擎 render 1 個業務 dashboard 端到端 | ⏳ not started |

> Dates are loose — slips are normal. The gates are *one-way doors* (Path A migration once opened can't easily close), not deadlines.

<details>
<summary>Long-term track aspirations(只是參考,sprint 才是執行單位 — 不要從這裡反推 sprint 內容)</summary>

| Track | Q3 2026 | Q4 2026 | Q1 2027 | Q2 2027 |
|-------|---------|---------|---------|---------|
| M4 prod-ready | 🟡 kickoff | target 100% (G1) | — | — |
| Tier A primitive (help_text / saved_view / feedback / subscription) | 🟢 help_text | saved_view + feedback | subscription | — |
| Tier 2 分析 wizard | — | alpha target | expand | demo-ready |
| Tier 2 admin 表單 | — | 🚧 alpha (G2 self-test) | Path A migration | done |
| AI 側欄 | — | — | 🚧 build | polish |
| Tier 3 Query Tool | — | — | — | 🚧 build |
| Tier 1 dashboard | — | — | — | 🚧 build (G4) |
| eval set 200 筆 | 🟡 self-collect | 🎯 200 complete | SLO self-eval | quarterly +20 |
| business_term | 🟡 V044 migration self-review | ≥20 blessed | ≥50 | ≥100 |

</details>

> **Legend:** 🟢 done · 🟡 in progress · 🚧 building · 🎯 milestone · ⏳ pending · 🔴 at risk

---

## Milestone 1: AuthZ Runs Locally — DONE

- [x] Docker Compose (PG 16 + Redis 7)
- [x] DB migrations V001-V017
- [x] `authz_resolve()`, `authz_check()`, `authz_filter()` PG functions
- [x] Dev seed data (18 groups, 19 users, 16 roles, 40+ resources)
- [x] `make verify` passes
- [x] Makefile dev workflow

## Milestone 2: First Page Is Permission-Aware — DONE

- [x] Express API service (`services/authz-api`, port 3001)
  - Routes: resolve, check, filter, browse, matrix, pool, rls-simulate
- [x] React dashboard (`apps/authz-dashboard`, port 5173)
  - Tabs: Overview, Resolve, Check, Matrix, RLS, Workbench, Pool, Browser, Audit
- [x] AuthzProvider context + meta-driven tab visibility
- [x] SSOT-driven pool denied_columns (V015)
- [x] L2 column masks + L0 column deny in RLS Simulator
- [x] API AuthZ middleware (requireAuth / requireRole / requirePermission)
- [x] Auth headers (X-User-Id, X-User-Groups)

## Milestone 3: All Three Paths Enforced — DONE

### Done
- [x] Path B: Express middleware wired (requireAuth, requirePermission, requireRole)
- [x] Path C: Pool management CRUD (profiles, assignments, credentials)
- [x] Path C: `authz_sync_db_grants()` + pgbouncer config generation
- [x] Path C: Native RLS policies on lot_status/sales_order (V019)
- [x] LDAP: OpenLDAP + phpLDAPadmin Docker setup (`deploy/docker-compose/docker-compose.ldap.yml`)
- [x] LDAP: Seed LDIF with 19 groups + 18 users + membership (`deploy/ldap/seed/`)
- [x] LDAP: V018 `authz_group_member` table + `authz_resolve_user_groups()` function
- [x] LDAP: `identity-sync` service (`services/identity-sync/`)
- [x] LDAP: API middleware auto-resolves groups from DB when header not provided
- [x] All seed data has `ldap_dn` populated
- [x] Data Source Registry: V020 `authz_data_source` table + pool_profile FK
- [x] Data Source Registry: CRUD + test + discover API (`/api/datasources`)
- [x] Data Source Registry: Dynamic pool management in `db.ts`
- [x] rls-simulate.ts + pool.ts use dynamic data source pools
- [x] ARCH-01: Business DB separation (nexus_authz + nexus_data in same PG instance) — **部署驗證 2026-04-23** (dev postgres 容器兩個 DB 都在,pgbouncer 路由正確)
- [x] ARCH-01: Migrations split into `migrations/` (authz) and `migrations/data/` (business) — deployed
- [x] ARCH-01: Seed data split into `seed/` (authz) and `seed/data/` (business) — deployed
- [x] ARCH-01: pgbouncer + pg_hba point pool roles at nexus_data — verified
- [x] ARCH-01: Cleaned up nexus_authz legacy business tables (pre-ARCH-01 init residue)
- [~] ARCH-01-FU-1: Fixed rls-simulate.ts to use getLocalDataPool() for business-table scan (待 dev api restart 驗證 live)
- [~] ARCH-01-FU-2: Audited browse-read.ts / config-exec.ts / masked-query.ts / datasource.ts info_schema queries — fixed three browse-read endpoints + config-exec fallback to use getLocalDataPool() (2026-04-23, commit d3b31a7). tsc clean. 待 dev api restart 驗證。Bonus: 順手修了 config-bulk.ts 兩處 pre-existing typo。
- [~] ARCH-01-FU-3: Split V019 — kept cluster-level role + BYPASSRLS only; removed business-table GRANT/RLS/POLICY/VIEW (data/V002 已是 SSOT) (2026-04-23, commit 75cab5b). 待 DBA 簽核 split + 下次 fresh init 驗證。

- [x] W-IT-01: Audit logging for all admin operations (pool + datasource CRUD)
- [x] W-IT-01: AuditTab access_path filter (All/A/B/C)
- [x] W-USER-01: WorkbenchTab row statistics + denied column tooltip
- [x] Phase 6: PoolTab Data Sources section (register, test, discover)
- [x] Phase 7: MatrixTab data source filter dropdown
- [x] W-USER-02: OverviewTab My Access Card (L0 grouped by type + L1 scope summary)
- [x] W-DBA-03: Profile create → credential setup prompt
- [x] W-IT-02: Assignment subject dropdown (replaces freetext input)
- [x] W-IT-03/04, W-DBA-04: Already implemented via action-items API
- [x] Business DB: resource attributes tagged with data_source_id
- [x] Business DB: ds:local host corrected for Docker networking
- [x] Config-Driven UI Engine Phase 1 (V022 authz_ui_page + fn_ui_page/fn_ui_root + /api/config-exec + ConfigEngine.tsx)
- [x] Shared masked-query helper (JS-side masks, no cross-DB dependency)
- [x] Data V003: 6 remaining business tables migrated to nexus_data
- [x] Admin CRUD: BrowserTab SSOT dropdowns (roles, groups, actions, resources, parent_id)
- [x] Admin CRUD: Search/filter on all 5 entity sections
- [x] Path C: pgbouncer live reload (apply+reload endpoint + writable volume)

- [x] Path C: External DB Grant Sync (sync SSOT grants to remote DBs)
- [x] Path C: Credential rotation auto-syncs to remote DBs
- [x] Path C: Drift detection (SSOT vs remote DB comparison)
- [x] V025: External sync support (sync_log table + data_source tracking)
- [x] V026: `allowed_modules` column on pool profiles
- [x] Metadata-driven table-to-module mapping (bulk API + UI)
- [x] Relational pool profiles (allowed_modules → recursive CTE expansion at sync time)
- [x] Table Mapping UI in DataSourcesSection (prefix grouping, module dropdown, bulk save)
- [x] Profile Form: allowed_modules field + Modules column in profiles table
- [x] pg_k8cluster scenario: Tiptop ERP modules + profile mapping
- [x] Greenplum compatibility: two-step table query, RLS skip, graceful column revoke

- [x] V027: EdgePolicy fusion schema (policy_assignment, data_classification, clearance_mapping, security_clearance/job_level on role)
- [x] V028: Phase 5 seed data (policy assignments, role clearance values, column classifications)
- [x] V029: Fix fn_ui_root card_grid layout filter
- [x] Phase 0: Shared helpers extraction (request-helpers.ts: getUserId, getClientIp, isAdminUser)
- [x] Phase 0: AuthzContext `isAdmin` centralized (removed 4 duplicate inline computations)
- [x] Phase 1: Browse route security split (browse-read.ts public + browse-admin.ts requireRole guard)
- [x] Phase 2: SSOT fixes — dynamic action list, dynamic role-pool map, dynamic default table
- [x] Phase 3: Admin audit completion — 11 missing logAdminAction calls in pool.ts + datasource.ts
- [x] Phase 4: AuditTab admin audit sub-tab + BrowserTab policy assignments + role clearance + classification UI
- [x] Phase 4: api.ts new endpoints (adminAuditLogs, policyAssignment*, roleClearanceUpdate, classifications, columnsClassified)
- [x] Phase 6: operation-detector integrated into rewrite pipeline (skip non-SELECT)
- [x] Phase 6: isAdminUser shared helper (removed duplicate in resolve.ts)
- [x] Config-exec fix: card_grid sub-page child population with authz_check filtering

### Remaining
(Milestone 3 complete — remaining items moved to Milestone 4)

## Milestone 4: Production-Ready — IN PROGRESS

### Done
- [x] Metabase BI: Docker Compose + Makefile targets (`make metabase-up`)
- [x] Metabase connects to nexus_data via pgbouncer Path C (SSOT — PG GRANT+RLS enforced)
- [x] DX-03: Dev port scheme (PG:15432, PgBouncer:16432, Redis:16379, API:13001, Dashboard:13173)
- [x] Config Tools: Export snapshot API (`GET /api/config/snapshot`) — 9 sections, selective export
- [x] Config Tools: Bulk import API (`POST /api/config/bulk`) — dry_run, dependency order, transaction-safe
- [x] Config Tools: ConfigToolsTab UI (export/import panels, dry run preview, result display)
- [x] Agent roles: 16 agent definitions in `.claude/agents/` (5 technical + 1 PO + 9 domain experts + shared principles)
- [x] TimescaleDB: Docker image switched to `timescale/timescaledb:latest-pg16`
- [x] V030: `authz_audit_log` → hypertable (7-day chunks, 30-day compression, 2-year retention)
- [x] V030: Continuous aggregates `audit_hourly_summary` + `audit_daily_by_subject`
- [x] data/V006: `lot_status_history` hypertable + trigger on `lot_status`
- [x] data/V006: `yield_events` hypertable + trigger on `cp_ft_result`
- [x] data/V006: Continuous aggregates `yield_daily_trend` + `lot_daily_flow`
- [x] Discover tab (bottom-up catalog): `GET /api/discover` + `/api/discover/stats` (admin-only) — cross-source view of every table/view/function with mapped/unmapped status, type/search/unmapped filters, 6 Playwright E2E tests (plan: `plan-bottom-up-ux-refactor.md`)
- [x] Discover → Promote to Module (Phase B): `POST /api/discover/promote` + per-row "Promote" button + modal — closes the bottom-up loop (existing data → 1-click permission-controlled Module). Transactional, refreshes module_tree_stats, writes admin audit. 2 Playwright E2E tests.
- [x] Discover → Promote attach mode (Phase C): same `POST /api/discover/promote` extended with `target_module_id` discriminator — modal toggles between "Create new module" and "Add to existing" (lazy-loads `moduleTree()`, searchable list). Audit action `ATTACH_TO_MODULE`. +1 Playwright E2E (3 total).
- [x] Discover → Reparent (Phase D): `POST /api/discover/reparent` — inverse of /promote. From a mapped row, Move to another Module or Detach back to the unmapped pool (parent_id = NULL). Modal with Move/Detach toggle, current module shown. Audit actions `MOVE_TO_MODULE` / `DETACH_FROM_MODULE`. +2 Playwright E2E in `08-discover-reparent.spec.ts` (33 total).
- [x] Discover → Bulk operations (Phase E): `POST /api/discover/bulk` — three modes: `create_attach` (one new Module + attach all), `attach` (existing Module), `detach` (clear parents). Frontend: per-row checkbox + select-all + sticky action bar with mapped/unmapped split + Promote N / Attach N / Detach N buttons + bulk modal. Skip-and-report semantics for rows that don't match the mode's precondition (already_mapped, not_mapped, wrong_type). Audit actions `BULK_PROMOTE_TO_MODULE` / `BULK_ATTACH_TO_MODULE` / `BULK_DETACH_FROM_MODULE`. +2 Playwright E2E in `09-discover-bulk.spec.ts` (35 total).
- [x] Path A clarity: Pool → Organization phase summary now states the consequence ("non-admins can't access via Path A/B until then") + amber banner explaining why action is needed + "Open Discover filtered" deeplink (sessionStorage + CustomEvent navigation, no router needed). Discover gained DS filter dropdown that consumes the deeplink hint.
- [x] Module access UI: surfaced `execute` action (in addition to read/write/approve/export/connect) — fixes silent gap where `module:analytics`-style execute grants weren't visible in AccessPanel and weren't probed in `/api/modules/:id/details.user_permissions`. Affects `services/authz-api/src/routes/modules.ts:219` + `apps/authz-dashboard/src/components/modules/AccessPanel.tsx:13`.
- [x] DAG: production seed `dag:material_360_trace` (`database/seed/dag_material_360_trace.sql`) under `module:analytics` — 4 pg_k8 functions (`fn_material_lookup` → `fn_material_substitution_map` / `fn_material_full_trace` / `fn_cxmzr115_shipment_history_by_material_no`), 3 fan-out edges on `material_no`. Re-runnable (ON CONFLICT DO UPDATE). Verified inheritance: `BI_USER` with `execute` on `module:analytics` → all 4 nodes pass `authz_check`.
- [x] BU-04/05: Discover sensitive-column scan + suggested-policy approval queue (`POST /api/discover/scan-rules`, `GET /api/discover/pending-policies`, `POST /api/discover/approve|reject`). Engine seeds suggestions into `authz_policy.status='pending_review'` from regex rules in `authz_discovery_rule`. Idempotent via `ON CONFLICT (policy_name) WHERE status='pending_review'`.
- [x] BU-06: Bottom-up loop column_mask end-to-end. Engine output shape now matches `PolicyEvaluator` expectations (`resource_condition.table` = bare table, `column_mask_rules` = `{ '<table>.<col>': { function, mask_type } }`). V047 migration replaces V046's broken `current_setting()` row_filter templates with `${subject.x}` (resolved at app layer in `rls.ts`). Verified by `services/authz-api/src/scripts/bu06-e2e.ts`: discover → approve → evaluate → rewrite → execute on live `nexus_data.lot_status` returns `cost: '***'` instead of `cost: '6.80'`. **Caveat: row_filter end-to-end deferred** — no seeded table has a `tenant_id`/`org_id`/`owner_id`-shaped column yet, so V047's row_filter UPDATE was `UPDATE 0` and the E2E only exercised the mask path.
- [x] BU-07: My Permissions tab L2 panel re-grouped by table (was: by policy). New `MaskedColumnsCard` flattens `{ policy: { 'table.col': rule } }` → per-table list with human-readable mask hints (`fn_mask_full` → "fully hidden, e.g. '***'"). End-user-friendly answer to "if I SELECT * FROM <table>, what gets masked?". `apps/authz-dashboard/src/components/ResolveTab.tsx`.
- [x] BU-08: Schema-driven UI POC — bottom-up "schema → SQL → UI auto-generation" sealed. New `lib/schema-to-ui.ts` introspects any registered data source (`information_schema.columns` + `pg_index` for PK), maps PG types → semantic kinds via existing `classifyType`, derives render hints (email_link / mono / relative_time / active_badge / json_truncate / array_pills / date) and Title-Case labels. `POST /api/discover/generate-app` (admin) inserts `authz_ui_page` (layout='table', `columns_override` populated so existing `config-exec` / `DataTable` renders without a new descriptor-aware path) + `authz_ui_descriptor` (`status='derived'`, `derived_from` JSONB w/ schema_hash for drift detection). Page_id namespace `auto:<source>:<schema>.<table>` keeps auto-pages isolated from hand-seeded pages; `config-exec` validator widened to accept it. UI: Generate App button on Discover Tab table/view rows → fires `open-auto-page` event → `App.tsx` swaps to `auto-page` slot, ConfigEngine renders preview. Default landing zone `module:_unmapped` auto-created so orphan auto-pages don't break the module tree. Verified end-to-end by `services/authz-api/src/scripts/bu08-e2e.ts`: happy path (201 + render hints assert per type), 409 idempotency, 412 unscanned-resource precondition, full cleanup. Migration: V048 (descriptor `status` + `derived_at` + `derived_from` columns). **POC scope**: derived descriptors are read-only (override editor lands in Phase 4). Plan: `docs/design-schema-driven-ui.md`.

### Remaining — Infrastructure (Milestone 4 core)
- [~] SEC-06: Production secrets management — code-layer done (06a/b/d/e/f in commit ff7982a, 2026-04-23). Infra-layer remaining: 06c pgbouncer MD5 rotation + Vault/external-secrets wiring. Detail: `backlog-tech-debt.md`.
- [~] Redis L1 cache layer + `authz_check_from_cache()` integration — in-process MVP done 2026-04-23 (FEAT-01: `policy-cache.ts` + `policy-events.ts` LISTEN `authz_policy_changed`, scope `/api/resolve` only). Redis cluster + `/api/check` fast-path remain. Detail: `backlog-tech-debt.md` FEAT-01.
- [ ] Helm chart + K8s deployment
- [ ] LDAP sync CronJob (scheduled, not just manual)
- [ ] Keycloak SSO integration (optional)

### Remaining — Feature (current development focus, detail: `wishlist-features.md`)
- [ ] Data Mining module: Config-SM business logic pages (design: `design-data-mining-engine.md`)
- [ ] Metabase BI self-service: lower barrier for BI users
- [ ] Policy Simulator + Impact Analysis

### Planned — Oracle 19c CDC Support
> Design complete (7 steps, 8 architecture decisions D1-D8). Plan: `.claude/plans/`

- [ ] V032: Migration — `cdc_target_schema`, `oracle_connection` columns on `authz_data_source`
- [ ] data/V005: CDC schema helper function `_nexus_create_cdc_schema()`
- [ ] `oracledb` dependency + `getOracleConnection()` / `getLocalDataPool()` in `db.ts`
- [ ] `datasource.ts`: Oracle-aware registration, test, discovery
- [ ] `oracle-exec.ts`: Oracle function call proxy route (`POST /api/oracle-exec`)
- [ ] `remote-sync.ts`: Oracle source grant sync redirected to local PG
- [ ] Frontend: Oracle data source form fields + discovery display

---

## Project Goals — Roadmap

> SSOT: milestones and goals are tracked here. Other docs reference this file.

```
Milestone 1: AuthZ Runs Locally                    ✅ Complete
Milestone 2: First Page Is Permission-Aware        ✅ Complete
Milestone 3: All Three Paths Enforced              ✅ Complete
Milestone 4: Production-Ready                      🟡 In Progress
  ├── Infrastructure: SEC-06, Redis, Helm, LDAP CronJob, Keycloak
  ├── Feature: Data Mining, Metabase BI, Policy Simulator
  └── Oracle CDC: 7-step implementation plan ready
Phase 2: AI Agent Integration (Smart Analyst 2.0)  ⏳ Blocked on M4
  └── Decision (2026-02-11): Data Nexus goes live first
```

---

## Database Migrations

| Migration | Content | Status |
|-----------|---------|--------|
| V001 | ENUM types | Done |
| V002 | Core tables (subject, resource, action, role, permission, subject_role) | Done |
| V003 | Policy tables (policy, composite_action, mask_function) | Done |
| V004 | Pool tables (pool_profile, pool_assignment, pool_credentials) | Done |
| V005 | Sync & audit tables + indexes | Done |
| V006 | Policy version table + auto-version trigger | Done |
| V007 | Core functions (_authz_resolve_roles, authz_check, authz_filter) | Done |
| V008 | Path A: authz_resolve() | Done |
| V009 | Path B: authz_resolve_web_acl() | Done |
| V010 | Path C: authz_sync_db_grants(), authz_sync_pgbouncer_config() | Done |
| V011 | Audit batch insert function | Done |
| V012 | Cache invalidation triggers (LISTEN/NOTIFY) | Done |
| V013 | Base seed data (roles, actions, mask function registry) | Done |
| V014 | Sample lot_status + sales_order data | Done |
| V015 | SSOT pool denied_columns + v_pool_ssot_check view | Done |
| V016 | Column mask PG functions (fn_mask_full/partial/hash/range) | Done |
| V017 | Fix authz_filter() resource_condition data_domain matching | Done |
| V018 | Group membership table + authz_resolve_user_groups() | Done |
| V019 | Path C native RLS (PG roles, GRANT, RLS policies, views) | Done |
| V020 | Data Source Registry (authz_data_source) + pool_profile FK | Done |
| V021 | Create 6 physical business tables in nexus_authz | Done |
| V022 | Config-Driven UI Engine (authz_ui_page + fn_ui_page/fn_ui_root) | Done |
| V023 | Fix authz_sync_pgbouncer_config() STABLE → VOLATILE | Done |
| V024 | Fix authz_check_from_cache() deny-wins + authz_resolve() include deny in L0 | Done |
| V025 | External sync support (authz_sync_log + last_grant_sync_at) | Done |
| V026 | `allowed_modules` TEXT[] on authz_db_pool_profile | Done |
| V027 | EdgePolicy fusion schema (policy_assignment, classification, clearance_mapping, role columns) | Done |
| V028 | Phase 5 seed data (policy assignments, role clearance, column classifications) | Done |
| V029 | Fix fn_ui_root: remove card_grid layout exclusion | Done |
| V030 | TimescaleDB audit hypertable (7-day chunks, 30-day compression, 2-year retention) + continuous aggregates | Done |
| V049 | AUDIT-AI-01: admin-audit columns (actor_type/agent_id/model_id/consent_given) for Constitution §9.7 | Done (commit dac27d6) |
| V050 | audit_home_handler — staged for `audit_home` Tier B page | Untracked (in tree) |
| V044 | Semantic layer: business_term/definition/formula/owner_subject_id/status/blessed_at/by on authz_resource | Done (2026-04-26, self-reviewed promote) |
| V053 | UI render-token registry (icon / status_color / phase_color / gate_color) — RENDER-TOKEN-01 | Done (2026-04-26) |
| V054 | `authz_ui_page.snapshot_data` JSONB + fn_ui_page refresh — DAG-SAVE-PAGE-01 Path A | Done (2026-04-26) |
| V045 (draft) | resource_cascade_policy table (stateless_auto vs stateful_sandbox_30d) | Drafted 2026-04-23, awaiting self-review + promote (depends on V044) |
| data/V003 | 6 remaining business tables migrated to nexus_data | Done |
| data/V004 | Path C RLS: remove current_setting(), add identity-only pg_has_role | Done |
| data/V006 | TimescaleDB business hypertables (lot_status_history, yield_events) + triggers + continuous aggregates | Done |

## Services

| Service | Path | Port | Status |
|---------|------|------|--------|
| authz-api | `services/authz-api` | 13001 | Running |
| identity-sync | `services/identity-sync` | CLI | Manual sync via `make ldap-sync` |
| authz-dashboard | `apps/authz-dashboard` | 13173 | Running |
| PostgreSQL | `deploy/docker-compose` | 15432 | Docker |
| PgBouncer | `deploy/docker-compose` | 16432 | Docker |
| Redis | `deploy/docker-compose` | 16379 | Docker |

## Key Docs

| Doc | Purpose | When to read |
|-----|---------|-------------|
| `PROGRESS.md` (this file) | Where are we now | Every session start |
| `phison-data-nexus-architecture-v2.4.md` | What we're building (full spec) | Architecture decisions |
| `er-diagram.md` | Database schema diagram | DB changes |
| `nexus-startup-guide.md` | How to get started | First-time setup |
| `backlog-tech-debt.md` | Known issues + tech debt | Sprint planning |
| `wishlist-features.md` | User feature requests + current focus | Sprint planning |
| `design-data-mining-engine.md` | Data Mining module execution plan | When implementing Data Mining |
| `design-mining-vision.md` | Data Mining long-term vision | When trigger conditions met |
| `.claude/agents/README.md` | Agent roles (16 agents) + architecture principles | AI-assisted development |
| `.claude/plans/` | Oracle CDC implementation plan (D1-D8) | When starting Oracle support |
| `standards/` | Dev standards, security rules, known risks | Before writing code |
