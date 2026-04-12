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
};
