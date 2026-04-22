# LLM Eval Set (200 筆) Collection Plan

- **Owner:** TBD (Adam + DBA team + PM)
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.8, §3 Q3 2026, §6.1
- **Target:** Q3 2026 start → Q4 2026 delivery (100/200 by Q3, 200/200 by Q4)

---

## Purpose

建立 Data Nexus 專屬的 eval set，用來對 LLM team 交付的模型做驗收與回歸測試（SLO：text-to-SQL ≥ 85%, recall@10 ≥ 0.90）。此集合是 LLM team 契約驗收的唯一標準。

---

## DBA 100 筆 — Sourcing Strategy

- **Source A:** Path B existing SQL queries — pull top-N by execution count from audit / query log
- **Source B:** Tier 3 Query Tool real SQL patterns (once Tier 3 alpha exists; for Q3 2026 collection, use current direct-DB query logs)
- **Source C:** DBA 手寫的 canonical query examples per data domain (each DBA contributes 5-10)
- Dedup + sanitize (hash PII) + anonymize users before checking into eval set
- Owner: DBA team lead

## Business 100 筆 — Sourcing Strategy

- **Source A:** PM interviews (structured — "what do you want to ask this system?")
- **Source B:** Existing BI ticket backlog (request → expected output)
- **Source C:** 業務 owners (per domain: 製造 / 品質 / 營運 / 財務) — 20-30 per domain
- Pair each natural-language question with **expected SQL** and **expected result shape**
- Owner: PM pool coordinator

## Format Spec (draft)

```yaml
id: eval-0001
source: dba|business
domain: manufacturing|quality|finance|...
question_zh: "上週 A 產線的 OEE 是多少？"
question_en: "What was the OEE of production line A last week?"
expected_sql: |
  SELECT AVG(oee) FROM ... WHERE line = 'A' AND ts >= NOW() - INTERVAL '7 days';
expected_result_shape:
  columns: [avg_oee]
  row_count: 1
authz_context:
  user_role: operations_manager
  visible_resources: [manufacturing.line_metrics]
notes: |
  ...
```

(JSON allowed — YAML preferred for human review.)

## Scoring Methodology

- **text-to-SQL accuracy ≥ 85%:**
  - Score 1 if predicted SQL result set matches expected shape + row count + deterministic sample of values
  - Tolerate whitespace / alias / order differences; reject semantic differences
- **recall@10 ≥ 0.90 (embedding retrieval):**
  - For each question, check whether the gold `business_term` or resource appears in the top-10 retrieval hits
- **p99 latency ≤ 3s (SQL gen) / ≤ 500ms (embedding):**
  - Measured per call during eval run

## Kickoff This Week (2026-04-22 → 2026-04-28)

- [ ] **Mon:** Adam 寄信給 DBA team lead,列明 DBA 100 筆需求 + source A/B/C 拆法 + 格式樣板 (本文件)
- [ ] **Mon:** Adam 寄信給各域 PM (製造 / 品質 / 營運 / 財務),列明業務 100 筆訪談需求 + 每域 20-30 筆目標
- [ ] **Tue:** 決定 eval set repo 位置 (private Phison internal — 建議 `data-nexus-eval` 獨立 repo,不混進主 repo 因為含內部 SQL + 業務問題)
- [ ] **Wed:** Adam draft 第一版訪談 script 給 PM 用 (10 題問題結構)
- [ ] **Thu:** DBA team lead 回 nomination: 誰貢獻哪個 domain 的 5-10 筆,預期交付日
- [ ] **Fri:** 啟動 LLM team 初步對話 — 確認他們 OK 用這個 eval set 當驗收依據 (不是等 Q4 2026 才通知)
- [ ] **Fri:** Adam 把 eval set kickoff 進度寫入 `docs/PROGRESS.md` 本週區塊

### LLM SLO 簽契約時程 (與 eval set 同步)

- **2026-04 (now):** 通知 LLM team 契約即將啟動,索取他們目前模型的 baseline score
- **2026-06:** 用 100/200 半集做第一次 baseline 跑分,有數字才談得動
- **2026-09:** 200/200 交付完,與 LLM team 正式簽 SLO 契約 (Gate G3 起跑點)
- **2027-03 (G3):** SLO 達成驗收

---

## Quarterly Augmentation Process

- Every quarter: +20-50 筆 (master plan §2.8)
- Sources: new Tier 3 query patterns, new business questions, production failures surfaced in AI incidents
- Review: DBA + PM approve before admission
- Versioning: `eval-v1.0` @ Q4 2026, `eval-v1.1` @ Q1 2027, ...

## Acceptance Criteria

- Q3 2026 milestone: 100/200 collected, format-validated
- Q4 2026 milestone: 200/200, signed off by LLM team as the contract baseline
- Each item has: question (zh + en), expected SQL, expected result shape, authz context

---

## STUB — to be filled

- Repository location for eval set (private; not public repo)
- Scoring harness implementation (who owns, language, CI integration)
- PII sanitization checklist
- Per-domain quota breakdown for business 100
- Interview script for PMs
- Cross-team review SLA (DBA ↔ PM ↔ LLM team)
