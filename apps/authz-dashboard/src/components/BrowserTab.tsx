import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { Users, Shield, Database, FileText, Zap } from 'lucide-react';
import { ReactNode } from 'react';
import { SubjectsSection } from './access-manager/SubjectsSection';
import { RolesSection } from './access-manager/RolesSection';
import { ResourcesSection } from './access-manager/ResourcesSection';
import { PoliciesSection } from './access-manager/PoliciesSection';
import { ActionsSection } from './access-manager/ActionsSection';

export type Section = 'subjects' | 'roles' | 'resources' | 'policies' | 'actions';

const sections: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'subjects',  label: 'Subjects',  icon: <Users size={14} /> },
  { id: 'roles',     label: 'Roles',     icon: <Shield size={14} /> },
  { id: 'resources', label: 'Resources', icon: <Database size={14} /> },
  { id: 'policies',  label: 'Policies',  icon: <FileText size={14} /> },
  { id: 'actions',   label: 'Actions',   icon: <Zap size={14} /> },
];

export function BrowserTab({ initialSection, onSectionChange }: {
  initialSection?: Section;
  onSectionChange?: (section: Section) => void;
}) {
  const [section, setSection] = useState<Section>(initialSection || 'subjects');
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);

  // Sync section when sidebar navigates to a different access-* tab
  useEffect(() => {
    if (initialSection && initialSection !== section) {
      setSection(initialSection);
    }
  }, [initialSection]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeSection = (s: Section) => {
    setSection(s);
    onSectionChange?.(s);
  };

  const reload = useCallback(() => {
    const fetchers = { subjects: api.subjects, roles: api.roles, resources: api.resources, policies: api.policies, actions: api.actions };
    setLoading(true);
    fetchers[section]().then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [section]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Access Manager</h1>
        <p className="page-desc">Manage identity and access control — subjects, roles, resources, policies, and actions</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button key={s.id} onClick={() => changeSection(s.id)}
            className={`btn btn-sm gap-1.5 ${
              section === s.id
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
            }`}>
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <div className="card-body text-center py-12 text-slate-400">Loading...</div>
        ) : (
          <>
            {section === 'subjects' && <SubjectsSection data={data} onReload={reload} />}
            {section === 'roles' && <RolesSection data={data} onReload={reload} />}
            {section === 'resources' && <ResourcesSection data={data} onReload={reload} />}
            {section === 'policies' && <PoliciesSection data={data} onReload={reload} />}
            {section === 'actions' && <ActionsSection data={data} onReload={reload} />}
          </>
        )}
      </div>
    </div>
  );
}
