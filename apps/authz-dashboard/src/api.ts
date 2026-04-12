const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
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
  auditLogs: (params?: { subject?: string; action?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.subject) qs.set('subject', params.subject);
    if (params?.action) qs.set('action', params.action);
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
  poolSyncGrants: () => request<{ actions: { action: string; detail: string }[] }>('/pool/sync/grants', { method: 'POST' }),
  poolSyncPgbouncer: () => request<{ config: string }>('/pool/sync/pgbouncer', { method: 'POST' }),
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
  rotate_interval: string;
};
