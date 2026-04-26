# Two-Tier Platform Model

- **Owner:** Adam Ou
- **Status:** draft
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.1
- **Configures:** [`docs/standards/metadata-driven-ui.md`](../../../docs/standards/metadata-driven-ui.md)
- **Target:** Foundation decision — gates every UI 提案 Q3 2026 起

---

## Purpose

把 Nexus 切成兩層,每個 UI 提案必須先歸位:

- **Tier A — Platform**:Nexus core team own 的東西(renderer / widget registry / AuthZ / metadata schema / 共享 primitive)
- **Tier B — Applications**:業務 workflow(Combo Workbench / Customer Detail / Production Lookup / ...)由 Curator **用 Tier A 的 primitive 配出來**,不寫進 Nexus core code

不分這兩層的話,「再加一個 X workbench」的提案會慢慢把 Nexus 變成另一個 Aras。

---

## Tier 定義

### Tier A — Platform

**Own 什麼:**
- Widget catalog(`HANDLER_REGISTRY` / `ICON_MAP` / layout dispatch,在 `apps/authz-dashboard/src/components/ConfigEngine.tsx`)
- Renderer endpoint(`services/authz-api/src/routes/config-exec.ts` + `fn_ui_page()` / `fn_ui_root()`)
- AuthZ enforcement(`authz_check` / `authz_filter` / `authz_resolve` / 三路徑同步)
- Metadata schema(`authz_resource` / `authz_role_permission` / `authz_ui_page` / `authz_data_source` / `authz_ai_provider`)
- Audit + Constitution §9 enforcement
- 4 個 platform primitive(見 §"Platform Primitives")

**Tier A 的現有 tabs:**
| Tab | 為什麼是 A |
|---|---|
| Permissions Studio | Curator / AuthZ admin 操作 Nexus 本身 |
| Modules | Curator 瀏覽 metadata |
| Discover | Curator 巡上游資料源 |
| Pool | Curator 管直接 DB access |
| Audit | Auditor 讀平台 audit log |
| AI Providers | Curator 配 LLM 憑證 (V052) |
| Tables (raw) | Curator 看底層 schema |
| Config Tools | Curator 雜事 admin |

**使用者:**
- Curator(metadata + state machine 作者)
- AuthZ admin(role / policy / preset)
- Auditor(read-only audit + forensic timeline)
- AI Agent(Constitution §9:`actor_type='ai'` + 同意流綁定)

### Tier B — Applications

**是什麼:**業務 workflow,由 `authz_ui_page` 一筆(或一組)資料定義,有 `data_table` / `columns` / `layout` / `handler_name`...。**Curator 寫,不是 platform team 寫。**

**現有 tabs 的 tier 歸屬:**
| Tab | 歸位 | 動作 |
|---|---|---|
| Overview | 邊界(平台入口) | 留在 core |
| modules_home(`modules_home_handler`) | Tier B(已透過 handler 配出) | ✅ 模範 |
| audit_home(`audit_home_handler`) | Tier B(同上) | ✅ 模範 |
| Data Query | 將來 Tier B | 暫留 core,Q1 2027 評估 |
| Metabase | Tier B integration | 留 core 當外接點 |
| DAG / Flow Composer | 邊界 — Tier B 的 authoring tool 跑在 Tier A primitive 上 | Q4 2026 audit |
| auto-page (BU-08) | **Curator 從表自動生 Tier B page 的參考實作** | 留,這是 Tier B authoring loop |

**使用者:**
- Producer(RD / PM 填表單、提 ECO)
- Consumer(FAE / Exec / Production 看 dashboard / 查 genealogy)
- Operator(產線跑 blessed view 的 query)

**邊界判準:**有 domain 業務邏輯(Combo / ECO / Customer / Lot / Wafer)就是 Tier B。任何業務 app 都會用到的(search / notification / saved view / feedback)就是 Tier A。

---

## Platform Primitives(Tier A backlog)

Tier B app 都會用到的共享服務。Tier A 蓋一次,比每個 Tier B 各蓋一次便宜得多。

