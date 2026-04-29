# Tier A Primitives Roadmap

- **Owner:** Adam (planner) — sub-plans 各自獨立 owner
- **Status:** ROADMAP (meta-doc, not an executable sprint)
- **Linked from:** [`two-tier-platform-model.md`](./two-tier-platform-model.md) §82
- **Created:** 2026-04-29
- **Last updated:** 2026-04-29

---

## 0. 為什麼有這份 doc

`two-tier-platform-model.md` §82 列了 4 個 Tier A platform primitive(help_text / saved_view / feedback / subscription)。PROGRESS.md 的「下一個 sprint 候選」又有 3 個 Tier A 性質的(C/D/E)。沒有一份文件把這 6+1 個一起排序、評估、列出 trigger。本 doc 就是這份。

每個 Tier B app(Tier 2 admin form / AI Sidebar / Tier 1 dashboard / 未來業務 page)上線時都會用到 Tier A 共享服務。Tier A 蓋一次,Tier B 免費拿;沒蓋,每個 Tier B 自己亂寫一次,合併時出 N 種不一致。

> 排序的判準:**「user pain reduced per week of build」**——每週投入能降的 user 摩擦。end-user 痛(saved_view、feedback)與 Curator 痛(default-perm、column mask)各自評。

---

## 1. Inventory(本次盤點)

| ID | 項目 | 來源 | 服務對象 | 現況 | 我手上的證據 |
|----|------|------|---------|------|------------|
| **A1** | help_text | §82 #1 | Curator → end-user | ✅ DONE (HELP-TEXT-V01, 2026-04-29) | primitive 完整,seed→live wire 等首個 ConfigEngine page |
| **A2** | saved_view | §82 #2 | end-user | ⏳ greenfield | 0 個 `authz_user_view` 之類的 table |
| **A3** | feedback | §82 #3 | end-user → Curator | ⏳ greenfield | 0 個 `authz_feedback` table |
| **A4** | subscription | §82 #4 | end-user / AI agent | ⏳ greenfield, gated | 0 個 `authz_event` / `authz_subscription` table、0 已知 event consumer |
| **C** | business_term-driven column mask | PROGRESS 候選 C | Curator | ⏳ gated on blessing backlog | **0 blessed business_term**(共 2620 resource);C 上線 unlocks 0 value 直到 blessing 填到 ≥10 |
| **D** | default-by-convention permission preset | PROGRESS 候選 D | new user(onboarding) | 🟡 IN-PROGRESS — `permission-default-allow-pilot-plan.md` Phase 0 已開工 | 已有獨立 sub-plan,本 roadmap 不 re-design |
| **E** | page-level help_text / `description` 收編 | PROGRESS 候選 E | Curator → end-user | ⛔ 顯式 deferred(trigger 待觸發) | `help-text-primitive-plan.md` §2 已 defer;trigger:**有頁面真的要長文/多行說明** |

> **Edit log:** 本盤點包含 2 個 advisor pre-commit 抓出的關鍵事實——C 無上游(blessing backlog 0)、E 已 deferred。沒踩這兩個會把 roadmap 排錯。

---

## 2. Sequencing(排序)

### 2.1 排序總圖

| 序號 | 項目 | Slot | 投入 | 主要 user pain |
|------|------|------|------|---------------|
| 1 | **D — default-perm pilot** | now → 4 週 | 已開工(reference 既有 plan) | onboarding 5-10 天 → 0.5-1 天(★★★★★) |
| 2 | **A2 — saved_view** | Q3 2026 後段 → Q4 2026 早段 | ~1.5-2 週 | 每次重設 filter / sort / 欄位(★★★★) |
| 3 | **A3 — feedback** | Q4 2026 中段 | ~1.5 週 | 「這欄錯了」沒地方提(★★★) |
| 4 | **C — business_term mask 自動化** | gated (blessed_term ≥ 10);無 concrete schedule | ~1 週 | Curator 重複寫 mask rule(★★ 直到 blessing 填足) |
| 5 | **A4 — subscription** | gated (named consumer ≥ 2-3);無 concrete schedule | ~2-3 週 | 目前無 concrete consumer(★ 無 anchor 不開) |
| ⛔ | **E — page-level help_text** | Deferred,trigger-based | n/a | 觸發前不算 backlog |
| ✅ | **A1 — help_text** | DONE | — | — |

