import { keycloak, ssoEnabled, ensureFreshToken } from './lib/keycloak';

const BASE = '/api';

// Current user context for authenticated API calls (X-User-Id fallback path).
// Persisted to localStorage so:
//   (a) browser refresh keeps the picker selection, and
//   (b) Vite HMR module replacement (which discards module-scoped state)
//       can rehydrate without forcing the user to re-pick.
const AUTH_STORAGE_KEY = 'nx_auth_v1';

let _currentUserId = '';
let _currentGroups: string[] = [];

function readPersistedAuth(): { id: string; groups: string[] } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { id?: unknown; groups?: unknown };
    const id = typeof p?.id === 'string' ? p.id : '';
    const groups = Array.isArray(p?.groups) ? (p.groups as unknown[]).filter((g): g is string => typeof g === 'string') : [];
    return id ? { id, groups } : null;
  } catch {
    return null;
  }
}

// Hydrate on module load. Runs again whenever Vite HMR replaces this module.
{
  const persisted = readPersistedAuth();
  if (persisted) {
    _currentUserId = persisted.id;
    _currentGroups = persisted.groups;
  }
}

/** Read the persisted user id without subscribing — used by AuthzContext to
 *  rehydrate React state after a refresh. Returns null if nothing persisted. */
export function getPersistedUserId(): string | null {
  return readPersistedAuth()?.id ?? null;
}

export function setApiUser(userId: string, groups: string[]) {
  _currentUserId = userId;
  _currentGroups = groups;
  if (typeof window === 'undefined') return;
  try {
    if (userId) {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ id: userId, groups }));
    } else {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  } catch {
    // localStorage can throw on quota / privacy mode — best-effort only.
  }
}

