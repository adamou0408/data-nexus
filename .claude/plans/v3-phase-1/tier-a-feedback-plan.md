# Feedback Primitive (Tier A — A3)

- **Planner Owner:** Adam (this session)
- **Executor Owner:** Adam (same session — single-day primitive，pattern reuse SAVED-VIEW-V01)
- **Status:** DONE (2026-04-29 — single-session DRAFT → DONE;Curator Inbox tab 切 FU commit `FEEDBACK-V01-INBOX-FU`;**AC-7 frontend round-trip 未在瀏覽器手動驗證** caveat per `feedback_ui_verification`)
- **Linked from:** [`tier-a-primitives-roadmap.md`](./tier-a-primitives-roadmap.md) §3.2 (A3 排序)、[`two-tier-platform-model.md`](./two-tier-platform-model.md) §82
- **Target:** Q3 2026 rolling — Tier A platform primitive #3
- **Created:** 2026-04-29
- **Last updated:** 2026-04-29

---

## 1. Problem / Why

ConfigEngine 上線後 end-user 發現「這欄資料錯了」「這 filter 找不到我要的」「這頁說明看不懂」，目前**沒有任何 in-app 反饋管道**。Curator 只能靠口頭轉述、Slack DM、或 user 自己跑 audit_log 的 hypothetical pipeline。結果：

- **end-user**：Pain 累積、不回報就放棄這個 page
- **Curator**：sample-bias，看到的都是抱怨最大聲的；沉默多數的 feedback 永遠拿不到
- **demo target**：「對 user 好用」沒 evidence 機制，2027-05 demo 拿不出 quantitative engagement signal

**對應 Tier A roadmap §3.2：A3 feedback** 排序第 3，理由：
- 100% pure additive，不擋 hard gate
- reuse SAVED-VIEW-V01 的 per-user × per-page table pattern + ConfigEngine wrapper hook 點，第二週快很多
- Curator-side UX 風險（Inbox tab 設計）切到 follow-up 不擠這 sprint
- 後續 A4 subscription 若開（`feedback被回覆` 是 candidate consumer 之一）也能 reuse

---

## 2. Scope

**In scope (this commit):**
- [ ] V082 migration 建 `authz_feedback` table（feedback_id / user_id / page_id / target_path / kind / body / status / curator_id / resolved_at / created_at / updated_at）
- [ ] CHECK constraints：`kind` enum / `status` enum / `body` length 1-4000 / `target_path` regex
- [ ] Indexes：`(status, page_id)` for Curator inbox query / `(user_id, page_id, created_at DESC)` for user 自己看
- [ ] Backend 4 routes：
  - `POST /api/feedback`（self-write，user_id by session）
  - `GET /api/feedback/mine?page_id=X`（self-scope list）
  - `GET /api/feedback/inbox?status=&page_id=`（`requireRole('ADMIN','AUTHZ_ADMIN')`）
  - `PATCH /api/feedback/:id/status`（`requireRole`；sets `curator_id` + `resolved_at`）
- [ ] Audit log 4 action：`tier_a_feedback_create / triaged / resolved / dismissed`（PATCH route 依目標 status 對應 action_id）
- [ ] Frontend `useFeedback` hook + `FeedbackButton` 浮動按鈕（page-level only，column-level v2）+ dialog（kind dropdown + body textarea），wire 進 `TablePageWithSavedView`
- [ ] Smoke：`services/authz-api/scripts/test-feedback.ts` ~10 cases
- [ ] tsc × 2 clean
- [ ] AC-9 doc sync：plan / README Sub-Plans / README Status Table / roadmap §3.2 row / PROGRESS.md

**Out of scope (defer to Curator Inbox follow-up commit `FEEDBACK-V01-INBOX-FU`):**
- **Curator Inbox tab UI**（list / filter / status setter / empty state / pagination — 整套 UX 設計面）
- **column-level「📝」icon**（roadmap §3.2 v2，等 page-level 用得起來再評估）
- **Reply 鏈 / 對話**（v1 只「user 提、Curator 標 status」最小循環）
- **email / Slack 通知**（內部部署無 SMTP baseline）
- **User PATCH/DELETE 自己 feedback**（append-only，避免「我有沒有真的要撤回」UX 設計成本，且 audit trail 更乾淨）
- **Bulk triage / saved filter on inbox**（等 inbox 有 ≥ 50 row 再評）
- **Subscribe-to-feedback events**（屬 A4 subscription gated work）

