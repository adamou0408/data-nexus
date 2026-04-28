-- ============================================================
-- V075: workflow primitive (request + approval record)
--
-- Builds the runtime for authz_composite_action (V003).
-- composite_action defines the spec (target_action, target_resource,
-- approval_chain JSONB, timeout_hours). Until now the chain ran
-- nowhere — wishlist W-MGR-03 ("composite_action is an empty shell").
-- This migration adds the two tables that turn it into a real
-- request/approve/reject loop:
--
--   authz_workflow_request          — one row per submitted request
--   authz_workflow_approval_record  — one row per chain step result
--
-- First consumer: NPI gate sign-off (V076). Each
-- "advance from NPI_Gx → NPI_G(x+1)" is a composite_action; the
-- requester files an authz_workflow_request, each approver in the
-- chain leaves an authz_workflow_approval_record, and on the final
-- approve the lifecycle_instance.current_state is updated.
--
-- Hot-path note: workflow tables are NOT read by authz_check.
-- authz_check still asks "can role R do action A on resource X?".
-- Workflow gating sits on top: the API only ACCEPTS the request
-- if authz_check(requester, target_action, target_resource) passes,
-- and on the final approve the lifecycle_instance is moved.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) Workflow request — one row per submission
-- ------------------------------------------------------------
CREATE TABLE authz_workflow_request (
    request_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    composite_action_id BIGINT NOT NULL REFERENCES authz_composite_action(id),
    -- subject_id is the entity the request acts on (e.g. material
    -- number for an NPI gate advance). Mirrors lifecycle_instance.subject_id
    -- shape so the workflow can drive a lifecycle transition on approve.
    subject_id          TEXT NOT NULL,
    requested_by        TEXT NOT NULL,
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_reason      TEXT,
    request_payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
    -- expires_at = requested_at + composite_action.timeout_hours.
    -- Stored explicitly so an expiry sweep doesn't need to join.
    expires_at          TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    resolution_reason   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE authz_workflow_request IS
    'Runtime row per submitted composite_action request. status=pending until every approval_chain step has an approve record (or any step rejects). NOT read by authz_check.';

-- Hot path: "show me all pending requests for a given composite_action"
-- (workflow inbox). Partial because most rows are eventually resolved.
CREATE INDEX idx_workflow_request_pending
    ON authz_workflow_request (composite_action_id, requested_at DESC)
 WHERE status = 'pending';

CREATE INDEX idx_workflow_request_subject
    ON authz_workflow_request (subject_id, status);

-- ------------------------------------------------------------
-- 2) Approval record — one row per chain step result
-- ------------------------------------------------------------
CREATE TABLE authz_workflow_approval_record (
    record_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id           UUID NOT NULL REFERENCES authz_workflow_request(request_id) ON DELETE CASCADE,
    chain_step           INTEGER NOT NULL,             -- 0-based index into composite_action.approval_chain
    expected_role        TEXT NOT NULL,                -- snapshot of approval_chain[step].role
    actor                TEXT NOT NULL,
    decision             TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
    decided_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    note                 TEXT,
    -- dogfood_self_chained: TRUE when the actor's user matches the
    -- requester (single-person dogfood loop, NPI Adam-multi-role).
    -- Lets reviewers filter audit reports for "real" multi-actor
    -- approvals vs. dogfood self-loops.
    dogfood_self_chained BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (request_id, chain_step)
);

COMMENT ON TABLE authz_workflow_approval_record IS
    'One row per chain step decision. dogfood_self_chained=TRUE marks single-person dogfood loops (e.g. NPI Adam-multi-role); production audits can filter these out.';

CREATE INDEX idx_workflow_approval_record_actor
    ON authz_workflow_approval_record (actor, decided_at DESC);

COMMIT;
