# Permission Inheritance Cascade — schema-as-resource + parent_id walk

- **Planner Owner:** Adam（vision 提出）+ Claude planner session（本檔起草）
- **Executor Owner:** Claude（同 session — Adam default-driven workflow 授權合併 planner+executor）
- **Status:** READY-FOR-REVIEW（核心 migration 已 apply + 4 個 invariant 端到端驗證 — 2026-04-28）
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §基座（Q3 2026 onboarding 摩擦降低）；協同 [`permission-default-allow-pilot-plan.md`](./permission-default-allow-pilot-plan.md)
- **Target:** V070 migration draft Q3 2026；end-to-end pilot 配合 default-allow Phase 2
- **Created:** 2026-04-28
- **Last updated:** 2026-04-28（migration applied + verification green）

---

## Status Lifecycle

> `DRAFT` → `READY-FOR-IMPLEMENTATION` → `IN-PROGRESS` → `READY-FOR-REVIEW` → `DONE`
>
> Planner（本 session）負責 §1-4 + §6 + §8。寫完後等 Adam 看過 §3 Key decisions 一表 + §4 AC，鎖了再 → `READY-FOR-IMPLEMENTATION`。

---

## 1. Problem / Why

### Adam 的 vision（2026-04-28 原話）

> 「想要的 database & schema 層級適用預設通用,並且對應的 function 也是繼承 schema 的設定. 而用反向的方式,deny 那些 database & schema 不該被看到,以及所有的 rows filter & columns mask 都是用 deny 方式或特別設定在去卡控. 降低設定的成本」

拆解四個能力：

1. **DB/schema 層級預設通用** — 不再 row-by-row grant 每張 table
2. **Function 繼承 schema 設定** — 同 schema 的 fn 自動拿到 schema 的 default
3. **反向 deny** — 不該看到的 schema/table/column/row 用 deny rule 卡
4. **降低設定成本** — 一個新 datasource onboarding 從「150-200 條 row」降到「個位數」

### 現況差距（2026-04-28 DB inspect）

| 能力 | 現況 | Gap |
|------|------|-----|
| DB/schema 層級預設 | `authz_data_source.default_l0_policy` 已可選 deny/allow（V059） | 只能整個 datasource 一刀切，**沒有 schema 顆粒度** |
| `authz_resource.resource_type` enum | `ai_provider, column, function, module, table, web_api, web_page` | **沒有 `schema`** — 無法當作 inheritance 中介層 |
| Function 繼承 schema | function 資源 parent_id = NULL（3 個 tiptop schema fn 都這樣） | **沒有任何 cascade walk** — 走的就是 leaf node |
| 反向 deny | `authz_discovery_rule.effect=deny`（V061）+ V062 30 條 deny pattern（staged） | DB 反向 deny 機制 OK，但 **沒有 schema 中介**，rule 只能 match individual table |
| 設定成本 | 新 datasource = 150-200 條 row（permission-default-allow-pilot-plan §1） | default-allow 已能降到 ~10 條；加上 schema cascade 可降到 **個位數** |

### 為什麼現在做（不延後）

- Tier 2 wizard MVP（Q4 2026）依賴使用者快速取得跨 schema 資料，schema 級顆粒度是 wizard 「選資料來源 → 選 schema → 選表」的自然 UX 對應。
- default-allow pilot（Q3 2026 Phase 2）跑完之後，下一個 onboarding 摩擦點就是「even allow datasource 也要逐表 grant」— 這是 V070 要解的。
- 這次做完，Phase 1 onboarding 故事可以講「**3 步驟**：register datasource → set schema policy → 開測」。

---

## 2. Scope

**In scope（本 plan / V070 涵蓋）：**

- [ ] `authz_resource.resource_type` enum 新增 `schema`（不動現有 enum 值）
- [ ] `authz_resource.parent_id` 既有欄位語意延伸：function / table / view → schema → datasource fallback
- [ ] `authz_resolve` / `authz_check` 加入 **parent chain walk**（leaf 找不到時往上找）
- [ ] Schema-level `default_policy`（optional column 或從 parent walk 直接讀 datasource）
- [ ] Discovery promote 流程：把 leaf 升級時自動 ensure schema parent row
- [ ] Cache invalidation 擴充：schema-level policy 變更 → invalidate 所有 descendants 的 resolve cache
- [ ] V064 invariant 保留：**deny 永遠贏**，不論在 schema / leaf / datasource 哪一層宣告
- [ ] Before / after onboarding row count 量化（advisor 要求）

