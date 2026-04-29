# Saved View Primitive (Tier A — A2)

- **Planner Owner:** Adam (this session)
- **Executor Owner:** Adam (same session — single-day primitive)
- **Status:** READY-FOR-IMPLEMENTATION
- **Linked from:** [`tier-a-primitives-roadmap.md`](./tier-a-primitives-roadmap.md) §3.1 (A2 排序)、[`two-tier-platform-model.md`](./two-tier-platform-model.md) §82
- **Target:** Q3 2026 rolling — Tier A platform primitive #2
- **Created:** 2026-04-29
- **Last updated:** 2026-04-29

---

## 1. Problem / Why

ConfigEngine page 目前 filter / sort 全是 component-internal `useState`(`ConfigEngine.tsx:272-274`)；user 切頁、reload、回首頁再回來，所有設定全部 reset。Curator 在 Path A demo 時被反覆問「我每次打開都要重設一輪，能不能記住？」

**對應 Tier A roadmap §3.1：A2 saved_view 是 help_text 之後的下一個 primitive**，理由：
- 純 user-state，沒有跨 user blessing 流程，trigger 條件已滿足（至少 1 個業務 page filter ≥ 3）
- 直接消化 Path A demo 反饋，做完當天可看到效果
- 後續 A3 feedback 的「分類 / 過濾 / 我的 feedback list」可以 reuse 同個 user-state pattern

**為什麼現在做：** help_text DONE 收尾後，下個 primitive 接力；roadmap 已 ROADMAP 鎖定排序。

---

## 2. Scope

**In scope (this sprint):**
- [ ] V080 migration 建 `authz_user_view` table（user × page × name → config_json）
- [ ] `is_default` per (user_id, page_id) 以 partial unique index 鎖唯一性
- [ ] Backend `/api/saved-view` CRUD：list / create / update / delete / set-default（自 user scope）
- [ ] Frontend `useSavedView` hook 串 `ConfigEngine`：dropdown 切換 / save dialog / 刪除 / 設預設
- [ ] URL `?view=<view_id>` 可分享自己 view（authz：他人 view 一律 404）
- [ ] `authz_audit_log` 寫 `tier_a_saved_view_create / update / delete / set_default` 四個 action
- [ ] 端到端 smoke：建立 → reload → URL share → 設預設 → 刪除

**Out of scope (defer):**
- **`is_shared` / 跨 user 分享**：v1 純 self-scope；分享需要 authz 設計（誰能讀誰、是否需要 owner 授權），等真有 cross-user demand 再做（CLAUDE.md：don't design for hypothetical）
- **Descriptor pattern (V036/V039) 與 handler-driven page (V050/V078)**：roadmap §3.1 v1 限 `ConfigEngine columns_override` 路徑；其他 page 模式走自己的 view 機制
- **Column width / pinned column / column order**：v1 只記 filters / sort / hidden_cols；其餘待 ConfigEngine 自己 expose
- **View versioning / 歷史記錄**：直接覆蓋；想要版本化時改 audit_log 撈

---

## 3. Design / Approach

### 3.1 Schema (V080)

```sql
-- database/migrations/V080__authz_user_view.sql
CREATE TABLE authz_user_view (
  view_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text        NOT NULL,
  page_id      text        NOT NULL,
  name         text        NOT NULL,
  config_json  jsonb       NOT NULL,
  is_default   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authz_user_view_unique_name UNIQUE (user_id, page_id, name)
);

-- 一個 user 在一個 page 最多一個 default
CREATE UNIQUE INDEX authz_user_view_default_uniq
  ON authz_user_view (user_id, page_id)
  WHERE is_default = true;

CREATE INDEX authz_user_view_user_page_idx
  ON authz_user_view (user_id, page_id);

COMMENT ON TABLE authz_user_view IS
  'Tier A primitive #2: per-user × per-page saved view (filters / sort / hidden_cols). Self-scope only in v1.';
```

### 3.2 `config_json` shape（鎖定）

```jsonc
{
  "filters": [
    { "field": "status", "op": "eq", "value": "active" },
    { "field": "yield_rate", "op": "gte", "value": "0.9" }
  ],
  "sort": { "col": "lot_id", "dir": "desc" },
  "hidden_cols": ["internal_note", "raw_blob"]
}
```

- v1 `op` 只支援 `eq`（FilterBar 目前只有 select / text equality）；未來 ≥ / ≤ / like 自然擴張
- `hidden_cols` 是 string[]；v1 ConfigEngine 還沒有 hide column UI，schema 先預留，前端 hook 上線後再加 toggle
- `sort.dir` ∈ `'asc' | 'desc'`；對齊現有 `sortDir` state
- 未填欄位皆視為 default（filters 空 = 不過濾；sort 空 = 不排）