---

## 3. Design / Approach

### 3.1 Schema (V082)

```sql
-- database/migrations/V082__authz_feedback.sql
CREATE TABLE authz_feedback (
  feedback_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text        NOT NULL,
  page_id      text        NOT NULL,
  target_path  text        NOT NULL,                  -- 'page' | 'column:<col>' | 'filter:<field>'
  kind         text        NOT NULL,
  body         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'open',
  curator_id   text,                                  -- nullable until first triage
  resolved_at  timestamptz,                           -- nullable; set when status moves out of 'open'
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authz_feedback_user_nonblank   CHECK (length(btrim(user_id)) > 0),
  CONSTRAINT authz_feedback_page_nonblank   CHECK (length(btrim(page_id)) > 0),
  CONSTRAINT authz_feedback_target_shape    CHECK (target_path ~ '^(page|column:.+|filter:.+)$'),
  CONSTRAINT authz_feedback_kind_enum       CHECK (kind   IN ('data_wrong','feature_request','confusing','other')),
  CONSTRAINT authz_feedback_status_enum     CHECK (status IN ('open','triaged','resolved','dismissed')),
  CONSTRAINT authz_feedback_body_len        CHECK (length(btrim(body)) BETWEEN 1 AND 4000)
);

-- Curator inbox query: WHERE status = 'open' [AND page_id = ?]
CREATE INDEX authz_feedback_status_page_idx
  ON authz_feedback (status, page_id);

-- User 自己看：WHERE user_id = ? AND page_id = ? ORDER BY created_at DESC
CREATE INDEX authz_feedback_user_page_created_idx
  ON authz_feedback (user_id, page_id, created_at DESC);

COMMENT ON TABLE authz_feedback IS
  'Tier A primitive #3: per-user feedback on Tier B pages (data_wrong/feature_request/confusing/other). Append-only for users; Curator triages.';
```

**為什麼用 plain text + CHECK 而非 ENUM**：對齊 V049 (`actor_type`) / V061 (`effect`) / V079 (`cascade_mode`) 既有 codebase pattern，避免 ENUM ALTER pain。

**為什麼 `curator_id` 不設 FK**：對齊 V080 `authz_user_view.user_id` 慣例（subject 來源異質：LDAP / Keycloak / `group:` virtual subject），FK 反而擋 cross-source。

### 3.2 `target_path` 三層格式（鎖定）

| Pattern | 觸發點 | 例子 |
|---------|--------|------|
| `page` | 浮動按鈕（v1 唯一觸發點） | `'page'` |
| `column:<col>` | column header 旁的「📝」icon（v2 deferred） | `'column:lot_id'` |
| `filter:<field>` | filter label 旁的「📝」icon（v2 deferred） | `'filter:status'` |

CHECK regex `^(page|column:.+|filter:.+)$` 強制三選一；`.+` 允許任何 column / field name（不去煩前端對齊，cross-product over 1000 個 page × col 不適合 enum）。

### 3.3 `kind` 四分類

| `kind` | 何時用 |
|--------|--------|
| `data_wrong` | 「這格資料錯了」/「這應該顯示 X 但顯示 Y」 |
| `feature_request` | 「我想要 filter 支援 ≥」/「能加個 export 嗎」 |
| `confusing` | 「help_text 看不懂」/「這 column 名是什麼意思」 |
| `other` | 不確定屬哪類 |

Curator 依 kind 排優先（`data_wrong` 通常最緊；`feature_request` 入 backlog）；status flow 與 kind 正交。

### 3.4 `status` 四階段（any-to-any，無 state machine）