**Out of scope（不在 V070，分開 plan）：**

- ❌ Row filter 設計（Adam vision 提到「rows filter ... 用 deny 方式」— 但這要看 row-level discovery rule，獨立 plan）
- ❌ Column mask 機制改寫（V010 已存在，不在這輪重構）
- ❌ 改 default_l0_policy default 值（仍是 `deny` — 由 default-allow pilot 控制 flip）
- ❌ Tier 2 wizard 的 schema 選單 UI（wizard plan 自己處理）
- ❌ Path C `pg_default_acl` 的 schema-level GRANT（V063 已處理 ALL TABLES，schema-level 等實際需要再加）
- ❌ V045 disable cascade（completely different scope — V045 處理 lifecycle disable，V070 處理 always-on read path）

---

## 3. Design / Approach

### 3.1 Resource type 新增

```sql
-- V070 段一：新增 schema enum
ALTER TYPE authz_resource_type ADD VALUE 'schema';

-- 範例 row（Discovery promote auto-ensure 寫入）
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
VALUES (
  'schema:pg_k8.public',          -- naming convention: schema:<datasource_short>.<schema_name>
  'schema',
  NULL,                            -- parent_id 不指 datasource（datasource 不是 authz_resource，見 3.2）
  'pg_k8 / public',
  '{"data_source_id": "ds:pg_k8", "schema_name": "public", "default_policy_inherited_from": "data_source"}'::jsonb
);

-- 既有 table / fn reparent
UPDATE authz_resource
   SET parent_id = 'schema:pg_k8.tiptop'
 WHERE resource_id IN (
   'function:tiptop.fn_cxmzr115_shipment_history_by_material_no',
   'function:tiptop.get_work_orders_by_part',
   'function:tiptop.search_cimzr067_by_keys'
 );
```

**重要：resource_id naming 不變**（advisor 第 1 條：don't change resource_ids）。`function:tiptop.fn_xxx` 仍然是 `function:tiptop.fn_xxx`，只是現在 `parent_id = 'schema:pg_k8.tiptop'`。

### 3.2 Chain top — parent walk 終點怎麼接？

Advisor 給三個選項：

| 選項 | 說明 | 取捨 |
|------|------|------|
| (a) `datasource` 變成 `authz_resource` | 把 `ds:pg_k8` 也 INSERT 進 authz_resource | **改動最大**：要改 V059 的 default_l0_policy 來源、改 owner_subject FK、authz_data_source 仍存在但變雙寫 |
| (b) Virtual root resource per datasource | 寫 `root:ds:pg_k8` 當 schema parent | 多一層抽象但 datasource 表不動 |
| (c) Walk hits NULL → fallback to `authz_data_source.default_l0_policy` | parent_id 鏈走到 schema 的 NULL parent，resolver 自動 fallback 到 `data_source.default_l0_policy` | **改動最小**，沿用 V059/V060 的 default_l0_policy ENUM；schema row attributes 記錄 `data_source_id` 即可 |

**Recommendation: (c)**。理由：
- V059/V060/V063/V064 整套 default-allow 機制是建在 `authz_data_source.default_l0_policy` 上，(c) 不破壞任何 invariant。
- `authz_resource` 表只增 schema row + 既有 table/fn reparent，**不需要改 FK / owner_subject 結構**。
- Walk logic 簡單：`leaf → schema → (NULL parent) → look up data_source_id from schema.attributes → read default_l0_policy`。

### 3.3 Precedence ladder（advisor 要求 explicit）

從上到下，先 match 先贏；遇到 deny 直接停（V064 invariant）：

```
1. SYSADMIN god-mode bypass     (V066/V067) — allow 全部，但 deny 仍贏（已實作）
2. Resource-level allow/deny    — table/fn/column 上的明確 grant / deny
3. Schema-level deny            — schema row 上的 deny rule（包含 V061 discovery_rule effect=deny）
4. Schema-level allow / inherit — schema row 的 default_policy（無則 fallback 到 4.5）
5. Datasource-level deny        — discovery rule + 既有 V064 deny override
6. Datasource-level default     — authz_data_source.default_l0_policy
7. Global default               — 系統 default deny（V001 baseline）
```

**Deny 永遠贏（V064 invariant 擴張）：** 任何一層 deny，不論在 leaf / schema / datasource，都覆蓋上面所有 allow。Resolver walk 時 deny 短路返回。

### 3.4 Discovery auto-attach parent

