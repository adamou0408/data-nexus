import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { api, setApiUser, UserProfile } from './api';

// Resolved config from authz_resolve() — sanitized by API (SEC-01)
// Non-admin: rls_expression stripped, L2 mask function names stripped
// Admin with _detailed=true: full config
type ResolvedConfig = {
  user_id: string;
  resolved_roles: string[];
  access_path: string;
  L0_functional: { resource: string; action: string }[];
  L1_data_scope: Record<string, { has_rls?: boolean; rls_expression?: string; resource_condition?: unknown; subject_condition?: unknown }>;
  L2_column_masks: Record<string, Record<string, { mask_type: string; function?: string }>>;
  L3_actions: unknown[];
};

export type { UserProfile };

export type AdminStats = {
  subjects: number;
  roles: number;
  resources: number;
  policies: number;
  auditErrors24h: number;
};

type AuthzState = {
  user: UserProfile | null;
  config: ResolvedConfig | null;
  loading: boolean;
  users: UserProfile[];
  usersLoading: boolean;
  isAdmin: boolean;
  adminStats: AdminStats | null;
  refreshAdminStats: () => void;
  login: (user: UserProfile) => Promise<void>;
  logout: () => void;
  hasPermission: (action: string, resource: string) => boolean;
  hasRole: (role: string) => boolean;
};

const AuthzContext = createContext<AuthzState | null>(null);

export function AuthzProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [config, setConfig] = useState<ResolvedConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);

  // Fetch user profiles from DB on mount
  useEffect(() => {
    api.subjectProfiles()
      .then(setUsers)
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false));
  }, []);

  const login = useCallback(async (u: UserProfile) => {
    setLoading(true);
    setApiUser(u.id, u.groups);
    try {
      const data = await api.resolve(u.id, u.groups, u.attrs) as ResolvedConfig;
      setUser(u);
      setConfig(data);
    } catch {
      setUser(u);
      setConfig(null);
    }
    setLoading(false);
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setConfig(null);
    setApiUser('', []);
  }, []);

  const hasPermission = useCallback((action: string, resource: string): boolean => {
    if (!config) return false;
    return config.L0_functional.some(
      p => (p.action === action || p.action === '*') &&
           (p.resource === resource || p.resource === '*')
    );
  }, [config]);

  const hasRole = useCallback((role: string): boolean => {
    if (!config) return false;
    return config.resolved_roles.includes(role);
  }, [config]);

  const isAdmin = config?.resolved_roles?.some(r => r === 'ADMIN' || r === 'AUTHZ_ADMIN') ?? false;

  const [adminStats, setAdminStats] = useState<AdminStats | null>(null);
  const refreshAdminStats = useCallback(() => {
    if (!isAdmin) { setAdminStats(null); return; }
    Promise.all([
      api.subjects(), api.roles(), api.resources(), api.policies(),
      api.adminAuditLogs({ limit: 200 }).catch(() => [] as Record<string, unknown>[]),
    ]).then(([s, r, res, p, audit]) => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const errors = audit.filter(row => {
        const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : 0;
        const dec = String(row.decision || '').toLowerCase();
        return ts >= cutoff && (dec === 'deny' || dec === 'error');
      }).length;
      setAdminStats({ subjects: s.length, roles: r.length, resources: res.length, policies: p.length, auditErrors24h: errors });
    }).catch(() => setAdminStats(null));
  }, [isAdmin]);

  useEffect(() => { refreshAdminStats(); }, [refreshAdminStats]);

  return (
    <AuthzContext.Provider value={{ user, config, loading, users, usersLoading, isAdmin, adminStats, refreshAdminStats, login, logout, hasPermission, hasRole }}>
      {children}
    </AuthzContext.Provider>
  );
}

export function useAuthz() {
  const ctx = useContext(AuthzContext);
  if (!ctx) throw new Error('useAuthz must be used within AuthzProvider');
  return ctx;
}

export function useAuthzCheck(action: string, resource: string): boolean {
  const { hasPermission } = useAuthz();
  return hasPermission(action, resource);
}
