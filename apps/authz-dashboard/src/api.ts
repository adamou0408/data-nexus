const BASE = '/api';

// Current user context for authenticated API calls
let _currentUserId = '';
let _currentGroups: string[] = [];

export function setApiUser(userId: string, groups: string[]) {
  _currentUserId = userId;
  _currentGroups = groups;
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
  // Attach auth headers for admin APIs
  if (_currentUserId) {
    headers['X-User-Id'] = _currentUserId;
    headers['X-User-Groups'] = _currentGroups.join(',');
  }
  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
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

  configExecPage: (pageId: string, params?: Record<string, string>) =>
    request<{
      config: Record<string, unknown>;
      data: Record<string, unknown>[];
      meta: {
        filteredCount: number;
        totalCount: number;
        columnMasks: Record<string, string>;
        resolvedRoles: string[];
        filterClause: string;
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
  datasource: (id: string) => request<DataSource>(`/datasources/${encodeURIComponent(id)}`),
  datasourceCreate: (data: Partial<DataSource> & { connector_password?: string }) =>
    request<DataSource>('/datasources', { method: 'POST', body: JSON.stringify(data) }),
  datasourceUpdate: (id: string, data: Partial<DataSource>) =>
    request<DataSource>(`/datasources/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  datasourceDelete: (id: string) =>
    request(`/datasources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  datasourcePurge: (id: string) =>
    request<{ purged: string; columns_deleted: number; tables_deleted: number; profiles_deleted: number }>(
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
  }) =>
    request<{ status: string; resource_id: string; display_name: string; nodes: any[]; edges: any[] }>(
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

  // Generic UI descriptors — any page_id registered in authz_ui_descriptor
  uiDescriptors: (pageId: string) =>
    request<UIDescriptor[]>(`/ui/descriptors/${encodeURIComponent(pageId)}`),

  // Config snapshot & bulk import
  configSnapshot: (sections?: string[]) =>
    request<ConfigSnapshot>(`/config/snapshot${sections ? `?sections=${sections.join(',')}` : ''}`),

  configBulkApply: (payload: { dry_run?: boolean; [section: string]: any }) =>
    request<BulkApplyResult>('/config/bulk', {
      method: 'POST', body: JSON.stringify(payload),
    }),
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
  deployment:   { status: PhaseStatus; last_sync: string | null };
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

export type ModuleDetails = {
  module: { resource_id: string; display_name: string; parent_id: string | null; attributes: Record<string, unknown> | null };
  children: {
    modules: { resource_id: string; display_name: string; table_count: number }[];
    tables: { resource_id: string; display_name: string; resource_type: string; column_count: number; data_source_id: string | null }[];
    functions: { resource_id: string; display_name: string; data_source_id: string | null; schema: string | null }[];
  };
  access: { role_id: string; role_name: string; actions: { action_id: string; effect: string }[] }[];
  profiles: { profile_id: string; pg_role: string; connection_mode: string; data_source_id: string | null }[];
  user_permissions: { actions: string[]; is_admin: boolean };
};