| `status` | 語意 | Curator 動作 |
|----------|------|-------------|
| `open` | 剛收到，未檢視 | INSERT 預設 |
| `triaged` | Curator 看過、分類完，等處理 | PATCH `triaged` |
| `resolved` | 已修 / 已回應 | PATCH `resolved` |
| `dismissed` | 不會處理（重複 / 不相關 / decline） | PATCH `dismissed` |

**為什麼不寫 state machine**：誤標可逆（`resolved` → 又回到 `open`）、`audit_log` 帶完整序列、寫 state machine 限制反而擋實用 flow。

### 3.5 Backend API surface

| Method | Path | Authz | Body / Query |
|--------|------|-------|-------------|
| `POST` | `/api/feedback` | `requireAuth` (any user) | `{ page_id, target_path, kind, body }` |
| `GET` | `/api/feedback/mine?page_id=X` | `requireAuth`；`WHERE user_id=current` | optional `page_id` filter |
| `GET` | `/api/feedback/inbox?status=open&page_id=X` | `requireRole('ADMIN','AUTHZ_ADMIN')`（SYSADMIN bypass） | optional `status` / `page_id` filters |
| `PATCH` | `/api/feedback/:id/status` | `requireRole` 同上 | `{ status: 'triaged'\|'resolved'\|'dismissed' }` |

**PATCH 行為**：
- 從 session 拿 `curator_id`、寫入
- 若新 `status !== 'open'` 且 `resolved_at IS NULL` → set `resolved_at = now()`（first-triage timestamp，後續 PATCH 不再覆蓋）
- 若改回 `open`（unlikely but valid）→ 不清 `resolved_at`，保留歷史軌跡
- audit `action` 依目標 status 取：`tier_a_feedback_triaged / resolved / dismissed`

**audit log 對齊 SAVED-VIEW-V01 pattern**：直接 `void logAdminAction(pool, {...})`，actor_type='human'、consent_given='human_explicit' 走預設。

### 3.6 Frontend 整合（`ConfigEngine.tsx` `TablePageWithSavedView` wrapper）

```tsx
// apps/authz-dashboard/src/components/FeedbackButton.tsx — NEW
//   Bottom-right floating button + modal dialog
//   - kind: <select>
//   - body: <textarea> (maxLength=4000)
//   - submit → POST /api/feedback (target_path='page')
//
// apps/authz-dashboard/src/hooks/useFeedback.ts — NEW
//   minimal: { submit(input), submitting, error }
//   list-mine 留給 inbox FU commit
//
// ConfigEngine.tsx TablePageWithSavedView 加一行:
//   <FeedbackButton pageId={pageId} />
```

**為什麼浮動按鈕而非 column-level icon (v1)**：
- 浮動按鈕讓 user 主動描述 target，Curator 收到的 feedback 品質高於系統強塞 column path
- column-level icon 會跟 help_text 的 `?` icon 競爭視覺；先讓 page-level 跑一輪看真實使用率再決定 column-level 值不值得做

**為什麼掛在 `TablePageWithSavedView` 而非 `ConfigEngine` 整體**：
- v1 限 ConfigEngine `columns_override` 走 layout=table 的 page，對齊 SAVED-VIEW-V01 scope
- handler-driven page (V050 audit_home / V078 npi_gate_console) 自己決定要不要掛
- descriptor pattern (V036/V039) 走自己的 page model，等真有 demand 再評估

### 3.7 Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| User append-only / 可改可刪 | **append-only** | 簡化 authz、audit trail 乾淨、無「我有沒有要撤回」UX 設計成本 |
| State machine | **無 — any-to-any transitions** | 誤標可逆；audit 序列完整；無 state machine 限制反而靈活 |
| `target_path` 驗證 | **PG-side regex CHECK** | DB-side 免費；frontend 仍要對齊但雙保險 |
| `kind` enum | **TEXT + CHECK** | 對齊 V049/V061/V079 codebase pattern |
| `body` 上限 | **4000 char** | textarea 合理上限；防 abuse |
| `curator_id` FK | **無** | 對齊 V080 `user_id` 慣例 |
| Audit action 命名 | **`tier_a_feedback_<status>`** | 對齊 SAVED-VIEW-V01 `tier_a_saved_view_*` prefix |
| Curator Inbox UI | **單獨 follow-up commit** | UX 設計面風險集中、避免 SAVED-VIEW timing 重演 |
| Floating button vs column-level | **v1 floating only** | column-level 跟 help_text icon 衝突視覺；先看 page-level 使用率 |
| Page 類型範圍 | **ConfigEngine `columns_override` only** | 對齊 SAVED-VIEW-V01 與 roadmap §3.2 v1 scope |

