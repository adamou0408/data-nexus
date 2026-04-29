-- ============================================================
-- V082: authz_feedback — Tier A primitive #3 (per-user page feedback)
--
-- Plan: .claude/plans/v3-phase-1/tier-a-feedback-plan.md
--
-- ── Problem ──
--   ConfigEngine 上線後 end-user 發現「資料錯了」「filter 不夠用」
--   「help_text 看不懂」沒有 in-app 反饋管道。Curator sample-bias，
--   靠口頭 / Slack DM 拿不到沉默多數的 feedback。
--
-- ── Choice ──
--   Per-user × per-page table（reuse SAVED-VIEW V080 pattern）。
--   Append-only for end-user；Curator triages via PATCH status。
--   target_path 三層：'page' | 'column:<col>' | 'filter:<field>'。
--   v1 frontend 只送 'page'；column/filter v2 deferred。
--
-- ── kind enum ──
--   data_wrong / feature_request / confusing / other
--
-- ── status flow ──
--   open → triaged → resolved | dismissed（any-to-any，無 state machine）
--
-- ── Out of scope ──
--   Curator Inbox tab UI（FU commit FEEDBACK-V01-INBOX-FU）
--   Reply chain / email / Slack notify
--   User PATCH/DELETE on own feedback
-- ============================================================

BEGIN;

CREATE TABLE authz_feedback (
  feedback_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text        NOT NULL,
  page_id      text        NOT NULL,
  target_path  text        NOT NULL,
  kind         text        NOT NULL,
  body         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'open',
  curator_id   text,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authz_feedback_user_nonblank   CHECK (length(btrim(user_id)) > 0),
  CONSTRAINT authz_feedback_page_nonblank   CHECK (length(btrim(page_id)) > 0),
  CONSTRAINT authz_feedback_target_shape    CHECK (target_path ~ '^(page|column:.+|filter:.+)$'),
  CONSTRAINT authz_feedback_kind_enum       CHECK (kind   IN ('data_wrong','feature_request','confusing','other')),
  CONSTRAINT authz_feedback_status_enum     CHECK (status IN ('open','triaged','resolved','dismissed')),
  CONSTRAINT authz_feedback_body_len        CHECK (length(btrim(body)) BETWEEN 1 AND 4000)
);

-- Curator inbox query: WHERE status = 'open' [AND page_id = ?]
CREATE INDEX authz_feedback_status_page_idx
  ON authz_feedback (status, page_id);

-- User self-list: WHERE user_id = ? [AND page_id = ?] ORDER BY created_at DESC
CREATE INDEX authz_feedback_user_page_created_idx
  ON authz_feedback (user_id, page_id, created_at DESC);

COMMENT ON TABLE authz_feedback IS
  'Tier A primitive #3: per-user feedback on Tier B pages (data_wrong/feature_request/confusing/other). Append-only for users; Curator triages via PATCH status.';

COMMENT ON COLUMN authz_feedback.target_path IS
  'Three forms: ''page'' (whole page) | ''column:<col>'' (column-level, v2) | ''filter:<field>'' (filter-level, v2).';

COMMENT ON COLUMN authz_feedback.resolved_at IS
  'First-triage timestamp. Set when status first moves out of ''open''. Not cleared on subsequent transitions (preserves history).';

COMMIT;

-- ── Post-migration verification (run manually) ──
-- SELECT conname FROM pg_constraint WHERE conrelid = 'authz_feedback'::regclass AND contype = 'c';
--   Expected: 6 CHECK rows (user_nonblank, page_nonblank, target_shape, kind_enum, status_enum, body_len)
--
-- SELECT indexname FROM pg_indexes WHERE tablename = 'authz_feedback';
--   Expected: authz_feedback_pkey, authz_feedback_status_page_idx, authz_feedback_user_page_created_idx
