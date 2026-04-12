-- ============================================================
-- V011: Audit Batch Insert Function
-- ============================================================

CREATE OR REPLACE FUNCTION authz_audit_batch_insert(
    p_events JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    INSERT INTO authz_audit_log (timestamp, access_path, subject_id, action_id, resource_id, decision, policy_ids, context)
    SELECT
        (e->>'timestamp')::timestamptz,
        (e->>'access_path')::char(1),
        e->>'subject_id',
        e->>'action_id',
        e->>'resource_id',
        (e->>'decision')::authz_effect,
        ARRAY(SELECT jsonb_array_elements_text(e->'policy_ids'))::bigint[],
        e->'context'
    FROM jsonb_array_elements(p_events) AS e;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