### 3.8 Open questions

- 暫無

---

## 4. Acceptance Criteria

- [ ] **AC-1:** V082 migration 套上後，`authz_feedback` 存在；`pg_indexes` 看到 `authz_feedback_status_page_idx` + `authz_feedback_user_page_created_idx` 兩個 index；`pg_constraint` 看到 4 個 CHECK
- [ ] **AC-2:** `POST /api/feedback` 帶 `kind='data_wrong' body='lot_id 顯示錯誤'` 回 201，row 寫入；`status='open'`、`curator_id IS NULL`、`resolved_at IS NULL`
- [ ] **AC-3:** `POST` 帶 bad `kind='unknown'` / `target_path='garbage'` / `body=''` 各自 400
- [ ] **AC-4:** `GET /api/feedback/mine?page_id=X` 只回 `user_id = current_user` 的 row；別 user 的 row 不出現
- [ ] **AC-5:** `GET /api/feedback/inbox` non-admin user 回 403；admin user 回所有 row
- [ ] **AC-6:** `PATCH /api/feedback/:id/status {status:'triaged'}` （admin）回 200，row `curator_id = admin user_id`、`resolved_at = now()`；非 admin 回 403
- [ ] **AC-7:** Frontend：浮動按鈕在 ConfigEngine `columns_override` page 出現，點開 dialog → 填 kind + body → submit → 成功訊息 *(AC-7 frontend round-trip 預期不在瀏覽器手動驗證；component+hook tsc clean 即可，per `feedback_ui_verification`)*
- [ ] **AC-8:** Smoke: `services/authz-api/scripts/test-feedback.ts` ≥ 10 cases pass（create 201 / bad kind 400 / bad target_path 400 / empty body 400 / mine self-scope / inbox non-admin 403 / inbox admin sees all / PATCH triaged 200 / PATCH non-admin 403 / audit_log 寫入驗證）
- [ ] **AC-9:** `npx tsc -p services/authz-api` + `npx tsc -p apps/authz-dashboard` 雙 clean
- [ ] **AC-10:** `authz_admin_audit_log` 抓得到 `tier_a_feedback_create / triaged / resolved / dismissed` 四個 action（smoke 至少驗 create + triaged）
- [ ] **AC-11:** Doc sync：本 plan status / README Sub-Plans 表新增 row / README Status Table 新增 row / roadmap §3.2 row 標 DONE / PROGRESS.md 新增 FEEDBACK-V01 條目

---

## 5. Implementation Plan (Executor 填)

### Tasks

- [ ] V082 migration 寫 + apply 到 dev DB
- [ ] Backend route file `services/authz-api/src/routes/feedback.ts`（4 routes）
- [ ] Mount in `services/authz-api/src/index.ts`：`app.use('/api/feedback', requireAuth, feedbackRouter)`（inbox + PATCH 內部再用 `requireRole`）
- [ ] Smoke `services/authz-api/scripts/test-feedback.ts`
- [ ] Frontend `apps/authz-dashboard/src/api.ts` 加 4 method + types
- [ ] Frontend hook `apps/authz-dashboard/src/hooks/useFeedback.ts`
- [ ] Frontend `apps/authz-dashboard/src/components/FeedbackButton.tsx`（floating bottom-right + dialog）
- [ ] Wire `<FeedbackButton pageId={pageId}/>` 進 `ConfigEngine.tsx` `TablePageWithSavedView` 內
- [ ] tsc × 2 clean
- [ ] Commit FEEDBACK-V01 + AC-11 doc sync

### Files touched

