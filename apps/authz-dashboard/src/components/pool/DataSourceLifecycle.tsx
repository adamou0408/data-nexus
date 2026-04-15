import { useState, useEffect, useCallback } from 'react';
import { api, LifecycleResponse } from '../../api';
import { useToast } from '../Toast';
import { LifecycleStepper, PhaseCard, phaseLabels, phaseSummary } from './shared';
import { ConnectionPhase } from './ConnectionPhase';
import { DiscoveryPhase } from './DiscoveryPhase';
import { OrganizationPhase } from './OrganizationPhase';
import { ProfilesPhase } from './ProfilesPhase';
import { CredentialsPhase } from './CredentialsPhase';
import { DeploymentPhase } from './DeploymentPhase';
import { ArrowLeft } from 'lucide-react';

export function DataSourceLifecycle({ dsId, onBack }: { dsId: string; onBack: () => void }) {
  const toast = useToast();
  const [lifecycle, setLifecycle] = useState<LifecycleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const lc = await api.datasourceLifecycle(dsId);
      setLifecycle(lc);
      // Auto-expand first non-done phase
      if (!expanded) {
        const keys = ['connection', 'discovery', 'organization', 'profiles', 'credentials', 'deployment'] as const;
        const firstIncomplete = keys.find(k => lc.phases[k].status !== 'done');
        setExpanded(firstIncomplete || null);
      }
    } catch (err) { toast.error('Failed to load lifecycle'); console.warn(err); }
    finally { setLoading(false); }
  }, [dsId]);

  useEffect(() => { load(); }, [load]);

  const onMutate = () => { load(); };

  if (loading || !lifecycle) {
    return <div className="text-center py-20 text-slate-400">Loading lifecycle...</div>;
  }

  const phaseDone = Object.values(lifecycle.phases).filter(p => p.status === 'done').length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="btn-ghost btn-sm p-1.5"><ArrowLeft size={18} /></button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="page-title truncate">{lifecycle.display_name}</h1>
            <span className="badge badge-blue text-[10px]">{lifecycle.db_type}</span>
            {!lifecycle.is_active && <span className="badge badge-red text-[10px]">Inactive</span>}
          </div>
          <div className="text-xs text-slate-500 font-mono">{lifecycle.host}:{lifecycle.port}/{lifecycle.database_name}</div>
        </div>
        <div className="text-sm text-slate-500">{phaseDone}/6 phases</div>
      </div>

      {/* Progress stepper */}
      <div className="card p-4 sm:p-5">
        <LifecycleStepper phases={lifecycle.phases} />
      </div>

      {/* Phase cards */}
      <div className="space-y-3">
        {phaseLabels.map((p, i) => {
          const key = p.key as keyof LifecycleResponse['phases'];
          const phase = lifecycle.phases[key];
          const summaryText = phaseSummary(key, lifecycle.phases);
          return (
            <PhaseCard
              key={p.key}
              phase={p.key}
              index={i + 1}
              status={phase.status}
              title={p.label}
              summary={summaryText}
              expanded={expanded === p.key}
              onToggle={() => setExpanded(expanded === p.key ? null : p.key)}
            >
              {p.key === 'connection'   && <ConnectionPhase dsId={dsId} lifecycle={lifecycle} onMutate={onMutate} onPurged={onBack} />}
              {p.key === 'discovery'    && <DiscoveryPhase dsId={dsId} lifecycle={lifecycle} onMutate={onMutate} />}
              {p.key === 'organization' && <OrganizationPhase dsId={dsId} lifecycle={lifecycle} onMutate={onMutate} />}
              {p.key === 'profiles'     && <ProfilesPhase dsId={dsId} lifecycle={lifecycle} onMutate={onMutate} />}
              {p.key === 'credentials'  && <CredentialsPhase dsId={dsId} onMutate={onMutate} />}
              {p.key === 'deployment'   && <DeploymentPhase dsId={dsId} onMutate={onMutate} />}
            </PhaseCard>
          );
        })}
      </div>
    </div>
  );
}
