-- ============================================================
-- V006: Policy Version History + Auto-versioning Trigger
-- ============================================================

CREATE TABLE authz_policy_version (
    version_id      BIGSERIAL PRIMARY KEY,
    policy_id       BIGINT NOT NULL REFERENCES authz_policy(policy_id),
    version_number  INTEGER NOT NULL,
    snapshot        JSONB NOT NULL,
    changed_by      TEXT NOT NULL,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    change_reason   TEXT,
    UNIQUE (policy_id, version_number)
);

-- Trigger: auto-save version on every policy update
CREATE OR REPLACE FUNCTION authz_policy_version_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO authz_policy_version (policy_id, version_number, snapshot, changed_by)
    VALUES (
        OLD.policy_id,
        COALESCE((SELECT MAX(version_number) FROM authz_policy_version WHERE policy_id = OLD.policy_id), 0) + 1,
        to_jsonb(OLD),
        COALESCE(current_setting('app.current_user', true), 'system')
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_versioning
    BEFORE UPDATE ON authz_policy
    FOR EACH ROW EXECUTE FUNCTION authz_policy_version_trigger();

-- Rollback function
CREATE OR REPLACE FUNCTION authz_policy_rollback(
    p_policy_id BIGINT,
    p_version   INTEGER
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_snapshot JSONB;
BEGIN
    SELECT snapshot INTO v_snapshot
    FROM authz_policy_version
    WHERE policy_id = p_policy_id AND version_number = p_version;

    IF v_snapshot IS NULL THEN
        RAISE EXCEPTION 'Version % not found for policy %', p_version, p_policy_id;
    END IF;

    UPDATE authz_policy SET
        policy_name = v_snapshot->>'policy_name',
        description = v_snapshot->>'description',
        subject_condition = (v_snapshot->'subject_condition'),
        resource_condition = (v_snapshot->'resource_condition'),
        action_condition = (v_snapshot->'action_condition'),
        environment_condition = (v_snapshot->'environment_condition'),
        rls_expression = v_snapshot->>'rls_expression',
        column_mask_rules = v_snapshot->'column_mask_rules',
        priority = (v_snapshot->>'priority')::integer,
        effect = (v_snapshot->>'effect')::authz_effect,
        status = 'active',
        updated_at = now()
    WHERE policy_id = p_policy_id;
END;
$$;