- `database/migrations/V082__authz_feedback.sql` — new
- `services/authz-api/src/routes/feedback.ts` — new
- `services/authz-api/src/index.ts` — mount route
- `services/authz-api/scripts/test-feedback.ts` — new
- `apps/authz-dashboard/src/api.ts` — modify
- `apps/authz-dashboard/src/hooks/useFeedback.ts` — new
- `apps/authz-dashboard/src/components/FeedbackButton.tsx` — new
- `apps/authz-dashboard/src/components/ConfigEngine.tsx` — wire button into TablePageWithSavedView
- `.claude/plans/v3-phase-1/README.md` — Sub-Plans + Status rows
- `.claude/plans/v3-phase-1/tier-a-primitives-roadmap.md` — §3.2 row + 排序總圖 + Handoff Log
- `docs/PROGRESS.md` — 新近完成 entry

### Migration / DB notes

- V082 是下個 free 號（V079=cascade_policy / V080=user_view / V081=sink_as_authz_resource）
- Rollback：`DROP TABLE authz_feedback CASCADE`；無外鍵指過來，安全
- 不 backfill；新表，無歷史資料

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| V082 編號跟另一 worktree 撞 | 低 | 開工前 `ls database/migrations/`；V081 是最後 |
| Curator 收 feedback 後無 UI 看 → user 提了沒人理 | 中 | inbox API 已落地，Curator 可手 curl 暫看；FU commit `FEEDBACK-V01-INBOX-FU` 必接才算 user-visible 完整 |
| `target_path` regex 與前端不一致 → user 提交時 400 | 中 | v1 frontend 只送 `'page'`，正則允許；v2 加 column/filter 觸發點時同步 update |
| Append-only 設計使誤填 spam 累積 | 低 | Curator `status='dismissed'` 即可隱藏；真 abuse 才 hard-delete（DB-side 手動） |
| Audit log 4 action 命名 typo | 低 | smoke AC-10 直接 query 驗 |
| Floating button 蓋到 SavedViewBar dropdown | 低 | bottom-right vs top-toolbar 不衝突；dialog 用 Modal 蓋全螢幕 |

**Rollback**：
1. 前端：`FeedbackButton` 不掛 → ConfigEngine 退回原樣
2. 後端：移除 `/api/feedback` route registration
3. DB：`DROP TABLE authz_feedback`（無外鍵，安全）

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-29 | Adam (planner) | → DRAFT → READY-FOR-IMPLEMENTATION | Advisor pre-draft pass：6 design holes (single-commit cap / append-only / schema CHECK / 4-route surface / AC-9+AC-5 baked / README append-not-reorder) 全 close |
| 2026-04-29 | Adam (executor, same session) | → DONE | V082 applied + 4 routes + smoke 10/10 + tsc×2 clean + FeedbackButton 浮動 UI wire 進 `TablePageWithSavedView`;append-only user 模型 + any-to-any status flow + PG-side CHECK constraints 全落地。**AC-7 frontend round-trip 未在瀏覽器手動驗證** caveat 寫進 commit body;Curator Inbox tab UI 切 FU commit `FEEDBACK-V01-INBOX-FU`(避免 SAVED-VIEW timing 風險重演)。AC-11 doc sync 5 處(plan / README Sub-Plans / README Status Table / roadmap §1+§2.1+§7 / PROGRESS.md)同 commit |

---

## 8. References

- Roadmap: [`tier-a-primitives-roadmap.md`](./tier-a-primitives-roadmap.md) §3.2
- Sister primitive (DONE): [`tier-a-saved-view-plan.md`](./tier-a-saved-view-plan.md) — pattern reuse 主 source
- Sister primitive (DONE): [`help-text-primitive-plan.md`](./help-text-primitive-plan.md)
- Backlog parent: [`two-tier-platform-model.md`](./two-tier-platform-model.md) §82
- Audit log convention: V044 / V061 / V070 / V080
- Frontend integration target: `apps/authz-dashboard/src/components/ConfigEngine.tsx` `TablePageWithSavedView`
- Template: [`_TEMPLATE.md`](./_TEMPLATE.md)
