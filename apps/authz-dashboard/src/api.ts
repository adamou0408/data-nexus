const BASE = '/api';

// Current user context for authenticated API calls
let _currentUserId = '';
let _currentGroups: string[] = [];

export function setApiUser(userId: string, groups: string[]) {
  _currentUserId = userId;
  _currentGroups = groups;
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
  resolve: (user_id: string, groups: string[], attributes: Record<string, string>) =>
    request('/resolve', { method: 'POST', body: JSON.stringify({ user_id, groups, attributes }) }),

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

  matrix: (action?: string) => request<{
    permissions: { role_id: string; action_id: string; resource_id: string; effect: string }[];
    roles: { role_id: string; display_name: string }[];
    resources: { resource_id: string; display_name: string; resource_type: string }[];
    actions: { action_id: string; display_name: string }[];
  }>(`/matrix${action ? `?action=${action}` : ''}`),

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
  auditLogs: (params?: { subject?: string; action?: string; path?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.subject) qs.set('subject', params.subject);
    if (params?.action) qs.set('action', params.action);
    if (params?.path) qs.set('path', params.path);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    return request<Record<string, unknown>[]>(`/browse/audit-logs?${qs}`);
  },

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
  tables: () => request<{ table_name: string; column_count: string }[]>('/browse/tables'),
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
  datasourceCreate: (data: Partial<DataSource> & { connector_password: string }) =>
    request<DataSource>('/datasources', { method: 'POST', body: JSON.stringify(data) }),
  datasourceUpdate: (id: string, data: Partial<DataSource>) =>
    request<DataSource>(`/datasources/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  datasourceDelete: (id: string) =>
    request(`/datasources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  datasourceTest: (id: string) =>
    request<{ status: string; version?: string; error?: string }>(`/datasources/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  datasourceDiscover: (id: string) =>
    request<{ source_id: string; tables_found: number; columns_found: number; resources_created: number; created: string[] }>(
      `/datasources/${encodeURIComponent(id)}/discover`, { method: 'POST' }),
  datasourceTables: (id: string) =>
    request<{ source_id: string; database: string; tables: { table_schema: string; table_name: string; column_count: string }[] }>(
      `/datasources/${encodeURIComponent(id)}/tables`),

  poolSyncGrants: () => request<{ actions: { action: string; detail: string }[] }>('/pool/sync/grants', { method: 'POST' }),
  poolSyncPgbouncer: () => request<{ config: string }>('/pool/sync/pgbouncer', { method: 'POST' }),
  poolCredentialRotate: (pg_role: string, new_password: string) =>
    request<{ pg_role: string; is_active: boolean; last_rotated: string }>(
      `/pool/credentials/${encodeURIComponent(pg_role)}/rotate`,
      { method: 'POST', body: JSON.stringify({ new_password }) }
    ),
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
  assignment_count?: string;
};

export type PoolAssignment = {
  id: number;
  subject_id: string;
  profile_id: string;
  subject_name: string;
  granted_by: string;
  is_active: boolean;
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
