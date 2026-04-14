/** Lowercase slug: "My New Thing" → "my_new_thing" */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Per-entity auto-ID generators */
export const autoId = {
  subject: (name: string, type: string) => {
    const slug = slugify(name);
    return slug ? `${type}:${slug}` : '';
  },
  role: (name: string) => slugify(name).toUpperCase(),
  resource: (name: string, type: string) => {
    const slug = slugify(name);
    return slug ? `${type}:${slug}` : '';
  },
  policy: (description: string) => slugify(description),
  action: (name: string) => slugify(name),
  dataSource: (name: string) => {
    const slug = slugify(name);
    return slug ? `ds:${slug}` : '';
  },
  poolProfile: (name: string) => {
    const slug = slugify(name);
    return slug ? `pool:${slug}` : '';
  },
  pgRole: (profileId: string) => {
    const suffix = profileId.replace(/^pool:/, '');
    return suffix ? `nexus_${suffix}` : '';
  },
};

/**
 * Deduplicate: if `base` already exists in `existingIds`, append _2, _3, etc.
 * "user:john_smith" + ["user:john_smith"] → "user:john_smith_2"
 */
export function uniqueId(base: string, existingIds: string[]): string {
  if (!base || !existingIds.includes(base)) return base;
  let i = 2;
  while (existingIds.includes(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}
