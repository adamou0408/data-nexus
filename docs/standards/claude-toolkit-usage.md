# Claude Code 工具盤點與精簡使用指南（原生版）

> **目的**：Data Nexus 專案在 2026-04-28 砍掉 gstack 框架，回到原生 Claude Code。
> 本文件給「Adam 自己 + 接手的 Claude session」一份精簡配方。
>
> **更新時機**：原生 Claude Code 升級加 / 移 skill；工作流調整；memory 異動。
>
> **歷史**：本文件 v1（2026-04-26）依賴 gstack 的 `/freeze` / `/checkpoint` / `/investigate` / `/retro` 等 skill；
> v2（2026-04-28）gstack 移除後重寫，工作流改用 conversation instruction + plan template + advisor() 替代。

---

## 1. Memory（持久記憶，跨 session）

存於 `C:\Users\adam_ou\.claude\projects\D--Adam-project-data-nexus\memory\`

| 檔案 | 內容 | 狀態 |
|------|------|------|
| `user_role.md` | Adam = Phison tech lead，協調 Data Nexus + AI | 長期 |
| `project_ai_agent_roadmap.md` | Smart Analyst 2.0 必須等 Data Nexus go-live | 長期 |
| `project_v3_universal_platform.md` | v3 Phase 1 universal platform 方向 | 半年 review |
| `feedback_datasource_constitution.md` | 改 `authz_data_source` 必須先取得 consent | **長期、重要** |
| `project_tier2_user_needs.md` | Tier 2 受眾需求已確定，不要再推使用者研究 | 長期 |
| `project_pure_software_dev.md` | Phase 1 是純軟體開發（無 hiring / 訪談）| 長期 |
| `feedback_ui_verification.md` | UI 視覺驗證不要卡 Adam | 長期 |
| `feedback_language.md` | 用繁體中文回 | 長期 |
| `feedback_default_driven_workflow.md` | 小決策直接 default + PR 列清單 | 長期 |
| `feedback_tech_lead_governance.md` | Tech lead 可 self-sign internal dev governance | 長期 |
| `feedback_no_phase_anchor.md` | 純加性工作不要套 Phase 1.5 / Q3-Q4 框架 | 長期 |

不需動。

---

## 2. Skills（原生 Claude Code 內建）

砍 gstack 後，可用 skill = 原生那一組。常用對應 Data Nexus 工作流如下。

### 🟢 Phase 1 會用到

| Skill | 用途 | 觸發時機 |
|-------|------|---------|
| `/simplify` | 改完 code 自審（重複 / 死碼 / 過度抽象） | Executor 階段結束時 |
| `/review` | PR / 待 commit 變更 review | Ship 前 |
| `/security-review` | 安全 review | 動 authz / SQL / RLS 後 |
| `/init` | 新建 CLAUDE.md（一次性） | 新 repo 才會用 |

### 🟡 偶爾用 / 視情況

| Skill | 何時用 |
|-------|--------|
| `/update-config` | 動 settings.json / hooks / permissions 時 |
| `/fewer-permission-prompts` | 過多權限 prompt 干擾時，掃 transcript 補 allowlist |
| `/keybindings-help` | 改鍵盤快捷鍵 |
| `/claude-api` | 改 Anthropic SDK / API 程式碼（本專案 `services/authz-api/src/lib/ai-call.ts` 直接用 fetch，不走 SDK，目前不需）|
| `/loop` `/schedule` | 排程或 polling — 本專案不需 |

### ❌ 已失去（gstack 砍掉後不再可用）

`/freeze` `/unfreeze` `/checkpoint` `/investigate` `/retro` — 替代方案見 §4。

---

## 3. Agents（角色化諮詢）

存於 `.claude/agents/`，用 `Agent(subagent_type=...)` 呼叫。**不受 gstack 影響，全留。**

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
| `domain-pm` `domain-fae` `domain-qa-dept` | 中 |
| `domain-sales` `domain-ops` `domain-scm` | 低（Phase 1 暫不涉及，可 archive）|

### 其他

- `qa-engineer` — 寫測試 / e2e 設計時叫
- `dba-guardian-hiring` — **暫擱置**（Phase 1 純軟體開發無 hiring，建議移 `_ARCHIVED/`）

### 內建子代理人（原生）

```
Agent(subagent_type='general-purpose' | 'Explore' | 'Plan' | 'statusline-setup')
```

`Explore`：跨檔案 codebase 探索；`Plan`：軟體架構規劃；其他特殊用途偶爾用。

---

## 4. 雙 Session 工作流配方（gstack 砍掉後改版）

### 模式：規劃 + 執行（角色可輪流切換）

```
Planner session (寫 markdown)        Executor session (寫 code)
─────────────────────────             ──────────────────────────
告訴 Claude:                          讀對應 plan §1-4
"這 session 我只動 docs/ 跟           確認 Status = READY-FOR-IMPLEMENTATION
.claude/plans/，其他不要碰"           ↓
（取代 /freeze）                      改 Status → IN-PROGRESS
↓                                     ↓
寫 plan §1-4 + §6 + §8                開工（呼叫 backend-engineer /
（可呼叫 product-owner /              dba-guardian / dashboard-engineer）
authz-architect 諮詢）                ↓
↓                                     /simplify 自審
Status: DRAFT → READY-FOR-            ↓
IMPLEMENTATION                        advisor() 獨立 review
↓                                     ↓
（等 Executor 通知）                  /security-review（如涉及 authz）
↓                                     ↓
Review Executor 交付                  /review（commit 前最後一次）
（Status: READY-FOR-REVIEW）          ↓
↓                                     Status → READY-FOR-REVIEW
Status → DONE，更新 PROGRESS.md       commit + push
```

### Conversation-level 規約（取代砍掉的 gstack skill）

| gstack skill | 替代做法 |
|--------------|---------|
| `/freeze docs/` | 對話開頭打：「這 session 我只動 `docs/` 跟 `.claude/plans/`，其他資料夾不要動」 |
| `/unfreeze` | 「解除前述限制，現在可以動 `apps/` `services/`」 |
| `/checkpoint` | 把進度塞進 `docs/PROGRESS.md` 當週區塊 + git commit；換 session 直接讀 PROGRESS |
| `/investigate` 4-phase | 自己跑：(1) repro / 看 log → (2) grep + read 找根因 → (3) 寫一段 hypothesis → 動工前先 advisor() 驗 |
| `/retro` | 半年 / 月底翻 `docs/PROGRESS.md` 累積 entry，看模式 |

### 角色切換 prompt（每次切換貼一次）

```
Role Switch — 跑 /clear，然後告訴我新角色：
- 上次是 EXECUTOR → 你現在是 PLANNER，從 .claude/plans/v3-phase-1/README.md
  找 STUB 或 DRAFT 狀態的 plan 來規劃；只動 docs/ + .claude/plans/
