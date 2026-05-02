import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { SubjectsSection } from './SubjectsSection';
import { RolesSection } from './RolesSection';
import { ResourcesSection } from './ResourcesSection';
import { PoliciesSection } from './PoliciesSection';
import { ActionsSection } from './ActionsSection';
import { PacksSection } from './PacksSection';

export type AccessSection = 'subjects' | 'roles' | 'resources' | 'policies' | 'actions' | 'packs';

const META: Record<AccessSection, { title: string; desc: string }> = {
  subjects:  { title: 'Subjects',  desc: 'Users, groups, and service accounts that can be authorized.' },
  roles:     { title: 'Roles',     desc: 'Named bundles of permissions assigned to subjects.' },
  resources: { title: 'Resources', desc: 'Tables, pages, and APIs that permissions are granted against.' },
  policies:  { title: 'Policies',  desc: 'Conditional authorization rules (ABAC / row-level).' },
  actions:   { title: 'Actions',   desc: 'Verbs a subject can perform on a resource (read, write, etc).' },
  packs:     { title: 'Permission Packs', desc: 'Reusable bundles of (resource, action) tuples — apply once, reuse across roles.' },
};

export function AccessSectionPage({ section }: { section: AccessSection }) {
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);

  const reload = useCallback(() => {
    const fetchers: Record<AccessSection, () => Promise<Record<string, unknown>[]>> = {
      subjects: api.subjects, roles: api.roles, resources: api.resources,
      policies: api.policies, actions: api.actions,
      // Role-pack list endpoint is wrapped — unwrap here so the section
      // contract (data: row[]) stays uniform.
      packs: () => api.rolePackList().then(r => r.packs as unknown as Record<string, unknown>[]),
    };
    fetchers[section]()
      .then(setData)
      .catch(() => {})
      .finally(() => setInitialLoading(false));
  }, [section]);

  useEffect(() => {
    setInitialLoading(true);
    setData([]);
    reload();
  }, [reload]);

  const meta = META[section];

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">{meta.title}</h1>
        <p className="page-desc">{meta.desc}</p>
      </div>

      <div className="card">
        {initialLoading ? (
          <div className="card-body text-center py-12 text-slate-400">Loading...</div>
        ) : (
          <>
            {section === 'subjects' && <SubjectsSection data={data} onReload={reload} />}
            {section === 'roles' && <RolesSection data={data} onReload={reload} />}
            {section === 'resources' && <ResourcesSection data={data} onReload={reload} />}
            {section === 'policies' && <PoliciesSection data={data} onReload={reload} />}
            {section === 'actions' && <ActionsSection data={data} onReload={reload} />}
            {section === 'packs' && <PacksSection data={data} onReload={reload} />}
          </>
        )}
      </div>
    </div>
  );
}