### 3.3 `is_default` 切換邏輯（避免 race）

```sql
BEGIN;
UPDATE authz_user_view
   SET is_default = false, updated_at = now()
 WHERE user_id = $1 AND page_id = $2 AND is_default = true;
UPDATE authz_user_view
   SET is_default = true, updated_at = now()
 WHERE view_id = $3 AND user_id = $1;
COMMIT;
```

backend `/api/saved-view/:id/set-default` route 用 single transaction 包；partial unique index 是 last-line guard。

### 3.4 URL `?view=<id>` 解析規則

| 條件 | 行為 |
|------|------|
| 無 `?view` param | 撈 `is_default = true` 的 view；找不到 → 不套用任何 view（空狀態） |
| `?view=<id>` 存在 & 屬於 current user | 套用 |
| `?view=<id>` 存在 & 屬於別人 | 回 404，不洩漏存在性 |
| `?view=<id>` 不存在 | 回 404 |
| `?view=<id>` 存在但 `page_id` 不符 | 回 404（防 cross-page leak） |

front-end 撈失敗（404）時 fall through 到 default flow（撈 `is_default`）；若 default 也沒有，呈現 empty state。

### 3.5 Backend API surface

| Method | Path | Body / Query | Authz |
|--------|------|--------------|-------|
| `GET` | `/api/saved-view?page_id=xxx` | — | 自 user scope；回 list |
| `GET` | `/api/saved-view/:view_id` | — | `WHERE user_id = current_user`；別人的回 404 |
| `POST` | `/api/saved-view` | `{ page_id, name, config_json, is_default? }` | 寫入時 user_id 由 session 鎖定 |
| `PATCH` | `/api/saved-view/:view_id` | `{ name?, config_json? }` | 自 user scope |
| `POST` | `/api/saved-view/:view_id/set-default` | — | transaction demote-then-promote |
| `DELETE` | `/api/saved-view/:view_id` | — | 自 user scope |

每個 mutating route 寫 `authz_audit_log`：action ∈ `tier_a_saved_view_create / update / set_default / delete`。

### 3.6 Frontend 整合（`ConfigEngine.tsx`）

ConfigEngine 目前 state 全 internal（`sortKey / sortDir / filterValues`）。要 expose 一個 `useSavedView` hook：

```tsx
const {
  views,                 // SavedView[]
  activeView,            // SavedView | null
  applyView,             // (view_id) => void  套用設 sortKey/sortDir/filterValues
  saveAsView,            // (name) => Promise<view>  讀當前 state 寫入
  updateActiveView,      // () => Promise<void>  覆蓋 active view
  deleteView,            // (view_id) => Promise<void>
  setDefault,            // (view_id) => Promise<void>
} = useSavedView({ pageId });

// ConfigEngine 內部 state 不動,只多接一個 toolbar:
<SavedViewBar
  views={views}
  active={activeView}
  onApply={applyView}
  onSave={saveAsView}
  onUpdate={updateActiveView}
  onDelete={deleteView}
  onSetDefault={setDefault}
/>
```

### 3.7 Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| 表是否新建 | 新表 `authz_user_view` | 不適合塞 `authz_ui_page` JSONB（per-user × per-page 多筆） |
| 多 user 分享 | v1 self-scope only | hypothetical;cross-user authz 需獨立設計 |
| `is_default` 唯一性 | partial unique index + transaction | DB 端有保護;application 端做 demote |
| `config_json` 結構 | 三 key 鎖定（filters / sort / hidden_cols） | 預留欄位避開未來 schema 變動；v1 hidden_cols 即使 UI 沒接也保留 |
| URL `?view=<id>` 不存在/越權 | 一律 404 | 不洩漏存在性、避免 enumeration |
| Audit | 寫 `authz_audit_log` 4 個 action | 對齊 V044/V061/V070 慣例 |
| Page 類型範圍 | ConfigEngine `columns_override` only | 對齊 roadmap §3.1 v1 |

### 3.8 Open questions

- 暫無

---

## 4. Acceptance Criteria

