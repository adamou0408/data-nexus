# Permissions Side Panel — In-context "Who can access" Inspector Section

- **Planner Owner:** Adam (tech lead) + main session
- **Executor Owner:** TBD（Phase B 完成後派）
- **Status:** DRAFT
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §Tier-A primitives / Catalog Workspace V2
- **Target:** Phase 1 純加性工作（無 hard gate）；建議排在 V3 Explorer Phase C 之後
- **Created:** 2026-05-04
- **Last updated:** 2026-05-04

---

## 1. Problem / Why

### 觸發背景

Adam 觀察 Confluence「在 page 上點 Restrictions 直接設權限」的 UX，問現行 Data Nexus SSOT-first 做法（Permissions / Permission Packs admin tab）對權限控管者的好用度落差。

主 session 比較結論：
- **Confluence in-context** 直覺但散亂（無法 aggregate audit、規則散落 N 個 page）
- **Data Nexus SSOT-first** 嚴謹但繞路（看 page 想改權限要 mental hop：page → resource → role → pack）

對 Phison 內部資料中心 + compliance 場景，**SSOT 是必要 bedrock 不能退讓**，但目前缺一個「站在 page/module 前看到誰能存取」的 read-only context shortcut——這是 Confluence 在 ad-hoc 場景擊敗 SSOT 系統的真正原因。

### 對應 master plan

Catalog Workspace V2 已有 Inspector slide-in drawer（`Inspector.tsx`），目前 4 個 inspector renderer（Page / Module / Resource / Table）顯示 metadata + lineage。本 plan 在現有 inspector 內增加 **"Who can access" 段落**，不新建 panel、不破壞現有 SSOT 寫入路徑。

### 三軸決策動機

| 維度 | 不做 | 做 in-context read-only |
|------|------|-------------------------|
| **Tech Debt** | 累積（pages 多了之後 curator 反而懶得設、走後門默許） | 低（純 derive，不複製狀態） |
| **維運成本** | 高（每次 audit 都要 Adam 親自 query SSOT 給人看） | 中（多一支 derive endpoint 要 cache 對齊） |
| **UX** | 差（看到 page 找不到誰能讀，要切 tab + 查 role + 查 pack） | 好（看到當下就知道、一鍵跳去改） |

---

## 2. Scope

**In scope:**
- [ ] 後端新端點：`GET /api/resource/:resource_id/effective-roles` —— 從 SSOT (`authz_role_permission` + `authz_policy`) 即時 derive 哪些 role 對該 resource 有 read 權限、是透過哪個 pack 拿到的
- [ ] 前端：在現有 4 個 inspector (`PageInspector` / `ModuleInspector` / `ResourceInspector` / `TableInspector`) 內加 **"Who can access"** 摺疊 section（預設摺疊，避免衝擊現有版型）
- [ ] Section 顯示：role list（label + member count from `authz_role`），標註透過哪個 pack 拿到（`via pack: data_steward_v2`）
- [ ] 點 role → 觸發 `navigate-tab` event 跳到 access-manager → `PermissionsStudio` 該 role 的 pack 編輯介面（pre-filtered）
- [ ] **唯讀**——側邊面板沒有 inline edit。SSOT 紀律保留。

**Out of scope (defer / Phase 2):**
- 在 inspector 內 inline 編輯權限（明確不做——SSOT 紀律）
- L1 RLS / L2 column mask 顯示（複雜度高、且 SEC-01 sanitize 規則已在 `resolve.ts` 把這些 strip 掉；Phase 2 想做要先設計 admin-only re-elevate channel）
- Path C（DB GRANT / RLS）權限顯示——這是 PG 層級事實，跟 SSOT derive 不同來源
- Module-level 反向查（「Alice 在哪些 module 有權限」）——是另一個 dashboard 等級的功能
- Telemetry 事件追蹤點開 panel 的次數（catalog-telemetry-v01 一起處理）

---

## 3. Design / Approach

### 3.1 後端 API

**新端點：** `GET /api/resource/:resource_id/effective-roles`

**Auth:** 需要 `X-User-Id`，admin OR 對該 resource 有 read 權限的 user（避免 information leakage）。

**Response shape:**
```json
{
  "resource_id": "page:fc_search_material",
  "resource_type": "page",
  "effective_roles": [
    {
      "role_id": "data_steward",
      "role_label": "Data Steward",
      "member_count": 4,
      "via": [
        { "pack_id": "data_steward_v2", "pack_label": "Data Steward (v2)", "permission": "read" }
      ]
    },
    {
      "role_id": "viewer_pg_tiptop",
      "role_label": "Viewer (TipTop)",
      "member_count": 12,
      "via": [
        { "pack_id": "tiptop_read_v1", "pack_label": "TipTop Read", "permission": "read" }
      ]
    }
  ],
  "stale_at": "2026-05-04T08:31:22Z"
}
```

**底層 query** 走 PG function（新增 `fn_effective_roles_for_resource(text)` 或在現有 `authz_resolve` 旁邊加 sibling fn——decision 見 §3.4）。