### 2.2 排序的 4 個關鍵判準

| 判準 | 怎麼用 |
|------|--------|
| **anchor 是否存在** | A4(subscription)無 concrete event consumer → 不排具體 sprint;C(column mask)無 blessed term → gated |
| **既有 plan 是否已開工** | D 已 IN-PROGRESS,reference 不重畫 |
| **降 pain / 週** | A2 saved_view 1 週可降「每次重設 filter」這個全域痛點 → 排 #2 |
| **顯式 deferred** | E 在 help_text plan §2 才剛 defer,不該本 doc 重開 |

### 2.3 排序背後的取捨(對使用者好用)

- **為什麼 saved_view 排在 feedback 前**:saved_view 100% end-user 收益、Curator-side 工作量趨近 0(就一個 user-scoped table)。feedback 一半 end-user(沒地方提)、一半 Curator(Curator Inbox tab 是真實 UX 設計成本 — 排序、status flow、空狀態、reply-or-defer 動作集都要決)。先做 saved_view 把「per-user × per-page schema + ConfigEngine hook 點」這個模式走通,feedback 第二週 reuse 模式更快,且 UX 風險集中在後一個 sprint 不會兩週都卡 UX 設計。
- **為什麼 business_term mask 不搶 Q3 sprint slot**:V044 落地了不代表 mask 自動化能立刻產生 user 收益。**0 blessed business_term** = 0 個自動化目標。先讓 Curator 用既有 V044 把 ≥ 10 個高 PII / SOX 表的 business_term 填到 blessed,再開 C。這也是「對使用者好用」——避免做了一個沒人受益的功能。
- **為什麼 subscription 不排具體日期**:event bus 的 schema 取決於有哪些 events。**目前 named consumer = 0**(AI Sidebar 是 hypothetical、authz_audit_log 不需要訂閱、saved_view / feedback 還沒落地)。在 ≥ 2-3 個 concrete event consumer 浮現前開 subscription = 過度工程。
- **為什麼 D 不再 roadmap 內 redesign**:有獨立 sub-plan、Phase 0 已開工,roadmap 只負責「指出它在 Tier A 大圖裡的位置」,不 fork SSOT。

---

## 3. 每個 primitive 的 key decisions(per-decision 評估)

> 以下只列 roadmap 層級的決策(scope 邊界 + schema 起點 + UX 機制 + authz 模型 + dependency)。實作細節等被 picked up 時新開 sub-plan。

### 3.1 A2 — saved_view

| 決策維度 | 候選 | 推薦 | 為什麼對使用者好用 |
|---------|------|------|------------------|
| **Schema 起點** | (a) 新 table `authz_user_view` / (b) 擴 `authz_ui_page.config` JSONB | **(a) 新 table** | per-user × per-page row pattern,JSONB 在 page 層存 user list 會撞 row 鎖;DataTable 載入時要 `WHERE user_id = ? AND page_id = ?` 直查,index 友善。help_text 的 JSONB-only convention 不適用(那是 page-level metadata,不是 per-user state) |
| **欄位 sketch** | `(view_id, user_id, page_id, name, config_json, is_default, is_shared, created_at, updated_at)` | 採用 + `unique (user_id, page_id, name)` | `is_default` 讓 user 設「我每次打開都用這個 view」;`is_shared` 留 future 「分享到團隊」未實作但 schema 預留 |
| **UX 機制** | (a) 下拉 dropdown「我的 view」/ (b) URL `?view=xxx` deeplink-only | **(a) dropdown + (b) URL share** 兩者都要 | dropdown 解「我自己反覆用」;URL 解「我傳 link 給同事」。兩個 user pain 都常見,只做一個會剩另一半 |
| **Authz 模型** | (a) 純 user 自己讀寫 / (b) 加 read permission | **(a) 純 self-scope** | saved_view 是個人偏好不是業務資料,無 cross-user read 需求(分享走 URL deeplink 即時生效不存 ACL)。實作:row-level filter `WHERE user_id = current_user_id` |
| **Scope 邊界** | DataTable column / filter / sort 是 in scope;column width / pinned column 是 nice-to-have 但不在 v1 | 限定 column hide + filter values + sort,其餘 v2 再加 | 先把 80% 的 user 用 case 解掉(他們最常設的就是 filter + sort),width / pin 是 polishing |
| **Page 類型範圍 (v1)** | (a) ConfigEngine `columns_override` page only / (b) 含 descriptor pattern (V036/V039) / (c) 含 handler-driven (V050/V078) | **(a) only** | 同 help_text visibility caveat — 本 v1 限 ConfigEngine `columns_override` 路徑;descriptor pattern (V036/V039 actions_home etc.) 與 handler-driven page (V050 audit_home / V078 npi_gate_console) 走自己的 view 模式,不在 v1 scope。等首個 ConfigEngine 業務 page 真用上 saved_view 再評估是否擴張 |
| **Dependency** | DataTable 內部 state 要外露 hook 點 | 改 ConfigEngine 加 `onConfigChange` callback | 已有 sortKey / filter values 是 React state,只是現在 不 persist;hook 點 1 處 |

