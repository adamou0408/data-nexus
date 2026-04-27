# Claude Code 工具盤點與精簡使用指南

> **目的**：在 Data Nexus 專案中，Claude Code 提供大量 memory / skills / agents，但實際常用的不多。本文件給出「精簡配方」，避免每次都從一堆工具裡挑。
>
> **誰看**：Adam 自己 + 接手的 Claude session（規劃方 / 執行方都讀）
>
> **更新時機**：當工作流調整、新增常用 skill/agent，或某項工具被驗證為長期不用時

---

## 1. Memory（持久記憶，跨 session）

存於 `C:\Users\adam_ou\.claude\projects\D--Adam-project-data-nexus\memory\`

| 檔案 | 內容 | 狀態 |
|------|------|------|
| `user_role.md` | Adam = Phison tech lead，協調 Data Nexus + AI | 長期 |
| `project_ai_agent_roadmap.md` | Smart Analyst 2.0 必須等 Data Nexus go-live | 長期 |
| `project_v3_universal_platform.md` | v3 Phase 1 universal platform 方向 | 半年 review 一次 |
| `feedback_datasource_constitution.md` | 改 `authz_data_source` 必須先取得 consent | **長期、重要** |
| `project_tier2_user_needs.md` | Tier 2 受眾需求已確定，不要再推使用者研究 | 長期 |
| `project_pure_software_dev.md` | Phase 1 是純軟體開發（無 hiring / 訪談）| 長期 |
| `feedback_ui_verification.md` | UI 視覺驗證不要卡 Adam | 長期 |
| `feedback_language.md` | 用繁體中文回 | 長期 |

**精簡狀態**：8 條都有用，不需動。

---

## 2. Skills（指令式工具）

### 🟢 核心（每天 / 每階段都會用，記住這 5 個就夠）

| Skill | 用途 | 觸發時機 |
|-------|------|---------|
| `/freeze` | 鎖編輯範圍在某目錄 | Planner session 開頭：`/freeze docs/ .claude/` |
| `/unfreeze` | 解除鎖定 | 角色切換時 |
| `/simplify` | 改完 code 自審（重複 / 死碼 / 過度抽象） | Executor 階段結束時 |
| `/review` | PR 落地前 review | Ship 前 |
| `/security-review` | 安全 review | 動 authz / SQL / RLS 後 |

### 🟡 情境（需要時叫，不需要記順序）

| Skill | 何時用 |
|-------|--------|
| `/investigate` | 系統性 debug，4 phase（investigate → analyze → hypothesize → implement）|
| `/health` | 看專案健康度（type / lint / test 整體狀態） |
| `/checkpoint` | 工作中斷前存 git state + 進度 |
| `/careful` / `/guard` | 跑危險指令（rm -rf / DROP TABLE / 強推）前的安全網 |
| `/document-release` | Release 後更新 README / CHANGELOG |
| `/retro` | 週回顧（commit 模式 + 工作分析）|

### 🔴 跟 Data Nexus 工作流關聯弱（可忽略）

- **Browser/QA 系列**（`browse` / `qa` / `gstack` / `connect-chrome` / `canary` / `benchmark`）— 內網工具 + 人工 QA，不需自動化瀏覽器
- **Design 系列**（`design-consultation` / `design-html` / `design-review` / `design-shotgun`）— 內部工具不重視 design polish
- **Plan review 系列**（`plan-ceo-review` / `plan-eng-review` / `plan-devex-review`）— 已用 plan template + `advisor()` 取代
- **Deploy 系列**（`land-and-deploy` / `ship` / `setup-deploy`）— Phison 內部部署不走公網工具
- **Cron 系列**（`loop` / `schedule`）— 不需 recurring task
- **雜項**（`autoplan` / `codex` / `claude-api` / `office-hours` / `learn` / `keybindings-help`）— 偶爾用或不用

---

## 3. Agents（角色化諮詢）

存於 `.claude/agents/`，用 `Agent(subagent_type=...)` 呼叫。

### 主力（5 個）— Phase 1 經常召喚

| Agent | 何時召喚 |
|-------|---------|
| `authz-architect` | 設計 L0-L3 政策 / 改 `authz_resolve` / 三路徑影響分析 |
| `dba-guardian` | 動 migration / RLS / hypertable / 改 schema |
| `backend-engineer` | Express API / TypeScript service 實作 |
| `dashboard-engineer` | React + Vite + Tailwind UI 實作 |
| `product-owner` | 需求拆解 / Phase 1 scope 決策 / AC 鎖定 |

### 領域諮詢（9 個）— 需要時才叫

| Agent | 使用頻率（Phase 1）|
|-------|------------------|
| `domain-finance-bi` | **高**（Tier 2 wizard 主要用戶）|
| `domain-pe` | **高**（半導體 Process Engineer）|
| `domain-rd` | **高**（R&D 常用資料分析）|
| `domain-pm` | 中 |
| `domain-fae` | 中 |
| `domain-qa-dept` | 中 |
| `domain-sales` | 低（Phase 1 暫不涉及）|
| `domain-ops` | 低 |
| `domain-scm` | 低 |

### 其他

- `qa-engineer` — 寫測試 / e2e 設計時叫
- `dba-guardian-hiring` — **暫擱置**（Phase 1 純軟體開發無 hiring）

---

## 4. 雙 Session 工作流配方

### 模式：規劃 + 執行（角色可輪流切換）

```
Planner session (寫 markdown)        Executor session (寫 code)
─────────────────────────             ──────────────────────────
/freeze docs/ .claude/                讀對應 plan §1-4
↓                                     確認 Status = READY-FOR-IMPLEMENTATION
寫 plan §1-4 + §6 + §8                ↓
（可呼叫 product-owner /              改 Status → IN-PROGRESS
authz-architect 諮詢）                ↓
↓                                     開工（呼叫 backend-engineer /
Status: DRAFT → READY-FOR-            dba-guardian / dashboard-engineer）
IMPLEMENTATION                        ↓
↓                                     /simplify 自審
（等 Executor 通知）                  ↓
↓                                     advisor() 獨立 review
Review Executor 交付                  ↓
（Status: READY-FOR-REVIEW）          /security-review（如涉及 authz）
↓                                     ↓
Status → DONE，更新 PROGRESS.md       Status → READY-FOR-REVIEW
```

### 角色切換 prompt（每次切換貼一次）

```
Role Switch — 跑 /clear，然後告訴我新角色：
- 上次是 EXECUTOR → 你現在是 PLANNER，從 .claude/plans/v3-phase-1/README.md
  找 STUB 或 DRAFT 狀態的 plan 來規劃
- 上次是 PLANNER → 你現在是 EXECUTOR，讀「Status: READY-FOR-IMPLEMENTATION」
  的 plan 開始實作
```

### 衝突避免（單目錄並行）

- Planner 只動 `docs/` + `.claude/plans/`（用 `/freeze` 強制）
- Executor 只動 `services/` + `apps/` + `database/` + `tests/`
- Migration 編號開工前 `ls database/migrations/` 對齊
- Dev server / DB 由 Executor 獨佔
- 每個邏輯單位 commit + push，另一 session `git pull` 同步

---

## 5. 五個核心習慣（記這個就夠）

1. **`/freeze`** — Planner 開頭鎖編輯範圍
2. **規劃 → 執行** — 透過 plan markdown 交接（`_TEMPLATE.md`）
3. **`/simplify`** — Executor 階段結束自審
4. **`advisor()`** — 設計 / 完成前獨立 review（自帶完整 context）
5. **`/security-review`** — 動 authz 後守門

其他工具都是配料，需要時翻本文件查。

---

## 6. 維護備註

- 新增常用 skill/agent → 補進 §2 或 §3 對應分類
- 半年 review 一次「🔴 不用」分類，看有沒有後來變常用的
- Memory 檔案有變動時，§1 表格同步更新