| Primitive | 是什麼 | Schema sketch | Owner | 目標 |
|---|---|---|---|---|
| **help_text** | 任何 widget 旁邊的 `?` 圖示,文案來自 metadata | 擴 `authz_ui_page.config` widget schema:加 `help_text` 欄 | Adam | Q3 2026(最便宜先做) |
| **saved_view** | 每使用者在任一 page 上存 filter / sort / columns | `authz_user_view (user_id, page_id, name, config_json, is_default)` | Adam | Q4 2026 |
| **feedback** | inline「這欄位錯了 / 我想要 X」→ Curator inbox | `authz_feedback (user_id, page_id, kind, body, status, created_at)` | Adam | Q4 2026 |
| **subscription** | event bus + per-user 訂閱(page change / AuthZ change / domain event) | `authz_event`(append-only)+ `authz_subscription (user_id, event_pattern, channel)` | Adam | Q1 2027 |

每個 Tier B app 免費拿到這四個。沒 primitive = 每個 app 自己亂寫一次。

---

## Execution Roadmap

### Phase 0 — 本週(2026-04-26 → 2026-05-03)
- [x] 寫本 sub-plan
- [x] 寫 [`docs/standards/metadata-driven-ui.md`](../../../docs/standards/metadata-driven-ui.md)
- [x] Master plan §2.1 補一條
- [x] README index 更新

### Phase 1 — Q3 2026(對齊 G1)
- [ ] 既有 tab 在 code 裡都標上 Tier A / B 註解(`App.tsx` 區塊註解)
- [ ] 蓋 `help_text` primitive(最便宜、立即見效)
- [ ] PR template:任何 UI 變更必須宣告 `Tier A` 或 `Tier B`
- [ ] Tier A 禁止 domain-specific 分支(`if (entity === 'eco')` 之類);加 review checklist

### Phase 2 — Q4 2026
- [ ] `saved_view` primitive + 整合進 `DataTable` widget
- [ ] `feedback` primitive + 新 tab「Curator Inbox」
- [ ] **第一個完全由 Curator 配出的 Tier B app**(候選:用 BU-08 auto-page 為某張業務表配出列表 + 詳情頁,零 React 改動)

### Phase 3 — Q1 2027
- [ ] `subscription` primitive + event bus
- [ ] AI Sidebar(獨立 sub-plan)只用 Tier A primitive,不開後門

### Ongoing
- [ ] 每個新 UI 提案 merge 前 tier-labeled
- [ ] 每季 review:有沒有 Tier B 滲入 core?

---

## Acceptance Criteria

- 所有現存與新增 tab 都有 Tier A / B 標記
- 4 個 platform primitive 在 Q1 2027 前全部 ship
- Tier A code path 內零 domain-specific entity 邏輯
- ≥ 1 個 Tier B app 完全由 Curator 配出(0 行 React 改動)by Q4 2026
- AI Sidebar 只用 Tier A primitive,沒有 special wiring

---

## Anti-Patterns(必擋)

| 反模式 | 為什麼擋 | 正解 |
|---|---|---|
| `ConfigEngine.tsx` 內 `if (resource_type === 'eco')` | 把業務 entity 寫進平台 | 把行為抽成 widget;Curator 在 metadata 裡選 |
| `App.tsx` 加「Combo Workbench」tab | Tier B 漏進 core | INSERT `authz_ui_page` 用 `combo_workbench` layout |
| 每個 app 各自實作通知 | 重新發明輪子 + 碎裂 | 用 `subscription` primitive |
| 每個 app 各自存 user filter | 同上 | 用 `saved_view` primitive |
| Curator 想加 icon 要動 .tsx | 平台脆化 | 把 `ICON_MAP` 動態化(Phase 1) |

---

## STUB — 待補

- Lint / review-gate 規則(怎麼自動擋 Tier B 漏進 Tier A)
- `saved_view` schema 與 REST endpoint 詳細
- `subscription` event taxonomy(哪些事件 platform 預設發?)
- `feedback` inbox UX
- 既有 tab 中混到的(例如 dashboard repo 內有沒有純 Path B 業務頁?)— 需 audit
- BU-08 auto-page 與 Curator-configured Tier B app 的關係細節
