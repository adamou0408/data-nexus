# Development Standards

開發規範與參考文件，來源為 Dev Kit 模板 + 專案特化規則。

| 文件 | 用途 | 何時參考 |
|------|------|----------|
| `three-paths.md` | 三路徑影響分析 checklist | 修改 authz 表或函式前必讀 |
| `sql.md` | SQL 與資料庫遷移寫法規範 | 新增 migration 或修改 PL/pgSQL 時 |
| `security.md` | 安全審查規則與觸發條件 | 涉及 authz_check / authz_resolve 變更時 |
| `known-risks.md` | 20 個已知生產風險追蹤 | Sprint planning 或安全審查時 |
| `devkit.config` | 專案階段設定 (`STAGE=growth`) | Dev Kit 工具讀取用 |
| `claude-toolkit-usage.md` | Claude Code memory / skills / agents 精簡使用配方 | 開新 session、調整工作流、忘記哪個工具該用時 |

> Note: 專案全局規範、coding standards、安全紅線定義在根目錄 `CLAUDE.md`。