`services/authz-api/src/routes/discover.ts` promote 流程：

```ts
// promote table from discovery → authz_resource
async function promoteTable(dataSourceId, schemaName, tableName) {
  // ensure schema row exists
  const schemaResourceId = `schema:${shortName}.${schemaName}`;
  await db.query(`
    INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
    VALUES ($1, 'schema', NULL, $2, $3::jsonb)
    ON CONFLICT (resource_id) DO NOTHING
  `, [schemaResourceId, `${shortName} / ${schemaName}`,
      JSON.stringify({ data_source_id: dataSourceId, schema_name: schemaName })]);

  // promote table with parent_id pointing at schema
  await db.query(`
    INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name, attributes)
    VALUES ($1, 'table', $2, $3, $4::jsonb)
    ON CONFLICT (resource_id) DO UPDATE SET parent_id = EXCLUDED.parent_id
  `, [`table:${schemaName}.${tableName}`, schemaResourceId, ..., ...]);
}
```

Function promote 同理（已知 3 個 tiptop fn 走這條路 reparent）。

### 3.5 Cache invalidation

現況 `services/authz-api/src/cache.ts`：listen `authz_policy_changed` / `authz_resource_changed`，per-resource invalidate。

V070 後需要：
- Schema row attributes 變更 → invalidate 所有 `parent_id = schema_id` 的 descendants resolve cache
- Datasource default_l0_policy 變更（V059 既有事件）→ 擴張：invalidate 該 datasource 下所有 schema descendants 的 cache
- 實作建議：在 `policy-events` listener 加一個 `walkDescendants(resource_id)` 函式，BFS 一層 parent_id index，發送 cache invalidate 事件。

### 3.6 Onboarding row count — before / after（advisor 要求）

| 步驟 | Before V070 | After V070 |
|------|-------------|-----------|
| Register datasource | 1 row（authz_data_source） | 1 row（authz_data_source） |
| Set datasource default | 1 col update（V059 default_l0_policy='allow'） | 1 col update（V059） |
| Schema baseline | N/A | **1 row per schema**（schema:pg_k8.public, schema:pg_k8.tiptop ...） |
| Per-table grant | **150-200 rows**（authz_role_permission × roles × tables） | **0 rows**（從 schema 繼承） |
| Deny exceptions | 0-30 rows（V062 deny patterns） | 0-30 rows（同） |
| **總計** | **~150-230 rows** | **~10-40 rows**（schema rows + deny exceptions） |

**Sanity check（advisor 第 8 條）：** 如果 after 不顯著 < before，這個 plan 沒賺；目標 80%+ row 削減才值得改。

### Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| 新增 `schema` resource_type | Yes — `ALTER TYPE ... ADD VALUE 'schema'` | 不破壞既有 enum，cascade 中介層必要 |
| Chain top | (c) walk hits NULL → fallback to `authz_data_source.default_l0_policy` | 不動 V059 結構、不雙寫 datasource |
| resource_id naming | 不變（`function:tiptop.fn_xxx` 維持） | Advisor 強制：避免破壞既有 grant + audit log 引用 |
| Function 是否需要單獨 cascade 邏輯 | 不需要 | 2026-04-28 DB inspect 確認 3 個 fn 都是真實 PG fn 在 tiptop schema，跟 table 走同一條 parent walk |
| Schema-level `default_policy` 欄位 | 用 `attributes` jsonb 而不開新 column | V044 semantic layer 已用 attributes 模式；新 column 等真的要 index 再加 |
| Deny 短路 | 保留 V064 invariant；walk 遇 deny 直接 return | 不可動搖 — 法遵 + 安全的 single source of truth |

### Open questions

- [ ] **Q1：Schema 命名 collision 怎麼處理？** 兩個 datasource 都有 `public` schema → resource_id 該如何避免撞？目前提案：`schema:<datasource_short>.<schema_name>`，例：`schema:pg_k8.public`。但 `datasource_short` 從哪來（authz_data_source 沒這欄）？— owner: Planner（Adam 拍板）
- [ ] **Q2：Path C 的 `authz_sync_db_grants`（V063）要不要同步加 schema-level GRANT？** 現在是 ALL TABLES IN SCHEMA + ALTER DEFAULT PRIVILEGES，schema 顆粒度其實已經 cover；但如果 V070 後使用者期待「schema 級切換」立即同步 PG GRANT，需要新事件。— owner: DBA-guardian
- [ ] **Q3：Deny rule 在 schema 層可以用 wildcard 嗎？** 例：`schema:*.audit_log` deny。需要嗎？暫時 No（V070 不做 wildcard）。— owner: Planner