- [ ] **AC-1:** V080 migration 套上後，`authz_user_view` 存在；`pg_indexes` 看到 `authz_user_view_default_uniq` partial index
- [ ] **AC-2:** `POST /api/saved-view` 兩次同 (user_id, page_id, name) 第二次回 `409 unique_violation`；不同 user 同名互不干擾
- [ ] **AC-3:** `POST /api/saved-view/:id/set-default` 後，同 (user_id, page_id) 任何其他 view 的 `is_default` 必為 false（partial unique index 保證）
- [ ] **AC-4:** `GET /api/saved-view/:id` 對「不存在 / 別人的 view / page_id 不符」皆回 404，不洩漏 row
- [ ] **AC-5:** Frontend：建立 view → reload → 自動套 default → URL share `?view=<id>` → 切到別人帳號開同 URL 回 404
- [ ] **AC-6:** Smoke: `services/authz-api/scripts/test-saved-view.ts` ≥ 6 cases（create / list / set-default demote / 404 / unique / delete）pass
- [ ] **AC-7:** `npx tsc -p services/authz-api` + `npx tsc -p apps/authz-dashboard` 雙 clean
- [ ] **AC-8:** `authz_audit_log` 抓得到 `tier_a_saved_view_create / update / set_default / delete` 四個 action 各一筆
- [ ] **AC-9:** PROGRESS.md / `.claude/plans/v3-phase-1/README.md` / roadmap §3.1 status 同步

---

## 5. Implementation Plan

### Tasks

- [ ] V080 migration + apply
- [ ] Backend route file `services/authz-api/src/routes/saved-view.ts`（CRUD + set-default）
- [ ] Backend audit_log helper：直接 reuse 現有 `auditLog` util
- [ ] register route in `services/authz-api/src/server.ts`
- [ ] Smoke script `services/authz-api/scripts/test-saved-view.ts`
- [ ] Frontend hook `apps/authz-dashboard/src/hooks/useSavedView.ts`
- [ ] Frontend toolbar `apps/authz-dashboard/src/components/SavedViewBar.tsx`
- [ ] Wire toolbar 進 `ConfigEngine.tsx`（接 `sortKey/sortDir/filterValues` 雙向）
- [ ] URL `?view=<id>` 解析（讀 `useSearchParams` 或 `window.location.search`）
- [ ] tsc × 2 clean

### Files touched

- `database/migrations/V080__authz_user_view.sql` — new
- `services/authz-api/src/routes/saved-view.ts` — new
- `services/authz-api/src/server.ts` — register route
- `services/authz-api/scripts/test-saved-view.ts` — new
- `apps/authz-dashboard/src/hooks/useSavedView.ts` — new
- `apps/authz-dashboard/src/components/SavedViewBar.tsx` — new
- `apps/authz-dashboard/src/components/ConfigEngine.tsx` — wire toolbar + URL param + state ↔ view bridge

### Migration / DB notes

- V080 是下個 free 號（V079 = `authz_resource_cascade_policy`，已驗證）
- Rollback：`DROP TABLE authz_user_view CASCADE`；無外鍵指過來，安全
- 不 backfill；新表，無歷史資料

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| V080 編號跟另一 worktree 撞 | 低 | 開工前已 `ls database/migrations/`；V079 是最後 |
| `is_default` race（兩個 set-default 同時跑） | 低 | partial unique index + transaction 雙保險；最後一個 commit 贏，前一個 transaction 撞 unique violation 自動 rollback |
| URL `?view=<id>` 洩漏其他 user 存在 | 低 | 一律 404，不分「不存在」與「越權」 |
| `config_json` schema drift（前後端不一） | 中 | TypeScript type `SavedViewConfig` 共用；server 端 zod 驗 |
| 用戶手寫 1000 個 view 撐爆 | 低 | 不做 hard limit，audit_log 出現異常再 rate-limit |

**Rollback**：
1. 前端：`SavedViewBar` 不掛 → ConfigEngine 退回原 internal state
2. 後端：移除 `/api/saved-view` route registration
3. DB：`DROP TABLE authz_user_view`（無外鍵，安全）

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-29 | Adam (planner) | → DRAFT → READY-FOR-IMPLEMENTATION | Advisor pre-draft pass：5 design holes (config_json shape / is_default partial unique / drop is_shared / URL 404 spec / V080 verification) 皆 close |

---

## 8. References

- Roadmap: [`tier-a-primitives-roadmap.md`](./tier-a-primitives-roadmap.md) §3.1
- Sister primitive (DONE): [`help-text-primitive-plan.md`](./help-text-primitive-plan.md)
- Backlog parent: [`two-tier-platform-model.md`](./two-tier-platform-model.md) §82
- Frontend integration target: `apps/authz-dashboard/src/components/ConfigEngine.tsx:272-274` (current state pattern)
- Audit log convention: V044 `authz_business_term`、V061 `discovery_rule_effect`、V070 `authz_resource_cascade_policy`
- Template: [`_TEMPLATE.md`](./_TEMPLATE.md)