- 上次是 PLANNER → 你現在是 EXECUTOR，讀「Status: READY-FOR-IMPLEMENTATION」
  的 plan 開始實作；可動 services/ + apps/ + database/
```

### 衝突避免（單目錄並行）

- Planner 用 instruction 自鎖 `docs/` + `.claude/plans/`
- Executor 動 `services/` + `apps/` + `database/` + `tests/`
- Migration 編號開工前 `ls database/migrations/` 對齊
- Dev server / DB 由 Executor 獨佔
- 每個邏輯單位 commit + push，另一 session `git pull` 同步

---

## 5. 五個核心習慣（記這個就夠）

1. **口頭 freeze** — Planner 開頭打「只動 docs/ + .claude/plans/」instruction
2. **規劃 → 執行** — 透過 plan markdown 交接（`_TEMPLATE.md`）
3. **`/simplify`** — Executor 階段結束自審
4. **`advisor()`** — 設計 / 完成前獨立 review（自帶完整 context；最重要的工具）
5. **`/security-review`** — 動 authz 後守門

其他 skill 都是配料，需要時翻 §2 查。

---

## 6. 維護備註

- 原生 Claude Code 升級加 / 移 skill 時，§2 表格同步更新
- 半年 review §3 agents 一次 — domain-sales / domain-ops / domain-scm 若全期未召喚可 archive
- Memory 檔案有變動時，§1 表格同步更新
- 不再裝 gstack；如未來有特殊需要（如 conductor workspace handoff）再評估

---

## 7. gstack 移除歷史記錄（2026-04-28）

- **動機**：561MB 磁碟 + 80MB node_modules 供應鏈面 + GStack voice / Boil-the-Lake / YC framing 跟 Phison tech lead 工作偏離 + Adam 已重度用 advisor() 替代多數 plan-review skill
- **移除指令**：`rm -rf ~/.claude/skills/* ~/.gstack/`
- **重灌**：若未來想復原 → `cd ~/.claude/skills && git clone <gstack-repo> && bun run setup`
- **保留歷史 artifact**：autoplan-restore-bottom-up-ux-refactor-20260422.md 已備份至 `.claude/plans/_ARCHIVED/`