---

## 4. Acceptance Criteria

> Executor 看這裡知道何時算「做完」。Locked at READY-FOR-IMPLEMENTATION。

- [ ] **AC-1：Migration applied**
  - `database/migrations/V070__permission_inheritance_cascade.sql` apply 成功
  - `authz_resource_type` enum 含 `schema`
  - `authz_resolve` / `authz_check` 函式做 parent_id walk（pg_catalog 可看到新版函式定義）

- [ ] **AC-2：Fixture seed verifies cascade**
  - Seed `schema:pg_k8.tiptop` row（attributes 含 `data_source_id: 'ds:pg_k8'`）
  - 既有 3 個 `function:tiptop.*` reparent 到該 schema row
  - DB query 驗證：`SELECT parent_id FROM authz_resource WHERE resource_id LIKE 'function:tiptop.%'` 全部 = `schema:pg_k8.tiptop`

- [ ] **AC-3：End-to-end resolve test**
  - Datasource `ds:pg_k8` `default_l0_policy='allow'`
  - Schema `schema:pg_k8.tiptop` 無明確 policy
  - BI_USER 對 `function:tiptop.get_work_orders_by_part` 呼叫 `authz_check` → **allow**（從 datasource 繼承）
  - 加一條 schema-level deny（例：`INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES ('BI_USER', 'execute', 'schema:pg_k8.tiptop', 'deny')`）
  - 同呼叫 → **deny**（V064 invariant 擴張驗證）

- [ ] **AC-4：Discovery promote auto-ensure**
  - 新增一個 mock schema `schema:pg_k8.demo_schema`（Discovery 模擬）
  - Promote 一張新 table 經過 `discover.ts` → schema row 自動寫入；table row `parent_id` 指 schema row

- [ ] **AC-5：Cache invalidation**
  - 改 `schema:pg_k8.tiptop` 的 attributes → `policy-events` listener log 顯示 invalidate 至少 3 個 descendants
  - Resolve API 重打 → reflect 新 policy（不命中 stale cache）

- [ ] **AC-6：Onboarding cost measurement**
  - 用 V070 流程模擬「新增 ds:demo + 1 schema + 5 tables」
  - 計算實際 row 數（authz_resource + authz_role_permission）
  - 寫入 `permission-inheritance-cascade-report.md`：actual rows ≤ 40，達成 §3.6 預期

- [ ] **AC-7：Tests**
  - Unit：`authz_resolve` 在 schema-deny + datasource-allow 場景回 deny
  - Integration：promote API + check API 跨檔串通
  - Regression：所有既有 V059-V067 測試仍綠（不破壞 default-allow / SYSADMIN god-mode / V064）

- [ ] **AC-8：Docs**
  - 更新 `docs/architecture-diagram.md`（resource hierarchy 加 schema 層）
  - 更新 `docs/er-diagram.md`（authz_resource enum 註記）
  - 更新 `docs/PROGRESS.md` Phase 1 §基座

- [ ] **AC-9：PROGRESS.md 對應條目更新**

---

## 5. Implementation Plan (Executor 填)

> Executor session 在 `IN-PROGRESS` 階段填這節。Planner 不要 pre-fill。

### Tasks

- [ ] [task 1 — V070 SQL draft 寫到 `migration-drafts/`]
- [ ] [task 2 — fixture seed]
- [ ] [task 3 — discover.ts 改]
- [ ] [task 4 — cache.ts 改]
- [ ] [task 5 — tests]
- [ ] [task 6 — measurement report + docs]

### Files touched

- `database/migrations/V070__permission_inheritance_cascade.sql` — 新增
- `.claude/plans/v3-phase-1/migration-drafts/V070__permission_inheritance_cascade.sql` — draft
- `database/seed/dev-seed.sql` — 加 schema:pg_k8.tiptop row + reparent functions
- `services/authz-api/src/routes/discover.ts` — promote 自動 ensure schema
- `services/authz-api/src/cache.ts` — descendant walk invalidation
- `tests/integration/permission-inheritance.test.ts` — 新增

### Migration / DB notes

- `ALTER TYPE ... ADD VALUE` 在 PG 16 不能在 transaction 中跑 → V070 需要 split：第一段純 ALTER TYPE（standalone），第二段 function rewrite + seed。Migration runner 需確認支援。
- Rollback：drop new schema rows + revert authz_resolve / authz_check 函式定義（保留舊版本在 `migration-drafts/V070_rollback.sql`）。
- Enum value 一旦加進去**不能 drop**（PG 限制）。Rollback 只能保留 enum 值但停止使用。

