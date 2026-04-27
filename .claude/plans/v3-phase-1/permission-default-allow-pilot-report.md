# Permission Default-Allow Pilot — Report

> **Status:** 🟡 TEMPLATE — implementation ACs (1.x + X.1/X.2/X.3) shipped 2026-04-27.
> **Pending:** real 2-week pilot run measurements (this file is the harness; numbers fill in after pilot).
> **Plan:** `.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md`
> **Owner:** Adam · **Pilot driver:** TBD

---

## 1. Pilot scope (planned)

| Item | Decision |
|------|----------|
| **Business use case** | **物料狀況查詢**（Material status query — Adam 指定 2026-04-27） |
| Pilot datasource | `ds:_____` (TBD — 目前 dev 只有 `ds:local`，需要 (a) 在 `ds:local` 內 seed mock 物料 schema 跑驗證 pilot，或 (b) 等真實 ERP/MES DB onboard。**建議 (a)** 先驗證機制) |
| `default_l0_policy` flip date | `YYYY-MM-DD` |
| Roll-back date (if abort) | `YYYY-MM-DD` |
| Pilot duration | 2 weeks |
| Sample size | _N_ users across _M_ roles (target: ≥1 PE_* role + ≥1 SALES_* role + ≥1 BI/分析師 group) |
| Deny-list at start | V062 30 patterns + any L1/L2 carve-outs (list source: `SELECT … FROM authz_policy WHERE created_by IN ('seed-V062', …)`) |

---

## 2. Target metrics (from plan §1)

| Metric | Baseline (pre-pilot) | Plan target | Measured | Δ vs baseline | Pass? |
|--------|----------------------|-------------|----------|---------------|-------|
| New-DB onboarding end-to-end | 5–10 working days | 0.5–1 day (**−90%**) | _TBD_ | _TBD_ | ☐ |
| AUTHZ_ADMIN hours / month | 80–160 hr | **−85%** | _TBD_ | _TBD_ | ☐ |
| BI ad-hoc data coverage | ~30% of tables | **80%** | _TBD_ | _TBD_ | ☐ |
| Policy rows per new DB | 150–200 | not measured (informational) | _TBD_ | — | n/a |

**Measurement methods (fill in before pilot starts):**
- Onboarding time: timestamp from registration ticket open → first successful query, per onboarding case during pilot. Capture `n` ≥ 3 to compute median.
- AUTHZ_ADMIN hours: weekly self-report from AUTHZ_ADMIN(s), subtracting unrelated work. Compare 2 weeks pre-pilot vs 2 weeks pilot.
- BI coverage: `count(*) FROM authz_resource WHERE resource_type='table' AND attributes->>'data_source_id'='<pilot_ds>' AND authz_check('<bi_user>', ARRAY['<bi_role>'], 'read', resource_id)='t'` divided by total tables. Run for ≥3 representative BI users.

---

## 3. Safety / compliance signals

### 3.1 三大基線原則 audit (Adam 指定 2026-04-27)

> 法遵/內稽 sign-off 前，平台必須在這三條原則上**結構性能保證**，不是事後人工補。
> 這三條是 V062 30 條 deny patterns 的**前提**，不滿足就先補底，再談 pattern 種子。

| # | 原則 | 平台機制 | 現況 | Gap | 阻擋 pilot? |
|---|------|---------|------|-----|------------|
| 1 | **所有存取要可追溯到個人** | `authz_audit_log.subject_id` (text, NOT NULL) on every check | ✓ schema 有；待驗證 Path A/B/C 三條都實際寫入 | 須端到端跑一次 pilot 流量、檢查每筆 SELECT 都有 subject_id 落入 audit | 否（schema 已具備，缺的是 runtime 驗證） |
| 2 | **所有 AI 決策要可解釋** | `authz_audit_log` 上 `actor_type / agent_id / model_id / consent_given` 欄位（constitution v2.0 §9.7 承諾） | ❌ **欄位仍未加** — companion migration "pending"（已發現超過 3 天） | 需要 **V065 migration** 加四欄 + AI 寫 audit 時填入 + 拒寫 raw prompt（hash-only per §9.6） | **是** — Q1 2027 AI 側欄前必須交，pilot 期間若有 AI 動作會違反原則 #2 |
| 3 | **所有資料要可遮罩** | V061 `authz_discovery_rule.rule_type='column_mask'` + engine 寫 `auto_mask:*` policies | ✓ 機制存在；目前 0 條 mask rule 種子 | 物料狀況查詢若有 PII（員工姓名/工號／成本）需 seed mask rules | 視 pilot schema 內容而定；mock schema 若無 PII 可跳過 |

**結論：**
- pilot 啟動的硬阻擋只有 **V065 (AI audit columns)**。其餘兩條已具備機制，run-time 驗證就好。
- V062 30 條 deny patterns 與三原則**互補不互斥**：deny patterns 處理「特定欄位/資源不開」，三原則處理「所有開的東西要被記錄、可解釋、可遮罩」。

### 3.2 Pilot 期間實測指標

