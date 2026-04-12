import { useState, useEffect, ReactNode } from 'react';
import { useAuthz } from '../AuthzContext';
import { api } from '../api';
import {
  Users, Shield, Database, FileText,
  Layers, ArrowRight, CheckCircle2, XCircle,
  Lock, Eye,
} from 'lucide-react';

type Stats = {
  subjects: number;
  roles: number;
  resources: number;
  policies: number;
};

export function OverviewTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { user, config } = useAuthz();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    Promise.all([
      api.subjects(), api.roles(), api.resources(), api.policies(),
    ]).then(([s, r, res, p]) => {
      setStats({ subjects: s.length, roles: r.length, resources: res.length, policies: p.length });
    }).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="page-header">
        <h1 className="page-title">Dashboard Overview</h1>
        <p className="page-desc">
          Phison Data Nexus AuthZ platform status and quick actions
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<Users size={20} />} iconBg="bg-blue-100 text-blue-600"
          value={stats?.subjects ?? '-'} label="Subjects"
          onClick={() => onNavigate('browser')}
        />
        <StatCard
          icon={<Shield size={20} />} iconBg="bg-emerald-100 text-emerald-600"
          value={stats?.roles ?? '-'} label="Roles"
          onClick={() => onNavigate('browser')}
        />
        <StatCard
          icon={<Database size={20} />} iconBg="bg-purple-100 text-purple-600"
          value={stats?.resources ?? '-'} label="Resources"
          onClick={() => onNavigate('browser')}
        />
        <StatCard
          icon={<FileText size={20} />} iconBg="bg-amber-100 text-amber-600"
          value={stats?.policies ?? '-'} label="ABAC Policies"
          onClick={() => onNavigate('browser')}
        />
      </div>

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

                {/* L0 preview (top 6) */}
                <div>
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                    Functional Access (L0)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {config.L0_functional.slice(0, 8).map((p, i) => (
                      <div key={i} className="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-md px-2.5 py-1">
                        <span className="badge badge-green text-[10px]">{p.action}</span>
                        <span className="text-xs text-slate-700 font-mono">{p.resource}</span>
                      </div>
                    ))}
                    {config.L0_functional.length > 8 && (
                      <button onClick={() => onNavigate('resolve')}
                        className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
                        +{config.L0_functional.length - 8} more <ArrowRight size={12} />
                      </button>
                    )}
                  </div>
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
              icon={<Shield size={16} />} label="Resolve Permissions"
              desc="Full L0-L3 config for any user"
              onClick={() => onNavigate('resolve')}
            />
            <QuickAction
              icon={<Database size={16} />} label="RLS Simulator"
              desc="Compare data access side-by-side"
              onClick={() => onNavigate('rls')}
            />
            <QuickAction
              icon={<Grid3x3Icon />} label="Permission Matrix"
              desc="Role x Resource access grid"
              onClick={() => onNavigate('matrix')}
            />
            <QuickAction
              icon={<Table2Icon />} label="Data Workbench"
              desc="Live data with column masking"
              onClick={() => onNavigate('workbench')}
            />
          </div>
        </div>
      </div>

      {/* Three paths info */}
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
    </div>
  );
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

// Inline tiny icon components to avoid importing from lucide just for overview
function Grid3x3Icon() {
  return <Layers size={16} />;
}
function Table2Icon() {
  return <Database size={16} />;
}
