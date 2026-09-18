/**
 * File- and project-level embedding rows (EMBED_TEXT_VERSION 3).
 *
 * A code question is often about a FILE ("which file handles the websocket
 * reconnect") or the PROJECT ("what does this project do"), but v1/v2 only had
 * symbol vectors. This module derives one synthetic item per indexed file
 * (`node_id = file:<sha1(path)>`, node_type 'file') and one per project
 * (`node_id = project:<id>`, node_type 'project') from the node list a write
 * site already holds — no extra graph queries. They have no CodeNode; search
 * builds their results from the LanceDB row (qualified_name / file_path).
 *
 * Gated by settings.semanticSearch.embedFileChunks / embedProjectChunks
 * (default true) and by EMBED_TEXT_V3.
 */
import type { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/index.js';
import {
  EMBED_TEXT_V3,
  buildFileEmbeddingText,
  buildProjectEmbeddingText,
  fileNodeId,
  projectNodeId,
  type EmbeddingItem,
} from './embeddingText.js';

const logger = createLogger('embed-synthetic');

export interface SyntheticSourceNode {
  id: string;
  name?: string | null;
  qualifiedName: string;
  nodeType?: string | null;
  filePath?: string | null;
}

export interface SyntheticItemOptions {
  /** Only build file rows for these paths (incremental reindex) and skip the
   *  project row. Default: every distinct file in `nodes` + the project row. */
  filePaths?: string[];
  /** Override the settings flags (tests). */
  embedFileChunks?: boolean;
  embedProjectChunks?: boolean;
}

export function readSyntheticFlags(): { embedFileChunks: boolean; embedProjectChunks: boolean } {
  try {
    const cfgPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const ss = cfg?.semanticSearch ?? {};
      return {
        embedFileChunks: ss.embedFileChunks !== false,
        embedProjectChunks: ss.embedProjectChunks !== false,
      };
    }
  } catch { /* defaults below */ }
  return { embedFileChunks: true, embedProjectChunks: true };
}

/** Top-level symbol = nothing after the last `::` contains a member dot
 *  (`ns::Class.method` is a member; `src/x.ts::fn` and `pod::Class` are not). */
export function isTopLevelSymbol(qualifiedName: string, nodeType?: string | null): boolean {
  const nt = (nodeType || '').toLowerCase();
  if (['class', 'mixin', 'interface', 'enum', 'facet', 'struct', 'type'].includes(nt)) return true;
  const idx = qualifiedName.lastIndexOf('::');
  const tail = idx >= 0 ? qualifiedName.slice(idx + 2) : qualifiedName;
  return !tail.includes('.');
}

function readFirstExisting(dir: string, names: string[], maxBytes = 200_000): string | null {
  for (const n of names) {
    try {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      if (st.isFile() && st.size <= maxBytes) return fs.readFileSync(p, 'utf-8');
    } catch { /* next */ }
  }
  return null;
}

/** `summary = "…"` and `depends = ["sys 1.0", …]` from a build.fan. */
export function parseBuildFan(src: string): { summary?: string; depends: string[] } {
  const summary = src.match(/^\s*summary\s*=\s*"([^"]*)"/m)?.[1];
  const depends: string[] = [];
  const dep = src.match(/^\s*depends\s*=\s*\[([\s\S]*?)\]/m)?.[1];
  if (dep) {
    for (const m of dep.matchAll(/"([^"\s]+)[^"]*"/g)) if (!depends.includes(m[1])) depends.push(m[1]);
  }
  return { summary, depends };
}

export function parsePackageJson(src: string): { description?: string; depends: string[] } {
  try {
    const pkg = JSON.parse(src) as { description?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return {
      description: pkg.description,
      depends: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})],
    };
  } catch {
    return { depends: [] };
  }
}

/**
 * Build the synthetic file/project items for `projectId` from the node list a
 * write site is about to embed. Best-effort: any failure yields fewer items,
 * never a throw.
 */
