# Reference Documents Index

本目錄存放 AuthZ 專案的開發規範與參考文件，來源為 Dev Kit 模板 + 專案特化規則。

| 文件 | 用途 | 何時參考 |
|------|------|----------|
| `CLAUDE.md` | Dev Kit 原始 CLAUDE.md 模板（上游規範） | 了解專案全局規範、coding standards、安全紅線 |
| `authz-three-paths.md` | 三路徑影響分析 checklist | 每次修改 authz-service / database / authz-types 前必讀 |
| `authz-sql.md` | SQL 與資料庫遷移寫法規範 | 新增 migration 或修改 PL/pgSQL 時參考 |
| `authz-security.md` | 安全審查規則與觸發條件 | 涉及 `authz_check` / `authz_resolve` 變更時觸發 |
| `authz-known-risks.md` | 16 個已知生產風險追蹤 | Sprint planning 或變更安全相關邏輯時檢視 |
| `devkit.config` | 專案階段設定 (`STAGE=growth`) | Dev Kit 工具讀取用，一般不需手動修改 |