**Cache:** 跟 `policyCache` 同 invalidation 觸發點（policy / role-pack 寫入），TTL 60s（read-heavy + tolerable staleness）。

### 3.2 前端 inspector 擴充

**位置：** 4 個 inspector 內，metadata section 與 lineage section 之間。

**樣式：**
```
─────────────────────────────────────
▼ Who can access  (3 roles, 18 members)
─────────────────────────────────────
  Data Steward                      4 members
    via Data Steward (v2)               [→ edit]
  Viewer (TipTop)                  12 members
    via TipTop Read                     [→ edit]
  AI Agent (Read-only)              2 members
    via AI Agent Read                   [→ edit]
─────────────────────────────────────
```

**互動：**
- Section 預設摺疊（`<details>` element 或自 implement chevron）
- 展開時 fire `GET /api/resource/:rid/effective-roles`（lazy load，避免每個 inspector 開啟都打 API）
- `[→ edit]` 點擊 → `window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'access-manager', focus: { role_id, pack_id } } }))` → `App.tsx` 接事件切 tab 並把 focus payload 塞到 `PermissionsStudio` initial state
- 載入中：skeleton loader（跟 lineage 同樣式）
- 錯誤：inline 紅字「無法載入有權限的角色 — <retry>」
- 空 result：「目前沒有任何 role 對此 resource 有 read 權限」+ 提示一鍵跳 access-manager 開新 pack

### 3.3 Resource type 對應

| Inspector kind | resource_id mapping |
|----------------|--------------------|
| `page` | `page:<page_id>` |
| `module` | `module:<module_id>` |
| `resource` | 直接是 `resource_id` |
| `table` | `table:<data_source>.<schema>.<table>` |

→ 同一支 endpoint 服務四種 inspector，差別在 resource_id prefix。

### 3.4 Key decisions

| Decision | Choice (default) | Reason |
|----------|------------------|--------|
| Inline edit vs read-only | **Read-only + deep-link**（default per Adam memory `feedback_default_driven_workflow`） | SSOT 紀律不能退讓。在 inspector 寫入會繞過 PermissionsStudio 的 validation / audit context |
| Section 預設摺疊 vs 展開 | **預設摺疊**，lazy load | 避免每次開 inspector 都打 API；4 個 inspector 都裝後流量 4x。展開後 cache 60s |
| Endpoint 路徑 | `/api/resource/:resource_id/effective-roles` | 對齊現有 `/api/resource/...` REST style；`resource_id` 走 url-encoding |
| 顯示 role 還是 user | **顯示 role + member_count**，不展開 user list | 避免 PII 直接攤在 inspector；user list 在 PermissionsStudio 內部還是看得到 |
| 透過哪個 pack 顯示 | **顯示一個 pack（最具體那個）** | 避免 noise（一個 role 可能透過多 pack 拿到 read）。展開 `via` array 只在 debug mode |
| Cache 一致性 | 跟 `policyCache` 共用 invalidation hook | 避免 SSOT 與 inspector 顯示落差讓 curator 信任崩盤 |
| Module / table inspector 是否一起做 | **一起做**（同 endpoint） | 切 4 個 PR 反而 churn；統一介面 review 一次完 |
| 點 role 跳哪 | `access-manager` tab + `PermissionsStudio` pre-filtered | 比舊 `PermissionsTab` 新且是 V3 主軸 |
| 端點放 `routes/resolve.ts` 還是新 `routes/effective-roles.ts` | **新 `routes/effective-roles.ts`** | resolve.ts 是 user-centric (X-User-Id → permissions)；本端點是 resource-centric (resource_id → roles)，反方向問題不適合擠進去 |

### 3.5 Open questions（須 Adam 確認）

- [ ] **是否要 audit 點擊 panel 的事件？** Catalog Telemetry V01 已有 click event 機制，建議掛上但不阻塞 launch。owner: Adam decide
- [ ] **Module-level「effective roles」是 union of children 還是 module 自己 resource?** Default：module 自己（不展開）。展開 children 是 N+1 query，留給 Phase 2。owner: Adam confirm default
- [ ] **跨資料源 join：role 的 member_count 來源？** Default 從 `authz_role_member` count；如果未來有 LDAP/Keycloak group 動態 sync，要再對齊。owner: Adam confirm
- [ ] **空狀態的「create pack」CTA 要不要做？** Default 不做（避免 UX 教學負擔，先看實際使用率）

---

## 4. Acceptance Criteria

> **Executor 看這裡知道何時算「做完」。**