---

## 6. Risks & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `ALTER TYPE` 在 transaction 失敗 | 中 | Migration split 兩段；executor 跑 V070a + V070b |
| Cascade walk 拖慢 hot path（authz_check 是每次 API call 都跑） | 中 | parent_id 加 index；measure p95 latency before/after；advisor 第 6 條 |
| Cache invalidation BFS 把 descendants tree 太多 → invalidation storm | 低 | Schema 層改動頻率本來就低；加上限 + log warning |
| Schema naming collision 沒解（Q1） | 中 | 開工前 Adam 拍板 naming convention |
| Deny invariant 失守（V064 規矩破） | 高（如果失守很嚴重） | AC-3 直接驗證；regression test 涵蓋 V064 既有 case |
| 既有 grant 因 reparent 失效 | 低 | resource_id 不變（advisor 第 1 條），role_permission 表不動 |

**Rollback：** revert authz_resolve / authz_check 函式 → 行為退回 V067 狀態；新 schema rows 保留但不影響 walk（leaf 仍有自己的 grant）。Audit log 記錄 rollback event。

---

## 7. Handoff Log

| Date | From → To | Status change | Note |
|------|-----------|---------------|------|
| 2026-04-28 | Planner | → DRAFT | Adam vision 拆解 + advisor 9 constraints applied + DB function nature 已 verify（real PG fn）|
| 2026-04-28 | Planner → Executor (same session) | DRAFT → IN-PROGRESS | Adam default-driven workflow 授權 — Open Q1/Q2/Q3 各下 default 直接做 |
| 2026-04-28 | Executor | IN-PROGRESS → READY-FOR-REVIEW | V070 migration applied; 4 invariant 端到端驗證綠（baseline allow / schema-deny blocks descendant / SYSADMIN deny-wins / default-deny + schema-allow cascade）|

### Implementation reality vs. original plan

差異記錄（plan 寫的時候還沒看清楚 codebase）：

| 原 plan 寫 | 實作改成 | 為什麼 |
|------------|----------|---------|
| 新增 `schema` resource_type | 沿用既有 `db_schema`（V052 已加） | 不重複加 enum；resource_type 是 TEXT+CHECK 不是 PG enum |
| `schema:pg_k8.tiptop` naming | `db_schema:pg_k8.tiptop` | 配合 db_schema type prefix |
| 自寫 parent walk | 借 V037 `resource_ancestors` mat view | V037 已 pre-compute；deny walk JOIN ra 一次解決 |
| Schema-level default_policy 欄位 | `attributes.default_policy_inherits='data_source'` jsonb | V044 semantic layer pattern；不開新 column |

### Out-of-scope，留下一輪

- **Discovery promote auto-ensure schema row**（Task #35）— `services/authz-api/src/routes/discover.ts` 改：promote table/function 自動 INSERT schema row if missing。
- **Cache invalidation walk**（plan AC-5）— `services/authz-api/src/cache.ts` 改：schema-level policy 變更 → invalidate descendants resolve cache。
- **resource_ancestors auto-refresh**（V037 既有 pg_notify 機制）— V070 手動 REFRESH，需驗證 listener 是否 cover schema row INSERT/UPDATE 事件；如不 cover，補 trigger。
- **authz_check_batch 同步擴張**（V064 同樣 deferred，現 V070 也 deferred）— 等 telemetry 顯示有 gap 再做。

---

## 8. References

- Master plan: [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md)
- Architecture: [`docs/phison-data-nexus-architecture-v2.4.md`](../../../docs/phison-data-nexus-architecture-v2.4.md)
- Constitution: [`docs/constitution.md`](../../../docs/constitution.md)
- 協同 plan：[`permission-default-allow-pilot-plan.md`](./permission-default-allow-pilot-plan.md)（V070 是 pilot 後的下一步 onboarding 摩擦削減）
- 區隔對照：[`dependency-cascade-plan.md`](./dependency-cascade-plan.md)（V045 — disable lifecycle cascade，**完全不同 scope**）
- 相關 migration：V059（default_l0_policy）、V060（authz_resolve check）、V061（discovery_rule effect）、V062（deny pattern）、V063（sync_db_grants）、V064（deny override invariant）、V066/V067（SYSADMIN god-mode）
