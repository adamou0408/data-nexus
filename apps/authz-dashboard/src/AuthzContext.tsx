import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { api, setApiUser } from './api';

// Resolved config from authz_resolve()
type ResolvedConfig = {
  user_id: string;
  resolved_roles: string[];
  access_path: string;
  L0_functional: { resource: string; action: string }[];
  L1_data_scope: Record<string, unknown>;
  L2_column_masks: Record<string, Record<string, { mask_type: string; function: string }>>;
  L3_actions: unknown[];
};

type UserProfile = {
  id: string;
  label: string;
  groups: string[];
  attrs: Record<string, string>;
};

type AuthzState = {
  user: UserProfile | null;
  config: ResolvedConfig | null;
  loading: boolean;
  login: (user: UserProfile) => Promise<void>;
  logout: () => void;
  hasPermission: (action: string, resource: string) => boolean;
  hasRole: (role: string) => boolean;
};

const AuthzContext = createContext<AuthzState | null>(null);

export const TEST_USERS: UserProfile[] = [
  { id: 'wang_pe',      label: 'Wang (PE-SSD)',       groups: ['PE_SSD'],       attrs: { product_line: 'SSD', site: 'HQ' } },
  { id: 'chen_pe',      label: 'Chen (PE-eMMC)',      groups: ['PE_EMMC'],      attrs: { product_line: 'eMMC', site: 'HQ' } },
  { id: 'lin_pm',       label: 'Lin (PM-SSD)',        groups: ['PM_SSD'],       attrs: { product_line: 'SSD' } },
  { id: 'huang_qa',     label: 'Huang (QA)',          groups: ['QA_ALL'],       attrs: {} },
  { id: 'lee_sales',    label: 'Lee (Sales-TW)',      groups: ['SALES_TW'],     attrs: { region: 'TW' } },
  { id: 'zhang_sales',  label: 'Zhang (Sales-CN)',    groups: ['SALES_CN'],     attrs: { region: 'CN' } },
  { id: 'wu_fae',       label: 'Wu (FAE-TW)',         groups: ['FAE_TW'],       attrs: { region: 'TW' } },
  { id: 'liu_fw',       label: 'Liu (FW-SSD)',        groups: ['RD_FW'],        attrs: { product_line: 'SSD' } },
  { id: 'hsu_op',       label: 'Hsu (OP-SSD)',        groups: ['OP_SSD'],       attrs: { product_line: 'SSD', site: 'HQ' } },
  { id: 'yang_finance', label: 'Yang (Finance)',      groups: ['FINANCE_TEAM'], attrs: {} },
  { id: 'chang_vp',     label: 'Chang (VP)',          groups: ['VP_OFFICE'],    attrs: {} },
  { id: 'tsai_bi',      label: 'Tsai (BI)',           groups: ['BI_TEAM'],      attrs: {} },
  { id: 'sys_admin',    label: 'SysAdmin',            groups: [],               attrs: {} },
];

export function AuthzProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [config, setConfig] = useState<ResolvedConfig | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <AuthzContext.Provider value={{ user, config, loading, login, logout, hasPermission, hasRole }}>
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