**Acceptance criteria sketch(picked-up 時 expand):**
- AC-1: user 可以在任一 ConfigEngine page 點「Save view as...」,輸入名字,存進 `authz_user_view`
- AC-2: 該 page 載入時自動套用 `is_default=true` 的 view(若有)
- AC-3: dropdown 顯示「我的 views」+ 切換立即生效
- AC-4: URL `?view=<view_id>` 帶入時覆蓋 default
- AC-5: 刪除 view 走 confirm dialog
- AC-6: empty state(該 user 還沒存任何 view)dropdown 顯示「Save current view」call-to-action

### 3.2 A3 — feedback

| 決策維度 | 候選 | 推薦 | 為什麼對使用者好用 |
|---------|------|------|------------------|
| **Schema 起點** | 新 table `authz_feedback` | 採用 | append-only event 性質,JSONB 不適合(查詢、reply、status flow 都要 row) |
| **欄位 sketch** | `(feedback_id, user_id, page_id, target_path, kind, body, status, curator_id, resolved_at, created_at)` | 採用 | `target_path` 例如 `column:lot_id` / `filter:status` / `page` 三層;`kind` enum: `data_wrong` / `feature_request` / `confusing` / `other` |
| **UX 觸發點** | (a) 每個 column header 加「回報」/ (b) 頁面右下浮動按鈕 / (c) 兩者 | **(b) 浮動按鈕 v1,(a) v2** | column-level 太細容易誤觸;浮動按鈕讓 user 主動描述 target,Curator 收到的 feedback 品質高於系統強塞 column path |
| **Curator 端** | (a) 新 tab「Curator Inbox」/ (b) email 通知 / (c) audit log only | **(a) Curator Inbox tab + (c) audit log** | tab 是 Curator 真正會看的地方(audit_home 已是 handler-driven 範例);email 暫不做(內部部署沒 SMTP 設定 baseline,額外配置成本) |
| **Authz 模型** | (a) 純 user 自寫 + Curator 自讀 / (b) 加 reply 鏈 | **(a) v1,(b) v2** | v1 解「user 提、Curator 看」最小完整循環,reply 鏈是 power feature 等 inbox 真的塞才加 |
| **Scope 邊界** | inbox 只負責收 + 標 status;follow-up 工單系統不 in scope(不會做 Jira / Linear) | 限定收件箱,不做 ticketing | 避免複製 Linear。Curator 收到後自己判定要不要轉到對應系統 |
| **Dependency** | 浮動按鈕需要 ConfigEngine 提供 page_id context | 已有(ConfigEngine 知道自己在哪個 page) | 零新依賴 |

**為什麼排在 saved_view 之後**:saved_view 教會我們 ConfigEngine 加 user-scoped 表的模式(per-user × per-page),feedback 直接 reuse。先 saved_view 走通模式,feedback 第二週快很多。

### 3.3 A4 — subscription(gated)

