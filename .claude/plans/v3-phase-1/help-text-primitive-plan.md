# Help Text Primitive (Tier A)

- **Planner Owner:** Adam (this session)
- **Executor Owner:** Adam (same session — single-day primitive)
- **Status:** DONE
- **Linked from:** [`two-tier-platform-model.md`](./two-tier-platform-model.md) §82 (4 Tier A primitives backlog)
- **Target:** Q3 2026 rolling — Tier A platform primitive
- **Created:** 2026-04-29
- **Last updated:** 2026-04-29

---

## 1. Problem / Why

Curator 在 Path A / Tier 2 admin form / 未來 DAG inspector 加說明文字時，每個地方都要自建 tooltip 邏輯。`two-tier-platform-model.md` §82 把 help_text 列為 Tier A 平台 primitive 的第一個——任何 widget 旁的 `?` 圖示文案都來自 metadata，不寫在 component 裡。

**為什麼現在做：**
- 1-2 天最小投入；composer-operator-and-sink Now-sprint 完工後正好挖一個快收尾的小坑
- Path A demo 用語常被 reviewer 問「這欄到底什麼意思」、「這個 status 篩什麼」；help_text 一上線立刻消化掉這類提問
- Tier A primitive 落地後，後續 saved_view / feedback / subscription 三個 primitive 也照同個 JSONB-only 模式走

對應 master plan §two-tier-platform-model 的 Tier A backlog。

---

## 2. Scope

**In scope (this sprint):**
- [x] `authz_ui_page.columns_override.<col>.help_text?: string`（既有 JSONB，零 schema 變更）
- [x] `authz_ui_page.filters_config[].help_text?: string`（同上）
- [x] Backend type 擴張：`ColumnDef.help_text?` (`masked-query.ts`)、filter passthrough (`config-exec.ts`)
- [x] Frontend `HelpIcon` component (`?` lucide icon + native `title` tooltip)
- [x] Wire 進 `ConfigEngine.tsx` `DataTable` column header + `FilterBar` label
- [x] `_demo/ui-config-seed.sql` 加 5-6 個 help_text 範例（lot_id / grade / status filter / yield_rate 等）

**Out of scope (defer):**
- 頁面級 `description` 用 `?` 圖示渲染：page-level `description` 已存在但目前是 subtitle-ish 用法，先不動，等真有頁面要加長文再決定要不要 V0XX
- Tier 2 admin form wizard 的 help_text：等 Tier 2 自己 sprint
- DAG inspector tooltip：composer DAG inspector 還沒上 UI，等 inspector ready 再串
- Markdown / 多行 / link 在 tooltip：先用 native `title` plain string，PoC 先過再升級

---

## 3. Design / Approach

**JSONB-only convention — 零 migration：**

```jsonc
// authz_ui_page.columns_override
{
  "yield_rate": {
    "render": "yield_bar",
    "align": "right",
    "help_text": "良率 = pass_count / (pass_count + fail_count); <90% 進 RMA review"
  }
}

// authz_ui_page.filters_config
[
  { "field": "status", "type": "select", "help_text": "篩選批號狀態; 選 All 顯示全部" }
]
```

Backend 已 spread `...override` 到 `ColumnDef`，加 `help_text?` 自動穿越；filter 端在 `resolveFilterOptions` 顯式 forward。

Frontend `HelpIcon`:

```tsx
function HelpIcon({ text }: { text?: string }) {
  if (!text) return null;
  return <span title={text} aria-label={text}><HelpCircle className="w-3.5 h-3.5"/></span>;
}
```

放在 column label 後、filter label 後。

### Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Schema | JSONB-only (現有欄位) | 零 migration、零部署風險、可立刻 demo |
| Tooltip 機制 | Native `title` | 零依賴、a11y 內建；夠用就好 |
| Page-level help_text | 暫不做 | `description` 已存在當 subtitle 用，避免雙來源混亂 |
| DAG inspector 整合 | Defer | inspector 還沒 UI，無處 wire |

### Open questions

- 暫無

---

## 4. Acceptance Criteria

- [x] **AC-1:** `ColumnDef.help_text?: string` 出現在 `services/authz-api/src/lib/masked-query.ts` 與 `apps/authz-dashboard/src/components/ConfigEngine.tsx`
- [x] **AC-2:** `FilterDef.help_text?: string` 同步存在；`config-exec.ts:resolveFilterOptions` 正確透傳
- [x] **AC-3:** `HelpIcon` 元件存在；當 `text` 為空時 render `null`、不留空 span
- [x] **AC-4:** `DataTable` `<th>` 在 `col.help_text` 存在時顯示 `?` icon；hover 出現 tooltip
- [x] **AC-5:** `FilterBar` label 在 `f.help_text` 存在時顯示 `?` icon
- [x] **AC-6:** `_demo/ui-config-seed.sql` 至少 4 條 help_text（≥3 column + ≥1 filter）
- [x] **AC-7:** `npx tsc -p services/authz-api` 與 `npx tsc -p apps/authz-dashboard` 雙 clean
- [x] **AC-8:** PROGRESS.md / README.md 同步

---

## 5. Implementation Plan

### Tasks

- [x] Add `help_text?` to backend ColumnDef + frontend ColumnDef + FilterDef
- [x] Forward `help_text` through `resolveFilterOptions`
- [x] Create `HelpIcon` inline component in ConfigEngine.tsx
- [x] Wire `<HelpIcon>` into DataTable header + FilterBar
- [x] Patch `_demo/ui-config-seed.sql` with help_text demo entries
- [x] tsc clean × 2

### Files touched

- `services/authz-api/src/lib/masked-query.ts` — extend `ColumnDef`
- `services/authz-api/src/routes/config-exec.ts` — extend `resolveFilterOptions` shape
- `apps/authz-dashboard/src/components/ConfigEngine.tsx` — types + `HelpIcon` + DataTable + FilterBar
- `database/seed/_demo/ui-config-seed.sql` — demo help_text rows

### Migration / DB notes

無；純 JSONB 欄位擴張，鎖在 application layer。

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Tooltip 在小螢幕被截斷 | 低 | native `title` 由瀏覽器處理；PoC 階段可接受 |
| help_text 太長破版 | 中 | conventions 由 curator 自律；後續若需要再做 popover |
| 多語系（中/英）混雜 | 中 | 暫存中文，與 docs/constitution 用語一致；i18n 等 demo 後再批次處理 |

**Rollback:** 移除 `HelpIcon` import + 兩處 wire 點，type 上的 `help_text?` 留著（optional 不影響舊資料）。Seed 用 SQL `UPDATE ... SET columns_override = columns_override - 'help_text'` 可清。

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-29 | Adam | → DRAFT → READY → IN-PROGRESS → DONE | 單 session 完工：JSONB-only + HelpIcon + 4 demo seed + tsc×2 |

---

## 8. References

- Backlog: [`two-tier-platform-model.md`](./two-tier-platform-model.md) §82 Tier A primitives
- Sister sprint: [`composer-operator-and-sink.md`](./composer-operator-and-sink.md) (Now sprint DONE 2026-04-29)
- Backend: `services/authz-api/src/lib/masked-query.ts`、`services/authz-api/src/routes/config-exec.ts`
- Frontend: `apps/authz-dashboard/src/components/ConfigEngine.tsx`
- Seed: `database/seed/_demo/ui-config-seed.sql`
