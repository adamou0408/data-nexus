# [Plan Title]

> **Template usage:** Copy this file to `<plan-name>.md` in the same directory, fill in all fields, and add a row to `README.md` Sub-Plans table + Status Table. Delete this blockquote and the "Template Notes" section at the bottom before committing the new plan.

- **Planner Owner:** [人 / session — 負責需求 + 設計]
- **Executor Owner:** [人 / session — 負責實作；可 TBD 直到 Status = READY-FOR-IMPLEMENTATION]
- **Status:** DRAFT
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §X.X
- **Target:** [Quarter / Gate — e.g. Q4 2026 alpha / G2]
- **Created:** YYYY-MM-DD
- **Last updated:** YYYY-MM-DD

---

## Status Lifecycle

> **Legend (two-session workflow):**
> `DRAFT` → `READY-FOR-IMPLEMENTATION` → `IN-PROGRESS` → `READY-FOR-REVIEW` → `DONE` → `ARCHIVED`
>
> - **DRAFT** — Planner session 還在寫，executor **不要動**
> - **READY-FOR-IMPLEMENTATION** — Planner 確認需求/設計鎖定，executor 可以開工
> - **IN-PROGRESS** — Executor session 正在實作；planner 不要改 AC
> - **READY-FOR-REVIEW** — Executor 做完，等 planner / Adam 驗收
> - **DONE** — 驗收通過，PROGRESS.md 已更新
> - **ARCHIVED** — 已過期 / 已被取代

每次 status 變動，請同步更新 `README.md` Status Table 與本檔的 **Last updated** 欄位。

---

## 1. Problem / Why

[1-3 段描述要解決什麼問題、為什麼現在做。對應 master plan 哪個 §。]

---

## 2. Scope

**In scope:**
- [ ] [具體交付物 1]
- [ ] [具體交付物 2]

**Out of scope (defer / Phase 2):**
- [明確列出避免 scope creep 的項目]

---

## 3. Design / Approach

[架構圖 / 流程 / schema / API 形狀。Planner session 在這裡把 trade-off 講清楚，讓 executor 不用回頭再決策。]

### Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| [e.g. storage] | [e.g. 用 authz_audit_log 而非新表] | [e.g. 避免新增 hypertable] |

### Open questions

- [ ] [問題] — owner: [planner / Adam / DBA]

---

## 4. Acceptance Criteria

> **Executor 看這裡知道何時算「做完」。Planner 必須在 READY-FOR-IMPLEMENTATION 之前把這節寫死。**

- [ ] **AC-1:** [可驗證的條件，例如「`POST /api/foo` 回 200 + 寫入 authz_audit_log」]
- [ ] **AC-2:** [...]
- [ ] **AC-3:** Tests: [unit / integration / e2e — 至少列一個]
- [ ] **AC-4:** Docs: [更新 `docs/api-reference.md` / `docs/architecture-diagram.md` 等]
- [ ] **AC-5:** PROGRESS.md 對應條目更新

---

## 5. Implementation Plan (Executor 填)

> Executor session 在 `IN-PROGRESS` 階段填這節。Planner 不要 pre-fill。

### Tasks

- [ ] [task 1 — 預估 X hr]
- [ ] [task 2]

### Files touched

- `database/migrations/V0XX__xxx.sql` — [新增 / 修改]
- `services/authz-api/src/...` — [...]
- `apps/authz-dashboard/src/...` — [...]

### Migration / DB notes

[編號、order、rollback 策略]

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| [e.g. V0XX 編號跟另一 worktree 撞] | 中 | 開工前 `ls database/migrations/` 對齊 |

**Rollback:** [如果做完發現要退回怎麼辦]

---

## 7. Handoff Log

> 兩個 session 在這裡交接。每次 status 變動 + 一行 log。

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| YYYY-MM-DD | Planner | → DRAFT | 起草 |
| YYYY-MM-DD | Planner → Executor | DRAFT → READY-FOR-IMPLEMENTATION | AC locked, executor 可開工 |
| YYYY-MM-DD | Executor | → IN-PROGRESS | 開始實作 |
| YYYY-MM-DD | Executor → Planner | IN-PROGRESS → READY-FOR-REVIEW | 待 review |
| YYYY-MM-DD | Planner | → DONE | 驗收通過 |

---

## 8. References

- Master plan: [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md)
- Architecture: [`docs/phison-data-nexus-architecture-v2.4.md`](../../../docs/phison-data-nexus-architecture-v2.4.md)
- Constitution: [`docs/constitution.md`](../../../docs/constitution.md)
- Related sub-plans: [`./xxx.md`](./xxx.md)

---

## Template Notes (delete after copying)

**Two-session workflow recap:**

1. **Planner session** 寫 §1-4 + §6 + §8。寫完把 Status 改成 `READY-FOR-IMPLEMENTATION`，記 handoff log。
2. **Executor session** 開頭先讀整份 plan，確認 AC 清楚再動手；不清楚的回 planner 問。
3. Executor 開工時 Status → `IN-PROGRESS`，填 §5。
4. 做完 Status → `READY-FOR-REVIEW`，列出對哪些 AC 打勾、哪些 deferred。
5. Planner / Adam 驗收後 Status → `DONE`，更新 `README.md` Status Table + `docs/PROGRESS.md`。

**為什麼分這麼細？**

- 兩個 Claude session context 不共享，靠檔案傳遞狀態
- 明確的 AC 避免 executor 猜需求、planner 後悔
- Handoff Log 像 git log 一樣可追溯，未來 retro 用得上