| 決策維度 | 候選 | 推薦 | 為什麼對使用者好用 |
|---------|------|------|------------------|
| **Gate condition** | 立刻做 / 等真實 consumer | **等真實 consumer ≥ 2-3 個** | event bus 沒消費者 = 過度工程。會讓「對使用者好用」變成「對未來假想的使用者好用」 |
| **What counts as consumer** | (a) AI Sidebar:assistant 監聽「我關心的 page 變了」/ (b) saved_view:「該 view 的資料源變了我想 refresh」/ (c) feedback:「我提的 feedback 被回覆了」/ (d) Curator:「authz_role_permission 改了我要知道」 | **trigger:任 ≥ 2 個 + 1 個 nice-to-have 浮現再開** | 不要先設計 event taxonomy 再找消費者,順序反了 |
| **Schema 起點** | (a) `authz_event` + `authz_subscription` 兩表 / (b) reuse `authz_audit_log` 當 event source | **(a) 新表** | audit_log 是 control-plane(誰做了什麼),event 是 domain-plane(資料變了);hijack audit_log 會把 control / domain 攪在一起 |
| **Channel** | (a) in-app notification panel / (b) browser push / (c) email / (d) webhook | **(a) v1 only** | 內部部署 + 用 web app,in-app 已涵蓋 80%;其他 channel 等真實需求 |
| **Authz 模型** | (a) user 訂閱 = self-scope / (b) Curator 推送限定 resource 有 read 才能訂 | **(b) read-gated** | 不能讓 user 訂閱沒權限看的資料變動 leak metadata。subscribe 時走 `authz_check(user, read, resource)` |

**Trigger 寫進 long-term track aspirations**:當 saved_view + feedback 都落地,且 AI Sidebar 開始要監聽變更,roadmap 重審 A4 排程。

### 3.4 C — business_term-driven column mask 自動化(gated)

| 決策維度 | 候選 | 推薦 | 為什麼對使用者好用 |
|---------|------|------|------------------|
| **Gate condition** | 立刻做 / 等 blessed_term ≥ N | **gate at blessed_term ≥ 10** | 0 上游 = 0 收益;Curator 把 V044 用起來填 10 個 PII / SOX 高頻欄位再開 |
| **N 的選擇** | 1 / 5 / 10 / 50 | **10** | 1-5 太少示範性不夠;50 太晚反而 Curator 已被亂寫 mask rule 折磨完;10 是「值得自動化的密度」 |
| **Schema 起點** | (a) 擴 `authz_resource` 加 `mask_policy_ref` / (b) 改 V061 discovery rule 走 join | **(b) discovery rule join** | V061 已是 mask 規則的單一執行路徑,加 SQL join 不動 schema 最便宜;直接擴 authz_resource 容易跟 status / blessed 等 lifecycle 字段語意混 |
| **匹配規則** | (a) business_term match / (b) tag match / (c) 兩者 | **(a) 純 business_term** | tag 是 free-form 沒約束;business_term + status='blessed' 是受控 vocabulary,適合做 PII / SOX 自動歸類的鍵 |
| **Override 機制** | 自動規則 + 個別 row 強制 override | row-level override flag | 自動化必須有 escape hatch,否則 Curator 在邊角 case 會反過來 hate 系統 |

**Trigger 寫進 PROGRESS.md long-term track**:每月 audit 一次 blessed_term 數,≥ 10 時 promote 為 sprint candidate。

**Blessing-fill owner(誰把 blessed_term 從 0 填到 ≥ 10):**
- **Seed 來源:** first Tier 2 admin form pilot 暴露的 ≥ 5 個 PII / SOX column → 就是 blessing 第一批種子;當 pilot 走 V044 lifecycle (draft → review → blessed) 把那批欄填完,blessed_term 自然 ≥ 5
- **Audit cadence:** Adam 每月在 PROGRESS.md candidate audit 時跑一次 `SELECT count(*) FROM authz_resource WHERE status='blessed' AND business_term IS NOT NULL`;達 ≥ 10 即 promote C
- **Trigger 也可由 Curator 主動踏:** 若有 Curator 抱怨「同一條 mask rule 寫第三次了」,即使 blessed_term < 10 也可手動把 C 提 sprint(該抱怨本身就是 user pain 證據)

### 3.5 D — default-by-convention permission preset

**Reference:** [`permission-default-allow-pilot-plan.md`](./permission-default-allow-pilot-plan.md)(IN-PROGRESS,Phase 0 已開工)

本 roadmap 不 re-design。Tier A 大圖內 D 的位置:
- **它是 Tier A 因為:** 任何 Tier B app 上線 onboarding 都遇到「為何要一條條開 read 權限」摩擦
- **為什麼排第一:** 已開工 + onboarding 痛是 Phase 1 demo target 最 visible 的
- **roadmap 對它的承諾:** 不在本 doc 改其 Acceptance Criteria;若 D 出現 scope/timeline 變更,維護在那份 sub-plan 而非這份