- [ ] **AC-1:** `GET /api/resource/:resource_id/effective-roles` 回 200 + JSON shape 如 §3.1，admin / 有權限 user 都能 call；無權限 user 回 403
- [ ] **AC-2:** 4 個 inspector 都顯示 "Who can access" 摺疊 section；展開時 lazy fetch；摺疊狀態跟 inspector instance lifecycle 同步（換 target 重置）
- [ ] **AC-3:** 點 role 觸發 `navigate-tab` event；`App.tsx` 接到後切到 `access-manager` tab；`PermissionsStudio` 接到 focus payload 後 pre-select 該 role + pack
- [ ] **AC-4:** Cache 跟 `policyCache` 同 invalidation hook（寫 role-pack / role-permission 後 60s 內反映在 inspector）
- [ ] **AC-5:** Tests: integration test for endpoint（admin / non-admin / non-existent resource_id）+ e2e for inspector click → tab navigation
- [ ] **AC-6:** Docs: 更新 `docs/api-reference.md` + `docs/architecture-diagram.md` 加 inspector → effective-roles flow
- [ ] **AC-7:** PROGRESS.md 加一行 "Permissions Side Panel landed"
- [ ] **AC-8:** 三軸決策確認：tech debt / 維運 / UX 在 PR description 都列出

---

## 5. Implementation Plan (Executor 填)

> Executor session 在 `IN-PROGRESS` 階段填這節。

### Tasks

- [ ] [task 1 — backend endpoint + PG fn]
- [ ] [task 2 — 4 inspector extension]
- [ ] [task 3 — App.tsx event handler + PermissionsStudio focus payload]
- [ ] [task 4 — tests + docs]

### Files touched

- `database/migrations/V0XX__effective_roles_fn.sql` — NEW PG function
- `services/authz-api/src/routes/effective-roles.ts` — NEW endpoint
- `services/authz-api/src/index.ts` — register new router
- `apps/authz-dashboard/src/api.ts` — add `effectiveRoles` wrapper
- `apps/authz-dashboard/src/components/catalog/inspectors/{Page,Module,Resource,Table}Inspector.tsx` — add "Who can access" section
- `apps/authz-dashboard/src/App.tsx` — extend `navigate-tab` event handler with focus payload
- `apps/authz-dashboard/src/components/access-manager/roles/PermissionsStudio.tsx` — accept initial focus

### Migration / DB notes

V0XX is fn-only (no schema change), rollback safe via `DROP FUNCTION`.

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| effective_roles fn 計算成本高（大 module 下） | 中 | Cache 60s + index on `authz_role_permission(resource_id)` 已存在；先 EXPLAIN 確認 |
| Cache 不一致讓 curator 看到舊狀態，誤以為 SSOT bug | 中 | 跟 `policyCache` 同 invalidation；section 旁加 "更新於 X 秒前" timestamp |
| Inspector 變太擠（4 種 inspector 都加新 section） | 低 | 預設摺疊；如果版型崩，把 lineage 從 inspector 移出（Phase 2） |
| PII leak 透過 member_count（小組織下顯示 1 member 等於指認個人） | 低 | 只顯示 count 不展開 user；count < 3 顯示 "<3 members" 模糊化（default decision） |
| `navigate-tab` event 跨 tab 有 timing race | 低 | 已有 setTimeout(0) pattern in `PageInspector.openComposer` 可借鑑 |

**Rollback:** 移除 inspector 內的 section（純加性，不影響其他流程）；endpoint 留著也無害；migration drop fn。

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-05-04 | Main session (Adam consult) | → DRAFT | 觸發於 Confluence vs Data Nexus 比較討論。Plan 寫完待 Adam ack。 |

---

## 8. References

- Master plan: [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md)
- Architecture: [`docs/phison-data-nexus-architecture-v2.4.md`](../../../docs/phison-data-nexus-architecture-v2.4.md) §1 (SSOT) §2 (resolve)
- Constitution: [`docs/constitution.md`](../../../docs/constitution.md)
- Related sub-plans:
  - [`./catalog-workspace-unified-design.md`](./catalog-workspace-unified-design.md) — Inspector primitive
  - [`./permission-inheritance-cascade.md`](./permission-inheritance-cascade.md) — pack inheritance model
  - [`./tier-a-primitives-roadmap.md`](./tier-a-primitives-roadmap.md) — UX primitives
  - [`./catalog-telemetry-v01-report.md`](./catalog-telemetry-v01-report.md) — telemetry hook 點

---

## 9. Default decisions to surface in PR

> Per Adam memory `feedback_default_driven_workflow` — small decisions AI 直接 default + PR 列清單。

1. **Read-only inspector**（不允許 inline edit）—— SSOT 紀律
2. **Section 預設摺疊**，lazy fetch —— 避免 4x API 流量
3. **顯示 role + member_count，不展開 user list** —— PII 防護
4. **顯示一個 pack（最具體那個）** —— 避免 noise
5. **新 endpoint `/api/resource/:rid/effective-roles`** 而非塞進 `resolve.ts` —— 反方向 query
6. **跳 access-manager**（V3 主軸）而非舊 `PermissionsTab`
7. **Member count < 3 顯示 "<3 members"** —— 小組織 PII 模糊化
8. **Module-level 不展開 children** —— Phase 2 再做

任何 default 不對的，Adam ack 時 flag 即可。