/** Strip leading -- and /* ... *\/ comments so server-side CREATE FUNCTION regex matches. */
function stripLeadingSqlComments(sql: string): string {
  let out = sql;
  while (true) {
    const t = out.replace(/^\s+/, '');
    if (t.startsWith('--')) { const nl = t.indexOf('\n'); out = nl === -1 ? '' : t.slice(nl + 1); continue; }
    if (t.startsWith('/*')) { const end = t.indexOf('*/'); out = end === -1 ? '' : t.slice(end + 2); continue; }
    return t;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  // Bearer-first when Keycloak SSO is active; X-User-Id remains the dev fallback
  // (see services/authz-api/src/middleware/jwt.ts — backend accepts both).
  if (ssoEnabled && keycloak?.authenticated) {
    const token = await ensureFreshToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else if (_currentUserId) {
    headers['X-User-Id'] = _currentUserId;
    headers['X-User-Groups'] = _currentGroups.join(',');
  }
  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Surface server `detail` field — many routes (dag/execute-node, sink, etc) put the
    // underlying PG / connection error there. Keeping it out of the toast forced curators
    // to open DevTools to diagnose run-all failures (see Q2 redesign 2026-04-29).
    const head = body.error || `API error: ${res.status}`;
    throw new Error(body.detail ? `${head}: ${body.detail}` : head);
  }
  return res.json();
}

export const api = {
  resolve: (user_id: string, groups: string[], attributes: Record<string, string>, detailed = false) =>
    request('/resolve', { method: 'POST', body: JSON.stringify({ user_id, groups, attributes, _detailed: detailed }) }),

  check: (user_id: string, groups: string[], action: string, resource: string) =>
    request<{ allowed: boolean }>('/check', { method: 'POST', body: JSON.stringify({ user_id, groups, action, resource }) }),

  checkBatch: (user_id: string, groups: string[], checks: { action: string; resource: string }[]) =>
    request<{ action: string; resource: string; allowed: boolean }[]>('/check/batch', {
      method: 'POST', body: JSON.stringify({ user_id, groups, checks }),
    }),

  filter: (user_id: string, groups: string[], attributes: Record<string, string>, resource_type: string, path?: string) =>
    request<{ filter_clause: string }>('/filter', {
      method: 'POST', body: JSON.stringify({ user_id, groups, attributes, resource_type, path }),
    }),

  rlsSimulate: (user_id: string, groups: string[], attributes: Record<string, string>, table?: string, path?: string) =>
    request<{ table: string; filter_clause: string; filtered_rows: Record<string, unknown>[]; filtered_count: number; total_count: number }>(
      '/rls/simulate', { method: 'POST', body: JSON.stringify({ user_id, groups, attributes, table, path }) }
    ),

  rlsData: () => request<Record<string, unknown>[]>('/rls/data'),

  // Config-Driven UI engine
  configExecRoot: () =>
    request<{ config: Record<string, unknown> }>('/config-exec/root', { method: 'POST', body: '{}' }),

  // Note: `params` is unknown-typed because published_dag form values may be
  // arrays (text[]), numbers, booleans — not just drill-down strings. The
  // server discriminates: drill-down pages coerce to string filters, published
  // pages route values directly into PG fn bound_params.
  configExecPage: (pageId: string, params?: Record<string, unknown>) =>
    request<{
      config: Record<string, unknown>;
      data: Record<string, unknown>[];
      meta: {
        // standard data-table page meta
        filteredCount?: number;
        totalCount?: number;
        columnMasks?: Record<string, string>;
        resolvedRoles?: string[];
        filterClause?: string;
        // DAG-PUBLISH-V01 published-dag meta (form_load + exec stages)
        published_dag?: boolean;
        stage?: 'form_load' | 'exec';
        form_schema?: Array<{
          name: string; type: string; pg_type?: string;
          required: boolean; default: unknown;
          help_text?: string; source_node_id: string;
        }>;
        output_node_id?: string;
        row_count?: number;
        truncated?: boolean;
        elapsed_ms?: number;
        lineage?: Array<{ node_id: string; detail: string }>;
      };
    }>('/config-exec', {
      method: 'POST',
      body: JSON.stringify({ page_id: pageId, params }),
    }),

  matrix: (action?: string) => request<{
    permissions: { role_id: string; action_id: string; resource_id: string; effect: string }[];
    roles: { role_id: string; display_name: string }[];
    resources: { resource_id: string; display_name: string; resource_type: string }[];
    actions: { action_id: string; display_name: string }[];
  }>(`/matrix${action ? `?action=${action}` : ''}`),

  subjectProfiles: () => request<UserProfile[]>('/browse/subjects/profiles'),
  batchChecks: () => request<{ action: string; resource: string }[]>('/browse/batch-checks'),
  subjects: () => request<Record<string, unknown>[]>('/browse/subjects'),
  roles: () => request<Record<string, unknown>[]>('/browse/roles'),
  resources: () => request<Record<string, unknown>[]>('/browse/resources'),
  policies: () => request<Record<string, unknown>[]>('/browse/policies'),
  actions: () => request<Record<string, unknown>[]>('/browse/actions'),
  actionItems: (userId?: string, isAdmin?: boolean) => {
    const qs = new URLSearchParams();
    if (userId) qs.set('user_id', userId);
    if (isAdmin) qs.set('is_admin', 'true');
    return request<ActionItem[]>(`/browse/action-items?${qs}`);
  },
  // --- Entity CRUD ---
  // Subjects
  subjectCreate: (data: { subject_id: string; subject_type: string; display_name: string; ldap_dn?: string; attributes?: Record<string, string> }) =>
    request<Record<string, unknown>>('/browse/subjects', { method: 'POST', body: JSON.stringify(data) }),
  subjectUpdate: (id: string, data: { display_name?: string; ldap_dn?: string; attributes?: Record<string, string>; is_active?: boolean }) =>
    request<Record<string, unknown>>(`/browse/subjects/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  subjectDelete: (id: string) =>
    request(`/browse/subjects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  subjectAddGroup: (subjectId: string, groupId: string) =>
    request(`/browse/subjects/${encodeURIComponent(subjectId)}/groups`, { method: 'POST', body: JSON.stringify({ group_id: groupId }) }),
  subjectRemoveGroup: (subjectId: string, groupId: string) =>
    request(`/browse/subjects/${encodeURIComponent(subjectId)}/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' }),
  subjectAddRole: (subjectId: string, data: { role_id: string; valid_from?: string; valid_until?: string; granted_by?: string }) =>
    request(`/browse/subjects/${encodeURIComponent(subjectId)}/roles`, { method: 'POST', body: JSON.stringify(data) }),
  subjectRemoveRole: (subjectId: string, roleId: string) =>
    request(`/browse/subjects/${encodeURIComponent(subjectId)}/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' }),

  // Roles
  roleCreate: (data: { role_id: string; display_name: string; description?: string; is_system?: boolean }) =>
    request<Record<string, unknown>>('/browse/roles', { method: 'POST', body: JSON.stringify(data) }),
  roleUpdate: (id: string, data: { display_name?: string; description?: string; is_active?: boolean }) =>
    request<Record<string, unknown>>(`/browse/roles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  roleDelete: (id: string) =>
    request(`/browse/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  rolePermissions: (id: string) =>
    request<Record<string, unknown>[]>(`/browse/roles/${encodeURIComponent(id)}/permissions`),
  roleAddPermission: (roleId: string, data: { action_id: string; resource_id: string; effect?: string }) =>
    request(`/browse/roles/${encodeURIComponent(roleId)}/permissions`, { method: 'POST', body: JSON.stringify(data) }),
  roleRemovePermission: (roleId: string, permId: number) =>
    request(`/browse/roles/${encodeURIComponent(roleId)}/permissions/${permId}`, { method: 'DELETE' }),

  // Resources
  resourceCreate: (data: { resource_id: string; resource_type: string; display_name: string; parent_id?: string; attributes?: Record<string, unknown> }) =>
    request<Record<string, unknown>>('/browse/resources', { method: 'POST', body: JSON.stringify(data) }),
  resourceUpdate: (id: string, data: { display_name?: string; parent_id?: string; attributes?: Record<string, unknown>; is_active?: boolean }) =>
    request<Record<string, unknown>>(`/browse/resources/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  resourceDelete: (id: string) =>
    request(`/browse/resources/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Policies
  policyCreate: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/browse/policies', { method: 'POST', body: JSON.stringify(data) }),
  policyUpdate: (id: number, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/browse/policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  policyDelete: (id: number) =>
    request(`/browse/policies/${id}`, { method: 'DELETE' }),

  // Actions
  actionCreate: (data: { action_id: string; display_name: string; description?: string; applicable_paths?: string[] }) =>
    request<Record<string, unknown>>('/browse/actions', { method: 'POST', body: JSON.stringify(data) }),
  actionUpdate: (id: string, data: { display_name?: string; description?: string; applicable_paths?: string[]; is_active?: boolean }) =>
    request<Record<string, unknown>>(`/browse/actions/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  actionDelete: (id: string) =>
    request(`/browse/actions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  auditLogs: (params?: { subject?: string; action?: string; path?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.subject) qs.set('subject', params.subject);
    if (params?.action) qs.set('action', params.action);
    if (params?.path) qs.set('path', params.path);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    return request<Record<string, unknown>[]>(`/browse/audit-logs?${qs}`);
  },

  // Admin audit logs
  adminAuditLogs: (params?: { user?: string; action?: string; resource_type?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.user) qs.set('user', params.user);
    if (params?.action) qs.set('action', params.action);
    if (params?.resource_type) qs.set('resource_type', params.resource_type);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    return request<Record<string, unknown>[]>(`/browse/admin-audit?${qs}`);
  },

  // Policy assignments
  policyAssignments: (policyId: number) =>
    request<Record<string, unknown>[]>(`/browse/policies/${policyId}/assignments`),
  policyAssignmentCreate: (policyId: number, data: { assignment_type: string; assignment_value: string; is_exception?: boolean }) =>
    request<Record<string, unknown>>(`/browse/policies/${policyId}/assignments`, { method: 'POST', body: JSON.stringify(data) }),
  policyAssignmentDelete: (assignmentId: number) =>
    request(`/browse/policy-assignments/${assignmentId}`, { method: 'DELETE' }),

  // Role clearance
  roleClearanceUpdate: (roleId: string, data: { security_clearance?: string; job_level?: number }) =>
    request<Record<string, unknown>>(`/browse/roles/${encodeURIComponent(roleId)}/clearance`, { method: 'PUT', body: JSON.stringify(data) }),

  // Data classification
  classifications: () =>
    request<Record<string, unknown>[]>('/browse/classifications'),
  resourceClassify: (resourceId: string, classificationId: number | null) =>
    request<Record<string, unknown>>(`/browse/resources/${encodeURIComponent(resourceId)}/classify`, { method: 'PUT', body: JSON.stringify({ classification_id: classificationId }) }),
  columnsClassified: (tableResourceId: string) =>
    request<Record<string, unknown>[]>(`/browse/resources/${encodeURIComponent(tableResourceId)}/columns-classified`),

  // Path B: Web ACL
  resolveWebAcl: (user_id: string, groups: string[]) =>
    request('/resolve/web-acl', { method: 'POST', body: JSON.stringify({ user_id, groups }) }),

  // Path C: Pool management
  poolProfiles: () => request<PoolProfile[]>('/pool/profiles'),
  poolProfile: (id: string) => request<PoolProfile>(`/pool/profiles/${encodeURIComponent(id)}`),
  poolProfileCreate: (data: Partial<PoolProfile>) =>
    request<PoolProfile>('/pool/profiles', { method: 'POST', body: JSON.stringify(data) }),
  poolProfileUpdate: (id: string, data: Partial<PoolProfile>) =>
    request<PoolProfile>(`/pool/profiles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  poolProfileDelete: (id: string) =>
    request(`/pool/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  poolAssignments: (profileId: string) =>
    request<PoolAssignment[]>(`/pool/profiles/${encodeURIComponent(profileId)}/assignments`),
  poolAssignmentCreate: (data: { subject_id: string; profile_id: string }) =>
    request<PoolAssignment>('/pool/assignments', { method: 'POST', body: JSON.stringify(data) }),
  poolAssignmentDelete: (id: number) =>
    request(`/pool/assignments/${id}`, { method: 'DELETE' }),
  poolCredentials: () => request<PoolCredential[]>('/pool/credentials'),
  tables: (userId?: string, groups?: string[]) => {
    const qs = new URLSearchParams();
    if (userId) qs.set('user_id', userId);
    if (groups?.length) qs.set('groups', groups.join(','));
    return request<{ table_name: string; table_type?: string; column_count: string }[]>(`/browse/tables?${qs}`);
  },
  tableSchema: (table: string) =>
    request<{ table: string; columns: TableColumn[]; sample_data: Record<string, unknown>[] }>(
      `/browse/tables/${encodeURIComponent(table)}`
    ),
  functions: () => request<SqlFunction[]>('/browse/functions'),
  dataExplorer: (user_id: string, groups: string[], attributes: Record<string, string>, table: string) =>
    request<DataExplorerResult>('/browse/data-explorer', {
      method: 'POST', body: JSON.stringify({ user_id, groups, attributes, table }),
    }),
  // Data Source Registry
  datasources: () => request<DataSource[]>('/datasources'),
  // Lightweight catalog list — non-admin friendly (Flow Composer, Data Query)
  datasourcesLite: () => request<{ source_id: string; display_name: string; db_type: string }[]>('/datasources/list'),
  datasource: (id: string) => request<DataSource>(`/datasources/${encodeURIComponent(id)}`),
  datasourceCreate: (data: Partial<DataSource> & { connector_password?: string }) =>
    request<DataSource>('/datasources', { method: 'POST', body: JSON.stringify(data) }),
  datasourceUpdate: (id: string, data: Partial<DataSource>) =>
    request<DataSource>(`/datasources/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  datasourceDelete: (id: string) =>
    request(`/datasources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  datasourcePurge: (id: string) =>
    request<{ purged: string; descriptors_deleted: number; pages_deleted: number; permissions_deleted: number; composite_actions_deleted: number; columns_deleted: number; tables_deleted: number; credentials_deleted: number; profiles_deleted: number; sync_logs_deleted: number }>(
      `/datasources/${encodeURIComponent(id)}/purge`, { method: 'DELETE' }),
  datasourceTest: (id: string) =>
    request<{ status: string; version?: string; error?: string; pg_replica?: string; oracle?: string; details?: Record<string, any> }>(
      `/datasources/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  datasourceDiscover: (id: string) =>
    request<{ source_id: string; tables_found: number; views_found: number; functions_found: number; columns_found: number; resources_created: number; created: string[] }>(
      `/datasources/${encodeURIComponent(id)}/discover`, { method: 'POST' }),
  datasourceSchemas: (id: string) =>
    request<string[]>(`/datasources/${encodeURIComponent(id)}/schemas`),
  datasourceTables: (id: string) =>
    request<{ source_id: string; database: string; tables: { table_schema: string; table_name: string; table_type: string; column_count: string }[] }>(
      `/datasources/${encodeURIComponent(id)}/tables`),

  datasourceLifecycle: (id: string) =>
    request<LifecycleResponse>(`/datasources/${encodeURIComponent(id)}/lifecycle`),
  datasourceLifecycleSummary: () =>
    request<LifecycleSummary[]>('/datasources/lifecycle-summary'),

  // Resource mapping helpers
  resourcesUnmapped: (dataSourceId: string) =>
    request<{ resource_id: string; resource_type: string; parent_id: string | null; display_name: string; attributes: Record<string, unknown> }[]>(
      `/browse/resources/unmapped?data_source_id=${encodeURIComponent(dataSourceId)}`),
  resourcesMapped: (dataSourceId: string) =>
    request<{ resource_id: string; resource_type: string; parent_id: string | null; display_name: string; attributes: Record<string, unknown>; module_name: string | null }[]>(
      `/browse/resources/mapped?data_source_id=${encodeURIComponent(dataSourceId)}`),
  resourcesBulkParent: (mappings: { resource_id: string; parent_id: string | null }[]) =>
    request<{ updated: number }>('/browse/resources/bulk-parent', { method: 'PUT', body: JSON.stringify({ mappings }) }),
  resourceModules: () =>
    request<{ resource_id: string; display_name: string; parent_id: string | null }[]>('/browse/resources?type=module'),
  resourcesFunctions: (dataSourceId: string) =>
    request<{ resource_id: string; display_name: string; attributes: Record<string, unknown> }[]>(
      `/browse/resources/functions?data_source_id=${encodeURIComponent(dataSourceId)}`),

  // Oracle function call proxy
  oracleExec: (data_source_id: string, function_name: string, params?: Record<string, any>) =>
    request<{ status: string; function_name: string; result: any }>('/oracle-exec', {
      method: 'POST', body: JSON.stringify({ data_source_id, function_name, params }),
    }),

  // Generic PG/Greenplum data-query (Path B — whitelisted via authz_resource)
  dataQueryFunctions: (data_source_id: string) =>
    request<{
      resource_id: string;
      schema: string;
      function_name: string;
      display_name: string;
      arguments: string;
      parsed_args: { name: string; pgType: string; hasDefault: boolean; semantic_type?: string; kind?: string }[];
      return_type: string;
      return_shape?: any;
      volatility: string;
      subtype?: 'query' | 'calculation' | 'action' | 'report';
      idempotent?: boolean;
      side_effects?: boolean;
    }[]>(`/data-query/functions?data_source_id=${encodeURIComponent(data_source_id)}`),

  dataQueryCompatible: (data_source_id: string, available_semantic_types: string[]) =>
    request<{
      compatible: Array<{
        resource_id: string; display_name: string; subtype: string;
        required_inputs: { name: string; semantic_type?: string }[];
        optional_inputs: { name: string; semantic_type?: string }[];
        outputs: { name: string; semantic_type?: string }[];
        covered_inputs: string[]; missing_inputs: string[];
      }>;
      partial: any[];
      total_scanned: number;
    }>('/data-query/functions/compatible', {
      method: 'POST',
      body: JSON.stringify({ data_source_id, available_semantic_types }),
    }),

  dataQueryExec: (data_source_id: string, resource_id: string, params: Record<string, unknown>) =>
    request<{
      status: string;
      resource_id: string;
      columns: { name: string; dataTypeID: number }[];
      rows: Record<string, unknown>[];
      row_count: number;
      truncated: boolean;
      max_rows: number;
      elapsed_ms: number;
    }>('/data-query/functions/exec', {
      method: 'POST',
      body: JSON.stringify({ data_source_id, resource_id, params }),
    }),

  dataQueryTables: (data_source_id: string) =>
    request<{
      resource_id: string;
      resource_type: 'table' | 'view';
      table_schema: string;
      table_name: string;
      display_name: string;
      table_comment: string | null;
      outputs: { name: string; pgType: string; kind?: string }[];
      output_count: number;
    }[]>(`/data-query/tables?data_source_id=${encodeURIComponent(data_source_id)}`),

  dataQueryValidate: (data_source_id: string, sql: string) =>
    request<{
      status: string;
      schema: string;
      function_name: string;
      arguments: string;
      return_type: string;
      volatility: string;
      parsed_args: { name: string; pgType: string; hasDefault: boolean; kind?: string }[];
      return_shape: any;
      subtype: string;
    }>('/data-query/functions/validate', {
      method: 'POST',
      body: JSON.stringify({ data_source_id, sql: stripLeadingSqlComments(sql) }),
    }),

  /** FN-QUALITY-LINT-V02: per-fn quality summary for the deployed catalog.
   *  Returns { [resource_id]: {warn_count, info_count, codes, issues} }. List
   *  rows render dots from the counts; fn detail panel renders full issues[]. */
  dataQueryLintAll: (data_source_id: string) =>
    request<{
      functions: Record<string, {
        warn_count: number;
        info_count: number;
        codes: string[];
        issues: Array<{
          severity: 'warn' | 'info';
          code: 'FQL-01' | 'FQL-02' | 'FQL-03' | 'FQL-04';
          message: string;
          hint: string;
          context?: string;
        }>;
      }>;
    }>(`/data-query/functions/lint-all?data_source_id=${encodeURIComponent(data_source_id)}`),

  /** FN-QUALITY-LINT-V01: pure-text advisory on house conventions
   *  (volatility, SELECT *, p_ prefix, naming). Non-blocking. */
  dataQueryLint: (sql: string) =>
    request<{
      status: string;
      schema: string;
      function_name: string;
      volatility: string;
      issues: Array<{
        severity: 'warn' | 'info';
        code: 'FQL-01' | 'FQL-02' | 'FQL-03' | 'FQL-04';
        message: string;
        hint: string;
        context?: string;
      }>;
    }>('/data-query/functions/lint', {
      method: 'POST',
      body: JSON.stringify({ sql: stripLeadingSqlComments(sql) }),
    }),

  dataQueryDeploy: (data_source_id: string, sql: string) =>
    request<{
      status: string;
      resource_id: string;
      schema: string;
      function_name: string;
      display_name: string;
      arguments: string;
      return_type: string;
      volatility: string;
      subtype: string;
      parsed_args: { name: string; pgType: string; hasDefault: boolean; kind?: string }[];
      return_shape: any;
    }>('/data-query/functions/deploy', {
      method: 'POST',
      body: JSON.stringify({ data_source_id, sql: stripLeadingSqlComments(sql) }),
    }),

  // ── DAG (Flow Composer) ──
  dagList: (data_source_id?: string) =>
    request<{ resource_id: string; display_name: string; data_source_id: string; node_count: number; edge_count: number; updated_at: string; created_at: string }[]>(
      data_source_id ? `/dag?data_source_id=${encodeURIComponent(data_source_id)}` : '/dag'
    ),

  dagGet: (resource_id: string) =>
    request<{
      resource_id: string; display_name: string; data_source_id: string;
      description?: string; nodes: any[]; edges: any[]; version: number;
    }>(`/dag/${encodeURIComponent(resource_id)}`),

  dagSave: (payload: {
    resource_id?: string; display_name: string; data_source_id: string;
    description?: string; nodes: any[]; edges: any[];
    /** DAG-AUTOCAST-V01: ask the server to insert visible cast nodes for
     *  whitelist-safe DV-01 mismatches. Curator sees the inserts in the
     *  response and on the canvas. */
    auto_cast?: boolean;
  }) =>
    request<{
      status: string; resource_id: string; display_name: string;
      nodes: any[]; edges: any[];
      auto_inserted_casts?: Array<{
        edge_id: string;
        source_node: string; source_handle: string;
        target_node: string; target_handle: string;
        from_pgtype: string; to_pgtype: string;
        inserted_node_id: string;
      }>;
    }>(
      '/dag/save', { method: 'POST', body: JSON.stringify(payload) }
    ),

  dagDelete: (resource_id: string) =>
    request<{ status: string; resource_id: string }>(
      `/dag/${encodeURIComponent(resource_id)}`, { method: 'DELETE' }
    ),

  dagValidate: (doc: { nodes: any[]; edges: any[] }) =>
    request<{ ok: boolean; issues: Array<{ severity: 'error' | 'warn'; code: string; message: string; node_id?: string; edge_id?: string }> }>(
      '/dag/validate', { method: 'POST', body: JSON.stringify(doc) }
    ),

  dagExecuteNode: (payload: {
    data_source_id: string;
    node: any;
    upstream: Record<string, { columns: any[]; row0?: Record<string, unknown> }>;
    edges: any[];
  }) =>
    request<{
      status: string; node_id: string; resource_id: string;
      columns: Array<{ name: string; dataTypeID: number; semantic_type?: string }>;
      rows: Record<string, unknown>[]; row_count: number; truncated: boolean;
      elapsed_ms: number; lineage: Array<{ input: string; source: string }>;
    }>('/dag/execute-node', { method: 'POST', body: JSON.stringify(payload) }),

  dagSaveAsPage: (payload: {
    page_id: string;
    title: string;
    parent_page_id?: string;
    description?: string;
    dag_id: string;
    node_id: string;
    bound_params?: Record<string, unknown>;
    columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
    rows: Record<string, unknown>[];
    overwrite?: boolean;
  }) =>
    request<{ status: 'created' | 'overwritten'; page_id: string; row_count: number; column_count: number }>(
      '/dag/save-as-page', { method: 'POST', body: JSON.stringify(payload) }
    ),

  // DAG-SUBDAG-EMBED-V01 — list published_dags the caller can read,
  // optionally filtered to one data source (subdag requires same-ds parent/child).
  dagPublishedList: (data_source_id?: string) => {
    const qs = new URLSearchParams();
    if (data_source_id) qs.set('data_source_id', data_source_id);
    const tail = qs.toString() ? `?${qs.toString()}` : '';
    return request<{
      published_dags: Array<{
        rid: string;
        published_dag_id: string;
        title: string;
        data_source_id: string;
        output_node_id: string;
        exposed_node_ids: string[] | null;
      }>;
    }>(`/dag/published-list${tail}`);
  },

  // DAG-SUBDAG-EMBED-V01 — metadata the Composer needs to wire a subdag node.
  dagPublishedSnapshotMeta: (rid: string) =>
    request<{
      page_id: string;
      title: string;
      published_dag_id: string;
      data_source_id: string;
      output_node_id: string;
      exposed_node_ids: string[] | null;
      form_schema: Array<{ name: string; type: string; pg_type?: string; required: boolean; default: unknown; help_text?: string; source_node_id: string }>;
    }>(`/dag/published/${encodeURIComponent(rid)}/snapshot-meta`),

  // DAG-PUBLISH-V01 — publish a DAG as a live Tier B page.
  // Server registers `published_dag:<rid>` resource, snapshots the DAG-JSON,
  // derives the form schema from user_input_params, grants `read` on the
  // bless gate to the requested roles (default BI_USER).
  dagPublish: (resource_id: string, payload: {
    page_id: string;
    title: string;
    parent_page_id?: string;
    description?: string;
    overwrite?: boolean;
    grant_read_to_roles?: string[];
  }) =>
    request<{
      status: 'created' | 'overwritten';
      page_id: string;
      published_dag_id: string;
      published_dag_rid: string;
      output_node_id: string;
      form_schema: Array<{ name: string; type: string; pg_type?: string; required: boolean; default: unknown; help_text?: string; source_node_id: string }>;
      granted_read_to: string[];
    }>(
      `/dag/${encodeURIComponent(resource_id)}/publish`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),

  // sink-as-node-kind plan §3.3 — composer-native sink dispatch.
  dagExecuteSink: (payload: {
    dag_id: string;
    sink_node_id: string;
    sink_kind: 'page';
    sink_config: {
      page_id: string;
      title: string;
      parent_page_id?: string;
      description?: string;
      overwrite?: boolean;
    };
    bound_params?: Record<string, unknown>;
    columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
    rows: Record<string, unknown>[];
  }) =>
    request<{
      status: 'created' | 'overwritten'; sink_kind: string; artifact_id: string;
      page_id: string; row_count: number; column_count: number;
    }>(
      '/dag/execute-sink', { method: 'POST', body: JSON.stringify(payload) }
    ),

  discover: (params: { type?: 'table' | 'view' | 'function' | 'all'; unmapped_only?: boolean; q?: string; data_source_id?: string }) => {
    const qs = new URLSearchParams();
    if (params.type && params.type !== 'all') qs.set('type', params.type);
    if (params.unmapped_only) qs.set('unmapped_only', 'true');
    if (params.q) qs.set('q', params.q);
    if (params.data_source_id) qs.set('data_source_id', params.data_source_id);
    const query = qs.toString();
    return request<{
      total: number;
      truncated: boolean;
      rows: Array<{
        resource_id: string;
        resource_type: 'table' | 'view' | 'function';
        display_name: string;
        data_source_id: string | null;
        ds_display_name: string | null;
        ds_db_type: string | null;
        schema: string | null;
        mapped_to_module: { resource_id: string; display_name: string } | null;
        created_at: string;
      }>;
    }>(`/discover${query ? '?' + query : ''}`);
  },

  discoverStats: () =>
    request<{
      table: { total: number; mapped: number; unmapped: number };
      view: { total: number; mapped: number; unmapped: number };
      function: { total: number; mapped: number; unmapped: number };
      ds_count: number;
    }>('/discover/stats'),

  discoverPromote: (body:
    | { resource_id: string; module_display_name: string; parent_module_id?: string | null }
    | { resource_id: string; target_module_id: string }
  ) =>
    request<{
      mode: 'create' | 'attach';
      module_id: string;
      display_name: string;
      parent_module_id: string | null;
      promoted_resource_id: string;
    }>('/discover/promote', { method: 'POST', body: JSON.stringify(body) }),

  // BU-08 schema-driven UI: generate auto page from a table/view
  discoverGenerateApp: (body: {
    resource_id: string;
    source_id: string;
    schema: string;
    table_name: string;
    target_module_id?: string | null;
  }) =>
    request<{
      page_id: string;
      descriptor_id: string;
      module_id: string;
      reparented: boolean;
      preview_url: string;
      column_count: number;
      truncated: boolean;
    }>('/discover/generate-app', { method: 'POST', body: JSON.stringify(body) }),

  discoverReparent: (body: { resource_id: string; target_module_id: string | null }) =>
    request<{
      mode: 'detach' | 'move';
      resource_id: string;
      previous_module_id: string;
      previous_display_name: string;
      new_module_id: string | null;
      new_display_name: string | null;
    }>('/discover/reparent', { method: 'POST', body: JSON.stringify(body) }),

  discoverBulk: (body:
    | { mode: 'create_attach'; resource_ids: string[]; module_display_name: string; parent_module_id?: string | null }
    | { mode: 'attach'; resource_ids: string[]; target_module_id: string }
    | { mode: 'detach'; resource_ids: string[] }
  ) =>
    request<{
      mode: 'create_attach' | 'attach' | 'detach';
      applied_count: number;
      skipped_count: number;
      applied: string[];
      skipped: { resource_id: string; reason: string }[];
      module_id: string | null;
      module_display_name?: string | null;
      module_created: boolean;
    }>('/discover/bulk', { method: 'POST', body: JSON.stringify(body) }),

  // Bottom-up suggestion review
  discoverRunRules: (data_source_id?: string) =>
    request<{
      resources_scanned: number;
      rules_evaluated: number;
      policies_created: number;
      policies_skipped: number;
      classifications_tagged: number;
    }>('/discover/run-rules', {
      method: 'POST',
      body: JSON.stringify(data_source_id ? { data_source_id } : {}),
    }),

  discoverSuggestions: (params: { data_source_id?: string; rule_type?: 'column_mask' | 'row_filter' }) => {
    const q = new URLSearchParams();
    if (params.data_source_id) q.set('data_source_id', params.data_source_id);
    if (params.rule_type) q.set('rule_type', params.rule_type);
    const qs = q.toString();
    return request<Array<{
      policy_id: number;
      policy_name: string;
      description: string | null;
      column_mask_rules: Record<string, string> | null;
      rls_expression: string | null;
      suggested_by_rule: string;
      suggested_at: string | null;
      suggested_reason: string | null;
      status: string;
      resource_condition: { resource_ids?: string[] } | null;
      rule_type: 'column_mask' | 'row_filter' | 'classification';
      suggested_label: string | null;
      match_pattern: string | null;
      target_resource_id: string | null;
      target_display_name: string | null;
      target_resource_type: string | null;
      target_data_source_id: string | null;
      target_data_source_name: string | null;
    }>>(`/discover/suggestions${qs ? '?' + qs : ''}`);
  },

  discoverSuggestionAct: (
    policy_id: number,
    body: { action: 'approve' | 'reject'; subject_condition?: Record<string, unknown> },
  ) =>
    request<{ policy_id: number; policy_name: string; status: string }>(
      `/discover/suggestions/${policy_id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  poolUncredentialedRoles: () =>
    request<{ pg_role: string; profile_id: string; connection_mode: string; data_source_id: string | null }[]>('/pool/uncredentialed-roles'),

  poolSyncGrants: () => request<{ actions: { action: string; detail: string }[] }>('/pool/sync/grants', { method: 'POST' }),
  poolSyncPgbouncer: () => request<{ config: string }>('/pool/sync/pgbouncer', { method: 'POST' }),
  poolSyncPgbouncerApply: () => request<{ applied: boolean; config_path: string; reload: string }>('/pool/sync/pgbouncer/apply', { method: 'POST' }),

  poolPreviewModules: (modules: string[], data_source_id: string) =>
    request<{ modules: string[]; data_source_id: string; tables: string[]; count: number }>('/pool/profiles/preview-modules', {
      method: 'POST', body: JSON.stringify({ modules, data_source_id }),
    }),

  poolSyncExternalGrants: (data_source_id?: string) =>
    request<{ actions: SyncAction[] }>('/pool/sync/external-grants', {
      method: 'POST', body: JSON.stringify({ data_source_id }),
    }),
  poolSyncExternalDrift: (data_source_id: string) =>
    request<DriftReport>('/pool/sync/external-grants/drift', {
      method: 'POST', body: JSON.stringify({ data_source_id }),
    }),

  rolePoolMap: () => request<Record<string, string>>('/browse/role-pool-map'),
  poolMetabaseConnections: () => request<{
    metabase_url: string;
    pgbouncer: { host: string; port: number };
    connections: {
      profile_id: string; pg_role: string; description: string;
      data_source: string; database: string;
      metabase_config: { engine: string; host: string; port: number; dbname: string; user: string };
      access_scope: { allowed_tables: string[] | null; denied_columns: unknown; connection_mode: string };
    }[];
  }>('/pool/metabase-connections'),
  poolCredentialCreate: (pg_role: string, password: string, rotate_interval?: string) =>
    request<PoolCredential>('/pool/credentials', {
      method: 'POST',
      body: JSON.stringify({ pg_role, password, rotate_interval }),
    }),
  poolCredentialDelete: (pg_role: string) =>
    request<{ deactivated: string }>(`/pool/credentials/${encodeURIComponent(pg_role)}`, {
      method: 'DELETE',
    }),
  poolCredentialReactivate: (pg_role: string) =>
    request<PoolCredential>(`/pool/credentials/${encodeURIComponent(pg_role)}/reactivate`, { method: 'POST' }),
  poolAssignmentReactivate: (id: number) =>
    request<PoolAssignment>(`/pool/assignments/${id}/reactivate`, { method: 'POST' }),
  poolCredentialRotate: (pg_role: string, new_password: string) =>
    request<{ pg_role: string; is_active: boolean; last_rotated: string }>(
      `/pool/credentials/${encodeURIComponent(pg_role)}/rotate`,
      { method: 'POST', body: JSON.stringify({ new_password }) }
    ),

  // Module Management
  moduleTree: () =>
    request<ModuleTreeNode[]>('/modules/tree'),
  moduleDetails: (id: string) =>
    request<ModuleDetails>(`/modules/${encodeURIComponent(id)}/details`),
  moduleDelete: (id: string, cascade: boolean) =>
    request<{ deleted: string; cascade: boolean; children_reassigned: number; new_parent: string | null }>(
      `/modules/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ cascade }) }),
  moduleDescriptors: () =>
    request<UIDescriptor[]>('/modules/descriptors'),

  /** TIER-B-PAGE-RENAME-V01: rename and/or move a Tier B page in the catalog tree.
   *  page_id is immutable (external refs depend on it); pass {} → 400. */
  pageUpdate: (page_id: string, patch: { display_name?: string; parent_id?: string | null }) =>
    request<{ updated: string; page_id: string }>(
      `/modules/pages/${encodeURIComponent(page_id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),

  // Generic UI descriptors — any page_id registered in authz_ui_descriptor
  uiDescriptors: (pageId: string) =>
    request<UIDescriptor[]>(`/ui/descriptors/${encodeURIComponent(pageId)}`),

  // Render-token registry (V053 + V055) — { icon, status_color, phase_color, gate_color, semantic_color }
  renderTokens: () =>
    request<Record<'icon' | 'status_color' | 'phase_color' | 'gate_color' | 'semantic_color', Record<string, string>>>(
      '/ui/render-tokens'),

  // Config snapshot & bulk import
  configSnapshot: (sections?: string[]) =>
    request<ConfigSnapshot>(`/config/snapshot${sections ? `?sections=${sections.join(',')}` : ''}`),

  configBulkApply: (payload: { dry_run?: boolean; [section: string]: any }) =>
    request<BulkApplyResult>('/config/bulk', {
      method: 'POST', body: JSON.stringify(payload),
    }),

  // ── AI Provider Registry (Constitution §9.1) ──
  aiProviders: () =>
    request<AIProvider[]>('/ai-providers?include_inactive=true'),
  aiProvidersLite: () =>
    request<{ provider_id: string; display_name: string; purpose_tags: string[]; default_model: string | null; is_active: boolean; is_fallback: boolean }[]>(
      '/ai-providers/list'),
  aiProvider: (id: string) =>
    request<AIProvider>(`/ai-providers/${encodeURIComponent(id)}`),
  aiProviderCreate: (data: Partial<AIProvider> & { api_key?: string }) =>
    request<{ provider_id: string; display_name: string; provider_kind: string; is_active: boolean; created_at: string }>(
      '/ai-providers', { method: 'POST', body: JSON.stringify(data) }),
  aiProviderUpdate: (id: string, data: Partial<AIProvider>) =>
    request<{ provider_id: string; display_name: string; is_active: boolean; updated_at: string }>(
      `/ai-providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  aiProviderRotateKey: (id: string, api_key: string) =>
    request<{ provider_id: string; api_key_last4: string; api_key_rotated_at: string }>(
      `/ai-providers/${encodeURIComponent(id)}/key`, { method: 'PATCH', body: JSON.stringify({ api_key }) }),
  aiProviderDelete: (id: string) =>
    request<{ deactivated: string }>(`/ai-providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiProviderReactivate: (id: string) =>
    request<{ reactivated: string }>(`/ai-providers/${encodeURIComponent(id)}/reactivate`, { method: 'POST' }),
  aiProviderTestUnsaved: (data: { base_url: string; api_key?: string; default_model?: string; timeout_ms?: number; run_chat_probe?: boolean }) =>
    request<AIProviderTestResult>('/ai-providers/_test', { method: 'POST', body: JSON.stringify(data) }),
  aiProviderTest: (id: string, run_chat_probe = false) =>
    request<AIProviderTestResult>(`/ai-providers/${encodeURIComponent(id)}/test`, {
      method: 'POST', body: JSON.stringify({ run_chat_probe }),
    }),
  aiProviderRefreshModels: (id: string) =>
    request<{ status: string; model_count: number; available_models: string[] }>(
      `/ai-providers/${encodeURIComponent(id)}/refresh-models`, { method: 'POST' }),
  aiProviderUsage: (id: string, period: '24h' | '7d' | '30d' = '30d') =>
    request<AIProviderUsage>(`/ai-providers/${encodeURIComponent(id)}/usage?period=${period}`),
  aiProviderAudit: (id: string) =>
    request<AIProviderAuditEntry[]>(`/ai-providers/${encodeURIComponent(id)}/audit`),

  // ── AI-Assisted PG Function Authoring (dogfood, Constitution §11) ──
  aiAssistDraft: (data_source_id: string, prompt: string) =>
    request<AIAssistDraftResponse>('/ai-assist/function-draft', {
      method: 'POST', body: JSON.stringify({ data_source_id, prompt }),
    }),
  aiAssistRefine: (data_source_id: string, current_sql: string, instruction: string) =>
    request<AIAssistRefineResponse>('/ai-assist/function-refine', {
      method: 'POST', body: JSON.stringify({ data_source_id, current_sql, instruction }),
    }),
  aiAssistExplain: (sql: string) =>
    request<AIAssistExplainResponse>('/ai-assist/function-explain', {
      method: 'POST', body: JSON.stringify({ sql }),
    }),
  // §9.9 explicit-consent eval case capture (👍 / 👎 click)
  aiAssistEvalMark: (params: {
    ai_usage_id: number;
    prompt_text: string;
    response_text: string;
    verdict: 'good' | 'bad';
    notes?: string;
  }) =>
    request<{ case_id: number; verdict: 'good' | 'bad' }>('/ai-assist/eval-mark', {
      method: 'POST', body: JSON.stringify(params),
    }),

  // V075/V076 composite-action workflow runtime (NPI gate sign-off dogfood).
  workflowPending: (filters?: { policy_name?: string; subject_id?: string }) => {
    const qs = new URLSearchParams();
    if (filters?.policy_name) qs.set('policy_name', filters.policy_name);
    if (filters?.subject_id)  qs.set('subject_id',  filters.subject_id);
    const query = qs.toString();
    return request<WorkflowPendingRow[]>(`/workflow/pending${query ? `?${query}` : ''}`);
  },
  workflowGet: (request_id: string) =>
    request<WorkflowRequestDetail>(`/workflow/${request_id}`),
  workflowSubmit: (params: { policy_name: string; subject_id: string; request_reason?: string }) =>
    request<WorkflowSubmitResponse>('/workflow/request', {
      method: 'POST', body: JSON.stringify(params),
    }),
  workflowApprove: (request_id: string, note?: string) =>
    request<WorkflowDecisionResponse>(`/workflow/${request_id}/approve`, {
      method: 'POST', body: JSON.stringify({ note }),
    }),
  workflowReject: (request_id: string, note?: string) =>
    request<WorkflowDecisionResponse>(`/workflow/${request_id}/reject`, {
      method: 'POST', body: JSON.stringify({ note }),
    }),

  // Tier A primitive #2: per-user saved view (V080 + /api/saved-view)
  savedViewList: (page_id: string) =>
    request<{ views: SavedView[] }>(`/saved-view?page_id=${encodeURIComponent(page_id)}`),
  savedViewGet: (view_id: string, page_id?: string) => {
    const q = page_id ? `?page_id=${encodeURIComponent(page_id)}` : '';
    return request<{ view: SavedView }>(`/saved-view/${encodeURIComponent(view_id)}${q}`);
  },
  savedViewCreate: (params: { page_id: string; name: string; config_json: SavedViewConfig; is_default?: boolean }) =>
    request<{ view: SavedView }>(`/saved-view`, { method: 'POST', body: JSON.stringify(params) }),
  savedViewUpdate: (view_id: string, params: { name?: string; config_json?: SavedViewConfig }) =>
    request<{ view: SavedView }>(`/saved-view/${encodeURIComponent(view_id)}`, {
      method: 'PATCH', body: JSON.stringify(params),
    }),
  savedViewSetDefault: (view_id: string) =>
    request<{ view: SavedView }>(`/saved-view/${encodeURIComponent(view_id)}/set-default`, {
      method: 'POST',
    }),
  savedViewDelete: (view_id: string) =>
    request<{ status: string; view_id: string }>(`/saved-view/${encodeURIComponent(view_id)}`, {
      method: 'DELETE',
    }),

  // Tier A primitive #3: per-user feedback (V082 + /api/feedback)
  feedbackCreate: (params: { page_id: string; target_path: string; kind: FeedbackKind; body: string }) =>
    request<{ feedback: FeedbackRow }>(`/feedback`, {
      method: 'POST', body: JSON.stringify(params),
    }),
  feedbackMine: (page_id?: string) => {
    const q = page_id ? `?page_id=${encodeURIComponent(page_id)}` : '';
    return request<{ feedback: FeedbackRow[] }>(`/feedback/mine${q}`);
  },
  feedbackInbox: (filters?: { status?: FeedbackStatus; page_id?: string }) => {
    const qs = new URLSearchParams();
    if (filters?.status)  qs.set('status',  filters.status);
    if (filters?.page_id) qs.set('page_id', filters.page_id);
    const query = qs.toString();
    return request<{ feedback: FeedbackRow[] }>(`/feedback/inbox${query ? `?${query}` : ''}`);
  },
  feedbackPatchStatus: (feedback_id: string, status: Exclude<FeedbackStatus, 'open'>) =>
    request<{ feedback: FeedbackRow }>(`/feedback/${encodeURIComponent(feedback_id)}/status`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    }),

  // Tier A gate-prep: business-term admin (V044 semantic-layer columns).
  // All routes admin-only — gated at mount in services/authz-api/src/index.ts.
  businessTermList: (status?: BusinessTermStatus) => {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return request<{ rows: BusinessTermRow[] }>(`/business-term${q}`);
  },
  businessTermGet: (resource_id: string) =>
    request<{ row: BusinessTermRow }>(`/business-term/${encodeURIComponent(resource_id)}`),
  businessTermPatch: (
    resource_id: string,
    fields: Partial<Pick<BusinessTermRow, 'business_term' | 'definition' | 'formula' | 'owner_subject_id'>>
  ) =>
    request<{ row: BusinessTermRow }>(`/business-term/${encodeURIComponent(resource_id)}`, {
      method: 'PATCH', body: JSON.stringify(fields),
    }),
  businessTermTransition: (resource_id: string, status: BusinessTermStatus) =>
    request<{ row: BusinessTermRow }>(`/business-term/${encodeURIComponent(resource_id)}/transition`, {
      method: 'POST', body: JSON.stringify({ status }),
    }),

  // ACTIVITY-V01: stats over V030 continuous aggregates.
  activityHourlySummary: (hours = 24) =>
    request<{ hours: number; rows: Array<{ bucket: string; access_path: 'A'|'B'|'C'; decision: string; event_count: string; avg_duration_ms: number | null }> }>(
      `/activity/hourly-summary?hours=${hours}`),
  activityTopSubjects: (days = 7, limit = 10) =>
    request<{ days: number; rows: Array<{ subject_id: string; allow_count: string | null; deny_count: string | null; total_count: string }> }>(
      `/activity/top-subjects?days=${days}&limit=${limit}`),
  activityTopDeniedResources: (hours = 24, limit = 10) =>
    request<{ hours: number; rows: Array<{ resource_id: string; access_path: 'A'|'B'|'C'; deny_count: string; distinct_subjects: string }> }>(
      `/activity/top-denied-resources?hours=${hours}&limit=${limit}`),
  activityTotals: (hours = 24) =>
    request<{ hours: number; allow_count: string; deny_count: string; total_count: string }>(
      `/activity/totals?hours=${hours}`),

  // ANOMALY-V01: rule-based anomaly events.
  anomalyEvents: (params: { status?: 'open' | 'all'; rule?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.rule)   q.set('rule', params.rule);
    if (params.limit)  q.set('limit', String(params.limit));
    return request<{
      status: 'open' | 'all';
      rule: string | null;
      rows: Array<{
        event_id: string;
        detected_at: string;
        rule_id: string;
        severity: 'P1' | 'P2' | 'P3';
        subject_id: string | null;
        details: Record<string, unknown>;
        acked_at: string | null;
        acked_by: string | null;
        ack_note: string | null;
      }>;
    }>(`/anomaly/events${q.toString() ? `?${q}` : ''}`);
  },
  anomalySummary: () =>
    request<{
      total_open: number;
      by_rule: Array<{ rule_id: string; severity: 'P1' | 'P2' | 'P3'; open_count: string }>;
    }>(`/anomaly/summary`),
  anomalyAck: (event_id: string, note?: string) =>
    request<{
      event: {
        event_id: string; rule_id: string; severity: 'P1' | 'P2' | 'P3';
        subject_id: string | null; acked_at: string; acked_by: string; ack_note: string | null;
      };
    }>(`/anomaly/events/${encodeURIComponent(event_id)}/ack`, {
      method: 'PATCH',
      body: JSON.stringify({ note: note ?? null }),
    }),

  // PERM-SLIM-V01-PATH2: role pack template (V089 + /api/role-pack).
  // Read = AUTHZ_ADMIN/DATA_STEWARD, write = AUTHZ_ADMIN. Per-route gates
  // live inside the router; the dashboard hides write controls based on
  // useAuthz().isAuthzAdmin.
  rolePackList: () =>
    request<{ packs: RolePackSummary[] }>(`/role-pack`),
  rolePackGet: (pack_id: string) =>
    request<{ pack: RolePack; members: RolePackMember[]; assignments: RolePackAssignment[] }>(
      `/role-pack/${encodeURIComponent(pack_id)}`),
  rolePackCreate: (data: { pack_id: string; display_name: string; description?: string }) =>
    request<{ pack: RolePack }>(`/role-pack`, { method: 'POST', body: JSON.stringify(data) }),
  rolePackPatch: (pack_id: string, data: { display_name?: string; description?: string }) =>
    request<{ pack: RolePack }>(`/role-pack/${encodeURIComponent(pack_id)}`, {
      method: 'PATCH', body: JSON.stringify(data),
    }),
  rolePackDelete: (pack_id: string) =>
    request<{ status: 'deleted'; pack_id: string }>(
      `/role-pack/${encodeURIComponent(pack_id)}`, { method: 'DELETE' }),
  rolePackAddMember: (pack_id: string, data: { resource_id: string; action_id: string; effect?: 'allow' | 'deny' }) =>
    request<{ member: RolePackMember; resync: RolePackExpansion[] }>(
      `/role-pack/${encodeURIComponent(pack_id)}/members`, {
        method: 'POST', body: JSON.stringify(data),
      }),
  rolePackRemoveMember: (pack_id: string, resource_id: string, action_id: string) =>
    request<{ status: 'removed'; resync: RolePackExpansion[] }>(
      `/role-pack/${encodeURIComponent(pack_id)}/members/${encodeURIComponent(resource_id)}/${encodeURIComponent(action_id)}`,
      { method: 'DELETE' }),
  rolePackPreview: (pack_id: string, role_id: string) =>
    request<{
      pack_id: string; role_id: string;
      to_insert: RolePackMember[];
      to_delete: RolePackMember[];
      conflicts_with_manual: RolePackMember[];
    }>(`/role-pack/${encodeURIComponent(pack_id)}/preview/${encodeURIComponent(role_id)}`),
  rolePackApply: (pack_id: string, role_id: string) =>
    request<RolePackExpansion>(
      `/role-pack/${encodeURIComponent(pack_id)}/assignments/${encodeURIComponent(role_id)}`,
      { method: 'POST' }),
  rolePackUnapply: (pack_id: string, role_id: string) =>
    request<{ pack_id: string; role_id: string; deleted: number }>(
      `/role-pack/${encodeURIComponent(pack_id)}/assignments/${encodeURIComponent(role_id)}`,
      { method: 'DELETE' }),
  rolePackResync: (pack_id: string) =>
    request<{ pack_id: string; results: RolePackExpansion[] }>(
      `/role-pack/${encodeURIComponent(pack_id)}/resync`, { method: 'POST' }),
};

export type SavedViewConfig = {
  filters?: { field: string; op: string; value: string }[];
  sort?: { col: string; dir: 'asc' | 'desc' };
  hidden_cols?: string[];
};

export type SavedView = {
  view_id: string;
  user_id: string;
  page_id: string;
  name: string;
  config_json: SavedViewConfig;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type FeedbackKind = 'data_wrong' | 'feature_request' | 'confusing' | 'other';
export type FeedbackStatus = 'open' | 'triaged' | 'resolved' | 'dismissed';

export type FeedbackRow = {
  feedback_id: string;
  user_id: string;
  page_id: string;
  target_path: string;
  kind: FeedbackKind;
  body: string;
  status: FeedbackStatus;
  curator_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BusinessTermStatus = 'draft' | 'under_review' | 'blessed' | 'deprecated';

export type BusinessTermRow = {
  resource_id: string;
  business_term: string | null;
  definition: string | null;
  formula: string | null;
  owner_subject_id: string | null;
  status: BusinessTermStatus | null;
  blessed_at: string | null;
  blessed_by: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkflowChainStep = { step: number; role: string; label?: string };
export type WorkflowPendingRow = {
  request_id: string;
  subject_id: string;
  requested_by: string;
  requested_at: string;
  expires_at: string | null;
  request_reason: string | null;
  policy_name: string;
  approval_chain: WorkflowChainStep[];
  preconditions: { from_state?: string; to_state?: string };
  approvals_recorded: number;
  next_step: WorkflowChainStep | null;
};
export type WorkflowRequestDetail = WorkflowPendingRow & {
  status: string;
  resolved_at: string | null;
  resolution_reason: string | null;
  records: {
    chain_step: number;
    expected_role: string;
    actor: string;
    decision: 'approve' | 'reject';
    decided_at: string;
    note: string | null;
    dogfood_self_chained: boolean;
  }[];
};
export type WorkflowSubmitResponse = {
  request_id: string;
  requested_at: string;
  expires_at: string;
  status: string;
  composite_action: string;
  approval_chain: WorkflowChainStep[];
  preconditions: { from_state?: string; to_state?: string };
};
export type WorkflowDecisionResponse = {
  record_id: string;
  decided_at: string;
  chain_step: number;
  expected_role: string;
  dogfood_self_chained: boolean;
  request_status: 'pending' | 'approved' | 'rejected' | 'expired';
  lifecycle_advanced: { lifecycle_id: string; from: string; to: string } | null;
};

export type AIAssistUsage = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
};
export type AIAssistDraftResponse = {
  sql: string;
  rationale: string | null;
  provider_id: string;
  model_id: string;
  usage_id: number | null;
  schema_truncated: boolean;
  schema_tables: number;
  usage: AIAssistUsage;
};
export type AIAssistRefineResponse = {
  sql: string;
  diff_summary: string | null;
  provider_id: string;
  model_id: string;
  usage_id: number | null;
  usage: AIAssistUsage;
};
export type AIAssistExplainResponse = {
  markdown: string;
  provider_id: string;
  model_id: string;
  usage_id: number | null;
  usage: AIAssistUsage;
};

export type UserProfile = {
  id: string;
  label: string;
  groups: string[];
  attrs: Record<string, string>;
};

export type DataSource = {
  source_id: string;
  display_name: string;
  description: string | null;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  schemas: string[];
  connector_user: string;
  owner_subject: string | null;
  registered_by: string;
  is_active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  cdc_target_schema?: string | null;
  oracle_connection?: { host: string; port: number; service_name: string; user: string } | null;
};

export type PoolProfile = {
  profile_id: string;
  pg_role: string;
  allowed_schemas: string[];
  allowed_tables: string[] | null;
  denied_columns: Record<string, string[]> | null;
  connection_mode: 'readonly' | 'readwrite' | 'admin';
  max_connections: number;
  ip_whitelist: string[] | null;
  valid_hours: string | null;
  rls_applies: boolean;
  description: string | null;
  is_active: boolean;
  data_source_id: string | null;
  allowed_modules: string[] | null;
  assignment_count?: number;
};

export type PoolAssignment = {
  id: number;
  subject_id: string;
  profile_id: string;
  subject_name: string;
  granted_by: string;
  is_active: boolean;
  valid_from?: string;
  valid_until?: string;
  created_at?: string;
};

export type PoolCredential = {
  pg_role: string;
  is_active: boolean;
  last_rotated: string;
  rotate_interval: string | { days?: number };
};

export type TableColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
};

export type SqlFunction = {
  function_name: string;
  arguments: string;
  return_type: string;
  description: string | null;
  volatility: string;
};

export type DataExplorerColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  access: 'visible' | 'masked' | 'denied';
  mask_type: string | null;
  mask_function: string | null;
};

export type DataExplorerResult = {
  table: string;
  columns: DataExplorerColumn[];
  rls_filter: string;
  sample_data: Record<string, unknown>[];
  total_count: number;
  filtered_count: number;
  mask_functions: { function_name: string; description: string | null; example: string }[];
};

export type ActionItem = {
  type: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  meta?: unknown;
};

export type SyncAction = {
  action: string;
  detail: string;
  data_source_id: string;
  profile_id: string;
  status: 'ok' | 'error';
  error?: string;
};

export type DriftItem = {
  pg_role: string;
  type: 'role_missing' | 'role_extra_privilege' | 'grant_missing' | 'grant_extra' | 'column_grant_extra';
  detail: string;
};

export type DriftReport = {
  data_source_id: string;
  checked_at: string;
  items: DriftItem[];
};

export type PhaseStatus = 'not_started' | 'done' | 'action_needed';

export type LifecyclePhases = {
  connection:   { status: PhaseStatus };
  discovery:    { status: PhaseStatus; tables: number; views: number; columns: number; functions: number; last_discovered: string | null };
  organization: { status: PhaseStatus; mapped: number; unmapped: number };
  profiles:     { status: PhaseStatus; count: number; profile_ids: string[] };
  credentials:  { status: PhaseStatus; credentialed: number; uncredentialed: number; next_rotation: string | null };
  deployment:   { status: PhaseStatus; last_sync: string | null; has_local_profiles: boolean };
};

export type LifecycleResponse = {
  source_id: string;
  display_name: string;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  is_active: boolean;
  phases: LifecyclePhases;
};

export type LifecycleSummary = {
  source_id: string;
  display_name: string;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  is_active: boolean;
  phases_done: number;
  phases_total: number;
  next_action: string;
};

export type ConfigSnapshot = {
  _meta: { exported_at: string; system: string; format_version: string; description: string };
  summary: Record<string, any>;
  actions?: any[];
  roles?: any[];
  subjects?: any[];
  resources?: any[];
  policies?: any[];
  data_sources?: any[];
  pool_profiles?: any[];
  ui_pages?: any[];
  clearance_mappings?: any[];
};

export type BulkSectionResult = {
  section: string;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export type BulkApplyResult = {
  dry_run: boolean;
  status: 'ok' | 'partial';
  results: BulkSectionResult[];
  totals: { created: number; updated: number; skipped: number; errors: number };
};

export type UIDescriptor = {
  section_key: string;
  section_label: string;
  section_icon: string | null;
  display_order: number;
  visibility: 'all' | 'admin' | 'write' | 'read';
  columns: { key: string; label: string; type: string; width?: string; render_hint?: string; sortable?: boolean }[];
  render_hints: Record<string, unknown>;
};

export type ModuleTreeNode = {
  resource_id: string;
  display_name: string;
  parent_id: string | null;
  attributes: Record<string, unknown> | null;
  is_active: boolean;
  child_module_count: number;
  table_count: number;
  column_count: number;
  user_actions: string[]; // actions the current user can perform (e.g. ['read','write'])
};

export type AIProviderPricing = Record<string, { input: number; output: number }>;

export type AIProvider = {
  provider_id: string;
  display_name: string;
  description: string | null;
  provider_kind: 'openai' | 'azure_openai' | 'vllm' | 'ollama' | 'openrouter' | 'custom_oai';
  base_url: string;
  api_key_last4: string | null;
  api_key_rotated_at: string | null;
  api_key_set: boolean;
  default_model: string | null;
  available_models: string[];
  default_temperature: number;
  default_max_tokens: number;
  timeout_ms: number;
  pricing: AIProviderPricing;
  purpose_tags: string[];
  is_fallback: boolean;
  monthly_budget_usd: number | null;
  rate_limit_rpm: number | null;
  last_tested_at: string | null;
  last_test_status: string | null;
  last_test_detail: string | null;
  is_active: boolean;
  owner_subject: string | null;
  registered_by: string;
  created_at: string;
  updated_at: string;
};

export type AIProviderTestResult = {
  status: 'ok' | 'partial' | 'failed';
  layer?: 'models' | 'chat';
  reason?: string;
  message?: string;
  http_status?: number;
  models_reachable?: boolean;
  model_count?: number;
  models_sample?: string[];
  chat_probe?: {
    ok: boolean;
    model: string;
    sample?: string;
    latency_ms?: number;
    reason?: string;
    message?: string;
  };
};

export type AIProviderUsage = {
  period: string;
  summary: {
    call_count: string;
    ok_count: string;
    error_count: string;
    prompt_tokens_total: string;
    completion_tokens_total: string;
    cost_usd_total: string;
    avg_latency_ms: number | null;
  };
  by_feature: { feature_tag: string | null; calls: string; cost_usd: string }[];
  cost_usd_month_to_date: string;
};

export type AIProviderAuditEntry = {
  id: string;
  timestamp: string;
  user_id: string;
  action: string;
  details: Record<string, unknown>;
  actor_type: 'human' | 'ai_agent' | 'system';
  agent_id: string | null;
  model_id: string | null;
  consent_given: string;
};

export type ModuleDetails = {
  module: { resource_id: string; display_name: string; parent_id: string | null; attributes: Record<string, unknown> | null };
  children: {
    modules: { resource_id: string; display_name: string; table_count: number }[];
    tables: { resource_id: string; display_name: string; resource_type: string; column_count: number; data_source_id: string | null }[];
    functions: { resource_id: string; display_name: string; data_source_id: string | null; schema: string | null }[];
    pages: { resource_id: string; display_name: string; page_id: string; dag_id: string | null; node_id: string | null }[];
  };
  access: { role_id: string; role_name: string; actions: { action_id: string; effect: string }[] }[];
  profiles: { profile_id: string; pg_role: string; connection_mode: string; data_source_id: string | null }[];
  user_permissions: { actions: string[]; is_admin: boolean };
};

// PERM-SLIM-V01-PATH2 — role pack types
export type RolePack = {
  pack_id: string;
  display_name: string;
  description: string | null;
  is_system: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type RolePackSummary = RolePack & {
  member_count: number;
  assignment_count: number;
};

export type RolePackMember = {
  resource_id: string;
  action_id: string;
  effect: 'allow' | 'deny';
  added_by?: string;
  added_at?: string;
};

export type RolePackAssignment = {
  role_id: string;
  applied_by: string;
  applied_at: string;
};

export type RolePackExpansion = {
  pack_id: string;
  role_id: string;
  inserted: number;
  deleted: number;
  skipped_due_to_manual: number;
};
