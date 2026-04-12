# AuthZ 已知生產風險

> 這些是設計級的風險，不適合用程式碼中的 TECH_DEBT 註解追蹤。
> 每次 sprint planning 檢視所有 HIGH 風險的狀態。
> 來源：architecture.md §XVI

## 修復優先順序

SEC-2 → SEC-1 → DATA-1 → OPS-2 → COMP-2 → DX-1 → FT-1 → EVOL-2

## 風險清單

| ID | 維度 | 嚴重等級 | 描述 | 狀態 | 對應 Roadmap Phase |
|----|------|----------|------|------|-------------------|
| OPS-1 | Operations | HIGH | Policy 變更後 cache 不一致窗口（1-5 秒） | mitigated | Phase 23 |
| OPS-2 | Operations | HIGH | Sync engine 失敗無人察覺，GRANT 漂移 | needs_work | Phase 29 |
| OPS-3 | Operations | MED | Audit log partition 未自動建立 | mitigated | Phase 24 |
| SEC-1 | Security | HIGH | Resolved config 洩漏完整權限地圖到客戶端 | needs_work | Phase 26 |
| SEC-2 | Security | HIGH | ADMIN 角色是 god mode，無分權 | needs_work | Phase 25 |
| SEC-3 | Security | MED | PG session variable 可被 Path C 偽造 | mitigated | — |
| SCALE-1 | Scalability | HIGH | 單一 PostgreSQL 是 SPOF | mitigated | Phase 18 |
| SCALE-2 | Scalability | MED | Casbin in-memory policy set 無限成長 | needs_work | — |
| SCALE-3 | Scalability | LOW | JSONB 欄位深層嵌套影響查詢效能 | monitoring | — |
| DATA-1 | Data Integrity | HIGH | 多角色使用者的 allow/deny 衝突 | needs_work | Phase 28 |
| DATA-2 | Data Integrity | MED | 模組停用後 resource 殘留 | needs_work | — |
| DATA-3 | Data Integrity | MED | LDAP 群組同步延遲（最長 1 小時） | needs_work | — |
| DX-1 | Developer Experience | MED | 新模組 onboarding 容易漏步驟 | needs_work | Phase 30 |
| DX-2 | Developer Experience | MED | 開發環境測試 authz 很痛苦 | needs_work | — |
| FT-1 | Fault Tolerance | MED | Redis 掛掉時 DB 查詢暴增 100 倍 | needs_work | — |
| FT-2 | Fault Tolerance | LOW | Casbin reload 時短暫空 policy | needs_work | — |
| COMP-1 | Compliance | MED | Audit batch buffer crash 時遺失事件 | needs_work | — |
| COMP-2 | Compliance | MED | 無 policy 版本歷史和 rollback | mitigated | Phase 27 |
| EVOL-1 | Evolution | MED | 架構假設同質技術棧（PG + Node + React） | mitigated | Phase 20 |
| EVOL-2 | Evolution | MED | AI Agent 多步驟工具呼叫缺乏跨步授權 | needs_work | Phase 31 |

## 狀態定義

- **needs_work**：已識別，尚未有對應的實作或 Roadmap phase
- **mitigated**：有設計方案或已部分實作，殘留風險可接受
- **monitoring**：不需要立即處理，持續觀察指標
