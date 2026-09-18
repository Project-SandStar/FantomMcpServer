/**
 * Tracks which EMBED_TEXT_VERSION each project's code vectors were written
 * with. LanceDB rows carry the model name but not the text layout, and adding
 * a column would force a table rebuild, so the record lives in a small JSON
 * file next to the vector store. `VectorStore.storeEmbeddings` records the
 * current version for the project on every write; `/admin/vectors/model-status`
 * reports projects whose recorded version is behind (or missing).
 */
import * as fs from 'fs';
import * as path from 'path';
import { EMBED_TEXT_VERSION } from './embeddingText.js';

interface VersionFile {
  projects: Record<string, { version: number; updatedAt: string }>;
}

function fileFor(): string {
  return path.resolve(process.env.FANTOM_CACHE_DIR || '.cache', 'embed-text-versions.json');
}

function load(): VersionFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(), 'utf-8')) as VersionFile;
    if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object') return parsed;
  } catch { /* first run or unreadable → empty */ }
  return { projects: {} };
}

let pending: VersionFile | null = null;
let flushTimer: NodeJS.Timeout | null = null;

/** Record that `projectId` just received vectors built with the current text
 *  layout. Writes are coalesced (a re-embed calls this per batch).
 *  `version` defaults to EMBED_TEXT_VERSION; VectorStore passes the version
 *  the TARGET TABLE can actually hold — a v3 build writing into a v2 table
 *  (no chunk/line columns) records 2 so model-status keeps the project stale
 *  until a full re-embed creates a v3 table. */
export function recordEmbedTextVersion(projectId: number | undefined, version: number = EMBED_TEXT_VERSION): void {
  if (typeof projectId !== 'number' || !Number.isFinite(projectId)) return;
  const data = pending ?? load();
  const cur = data.projects[String(projectId)];
  if (cur && cur.version === version) return;
  data.projects[String(projectId)] = { version, updatedAt: new Date().toISOString() };
  pending = data;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const out = pending;
      pending = null;
      if (!out) return;
      try {
        const f = fileFor();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(out, null, 2));
      } catch (err) {
        console.warn(`[embed-text-version] could not write ${fileFor()}: ${(err as Error).message}`);
      }
    }, 500);
    flushTimer.unref?.();
  }
}

export interface EmbedTextVersionStatus {
  current: number;
  /** Projects recorded at the current layout. */
  currentProjects: number[];
  /** Projects recorded at an older layout — re-embed them. */
  staleProjects: Array<{ projectId: number; version: number }>;
  /** Projects that hold vectors but were never recorded (written before
   *  tracking existed) — treat as stale. */
  unknownProjects: number[];
}

export function getEmbedTextVersionStatus(projectsWithVectors: number[]): EmbedTextVersionStatus {
  const data = pending ?? load();
  const currentProjects: number[] = [];
  const staleProjects: Array<{ projectId: number; version: number }> = [];
  const unknownProjects: number[] = [];
  for (const pid of projectsWithVectors) {
    const rec = data.projects[String(pid)];
    if (!rec) unknownProjects.push(pid);
    else if (rec.version >= EMBED_TEXT_VERSION) currentProjects.push(pid);
    else staleProjects.push({ projectId: pid, version: rec.version });
  }
  return { current: EMBED_TEXT_VERSION, currentProjects, staleProjects, unknownProjects };
}
