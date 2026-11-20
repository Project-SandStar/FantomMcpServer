/**
 * Knowledge Cards viewer: URL state and bulk selection, as pure functions
 * (no imports) so the root Jest suite can test them.
 *
 * URL keys: projectId (all | <id>), writer, mark, kind, sort, q, card (row id).
 */
export type ProjectScope = 'all' | number;
export type MarkFilter = '' | 'good' | 'low' | 'stale' | 'failed';
export type SortKey = 'fanin' | 'confidence' | 'newest';

export interface ViewerUrlState {
  projectId: ProjectScope | null;
  writer: string;
  mark: MarkFilter;
  kind: string;
  sort: SortKey;
  q: string;
  card: string | null;
}

const MARK_KEYS: MarkFilter[] = ['good', 'low', 'stale', 'failed'];

export function parseViewerUrl(sp: { get(k: string): string | null }): ViewerUrlState {
  const p = sp.get('projectId');
  const n = Number(p);
  const projectId: ProjectScope | null = p === 'all' ? 'all' : Number.isInteger(n) && n > 0 ? n : null;
  const mark = (sp.get('mark') ?? '') as MarkFilter;
  const sort = sp.get('sort');
  return {
    projectId,
    writer: sp.get('writer') ?? '',
    mark: MARK_KEYS.includes(mark) ? mark : '',
    kind: sp.get('kind') ?? '',
    sort: sort === 'confidence' || sort === 'newest' ? sort : 'fanin',
    q: sp.get('q') ?? '',
    card: sp.get('card') || null,
  };
}

/** New query string after a patch; empty / default values are dropped. Other keys are kept. */
export function patchViewerUrl(current: string, patch: Partial<Record<keyof ViewerUrlState, string | number | null>>): string {
  const p = new URLSearchParams(current);
  for (const [k, v] of Object.entries(patch)) {
    const s = v === null || v === undefined ? '' : String(v);
    if (!s || (k === 'sort' && s === 'fanin')) p.delete(k); else p.set(k, s);
  }
  return p.toString();
}

/** Row id of a card: `<projectId>:<nodeId>:<writer>` (the writer may contain ':'). */
export function cardRowId(projectId: number, nodeId: string, writer: string): string {
  return `${projectId}:${nodeId}:${writer}`;
}

/** Selection: explicit ids. "Select all N" replaces it with every id the server returned for the filters. */
export function toggleId(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export function togglePage(sel: ReadonlySet<string>, pageIds: string[]): Set<string> {
  const next = new Set(sel);
  const allOn = pageIds.length > 0 && pageIds.every(id => next.has(id));
  for (const id of pageIds) { if (allOn) next.delete(id); else next.add(id); }
  return next;
}

/** Split ids into parts of at most `size` (the server takes 1000 per request). */
export function chunk<T>(list: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export interface ExportCard {
  rowId: string; projectId: number; kind: string; qualifiedName: string; name: string; filePath: string;
  lineStart: number; lineEnd: number; text: string; writerModel: string; checkerModel: string; builtAt: string;
  confidence: number; checkResult: string; status: string; mark?: string;
  sources: Array<{ file: string; lineStart: number; lineEnd: number; hash: string }>;
}

export function cardsToMarkdown(cards: ExportCard[]): string {
  const out: string[] = [`# Knowledge cards (${cards.length})`, ''];
  for (const c of cards) {
    out.push(`## ${c.qualifiedName || c.name}`, '');
    out.push(`- project ${c.projectId} · ${c.kind} · ${c.mark ?? c.status} · confidence ${Math.round(c.confidence * 100)}%`);
    if (c.filePath) out.push(`- \`${c.filePath}:${c.lineStart}-${c.lineEnd}\``);
    out.push(`- writer ${c.writerModel} · checker ${c.checkerModel || 'none'} (${c.checkResult}) · built ${c.builtAt}`);
    out.push(`- row id \`${c.rowId}\``, '');
    out.push(...c.text.split('\n').slice(1), '');
    if (c.sources.length) {
      out.push('Sources:');
      for (const s of c.sources) out.push(`- \`${s.file}:${s.lineStart}-${s.lineEnd}\` sha256 ${s.hash.slice(0, 12)}`);
      out.push('');
    }
  }
  return out.join('\n');
}
