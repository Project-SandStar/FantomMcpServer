/**
 * Facts for knowledge cards, gathered from the per-project code graph and the
 * source files BEFORE any model call: the node, its numbered source lines,
 * depth-1 callers / callees / containment / inheritance, and a sha256 of
 * every file used.
 *
 * Graph reads are depth-1 and batched, one project at a time, through
 * projectQuery (no variable-length walks; see the pool notes in
 * projectGraphConnection.ts).
 *
 * Pod and project nodes do not exist in the graph. Their cards use synthetic
 * ids `project:<id>` and `pod:<name>`; links still come from graph edges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectQuery } from '../graph/projectGraphConnection.js';
import { mapPath } from '../utils/pathMapping.js';
import type { CardKind, CardLink, CardSource } from './cardStore.js';
import type { KnowledgeCardSettings } from './cardSettings.js';

export interface GraphNodeRow {
  id: string;
  node_type: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number;
  line_end: number;
  signature: string;
  documentation: string;
  parent_type: string;
  is_public: boolean;
}

export interface CardTarget {
  nodeId: string;
  kind: CardKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  /** Calls into this node (rank key). */
  fanIn: number;
  /** For pod / project cards: member node ids. */
  members?: string[];
}

export interface CardFacts {
  target: CardTarget;
  /** Prompt text: numbered source and graph facts. */
  factText: string;
  /** file → allowed line ranges (claims outside are cut). */
  allowed: Map<string, Array<[number, number]>>;
  sources: CardSource[];
  links: CardLink[];
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const FUNC_TYPES = ['method', 'function', 'constructor'];
const CLASS_TYPES = ['class', 'mixin', 'enum', 'facet', 'type'];

export function sha256File(file: string): string | null {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/** Container path for a graph file_path (path mappings), or the path as is. */
export function localPath(p: string): string {
  try { return mapPath(p) || p; } catch { return p; }
}

const fileCache = new Map<string, string[] | null>();
function fileLines(file: string): string[] | null {
  if (fileCache.has(file)) return fileCache.get(file)!;
  let lines: string[] | null = null;
  try { lines = fs.readFileSync(localPath(file), 'utf-8').split('\n'); } catch { lines = null; }
  if (fileCache.size > 200) fileCache.clear();
  fileCache.set(file, lines);
  return lines;
}
export function clearFactFileCache(): void { fileCache.clear(); }

/** Pod name for a Fantom/Haxall source path: the folder that holds `fan/`, else the parent folder. */
export function podOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  const i = parts.lastIndexOf('fan');
  if (i > 0) return parts[i - 1];
  return parts.length >= 2 ? parts[parts.length - 2] : 'root';
}

const NODE_COLS = `n.id AS id, n.node_type AS node_type, n.name AS name, n.qualified_name AS qualified_name,
  n.file_path AS file_path, n.line_start AS line_start, n.line_end AS line_end, n.signature AS signature,
  n.documentation AS documentation, n.parent_type AS parent_type, n.is_public AS is_public`;

/**
 * Pick the nodes that get a card, highest fan-in first, capped at
 * maxCardsPerProject (pod and project cards included in the cap).
 */
export async function selectTargets(projectId: number, s: KnowledgeCardSettings, projectName: string): Promise<CardTarget[]> {
  const types = [...(s.kinds.functions ? FUNC_TYPES : []), ...(s.kinds.classes ? CLASS_TYPES : [])];
  const out: CardTarget[] = [];
  let nodes: GraphNodeRow[] = [];
  if (types.length || s.kinds.pods || s.kinds.projects) {
    const all = [...FUNC_TYPES, ...CLASS_TYPES].map(t => `'${t}'`).join(',');
    nodes = await projectQuery<GraphNodeRow>(projectId,
      `MATCH (n:CodeNode) WHERE n.node_type IN [${all}] RETURN ${NODE_COLS}`);
  }
  const fanRows = await projectQuery<{ id: string; c: number }>(projectId,
    `MATCH (a:CodeNode)-[e:CodeEdge]->(n:CodeNode) WHERE e.edge_type = 'calls' RETURN n.id AS id, count(a) AS c`);
  const fan = new Map(fanRows.map(r => [String(r.id), Number(r.c)]));
  const span = (n: GraphNodeRow) => Math.max(1, Number(n.line_end) - Number(n.line_start) + 1);
  const cardable = nodes.filter(n =>
    types.includes(n.node_type) && n.is_public !== false && span(n) >= s.minLines && !/^(_|test|mock)/i.test(n.name)
    && !/([\\/](__tests__|tests?|spec|mocks?|node_modules|build|dist)[\\/])|\.(test|spec)\.[jt]sx?$/i.test(n.file_path));
  cardable.sort((a, b) => (fan.get(b.id) ?? 0) - (fan.get(a.id) ?? 0) || span(b) - span(a));

  if (s.kinds.projects) {
    out.push({ nodeId: `project:${projectId}`, kind: 'project', name: projectName, qualifiedName: projectName,
      filePath: '', lineStart: 0, lineEnd: 0, fanIn: Number.MAX_SAFE_INTEGER,
      members: nodes.filter(n => CLASS_TYPES.includes(n.node_type)).map(n => n.id) });
  }
  if (s.kinds.pods) {
    const pods = new Map<string, string[]>();
    for (const n of nodes) {
      if (!CLASS_TYPES.includes(n.node_type)) continue;
      // Only real Fantom pods (a folder holding fan/); other projects get no pod cards.
      if (!/[\\/]fan[\\/]/.test(n.file_path)) continue;
      const p = podOf(n.file_path);
      if (!pods.has(p)) pods.set(p, []);
      pods.get(p)!.push(n.id);
    }
    if (pods.size > 1 || !s.kinds.projects) {
      for (const [p, ids] of pods) {
        out.push({ nodeId: `pod:${p}`, kind: 'pod', name: p, qualifiedName: p, filePath: '', lineStart: 0, lineEnd: 0,
          fanIn: Number.MAX_SAFE_INTEGER - 1, members: ids });
      }
    }
  }
  for (const n of cardable) {
    if (out.length >= s.maxCardsPerProject) break;
    out.push({
      nodeId: n.id, kind: CLASS_TYPES.includes(n.node_type) ? 'class' : 'function', name: n.name,
      qualifiedName: n.qualified_name, filePath: n.file_path, lineStart: Number(n.line_start), lineEnd: Number(n.line_end),
      fanIn: fan.get(n.id) ?? 0,
    });
  }
  return out.slice(0, s.maxCardsPerProject);
}

interface EdgeRow { a: string; an: string; aq: string; af: string; al: number; b: string; bn: string; bq: string; bf: string; bl: number; t: string; line: number }

/** Depth-1 edges touching `ids` (both directions), one query each way. */
async function edgesFor(projectId: number, ids: string[]): Promise<EdgeRow[]> {
  if (ids.length === 0) return [];
  const list = ids.map(i => `'${esc(i)}'`).join(',');
  const cols = `a.id AS a, a.name AS an, a.qualified_name AS aq, a.file_path AS af, a.line_start AS al,
    b.id AS b, b.name AS bn, b.qualified_name AS bq, b.file_path AS bf, b.line_start AS bl, e.edge_type AS t, e.line_number AS line`;
  const types = `['calls','contains','extends','implements','overrides']`;
  const outRows = await projectQuery<EdgeRow>(projectId,
    `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode) WHERE a.id IN [${list}] AND e.edge_type IN ${types} RETURN ${cols}`);
  const inRows = await projectQuery<EdgeRow>(projectId,
    `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode) WHERE b.id IN [${list}] AND e.edge_type IN ${types} RETURN ${cols}`);
  return [...outRows, ...inRows];
}

async function nodesByIds(projectId: number, ids: string[]): Promise<GraphNodeRow[]> {
  if (ids.length === 0) return [];
  const list = ids.map(i => `'${esc(i)}'`).join(',');
  return projectQuery<GraphNodeRow>(projectId, `MATCH (n:CodeNode) WHERE n.id IN [${list}] RETURN ${NODE_COLS}`);
}

function numbered(file: string, start: number, end: number, maxLines: number): { text: string; range: [number, number] } | null {
  const lines = fileLines(file);
  if (!lines) return null;
  const s = Math.max(1, start);
  const e = Math.min(lines.length, Math.max(s, end), s + maxLines - 1);
  const body = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l.length > 240 ? l.slice(0, 240) + '…' : l}`).join('\n');
  return { text: body, range: [s, e] };
}

const MAX_NEIGHBOURS = 12;

/**
 * Gather facts for a batch of targets of one project. One pair of edge
 * queries per batch, not per target.
 */
export async function gatherFacts(projectId: number, targets: CardTarget[]): Promise<CardFacts[]> {
  const symbolIds = targets.filter(t => t.kind === 'class' || t.kind === 'function').map(t => t.nodeId);
  const edges = await edgesFor(projectId, symbolIds);
  const byNode = new Map<string, EdgeRow[]>();
  for (const e of edges) {
    for (const id of [e.a, e.b]) {
      if (!symbolIds.includes(id)) continue;
      if (!byNode.has(id)) byNode.set(id, []);
      byNode.get(id)!.push(e);
    }
  }
  const memberIds = [...new Set(targets.flatMap(t => (t.members ?? []).slice(0, 40)))];
  const members = new Map((await nodesByIds(projectId, memberIds)).map(n => [n.id, n]));
  const selfRows = new Map((await nodesByIds(projectId, symbolIds)).map(n => [n.id, n]));

  const out: CardFacts[] = [];
  for (const t of targets) {
    const allowed = new Map<string, Array<[number, number]>>();
    const files = new Map<string, { lineStart: number; lineEnd: number; symbol?: string }>();
    const allow = (f: string, r: [number, number]) => {
      if (!allowed.has(f)) allowed.set(f, []);
      allowed.get(f)!.push(r);
      const cur = files.get(f);
      files.set(f, { lineStart: Math.min(cur?.lineStart ?? r[0], r[0]), lineEnd: Math.max(cur?.lineEnd ?? r[1], r[1]) });
    };
    const parts: string[] = [];
    const links: CardLink[] = [];

    if (t.kind === 'class' || t.kind === 'function') {
      const self = selfRows.get(t.nodeId);
      parts.push(`SUBJECT: ${t.kind} ${t.qualifiedName}`);
      if (self?.signature) parts.push(`Signature: ${self.signature}`);
      if (self?.parent_type) parts.push(`Parent type: ${self.parent_type}`);
      parts.push(`Location: ${t.filePath}:${t.lineStart}-${t.lineEnd}`);
      const src = numbered(t.filePath, t.lineStart - (self?.documentation ? 6 : 0), t.lineEnd, t.kind === 'class' ? 160 : 120);
      if (src) {
        allow(t.filePath, src.range);
        parts.push(`SOURCE ${t.filePath} (lines ${src.range[0]}-${src.range[1]}):\n${src.text}`);
      } else {
        parts.push('SOURCE: (file not readable)');
      }
      const rel = byNode.get(t.nodeId) ?? [];
      const seen = new Set<string>();
      const groups: Record<string, string[]> = {};
      for (const e of rel) {
        const outgoing = e.a === t.nodeId;
        const otherId = outgoing ? e.b : e.a;
        const relation: CardLink['relation'] = e.t === 'calls' ? (outgoing ? 'callee' : 'caller')
          : e.t === 'contains' ? (outgoing ? 'contains' : 'contained-by')
            : e.t === 'implements' ? 'implements' : 'extends';
        const key = `${relation}:${otherId}`;
        if (seen.has(key) || otherId === t.nodeId) continue;
        seen.add(key);
        const name = outgoing ? e.bq || e.bn : e.aq || e.an;
        const file = outgoing ? e.bf : e.af;
        const line = Number(outgoing ? e.bl : e.al) || 0;
        links.push({ nodeId: otherId, name, relation });
        (groups[relation] ??= []);
        if (groups[relation].length < MAX_NEIGHBOURS) {
          // The call site is a line inside the subject (callee) or inside the caller.
          const site = Number(e.line) || 0;
          const siteFile = outgoing ? t.filePath : file;
          groups[relation].push(`- ${name} (${file}:${line})${site && e.t === 'calls' ? ` call site ${siteFile}:${site}` : ''}`);
          if (file && line) allow(file, [line, line]);
          if (site && siteFile && e.t === 'calls') allow(siteFile, [site, site]);
        }
      }
      for (const [rname, list] of Object.entries(groups)) {
        const total = links.filter(l => l.relation === rname).length;
        parts.push(`GRAPH ${rname.toUpperCase()} (${total}${total > list.length ? `, first ${list.length}` : ''}):\n${list.join('\n')}`);
      }
      if (!Object.keys(groups).length) parts.push('GRAPH: no callers, callees or containment edges recorded.');
    } else {
      parts.push(`SUBJECT: ${t.kind} ${t.name}`);
      const ms = (t.members ?? []).map(id => members.get(id)).filter((n): n is GraphNodeRow => !!n).slice(0, 40);
      parts.push(`MEMBER TYPES (${t.members?.length ?? 0}${(t.members?.length ?? 0) > ms.length ? `, first ${ms.length}` : ''}):`);
      for (const m of ms) {
        const doc = (m.documentation ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
        parts.push(`- ${m.qualified_name} ${m.node_type} (${m.file_path}:${m.line_start})${doc ? ` — ${doc}` : ''}`);
        allow(m.file_path, [Number(m.line_start), Number(m.line_start)]);
        links.push({ nodeId: m.id, name: m.qualified_name, relation: 'contains' });
      }
      // A pod's build file, if there is one, is the best one-paragraph summary.
      const anyFile = ms[0]?.file_path;
      if (anyFile && t.kind === 'pod') {
        const segs = anyFile.split(/[\\/]/);
        const i = segs.lastIndexOf('fan');
        if (i > 0) {
          const build = [...segs.slice(0, i), 'build.fan'].join('/');
          const src = numbered(build, 1, 60, 60);
          if (src) { allow(build, src.range); parts.push(`BUILD FILE ${build}:\n${src.text}`); }
        }
      }
    }

    const sources: CardSource[] = [];
    for (const [file, r] of files) {
      const h = sha256File(localPath(file));
      if (h) sources.push({ file, hash: h, lineStart: r.lineStart, lineEnd: r.lineEnd });
    }
    out.push({ target: t, factText: parts.join('\n\n'), allowed, sources, links });
  }
  return out;
}

/** Is file:line inside the allowed ranges? (±2 lines of slack.) */
export function claimAllowed(allowed: Map<string, Array<[number, number]>>, file: string, line: number): boolean {
  const norm = (f: string) => f.replace(/\\/g, '/');
  for (const [f, ranges] of allowed) {
    if (norm(f) !== norm(file) && !norm(f).endsWith('/' + norm(file).replace(/^\.?\//, '')) && path.basename(f) !== norm(file)) continue;
    if (ranges.some(([a, b]) => line >= a - 2 && line <= b + 2)) return true;
  }
  return false;
}

/**
 * Build targets for given node ids, read from the live graph (current line
 * numbers, not the ones stored on an old card). Project and pod ids are
 * rebuilt from the graph the same way selectTargets does. Ids whose node is
 * gone are returned in `missing`.
 */
export async function targetsForNodes(
  projectId: number, nodeIds: string[], s: KnowledgeCardSettings, projectName: string,
): Promise<{ targets: CardTarget[]; missing: string[] }> {
  const want = [...new Set(nodeIds)];
  const symbolIds = want.filter(id => !id.startsWith('project:') && !id.startsWith('pod:'));
  const groupIds = want.filter(id => id.startsWith('project:') || id.startsWith('pod:'));
  const found = new Map<string, CardTarget>();
  if (groupIds.length) {
    const groups = await selectTargets(projectId, {
      ...s, kinds: { projects: true, pods: true, classes: false, functions: false }, maxCardsPerProject: 100_000,
    }, projectName);
    for (const t of groups) if (groupIds.includes(t.nodeId)) found.set(t.nodeId, t);
  }
  if (symbolIds.length) {
    const rows = await nodesByIds(projectId, symbolIds);
    const list = rows.map(r => `'${esc(r.id)}'`).join(',');
    const fanRows = rows.length ? await projectQuery<{ id: string; c: number }>(projectId,
      `MATCH (a:CodeNode)-[e:CodeEdge]->(n:CodeNode) WHERE e.edge_type = 'calls' AND n.id IN [${list}] RETURN n.id AS id, count(a) AS c`) : [];
    const fan = new Map(fanRows.map(r => [String(r.id), Number(r.c)]));
    for (const n of rows) {
      found.set(n.id, {
        nodeId: n.id, kind: CLASS_TYPES.includes(n.node_type) ? 'class' : 'function', name: n.name,
        qualifiedName: n.qualified_name, filePath: n.file_path, lineStart: Number(n.line_start), lineEnd: Number(n.line_end),
        fanIn: fan.get(n.id) ?? 0,
      });
    }
  }
  return { targets: want.filter(id => found.has(id)).map(id => found.get(id)!), missing: want.filter(id => !found.has(id)) };
}