### 3.6 E — page-level help_text / description 收編(deferred)

**狀態:** ⛔ Deferred (`help-text-primitive-plan.md` §2)

**Trigger to promote:**
- 條件 1:有 ≥ 1 個 live ConfigEngine page 收到 help_text feedback「需要長文 / 多行 / link」
- 條件 2:或 description 用法在 reviewer 對話中明確造成混亂(雙來源)
- 滿足任一即可重新 promote 到 PROGRESS candidates

不主動排 sprint slot。

---

## 4. 跨 primitive 的共通 convention(降低 6 個項目間的不一致)

| Convention | 適用 | 理由 |
|-----------|------|------|
| **Naming**: 表名 `authz_<noun>`(authz_user_view, authz_feedback, authz_event, authz_subscription) | A2/A3/A4 schema 起點 | codebase 既有慣例(authz_*) |
| **Per-user state default scope = self-only**,Curator 端走 handler-driven page | A2/A3 | 避免每個 primitive 自己重發明 ACL;handler 走 audit_home / modules_home pattern |
| **JSONB-first 只用在 page-level metadata**(help_text 屬此),per-user / per-event 用 row | A1 vs A2/A3/A4 | help_text 是 page 配置,scale ≪ 頁面數;per-user state scale = users × pages,row 比較友善 |
| **Tier A 內禁 domain-specific 分支**(`if (entity === 'eco')` 之類) | 全部 | `two-tier-platform-model.md` §132 anti-pattern,review checklist 加項 |
| **Authz check 必須有,即使 self-only** | A2/A3 read endpoint | 防 SSRF 變 horizontal IDOR(`view_id` enumeration → 拿別人 view) |
| **Audit log 必寫**(action 取統一 prefix `tier_a_*`) | 全部 mutation endpoint | 三大基線原則 #1 可追溯到個人 |

---

## 5. Roadmap 維護 protocol

- **重審節奏:** 每個 Tier A 項目 picked up 完成後重審本 doc 一次(看是否影響後續 ordering)
- **trigger 觸發時:** C 的 blessed_term ≥ 10 / A4 的 consumer ≥ 2 / E 的條件任一 — Adam 自審後 promote 到 PROGRESS candidates,並把對應 row 從本 doc gated 區搬到下個 slot
- **新 Tier A 項目進來:** 走「先 inventory + sequencing 判準 + key decisions」三段同 §1/§2/§3 結構
- **被吸收進 sub-plan 時:** 對應 sub-plan §1 開頭加一行「sequenced from `tier-a-primitives-roadmap.md` §3.x」

---

## 6. References

- 主圖: [`two-tier-platform-model.md`](./two-tier-platform-model.md) §82
- 已落地 Tier A: [`help-text-primitive-plan.md`](./help-text-primitive-plan.md)(A1 ✅)
- IN-PROGRESS Tier A: [`permission-default-allow-pilot-plan.md`](./permission-default-allow-pilot-plan.md)(D)
- V044(business_term lifecycle,C 上游): `database/migrations/V044__authz_resource_business_term.sql`
- V061(mask rule infrastructure,C 落地點): `database/migrations/V061__discovery_rule_effect.sql`
- Anti-patterns review checklist: `two-tier-platform-model.md` §132

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-29 | Adam | → ROADMAP | 初版排序 + 6 項 inventory + 每項 key decisions;advisor pre-draft 抓出 C 無上游(blessed_term=0)、E 已 deferred、D 別 fork SSOT 三個關鍵 framing |
| 2026-04-29 | Adam (advisor post-draft review) | ROADMAP → ROADMAP-revised | Advisor 抓 1 blocker + 2 notes:(1) §3.1 saved_view scope 沒分 ConfigEngine vs descriptor/handler page → 加「Page 類型範圍 (v1)」row 顯式限 ConfigEngine `columns_override`。(2) §2.3 saved_view-before-feedback 用「dependency framing」(DataTable hook reuse) 不準確 → 改成「user-value purity + Curator Inbox UX 風險集中」framing。(3) §3.4 C gate 沒指定 blessing-fill owner → 加 Tier 2 admin form pilot 種子 + Adam 每月 audit + Curator 抱怨可踏 trigger 三條 |
