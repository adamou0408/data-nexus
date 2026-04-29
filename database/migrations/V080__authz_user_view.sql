-- ============================================================
-- V080: authz_user_view — Tier A primitive #2 (saved view)
--
-- Context (.claude/plans/v3-phase-1/tier-a-saved-view-plan.md):
--   ConfigEngine page filter / sort / hidden_cols 目前全是 React
--   internal useState,user 切頁、reload、URL 分享全部 reset。本表
--   提供 per-user × per-page named view 持久化。
--
--   Scope (v1):
--     - ConfigEngine `columns_override` page only
--     - Self-scope only (無 cross-user 分享)
--     - filters / sort / hidden_cols 三個 key
--
--   config_json shape:
--     {
--       "filters": [{ "field": "...", "op": "eq", "value": "..." }],
--       "sort":    { "col": "...", "dir": "asc" | "desc" },
--       "hidden_cols": ["col1", "col2"]
--     }
--
-- Audit:
--   Mutating routes 寫入 authz_audit_log,action ∈
--   tier_a_saved_view_create / update / set_default / delete
-- ============================================================

CREATE TABLE authz_user_view (
  view_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text        NOT NULL,
  page_id      text        NOT NULL,
  name         text        NOT NULL,
  config_json  jsonb       NOT NULL,
  is_default   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authz_user_view_unique_name UNIQUE (user_id, page_id, name),
  CONSTRAINT authz_user_view_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT authz_user_view_user_nonblank CHECK (length(btrim(user_id)) > 0),
  CONSTRAINT authz_user_view_page_nonblank CHECK (length(btrim(page_id)) > 0)
);

-- 一個 user 在一個 page 最多一個 default view
CREATE UNIQUE INDEX authz_user_view_default_uniq
  ON authz_user_view (user_id, page_id)
  WHERE is_default = true;

-- list-by-page 查詢
CREATE INDEX authz_user_view_user_page_idx
  ON authz_user_view (user_id, page_id);

COMMENT ON TABLE authz_user_view IS
  'Tier A primitive #2: per-user × per-page saved view (filters / sort / hidden_cols). Self-scope only in v1. See .claude/plans/v3-phase-1/tier-a-saved-view-plan.md.';
COMMENT ON COLUMN authz_user_view.config_json IS
  'Shape: { filters: [{field,op,value}], sort: {col,dir}, hidden_cols: string[] }. Missing keys = no filter / no sort / show all.';
COMMENT ON COLUMN authz_user_view.is_default IS
  'Auto-applied when ConfigEngine loads the page without ?view=<id>. Partial unique index enforces at most one per (user_id, page_id).';
