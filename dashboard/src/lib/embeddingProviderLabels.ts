/**
 * Label rules for the per-project "embedded by" column.
 *
 * `servedBy` names come in four shapes:
 *  - `worker1` … `workerN`: a pool slot of Fantom's direct OpenRouter path
 *    (src/openrouter/workerAttribution.ts). Shown per worker.
 *  - `Fantom-OR-<Role>`: the direct path without a slot (query lane, or a row
 *    written before slots were recorded). Shown as "OpenRouter".
 *  - `<PCName>-OR-<Role>`: the old sidecar-proxied OpenRouter route. All of
 *    them fold into one "legacy sidecar route" entry, so old PC names stop
 *    showing; the re-embed replaces those rows over time.
 *  - anything else: a local GPU host, shown by host name without `.local`.
 */

export type ProviderKind = 'worker' | 'direct' | 'legacy' | 'local';

export const LEGACY_SIDECAR_LABEL = 'legacy sidecar route';
export const DIRECT_LABEL = 'OpenRouter';

export function providerKind(name: string): ProviderKind {
  if (/^worker\d+$/.test(name)) return 'worker';
  if (name.startsWith('Fantom-OR-')) return 'direct';
  if (name.includes('-OR-')) return 'legacy';
  return 'local';
}

/** OpenRouter-backed (cloud) rather than a local GPU. */
export function isCloudProvider(name: string): boolean {
  return providerKind(name) !== 'local';
}

export function providerLabel(name: string): string {
  switch (providerKind(name)) {
    case 'worker': return name;
    case 'direct': return DIRECT_LABEL;
    case 'legacy': return LEGACY_SIDECAR_LABEL;
    default: return name.replace(/\.local$/, '');
  }
}

export interface ServedEntry { label: string; cloud: boolean; texts: number; pct: number }

/**
 * Group raw `servedBy` entries by label (all legacy PC names become one
 * entry), sort by texts descending, and give each its share in percent.
 */
export function groupServedBy(by: ReadonlyArray<{ name: string; texts: number }>): ServedEntry[] {
  const total = by.reduce((n, x) => n + x.texts, 0) || 1;
  const groups = new Map<string, { cloud: boolean; texts: number }>();
  for (const x of by) {
    const label = providerLabel(x.name);
    const g = groups.get(label) ?? { cloud: isCloudProvider(x.name), texts: 0 };
    g.texts += x.texts;
    groups.set(label, g);
  }
  return [...groups.entries()]
    .map(([label, g]) => ({ label, cloud: g.cloud, texts: g.texts, pct: Math.round((g.texts / total) * 100) }))
    .sort((a, b) => b.texts - a.texts || a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/**
 * Did the provider Fantom SELECTED serve nothing? A direct run selects
 * `Fantom-OR-<Role>` but credits its pool workers, so a direct selection
 * served by any `workerN` is not a failover.
 */
export function isFailover(
  selected: string | null | undefined,
  sidecarName: string | null | undefined,
  servedBy: ReadonlyArray<{ name: string }> | null | undefined,
): boolean {
  if (!selected) return false;
  if (!servedBy?.length) return selected !== sidecarName;
  if (servedBy.some(s => s.name === selected)) return false;
  if (providerKind(selected) === 'direct' && servedBy.some(s => providerKind(s.name) === 'worker')) return false;
  return true;
}

/**
 * The fleet "Fan-out" strip, with the same grouping as the per-row column.
 * `projects` for a group is the largest member count (one project can be
 * served by several workers, so a sum would count it twice).
 */
export function groupFleetSplit(
  rows: ReadonlyArray<{ provider: string; texts: number; projects: number }>,
): Array<{ label: string; cloud: boolean; texts: number; projects: number }> {
  const groups = new Map<string, { cloud: boolean; texts: number; projects: number }>();
  for (const r of rows) {
    const label = providerLabel(r.provider);
    const g = groups.get(label) ?? { cloud: isCloudProvider(r.provider), texts: 0, projects: 0 };
    g.texts += r.texts;
    g.projects = Math.max(g.projects, r.projects);
    groups.set(label, g);
  }
  return [...groups.entries()]
    .map(([label, g]) => ({ label, ...g }))
    .sort((a, b) => b.texts - a.texts || a.label.localeCompare(b.label, undefined, { numeric: true }));
}
