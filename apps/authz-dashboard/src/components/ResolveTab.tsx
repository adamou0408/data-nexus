import { useAuthz } from '../AuthzContext';
import { JsonView } from './JsonView';
import { Shield, ChevronRight, Info } from 'lucide-react';

export function ResolveTab() {
  const { user, config } = useAuthz();

  // Use the already-resolved config from AuthzContext (no extra API call needed)
  const r = config as Record<string, unknown> | null;

  if (!user || !r) {
    return (
      <div className="space-y-6">
        <div className="page-header">
          <h1 className="page-title">My Permissions</h1>
          <p className="page-desc">Your resolved L0-L3 permission configuration</p>
        </div>
        <div className="card">
          <div className="card-body text-center py-16">
            <Info size={24} className="text-slate-400 mx-auto mb-3" />
            <p className="text-slate-500 text-sm">Select a user from the sidebar to view permissions</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="page-header">
        <h1 className="page-title">My Permissions</h1>
        <p className="page-desc">
          Resolved <span className="code">authz_resolve()</span> L0-L3 permission config for <strong>{user.label}</strong>
        </p>
      </div>

      {r && !r.error && (
        <>
          {/* Resolved Roles */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Shield size={16} className="text-blue-600" />
                Resolved Roles
              </h2>
            </div>
            <div className="card-body">
              <div className="flex gap-2 flex-wrap">
                {(r.resolved_roles as string[] || []).map((role: string) => (
                  <span key={role} className="badge badge-blue">{role}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Authorization Levels Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* L0 Functional */}
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">L0: Functional Access</h3>
                <span className="badge badge-green">{(r.L0_functional as unknown[])?.length ?? 0}</span>
              </div>
              <div className="table-container max-h-80">
                <table className="table">
                  <thead>
                    <tr><th>Resource</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {(r.L0_functional as { resource: string; action: string }[] || []).map((p, i) => (
                      <tr key={i}>
                        <td className="font-mono text-xs text-slate-700">{p.resource}</td>
                        <td><span className="badge badge-green">{p.action}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* L1 Data Scope */}
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">L1: Data Domain Scope</h3>
                <span className="badge badge-amber">
                  {Object.keys(r.L1_data_scope as Record<string, unknown> || {}).length}
                </span>
              </div>
              <div className="card-body">
                {Object.keys(r.L1_data_scope as Record<string, unknown> || {}).length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-4">No data scope policies apply</p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(
                      r.L1_data_scope as Record<string, { has_rls?: boolean; rls_expression?: string; resource_condition?: unknown }>
                    ).map(([name, policy]) => (
                      <div key={name} className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                        <div className="text-sm font-medium text-slate-900 mb-1.5">{name}</div>
                        <div className="text-xs bg-white px-3 py-2 rounded border border-amber-200 text-amber-800">
                          {policy.rls_expression
                            ? <span className="font-mono">WHERE {policy.rls_expression}</span>
                            : policy.has_rls
                              ? <span className="badge badge-amber">Row-level security active</span>
                              : <span className="text-slate-400">No row filter</span>
                          }
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* L2 Column Masks */}
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">L2: Column Masks</h3>
                <span className="badge badge-purple">
                  {Object.keys(r.L2_column_masks as Record<string, unknown> || {}).length}
                </span>
              </div>
              <div className="card-body">
                {Object.keys(r.L2_column_masks as Record<string, unknown> || {}).length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-4">No column mask rules apply</p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(
                      r.L2_column_masks as Record<string, Record<string, { mask_type: string; function?: string }>>
                    ).map(([policy, cols]) => (
                      <div key={policy} className="rounded-lg border border-purple-200 bg-purple-50/50 p-3">
                        <div className="text-sm font-medium text-slate-900 mb-2">{policy}</div>
                        <div className="space-y-1">
                          {Object.entries(cols).map(([col, rule]) => (
                            <div key={col} className="flex items-center gap-2 text-xs">
                              <span className="font-mono text-slate-700">{col}</span>
                              <ChevronRight size={12} className="text-slate-400" />
                              <span className="badge badge-purple">{rule.mask_type}</span>
                              {rule.function && <span className="text-slate-500">{rule.function}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* L3 Actions */}
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">L3: Composite Actions</h3>
                <span className="badge badge-indigo">
                  {(r.L3_actions as unknown[] || []).length}
                </span>
              </div>
              <div className="card-body">
                {(r.L3_actions as unknown[] || []).length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-4">No composite action policies</p>
                ) : (
                  <div className="space-y-3">
                    {(r.L3_actions as { action: string; resource: string; approval_chain: { step: number; required_role: string; min_approvers: number }[]; preconditions: Record<string, string> }[]).map((a, i) => (
                      <div key={i} className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="badge badge-indigo">{a.action}</span>
                          <span className="text-xs text-slate-500">on</span>
                          <span className="code">{a.resource}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-600">
                          {a.approval_chain.map((s, si) => (
                            <span key={si} className="flex items-center gap-1">
                              {si > 0 && <ChevronRight size={12} className="text-slate-400" />}
                              <span className="bg-white border border-indigo-200 rounded px-2 py-0.5">
                                Step {s.step}: {s.required_role}
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <JsonView data={r} />
        </>
      )}

      {r && 'error' in r && (
        <div className="card border-red-200 bg-red-50">
          <div className="card-body text-red-700 text-sm">{String(r.error)}</div>
        </div>
      )}
    </div>
  );
}
