-- V051: Clarify built-in action display_name + description
--
-- Goal: rewrite the 9 seeded action descriptions to be
--   1. neutral — drop Phison-specific jargon (NPI / wafer lot) so the same
--      action can be reused for orders, jobs, deploys, etc.
--   2. clear — explicitly state what the action covers and what it does NOT
--   3. scoped — include parenthetical examples so an admin reading the row
--      can immediately tell whether their use case fits.
--
-- Idempotent: safe to re-run. Only updates rows that exist; no schema change.

BEGIN;

UPDATE authz_action SET
    display_name = 'Read',
    description  = 'Read data or open a page / API response — no state change.'
WHERE action_id = 'read';

UPDATE authz_action SET
    display_name = 'Write',
    description  = 'Create new records or modify existing data (INSERT / UPDATE; covers form save and bulk edit).'
WHERE action_id = 'write';

UPDATE authz_action SET
    display_name = 'Delete',
    description  = 'Remove a row or deactivate a resource (soft-delete via is_active=FALSE, or hard DELETE).'
WHERE action_id = 'delete';

UPDATE authz_action SET
    display_name = 'Approve',
    description  = 'Sign off on a workflow step or gate (submissions, hold release, deployment, change request).'
WHERE action_id = 'approve';

UPDATE authz_action SET
    display_name = 'Export',
    description  = 'Move data outside the system (download CSV / Excel / PDF, or push to an external API / file share).'
WHERE action_id = 'export';

UPDATE authz_action SET
    display_name = 'Hold',
    description  = 'Pause or freeze an object so it cannot progress (workflow item, batch, order, deployment).'
WHERE action_id = 'hold';

UPDATE authz_action SET
    display_name = 'Release',
    description  = 'Resume a previously held object — the inverse of "hold".'
WHERE action_id = 'release';

UPDATE authz_action SET
    display_name = 'Execute',
    description  = 'Run a callable on demand (DB function / stored proc, scheduled job, AI tool, scripted action).'
WHERE action_id = 'execute';

UPDATE authz_action SET
    display_name = 'Connect',
    description  = 'Open a session against an external system (Path C direct DB connection, third-party handshake).'
WHERE action_id = 'connect';

COMMIT;