| Signal | Source | Threshold | Observed | Pass? |
|--------|--------|-----------|----------|-------|
| 三原則 #1 抽查 — 每日抽 100 筆 audit_log，subject_id 非空率 | `SELECT count(*) FILTER (WHERE subject_id<>'') * 100.0 / count(*) FROM authz_audit_log WHERE timestamp >= today` | **100%** | _TBD_ | ☐ |
| 三原則 #2 抽查 — AI 動作（若 pilot 期間有）的 actor_type/agent_id/model_id 完整率 | (V065 後) `SELECT … FROM authz_audit_log WHERE actor_type='ai_agent'` | **100%** 或 0 筆（pilot 不啟用 AI 也算過） | _TBD_ | ☐ |
| 三原則 #3 抽查 — pilot ds 的 PII 欄位是否都有 column_mask rule | `SELECT count(*) FROM authz_discovery_rule WHERE rule_type='column_mask' AND … data_source_id='<pilot_ds>'` | **覆蓋率 100% PII 欄位** | _TBD_ | ☐ |
| Unauthorised-access attempts on deny-listed columns | `authz_audit_log` WHERE decision='deny' AND resource matches V062 patterns | _TBD by Adam_ | _TBD_ | ☐ |
| New `authz_policy` deny suggestions emitted by engine during pilot | `count` from `authz_policy` WHERE `suggested_by_rule IS NOT NULL AND status='pending_review' AND effect='deny' AND suggested_at >= pilot_start` | informational | _TBD_ | n/a |
| Operator approval rate of deny suggestions | approved / total emitted (PATCH `/api/discover/suggestions/:id`) | informational | _TBD_ | n/a |
| 漏失（false-allow that should have been deny） | manual review of pilot users' top-50 viewed resources by 法遵 reviewer | **0 critical** | _TBD_ | ☐ |
| `pg_default_acl` symmetry on rollback drill | run `make verify-phase1` mid-pilot | C1=3, C2=0 | (verify-phase1 14/14 already passing 2026-04-27) | ✓ |

**Critical-deny incident protocol:** any 漏失 finding involving SOX / PII / IP triggers immediate `UPDATE authz_data_source SET default_l0_policy='deny' WHERE source_id='<pilot_ds>'` + 24-hour post-mortem before resuming pilot.

---

## 4. NPS / qualitative

| Audience | Question | Score (1–10) | Open comment |
|----------|----------|--------------|--------------|
| BI 分析師 (n=_TBD_) | "Did permission friction decrease this pilot?" | _TBD_ | _TBD_ |
| AUTHZ_ADMIN (n=_TBD_) | "Did your weekly ticket queue feel smaller?" | _TBD_ | _TBD_ |
| 法遵/內稽 (n=_TBD_) | "Are you comfortable extending default-allow beyond the pilot?" | _TBD_ | _TBD_ |

---

## 5. Decision matrix (fill at pilot end)

| Outcome | Trigger | Next action |
|---------|---------|-------------|
| **GO** to Phase 2 (expand to next datasource) | All 3 plan §1 targets within ±20%, **AND** zero critical 漏失, **AND** 法遵 NPS ≥ 7 | Open scoping ticket for next pilot datasource; schedule G2 alignment review |
| **HOLD** (extend pilot 2 more weeks) | Targets borderline OR NPS 5–6 OR ≥1 non-critical 漏失 with mitigation in flight | Document gap; iterate on V062 deny patterns; rerun verify-phase1 |
| **ROLLBACK** | Any critical 漏失 OR 法遵 NPS < 5 OR explicit business veto | `UPDATE … SET default_l0_policy='deny'` + run `authz_sync_db_grants()` (V063 symmetric REVOKE); post-mortem; archive plan as paused |

---

## 6. Implementation status (filled at template creation)

| AC | Status | Evidence |
|----|--------|----------|
| 1.1 `default_l0_policy` column | ✓ | V059 |
| 1.2 resource→datasource mapping | ✓ | `authz_resource.attributes->>'data_source_id'` convention used by V060/V064 |
| 1.3 invert `authz_resolve()` | ✓ | V060 |
| 1.4 invert `authz_check()` (+ batch single path) | ✓ | V060 |
| 1.5 deny-suggestion approval loop enforces | ✓ | V064 + engine `effect='deny'` + `/discover/suggestions` PATCH; verify-phase1 cell B7 |
| 1.6 `authz_sync_db_grants()` per-profile branch | ✓ | V063 |
| 1.7 rollback symmetry (`pg_default_acl` drains to 0) | ✓ | V063 + verify-phase1 cell C2 |
| X.1 12-cell regression matrix + L1/L2/L3 | ✓ (14/14) | `scripts/verify-phase1-default-allow.sh`, `make verify-phase1` |
| X.2 docs (api-reference + architecture-diagram + constitution Article 2 amendment v2.1) | ✓ | commits `eea5f4a` (api/arch) + constitution v2.1 (2026-04-27) |
| X.3 PROGRESS.md log | ✓ | commit `a6aab3a` |
| X.4 pilot report | 🟡 TEMPLATE | this file |

