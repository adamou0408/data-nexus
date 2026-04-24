import { useState, useEffect, ReactNode } from 'react';
import { useAuthz } from '../AuthzContext';
import { api, ActionItem } from '../api';
import {
  Users, Shield, Database, FileText,
  Layers, ArrowRight, CheckCircle2, XCircle, Circle,
  Lock, Eye, Search, AlertTriangle, Clock,
  Code2, BarChart3, Workflow,
  Inbox, Zap, Activity, ChevronDown, ChevronRight,
} from 'lucide-react';

type Stats = {
  subjects: number;
  roles: number;
  resources: number;
  policies: number;
};

type ChecklistItem = {
  key: string;
  label: string;
  detail: string;
  done: boolean;
  count?: number;
  cta: { label: string; tab: string };
};

type InboxData = {
  arrival: { suggestions: number; resources: number; mappedRatio: number | null };
  attention: { uncred: number; actionItems: number };
  health: { dsTotal: number; dsConnected: number };
};

export function OverviewTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { user, config, isAdmin } = useAuthz();
  const [stats, setStats] = useState<Stats | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[] | null>(null);
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [showSetupHelp, setShowSetupHelp] = useState(false);

  useEffect(() => {
    if (!isAdmin) { setStats(null); setChecklist(null); setInbox(null); return; }
    Promise.all([
      api.subjects(), api.roles(), api.resources(), api.policies(),
      api.datasourceLifecycleSummary().catch(() => [] as any[]),
      api.discoverStats().catch(() => null),
      api.adminAuditLogs({ limit: 1 }).catch(() => [] as Record<string, unknown>[]),
      api.discoverSuggestions({}).catch(() => [] as any[]),
      api.poolUncredentialedRoles().catch(() => [] as any[]),
    ]).then(([s, r, res, p, lifecycle, discover, audit, suggestions, uncred]) => {
      setStats({ subjects: s.length, roles: r.length, resources: res.length, policies: p.length });

      const dsCount = lifecycle.length;
      const dsConnected = lifecycle.filter((d: any) => d.phases_done >= 1).length;
      const discoveredTables = discover ? (discover.table?.total ?? 0) : 0;
      const mappedTables = discover ? (discover.table?.mapped ?? 0) : 0;
      const auditUsed = audit.length > 0;

      setInbox({
        arrival: {
          suggestions: suggestions.length,
          resources: discoveredTables,
          mappedRatio: discoveredTables > 0 ? mappedTables / discoveredTables : null,
        },
        attention: {
          uncred: uncred.length,
          actionItems: 0, // populated by separate effect below
        },
        health: {
          dsTotal: dsCount,
          dsConnected,
        },
      });

      setChecklist([
        {
          key: 'ds', label: '1. 接資料來源',
          detail: dsCount === 0 ? '尚未註冊任何 Data Source' : `已註冊 ${dsCount} 筆，${dsConnected} 筆連線就緒`,
          done: dsConnected > 0, count: dsConnected,
          cta: { label: 'Sources', tab: 'pool' },
        },
        {
          key: 'discover', label: '2. Discover 掃 schema',
          detail: discoveredTables === 0 ? '還沒掃出任何 table/view' : `已發現 ${discoveredTables} 張表`,
          done: discoveredTables > 0, count: discoveredTables,
          cta: { label: 'Discover', tab: 'discover' },
        },
        {
          key: 'modules', label: '3. 編 Modules 業務樹',
          detail: mappedTables === 0 ? '尚未把表對到模組' : `${mappedTables}/${discoveredTables} 張表已歸入模組`,
          done: mappedTables > 0, count: mappedTables,
          cta: { label: 'Modules', tab: 'modules' },
        },
        {
          key: 'subjects', label: '4. 同步 Subjects (LDAP)',
          detail: s.length === 0 ? '沒有任何使用者' : `${s.length} 筆 subject`,
          done: s.length > 0, count: s.length,
          cta: { label: 'Subjects', tab: 'access-subjects' },
        },
        {
          key: 'roles', label: '5. 設計 Roles',
          detail: r.length === 0 ? '尚未定義 role' : `${r.length} 個 role`,
          done: r.length > 0, count: r.length,
          cta: { label: 'Roles', tab: 'access-roles' },
        },
        {
          key: 'policies', label: '6. 寫 Policies (中央表)',
          detail: p.length === 0 ? '尚無 policy — 使用者會看不到任何資料' : `${p.length} 條 policy`,
          done: p.length > 0, count: p.length,
          cta: { label: 'Policies', tab: 'access-policies' },
        },
        {
          key: 'verify', label: '7. 用 Permission Tester 驗',
          detail: auditUsed ? 'Audit log 有事件，已被使用' : '還沒有任何 audit 紀錄',
          done: auditUsed,
          cta: { label: 'Permissions', tab: 'permissions' },
        },
      ]);
    }).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    api.actionItems(user?.id, isAdmin).then(setActionItems).catch(() => {});
  }, [user?.id, isAdmin]);

  // Sync action item count into inbox once both arrive.
  useEffect(() => {
    setInbox(prev => prev ? { ...prev, attention: { ...prev.attention, actionItems: actionItems.length } } : prev);
  }, [actionItems.length]);

  const checklistDone = checklist ? checklist.filter(c => c.done).length : 0;
  const checklistTotal = checklist?.length ?? 0;
  const inSetupMode = checklist !== null && checklistDone < 4;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="page-header">
        <h1 className="page-title">Dashboard Overview</h1>
        <p className="page-desc">
          Phison Data Nexus AuthZ platform status and quick actions
        </p>
      </div>

      {/* End-user primary CTA — non-admin only, when no actionItems */}
      {!isAdmin && user && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <PrimaryCta
            title="開始查詢資料"
            desc="用 Query Tool 跑 SQL，或用 Flow Composer 拼資料流。"
            icon={<Code2 size={28} />}
            color="blue"
            onClick={() => onNavigate('data-query')}
          />
          <PrimaryCta
            title="打開 BI 報表"
            desc="跳到 Metabase，看儀表板與報告。"
            icon={<BarChart3 size={28} />}
            color="purple"
            onClick={() => onNavigate('metabase')}
          />
        </div>
      )}

      {/* Inbox — bottom-up arrival / attention / health cards (admin only) */}
      {isAdmin && inbox && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <InboxCard
            tone="blue"
            icon={<Inbox size={18} />}
            title="新到貨 Arrival"
            primary={inbox.arrival.suggestions}
            primaryLabel={inbox.arrival.suggestions === 1 ? 'pending suggestion' : 'pending suggestions'}
            lines={[
              inbox.arrival.resources > 0
                ? `${inbox.arrival.resources} resources discovered${
                    inbox.arrival.mappedRatio !== null
                      ? ` · ${Math.round(inbox.arrival.mappedRatio * 100)}% mapped`
                      : ''
                  }`
                : 'No resources discovered yet',
            ]}
            cta={{
              label: inbox.arrival.suggestions > 0 ? 'Review suggestions' : 'Open Discover',
              onClick: () => {
                if (inbox.arrival.suggestions > 0) sessionStorage.setItem('discover.subTab', 'pending');
                onNavigate('discover');
              },
            }}
            empty={inbox.arrival.suggestions === 0 && inbox.arrival.resources === 0}
          />
          <InboxCard
            tone={inbox.attention.uncred + inbox.attention.actionItems > 0 ? 'amber' : 'slate'}
            icon={<Zap size={18} />}
            title="待處理 Attention"
            primary={inbox.attention.uncred + inbox.attention.actionItems}
            primaryLabel={inbox.attention.uncred + inbox.attention.actionItems === 1 ? 'item needs you' : 'items need you'}
            lines={[
              inbox.attention.actionItems > 0 && `${inbox.attention.actionItems} action item${inbox.attention.actionItems === 1 ? '' : 's'} (SSOT / credential / role)`,
              inbox.attention.uncred > 0 && `${inbox.attention.uncred} Path-C role${inbox.attention.uncred === 1 ? '' : 's'} without credential`,
            ].filter(Boolean) as string[]}
            cta={{
              label: inbox.attention.uncred > 0 ? 'Open Sources' : 'View action items',
              onClick: () => onNavigate(inbox.attention.uncred > 0 ? 'pool' : 'audit'),
            }}
            empty={inbox.attention.uncred + inbox.attention.actionItems === 0}
          />
          <InboxCard
            tone={inbox.health.dsTotal === 0 ? 'slate' : inbox.health.dsConnected === inbox.health.dsTotal ? 'emerald' : 'amber'}
            icon={<Activity size={18} />}
            title="體檢 Health"
            primary={`${inbox.health.dsConnected}/${inbox.health.dsTotal}`}
            primaryLabel="data sources connected"
            lines={[
              inbox.health.dsTotal === 0
                ? 'No data sources registered'
                : inbox.health.dsConnected === inbox.health.dsTotal
                  ? 'All sources reachable'
                  : `${inbox.health.dsTotal - inbox.health.dsConnected} source${inbox.health.dsTotal - inbox.health.dsConnected === 1 ? '' : 's'} not yet connected`,
            ]}
            cta={{
              label: 'Open Sources',
              onClick: () => onNavigate('pool'),
            }}
            empty={inbox.health.dsTotal === 0}
          />
        </div>
      )}

      {/* Setup Checklist — auto-expand when admin is still in setup mode, otherwise hidden behind a disclosure */}
      {isAdmin && checklist && (
        <div className="card">
          <button
            onClick={() => setShowSetupHelp(s => !s)}
            className="card-header w-full flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
          >
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              {showSetupHelp || inSetupMode ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <CheckCircle2 size={16} className="text-emerald-500" />
              Setup Checklist
              {inSetupMode && <span className="text-[11px] font-normal text-amber-600">· first-time setup in progress</span>}
            </h2>
            <span className="badge badge-slate">{checklistDone} / {checklistTotal}</span>
          </button>
          {(showSetupHelp || inSetupMode) && (
            <div className="card-body">
              <div className="space-y-2">
                {checklist.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => onNavigate(c.cta.tab)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors
                      ${c.done
                        ? 'border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50'
                        : 'border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50/40'}`}
                  >
                    <div className="shrink-0">
                      {c.done
                        ? <CheckCircle2 size={18} className="text-emerald-500" />
                        : <Circle size={18} className="text-slate-300" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-medium ${c.done ? 'text-slate-700' : 'text-slate-900'}`}>{c.label}</div>
                      <div className="text-xs text-slate-500">{c.detail}</div>
                    </div>
                    {typeof c.count === 'number' && c.count > 0 && (
                      <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{c.count}</span>
                    )}
                    <span className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 shrink-0">
                      {c.cta.label} <ArrowRight size={12} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stat cards — admin only */}
      {isAdmin && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={<Users size={20} />} iconBg="bg-blue-100 text-blue-600"
            value={stats?.subjects ?? '-'} label="Subjects"
            onClick={() => onNavigate('access-subjects')}
          />
          <StatCard
            icon={<Shield size={20} />} iconBg="bg-emerald-100 text-emerald-600"
            value={stats?.roles ?? '-'} label="Roles"
            onClick={() => onNavigate('access-roles')}
          />
          <StatCard
            icon={<Database size={20} />} iconBg="bg-purple-100 text-purple-600"
            value={stats?.resources ?? '-'} label="Resources"
            onClick={() => onNavigate('access-resources')}
          />
          <StatCard
            icon={<FileText size={20} />} iconBg="bg-amber-100 text-amber-600"
            value={stats?.policies ?? '-'} label="ABAC Policies"
            onClick={() => onNavigate('access-policies')}
          />
        </div>
      )}

      {/* Action Items / Approval Queue */}
      {actionItems.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-500" />
              Action Items
            </h2>
            <span className="badge badge-amber">{actionItems.length}</span>
          </div>
          <div className="card-body space-y-2">
            {actionItems.map((item, i) => {
              const guidance = actionGuidance(item, onNavigate);
              return (
                <div key={i} className={`p-3 rounded-lg border ${
                  item.severity === 'error' ? 'border-red-200 bg-red-50' :
                  item.severity === 'warning' ? 'border-amber-200 bg-amber-50' :
                  'border-blue-200 bg-blue-50'
                }`}>
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 shrink-0 ${
                      item.severity === 'error' ? 'text-red-500' :
                      item.severity === 'warning' ? 'text-amber-500' :
                      'text-blue-500'
                    }`}>
                      {item.severity === 'error' ? <XCircle size={16} /> :
                       item.severity === 'warning' ? <AlertTriangle size={16} /> :
                       <Clock size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900">{item.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{item.detail}</div>
                      {guidance && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-slate-600">{guidance.hint}</span>
                          <button onClick={guidance.action}
                            className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1">
                            {guidance.label} <ArrowRight size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                    <span className={`badge text-[10px] shrink-0 ${
                      item.type === 'ssot_drift' ? 'badge-red' :
                      item.type === 'credential_rotation' ? 'badge-amber' :
                      item.type === 'role_expiring' ? 'badge-purple' :
                      'badge-slate'
                    }`}>
                      {item.type === 'ssot_drift' ? 'SSOT' :
                       item.type === 'credential_rotation' ? 'Credential' :
                       item.type === 'role_expiring' ? 'Role' :
                       item.type === 'access_denied' ? 'Denied' :
                       item.type}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Current user card + Quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Current user summary */}
        <div className="lg:col-span-2 card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Current User Context</h2>
          </div>
          <div className="card-body">
            {!user ? (
              <div className="text-center py-8">
                <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
                  <Users size={24} className="text-slate-400" />
                </div>
                <p className="text-slate-500 text-sm">Select a user from the sidebar to get started</p>
              </div>
            ) : !config ? (
              <div className="text-center py-8 text-slate-400 text-sm">Loading user context...</div>
            ) : (
              <div className="space-y-5">
                {/* User info row */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
                      {user.label.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">{user.label}</div>
                      <div className="text-xs text-slate-500 font-mono">{user.id}</div>
                    </div>
                  </div>
                  <div className="sm:ml-auto flex gap-1.5 flex-wrap">
                    {config.resolved_roles.map(r => (
                      <span key={r} className="badge badge-blue">{r}</span>
                    ))}
                  </div>
                </div>

                {/* Access summary */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-2 text-slate-500 text-xs font-medium mb-1">
                      <CheckCircle2 size={14} className="text-emerald-500" />
                      L0 Permissions
                    </div>
                    <div className="text-xl font-bold text-slate-900">
                      {config.L0_functional.length}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-2 text-slate-500 text-xs font-medium mb-1">
                      <Eye size={14} className="text-amber-500" />
                      L1 Data Scopes
                    </div>
                    <div className="text-xl font-bold text-slate-900">
                      {Object.keys(config.L1_data_scope).length}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-2 text-slate-500 text-xs font-medium mb-1">
                      <Lock size={14} className="text-purple-500" />
                      L2 Column Masks
                    </div>
                    <div className="text-xl font-bold text-slate-900">
                      {Object.keys(config.L2_column_masks).length}
                    </div>
                  </div>
                </div>

                {/* My Access Card */}
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                      Accessible Resources
                    </div>
                    {(() => {
                      const groups: Record<string, { resource: string; actions: string[] }[]> = {};
                      for (const p of config.L0_functional) {
                        const type = p.resource.split(':')[0] || 'other';
                        if (!groups[type]) groups[type] = [];
                        const existing = groups[type].find(g => g.resource === p.resource);
                        if (existing) { existing.actions.push(p.action); }
                        else { groups[type].push({ resource: p.resource, actions: [p.action] }); }
                      }
                      const typeLabels: Record<string, string> = { module: 'Modules', table: 'Tables', column: 'Columns', web_api: 'APIs', web_page: 'Pages' };
                      return Object.entries(groups).slice(0, 4).map(([type, items]) => (
                        <div key={type} className="mb-2">
                          <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">{typeLabels[type] || type}</div>
                          <div className="flex flex-wrap gap-1.5">
                            {items.slice(0, 6).map((item, i) => (
                              <div key={i} className="inline-flex items-center gap-1 bg-emerald-50 border border-emerald-200 rounded px-2 py-0.5">
                                <span className="text-[10px] text-slate-700 font-mono">{item.resource.split(':').pop()}</span>
                                <span className="text-[9px] text-emerald-600">{item.actions.join('/')}</span>
                              </div>
                            ))}
                            {items.length > 6 && <span className="text-[10px] text-slate-400">+{items.length - 6}</span>}
                          </div>
                        </div>
                      ));
                    })()}
                  </div>

                  {Object.keys(config.L1_data_scope).length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                        Data Scope Restrictions
                      </div>
                      <div className="space-y-1">
                        {Object.entries(config.L1_data_scope).slice(0, 4).map(([name, policy]: [string, any]) => (
                          <div key={name} className="flex items-center gap-2 text-xs">
                            <Eye size={12} className="text-amber-500 shrink-0" />
                            <span className="font-medium text-slate-700">{name}</span>
                            {policy?.has_rls && (
                              <span className="badge badge-amber text-[10px]">RLS Active</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button onClick={() => onNavigate('permissions')}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
                    View full L0-L3 details <ArrowRight size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Quick actions */}
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Quick Actions</h2>
          </div>
          <div className="card-body space-y-2">
            <QuickAction
              icon={<Shield size={16} />} label="Permissions"
              desc="View / test / simulate permissions"
              onClick={() => onNavigate('permissions')}
            />
            <QuickAction
              icon={<Layers size={16} />} label="Data Explorer"
              desc="Browse business data with access control"
              onClick={() => onNavigate('tables')}
            />
            <QuickAction
              icon={<Code2 size={16} />} label="Query Tool"
              desc="Write SQL against allowed tables"
              onClick={() => onNavigate('data-query')}
            />
            <QuickAction
              icon={<Workflow size={16} />} label="Flow Composer"
              desc="Compose multi-step data flows"
              onClick={() => onNavigate('flow-composer')}
            />
            {isAdmin && (
              <QuickAction
                icon={<Search size={16} />} label="Discover"
                desc="Scan a data source for new tables"
                onClick={() => onNavigate('discover')}
              />
            )}
          </div>
        </div>
      </div>

      {/* Three paths info — admin only */}
      {isAdmin && (
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Three Access Paths</h2>
            <span className="badge badge-slate">SSOT Architecture</span>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <PathCard
                letter="A" name="Config-SM"
                desc="Metadata-driven UI with full L0-L3 config. Smart rendering based on resolved permissions."
                tags={['L0 Functional', 'L1 RLS', 'L2 Masks', 'L3 Workflows']}
                color="blue"
              />
              <PathCard
                letter="B" name="Web + API"
                desc="Traditional middleware-gated routes. API-level access control with row filtering."
                tags={['L0 Functional', 'L1 RLS']}
                color="emerald"
              />
              <PathCard
                letter="C" name="DB Pool"
                desc="PostgreSQL native GRANT + RLS via pgbouncer connection pools."
                tags={['PG GRANT', 'Native RLS', 'Column Deny']}
                color="purple"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function actionGuidance(
  item: ActionItem,
  onNavigate: (tab: string) => void,
): { hint: string; label: string; action: () => void } | null {
  switch (item.type) {
    case 'ssot_drift':
      return {
        hint: 'Pool 靜態設定與權限規則不一致，請執行同步以修正。',
        label: 'Go to Sync Grants',
        action: () => onNavigate('pool'),
      };
    case 'credential_rotation':
      return {
        hint: '請盡快輪換密碼以避免連線中斷。',
        label: 'Go to Credentials',
        action: () => onNavigate('pool'),
      };
    case 'role_expiring':
      return {
        hint: '授權即將到期，如需延期請至 Subjects 處理。',
        label: 'Go to Subjects',
        action: () => onNavigate('access-subjects'),
      };
    case 'access_denied':
      return {
        hint: '如需此權限，請聯繫 IT Admin 申請存取。',
        label: 'View My Permissions',
        action: () => onNavigate('permissions'),
      };
    default:
      return null;
  }
}

function StatCard({ icon, iconBg, value, label, onClick }: {
  icon: ReactNode; iconBg: string; value: string | number; label: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="stat-card hover:border-slate-300 transition-colors text-left w-full">
      <div className={`stat-icon ${iconBg}`}>{icon}</div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </button>
  );
}

function QuickAction({ icon, label, desc, onClick }: {
  icon: ReactNode; label: string; desc: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 p-3 rounded-lg border border-slate-200
                 hover:border-blue-300 hover:bg-blue-50/50 transition-all text-left group">
      <div className="w-8 h-8 rounded-lg bg-slate-100 group-hover:bg-blue-100 flex items-center justify-center
                      text-slate-500 group-hover:text-blue-600 transition-colors shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900">{label}</div>
        <div className="text-xs text-slate-500 truncate">{desc}</div>
      </div>
      <ArrowRight size={14} className="text-slate-300 group-hover:text-blue-500 ml-auto shrink-0 transition-colors" />
    </button>
  );
}

function PrimaryCta({ title, desc, icon, color, onClick }: {
  title: string; desc: string; icon: ReactNode;
  color: 'blue' | 'purple'; onClick: () => void;
}) {
  const colors = {
    blue:   { ring: 'hover:ring-blue-300',   icon: 'bg-blue-100 text-blue-600 group-hover:bg-blue-600 group-hover:text-white' },
    purple: { ring: 'hover:ring-purple-300', icon: 'bg-purple-100 text-purple-600 group-hover:bg-purple-600 group-hover:text-white' },
  };
  const c = colors[color];
  return (
    <button onClick={onClick}
      className={`group card p-6 text-left hover:shadow-md transition-all hover:ring-2 ${c.ring}`}>
      <div className="flex items-start gap-4">
        <div className={`w-14 h-14 rounded-xl flex items-center justify-center transition-colors shrink-0 ${c.icon}`}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold text-slate-900 mb-1">{title}</div>
          <div className="text-sm text-slate-500">{desc}</div>
          <div className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-blue-600 group-hover:text-blue-800">
            開始 <ArrowRight size={14} />
          </div>
        </div>
      </div>
    </button>
  );
}

function InboxCard({
  tone, icon, title, primary, primaryLabel, lines, cta, empty,
}: {
  tone: 'blue' | 'amber' | 'emerald' | 'slate';
  icon: ReactNode;
  title: string;
  primary: string | number;
  primaryLabel: string;
  lines: string[];
  cta: { label: string; onClick: () => void };
  empty?: boolean;
}) {
  const tones = {
    blue:    { ring: 'border-blue-200',    iconWrap: 'bg-blue-50 text-blue-600',       value: 'text-blue-700',    cta: 'text-blue-600 hover:text-blue-800' },
    amber:   { ring: 'border-amber-300',   iconWrap: 'bg-amber-50 text-amber-600',     value: 'text-amber-700',   cta: 'text-amber-700 hover:text-amber-900' },
    emerald: { ring: 'border-emerald-200', iconWrap: 'bg-emerald-50 text-emerald-600', value: 'text-emerald-700', cta: 'text-emerald-700 hover:text-emerald-900' },
    slate:   { ring: 'border-slate-200',   iconWrap: 'bg-slate-100 text-slate-500',    value: 'text-slate-600',   cta: 'text-slate-600 hover:text-slate-900' },
  };
  const t = tones[tone];
  return (
    <div className={`rounded-xl border ${t.ring} bg-white p-4 flex flex-col gap-3 ${empty ? 'opacity-80' : ''}`}>
      <div className="flex items-center gap-2">
        <div className={`w-9 h-9 rounded-lg ${t.iconWrap} flex items-center justify-center`}>{icon}</div>
        <div className="text-sm font-semibold text-slate-900">{title}</div>
      </div>
      <div>
        <div className={`text-3xl font-bold leading-none ${t.value}`}>{primary}</div>
        <div className="text-xs text-slate-500 mt-1">{primaryLabel}</div>
      </div>
      {lines.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-600">
          {lines.map((l, i) => <li key={i}>• {l}</li>)}
        </ul>
      )}
      <div className="mt-auto pt-1">
        <button onClick={cta.onClick} className={`text-xs font-medium inline-flex items-center gap-1 ${t.cta}`}>
          {cta.label} <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

function PathCard({ letter, name, desc, tags, color }: {
  letter: string; name: string; desc: string; tags: string[];
  color: 'blue' | 'emerald' | 'purple';
}) {
  const colors = {
    blue:    { bg: 'bg-blue-600',    badge: 'badge-blue' },
    emerald: { bg: 'bg-emerald-600', badge: 'badge-green' },
    purple:  { bg: 'bg-purple-600',  badge: 'badge-purple' },
  };
  const c = colors[color];
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-8 h-8 rounded-lg ${c.bg} text-white flex items-center justify-center font-bold text-sm`}>
          {letter}
        </div>
        <div className="font-semibold text-slate-900 text-sm">Path {letter}: {name}</div>
      </div>
      <p className="text-xs text-slate-500 mb-3">{desc}</p>
      <div className="flex flex-wrap gap-1">
        {tags.map(t => <span key={t} className={`badge ${c.badge} text-[10px]`}>{t}</span>)}
      </div>
    </div>
  );
}