export async function buildSyntheticItems(
  prisma: PrismaClient,
  projectId: number,
  nodes: SyntheticSourceNode[],
  opts: SyntheticItemOptions = {},
): Promise<EmbeddingItem[]> {
  const items: EmbeddingItem[] = [];
  if (!EMBED_TEXT_V3) return items;
  const flags = readSyntheticFlags();
  const doFiles = opts.embedFileChunks ?? flags.embedFileChunks;
  const doProject = (opts.embedProjectChunks ?? flags.embedProjectChunks) && !(opts.filePaths && opts.filePaths.length > 0);
  if (!doFiles && !doProject) return items;

  let project: { name: string; path: string; language: string | null; description: string | null; libraries: string | null; podName: string | null } | null = null;
  try {
    project = await prisma.fantomProject.findUnique({
      where: { id: projectId },
      select: { name: true, path: true, language: true, description: true, libraries: true, podName: true },
    });
  } catch (err) {
    logger.warn(`buildSyntheticItems: project ${projectId} lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const projectName = project?.name ?? `project-${projectId}`;
  const root = project?.path ?? '';

  if (doFiles) {
    const only = opts.filePaths ? new Set(opts.filePaths) : null;
    const byFile = new Map<string, Array<{ name: string; kind: string }>>();
    for (const n of nodes) {
      const fp = n.filePath;
      if (!fp) continue;
      if (only && !only.has(fp)) continue;
      const list = byFile.get(fp) ?? [];
      if (isTopLevelSymbol(n.qualifiedName, n.nodeType)) {
        list.push({ name: n.name || n.qualifiedName.split('::').pop() || n.qualifiedName, kind: n.nodeType || 'symbol' });
      }
      byFile.set(fp, list);
    }
    // A requested file with no surviving nodes still gets a row (its symbol list is empty).
    if (only) for (const fp of only) if (!byFile.has(fp)) byFile.set(fp, []);
    for (const [fp, symbols] of byFile) {
      if (!fs.existsSync(fp)) continue;
      let rel = fp;
      if (root && fp.startsWith(root)) rel = path.relative(root, fp);
      else if (root) {
        const r = path.relative(root, fp);
        if (!r.startsWith('..')) rel = r;
      }
      const text = buildFileEmbeddingText({ filePath: fp, relativePath: rel, projectName, symbols });
      items.push({
        nodeId: fileNodeId(fp),
        nodeType: 'file',
        qualifiedName: `${projectName}::${rel.replace(/\\/g, '/')}`,
        filePath: fp,
        chunkIndex: 0,
        chunkCount: 1,
        lineStart: 1,
        lineEnd: 1,
        text,
      });
    }
  }

  if (doProject && project) {
    let depends: string[] = [];
    let description = project.description ?? undefined;
    const buildFan = root ? readFirstExisting(root, ['build.fan']) : null;
    if (buildFan) {
      const b = parseBuildFan(buildFan);
      depends = b.depends;
      description = description || b.summary;
    }
    const pkg = root ? readFirstExisting(root, ['package.json']) : null;
    if (pkg) {
      const p = parsePackageJson(pkg);
      depends = [...depends, ...p.depends.filter((d) => !depends.includes(d))];
      description = description || p.description;
    }
    let libraries: string[] = [];
    try {
      const parsed = project.libraries ? JSON.parse(project.libraries) : [];
      if (Array.isArray(parsed)) libraries = parsed.map(String);
    } catch { /* ignore */ }
    const readme = root ? readFirstExisting(root, ['README.md', 'readme.md', 'README.MD', 'README.txt', 'README', 'Readme.md']) : null;
    const text = buildProjectEmbeddingText({
      name: projectName,
      language: project.language,
      description,
      readme,
      depends,
      libraries,
      path: root,
    });
    items.push({
      nodeId: projectNodeId(projectId),
      nodeType: 'project',
      qualifiedName: projectName,
      filePath: root,
      chunkIndex: 0,
      chunkCount: 1,
      lineStart: 1,
      lineEnd: 1,
      text,
    });
  }

  return items;
}
