/**
 * Discover Fantom pods under an instance's sourcePath, and register them in
 * the `pods` table so the dashboard's Fantom Pods page lists them.
 *
 * Layouts:
 *   flat    src/<pod>/fan/*.fan
 *   nested  src/<category>/<pod>/fan/*.fan   (Haxall)
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SourcePodCandidate { name: string; path: string; category?: string }

function subdirs(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch { return []; }
}

/** Pod folders under sourcePath (flat and one nested level). */
export function discoverSourcePods(sourcePath: string): SourcePodCandidate[] {
  const out: SourcePodCandidate[] = [];
  for (const dir of subdirs(sourcePath)) {
    const dirPath = path.join(sourcePath, dir);
    if (fs.existsSync(path.join(dirPath, 'fan'))) {
      out.push({ name: dir, path: dirPath });
      continue;
    }
    for (const nested of subdirs(dirPath)) {
      const nestedPath = path.join(dirPath, nested);
      if (fs.existsSync(path.join(nestedPath, 'fan'))) out.push({ name: nested, path: nestedPath, category: dir });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SourcePodSyncDeps {
  listInstances(): Promise<Array<{ id: number; name: string; version?: string | null; sourcePath?: string | null }>>;
  listPodPaths(): Promise<string[]>;
  createPod(input: { name: string; path: string; description?: string; defaultInstanceId?: number; compatVersions?: string[] }): Promise<unknown>;
}

/**
 * Create a `pods` row for every source pod that has none yet (matched by
 * path). Never changes or deletes existing rows. Returns the paths created.
 */
export async function syncInstanceSourcePods(deps: SourcePodSyncDeps): Promise<string[]> {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  const have = new Set((await deps.listPodPaths()).map(norm));
  const created: string[] = [];
  for (const inst of await deps.listInstances()) {
    const src = inst.sourcePath?.trim();
    if (!src || !fs.existsSync(src)) continue;
    for (const pod of discoverSourcePods(src)) {
      const p = norm(pod.path);
      if (have.has(p)) continue;
      await deps.createPod({
        name: pod.name,
        path: p,
        description: `Source of ${inst.name}${pod.category ? ` (${pod.category}/${pod.name})` : ''}`,
        defaultInstanceId: inst.id,
        compatVersions: inst.version ? [inst.version] : undefined,
      });
      have.add(p);
      created.push(p);
    }
  }
  return created;
}
