-- ============================================================
-- V047: Fix row_filter templates to use ${subject.x} placeholders
--
-- V046 seeded row_filter rules using current_setting('app.tenant_id', true)::TEXT
-- which only works inside Path C (per-user PG sessions where SET LOCAL is run).
-- Path B uses a shared connection pool; current_setting() returns NULL, so the
-- predicate becomes "<column> = NULL" and excludes ALL rows — quiet data loss.
--
-- The rls.ts rewriter resolves ${subject.<attr>} from UserContext at app layer
-- before the SQL hits Postgres. That works for both Path B and Path C.
--
-- Behavior change: filters now resolve from the user object the API constructed
-- (X-User-Id headers + LDAP attributes), not from session GUC. Same value, but
-- evaluated in the right place.
-- ============================================================

BEGIN;

UPDATE authz_discovery_rule
   SET suggested_filter_template = '{column} = ${subject.tenant_id}'
 WHERE rule_type = 'row_filter'
   AND match_pattern = '(?i)^tenant_id$';

UPDATE authz_discovery_rule
   SET suggested_filter_template = '{column} IN ${subject.org_ids}'
 WHERE rule_type = 'row_filter'
   AND match_pattern = '(?i)^(org_id|organization_id)$';

UPDATE authz_discovery_rule
   SET suggested_filter_template = '{column} = ${subject.user_id}'
 WHERE rule_type = 'row_filter'
   AND match_pattern = '(?i)^(owner_id|created_by|user_id)$';

-- Also fix any already-suggested policies that picked up the broken template.
-- Only safe to rewrite while still pending_review; admin-approved rows are theirs.
UPDATE authz_policy
   SET rls_expression = REPLACE(
         REPLACE(
           REPLACE(rls_expression,
             'current_setting(''app.tenant_id'', true)::TEXT', '${subject.tenant_id}'),
           'ANY(string_to_array(current_setting(''app.org_ids'', true), '',''))',
           'IN ${subject.org_ids}'),
         'current_setting(''app.user_id'', true)::TEXT', '${subject.user_id}')
 WHERE status = 'pending_review'
   AND suggested_by_rule IS NOT NULL
   AND rls_expression LIKE '%current_setting%';

COMMIT;