**Open items not gated by code:**
- V062 30 deny patterns still owe **法遵 / 內稽 + Adam dual sign-off** before any prod-bound flip.
- AC-2.1 pilot ds：use case 已定（**物料狀況查詢**, Adam 2026-04-27），但 dev DB 只有 `ds:local`，需先 seed mock 物料 schema 或等真實 ERP/MES onboard。
- **V065 (AI audit columns)** — constitution v2.0 §9.7 promised actor_type/agent_id/model_id/consent_given on `authz_audit_log`；目前未加。三原則 #2 (AI 可解釋) 的硬阻擋。建議在 pilot 啟動前 1 週交付。
- Single-source path of `authz_check_batch()` widened by V060/V064; multi-resource batch query NOT yet widened — Phase 2 follow-up if pilot telemetry shows the gap matters (V064 header notes).

---

## 7. Pilot 操作 SOP — Adam 每天做什麼（2 週版）

> 「不清楚要做什麼」的逐步答案。每一步都對應一個檔案/指令，不抽象。

### 前置（D-7 ~ D-1，共 1 週）

| Day | 事項 | 動作 | 完成判準 |
|-----|------|------|---------|
| D-7 | 決定 pilot ds | 在 dev `ds:local` 內 seed 物料 mock tables（Claude 可代寫 V0XX seed migration），或指定真實 ERP/MES DB | `SELECT … FROM authz_data_source WHERE source_id='<pilot_ds>'` 有資料 |
| D-6 | 補 V065 AI audit columns | 跑 V065 migration 加 `actor_type/agent_id/model_id/consent_given` to `authz_audit_log` | `\d authz_audit_log` 顯示 4 個新欄位 |
| D-5 | V062 30 條 deny 種子草案 | Claude 依物料 schema 列 candidate patterns（員工成本/客戶料號/折讓金額…）→ Adam 改 → 法遵/內稽 sign-off | `docs/audit-signoff/permission-pilot-2026MMDD.md` 兩個 reviewer 簽 |
| D-3 | Pilot 用戶 + 角色名單 | Adam 列 ≥5 個 BI 分析師帳號 + 對應 PE_*/SALES_* 角色 | namelist 寫到本報告 §1 sample size 欄 |
| D-1 | 三原則 baseline 抽查 | 跑 §3.2 抽查指令 1 次當 pilot 前的 baseline | 三筆數字寫到 §2 baseline 欄 |
| D-1 | Rollback drill | `make verify-phase1` 過 14/14；模擬 `UPDATE … SET default_l0_policy='deny'` 後 `authz_sync_db_grants()` `pg_default_acl` 歸零 | C1=3, C2=0 |

### 執行（D0 ~ D14，2 週）

| Day | 事項 | 動作 |
|-----|------|------|
| **D0 (flip day)** | 翻轉 flag | `UPDATE authz_data_source SET default_l0_policy='allow' WHERE source_id='<pilot_ds>'` + 立刻 `SELECT authz_sync_db_grants('<pilot_ds>')` |
| D0 | 通知 pilot 用戶 | Email/Slack 告知「pilot 開始,有任何看不到該看到的、或看到不該看到的,請當天回報」 |
| D1-D14 每天早上 | 三原則抽查（5 分鐘） | 跑 §3.2 三筆抽查 SQL，數字寫到 daily log |
| D1-D14 每天 | 收集 deny suggestions | `SELECT … FROM authz_policy WHERE status='pending_review' AND suggested_by_rule IS NOT NULL` → Adam 看完 → PATCH /api/discover/suggestions/:id 設 active 或 rejected |
| **D7 (期中)** | 期中 verify | `make verify-phase1` 應仍 14/14；NPS 第一輪問卷（5 人 × 3 題） |
| **D14 (期末)** | 期末 verify + 決議 | 跑 §2 三項目標數值、§3.2 三原則指標、§4 NPS 第二輪 → 填 §5 決策矩陣 → §7 sign-off |

### 觸發 ROLLBACK 的 3 個情境（任一即按）

1. 任何 SOX/PII/IP 漏失 → `UPDATE … SET default_l0_policy='deny'` + 24h 內開 post-mortem
2. 法遵 NPS < 5 → 同上
3. 連續 2 天三原則抽查 #1 (subject_id 非空率) < 100% → 暫停 pilot，查 audit 寫入路徑

### Adam 真正不能放手的 3 件事

- **D-5 V062 種子內容定案**（人為判斷，Claude 不能代）
- **D-1 / D7 / D14 sign-off 簽名**（責任歸屬）
- **任何 ROLLBACK 觸發點的決策**（Claude 可標紅，但不執行）

其餘都可以 Claude 代跑指令、出抽查報表、寫 deny pattern 草稿。

---

## 8. Sign-off

| Role | Name | Date | Decision |
|------|------|------|----------|
| Data Nexus owner | Adam | _TBD_ | _GO / HOLD / ROLLBACK_ |
| 法遵 reviewer | _TBD_ | _TBD_ | _approve / objection_ |
| 內稽 reviewer | _TBD_ | _TBD_ | _approve / objection_ |
| AUTHZ_ADMIN representative | _TBD_ | _TBD_ | _representative comment_ |
