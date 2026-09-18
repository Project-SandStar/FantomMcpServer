/**
 * Per-project record of which sidecar last embedded the project. Persisted
 * to a small JSON file so the dashboard can attribute work to a device
 * even after a server restart. Keyed by projectId.
 */

import * as fs from 'fs';
import * as path from 'path';

const META_PATH = path.join(process.cwd(), '.cache', 'projectEmbeddingMeta.json');

/** Test seam — redirect the store so a test never reads or writes `.cache/`. */
let metaPathOverride: string | null = null;
export function __setMetaPathForTest(p: string | null): void { metaPathOverride = p; }
function metaPath(): string { return metaPathOverride ?? META_PATH; }

export interface ProjectEmbeddingMeta {
  projectId: number;
  sidecarName?: string | null;
  sidecarHost?: string | null;
  sidecarModel?: string | null;
  /** Whether this run used in-process Xenova (true) or a sidecar (false). */
  inProcess?: boolean;
  embeddedAt: string;
  /** Number of vectors written in the most recent embedding pass. */
  lastProcessed?: number;
  /** Sidecar Fantom picked before the run (may differ from sidecarName after failover). */
  selectedSidecarName?: string | null;
  /** Who actually returned vectors, by texts served, descending. */
  servedBy?: Array<{ name: string; texts: number }>;
}

type MetaMap = Record<string, ProjectEmbeddingMeta>;

function load(): MetaMap {
  try {
    const p = metaPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as MetaMap;
  } catch {
    return {};
  }
}

function save(m: MetaMap): void {
  try {
    const p = metaPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(m, null, 2));
  } catch (err) {
    console.warn('[projectEmbeddingMeta] save failed:', (err as Error).message);
  }
}

export function recordProjectEmbedding(meta: ProjectEmbeddingMeta): void {
  const m = load();
  m[String(meta.projectId)] = meta;
  save(m);
}

export function getProjectEmbeddingMeta(projectId: number): ProjectEmbeddingMeta | null {
  const m = load();
  return m[String(projectId)] ?? null;
}

export function getAllProjectEmbeddingMeta(): MetaMap {
  return load();
}

/**
 * Fleet-wide fan-out split across every project's most recent pass —
 * provider name → texts embedded. This is what makes a mixed local/cloud run
 * legible: a cloud provider appears as `<PCName>-OR-CodeEmbedding` beside the
 * local hosts with its real share, rather than being invisible behind a
 * single "primary" sidecar that served only part of the work.
 *
 * It is also the isolation handle the compatibility gate implies: if a
 * provider is later found to have been producing incompatible vectors, the
 * projects it touched can be re-embedded instead of forcing a full rebuild.
 */
export function getFleetEmbeddingSplit(): Array<{ provider: string; texts: number; projects: number; cloud: boolean }> {
  const totals = new Map<string, { texts: number; projects: number }>();
  for (const meta of Object.values(load())) {
    for (const { name, texts } of meta.servedBy ?? []) {
      const t = totals.get(name) ?? { texts: 0, projects: 0 };
      t.texts += texts;
      t.projects += 1;
      totals.set(name, t);
    }
  }
  return [...totals.entries()]
    .map(([provider, t]) => ({ provider, ...t, cloud: provider.includes('-OR-') }))
    .sort((a, b) => b.texts - a.texts);
}
