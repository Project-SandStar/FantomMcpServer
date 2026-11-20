/**
 * Knowledge card lookup for AI coders (MCP tools `getKnowledgeCard` and
 * `listKnowledgeCards`). Read-only: never calls a model, never builds a card.
 *
 * Plan: docs/plans/2026-11-20-get-knowledge-card.md (GKC-01..03).
 */
import type { KnowledgeCard } from './cardStore.js';

export type CardReadStatus = 'fresh' | 'stale' | 'flagged' | 'low-confidence';

export interface LookupDeps {
  /** Cards of one project (all writers). */
  cardsForProject(projectId: number): Promise<KnowledgeCard[]>;
  /** sha256 of a source file now, or null when it cannot be read. */
  fileHash(file: string): string | null;
  minConfidence(): number;
  savedWriter(): string;
}

/** Status a reader should trust: stale when any source file changed. */
export function readStatus(c: KnowledgeCard, deps: Pick<LookupDeps, 'fileHash' | 'minConfidence'>): CardReadStatus {
  if (c.status === 'flagged') return 'flagged';
  if (c.status === 'stale' || c.status === 'check') return 'stale';
  for (const s of c.sources) {
    const now = deps.fileHash(s.file);
    if (now !== null && now !== s.hash) return 'stale';
  }
  return c.confidence < deps.minConfidence() ? 'low-confidence' : 'fresh';
}

/** One card per node: the saved writer first, else the newest card. */
export function pickPerNode(cards: KnowledgeCard[], savedWriter: string): Map<string, KnowledgeCard> {
  const out = new Map<string, KnowledgeCard>();
  for (const c of cards) {
    const cur = out.get(c.nodeId);
    if (!cur) { out.set(c.nodeId, c); continue; }
    const curSaved = cur.writerModel === savedWriter;
    const cSaved = c.writerModel === savedWriter;
    if (cSaved && !curSaved) out.set(c.nodeId, c);
    else if (cSaved === curSaved && c.builtAt > cur.builtAt) out.set(c.nodeId, c);
  }
  return out;
}

/** Match a symbol: exact qualified name, then name / qualified-name suffix. */
export function matchSymbol(cards: Iterable<KnowledgeCard>, symbol: string): KnowledgeCard[] {
  const q = symbol.trim();
  const all = [...cards];
  const exact = all.filter(c => c.qualifiedName === q);
  if (exact.length) return exact;
  const lower = q.toLowerCase();
  const tail = (s: string) => s.toLowerCase();
  return all.filter(c =>
    tail(c.name) === lower
    || tail(c.qualifiedName).endsWith(`::${lower}`)
    || tail(c.qualifiedName).endsWith(`.${lower}`));
}

export interface CardLookupResult {
  found: boolean;
  /** Several nodes matched; the caller must pick one. */
  candidates?: Array<{ qualifiedName: string; kind: string; file: string }>;
  card?: KnowledgeCard & { readStatus: CardReadStatus };
  neighbours: Array<{ relation: string; name: string; summary: string | null; readStatus: CardReadStatus | null }>;
  missingNeighbours: string[];
}

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,240}?[.!?])(\s|$)/);
  return (m ? m[1] : t.slice(0, 240)).trim();
}

export async function lookupCard(deps: LookupDeps, input: {
  projectId: number; symbol?: string; file?: string;
  neighbours?: 'none' | 'callers' | 'callees' | 'both'; maxNeighbours?: number;
}): Promise<CardLookupResult> {
  const cards = await deps.cardsForProject(input.projectId);
  const byNode = pickPerNode(cards, deps.savedWriter());
  let hits: KnowledgeCard[] = [];
  if (input.symbol) hits = matchSymbol(byNode.values(), input.symbol);
  else if (input.file) {
    const f = input.file.replace(/\\/g, '/');
    const inFile = [...byNode.values()].filter(c => c.filePath.replace(/\\/g, '/').endsWith(f));
    // The file's main type (class first), else its first card.
    hits = inFile.filter(c => c.kind === 'class').slice(0, 1);
    if (!hits.length) hits = inFile.slice(0, 1);
  }
  if (hits.length === 0) return { found: false, neighbours: [], missingNeighbours: [] };
  if (hits.length > 1) {
    return {
      found: false, neighbours: [], missingNeighbours: [],
      candidates: hits.slice(0, 20).map(c => ({ qualifiedName: c.qualifiedName, kind: c.kind, file: c.filePath })),
    };
  }
  const card = hits[0];
  const status = readStatus(card, deps);
  const want = input.neighbours ?? 'both';
  const max = Math.min(Math.max(input.maxNeighbours ?? 5, 0), 20);
  const rel = (r: string) => want === 'both'
    || (want === 'callers' && (r === 'caller' || r === 'contained-by'))
    || (want === 'callees' && (r === 'callee' || r === 'contains' || r === 'extends' || r === 'implements'));
  const links = want === 'none' ? [] : card.links.filter(l => rel(l.relation)).slice(0, max);
  const neighbours: CardLookupResult['neighbours'] = [];
  const missing: string[] = [];
  for (const l of links) {
    const n = byNode.get(l.nodeId);
    if (!n) { missing.push(l.name); neighbours.push({ relation: l.relation, name: l.name, summary: null, readStatus: null }); continue; }
    const ns = readStatus(n, deps);
    neighbours.push({ relation: l.relation, name: n.qualifiedName, summary: ns === 'fresh' ? firstSentence(n.text) : null, readStatus: ns });
  }
  return { found: true, card: { ...card, readStatus: status }, neighbours, missingNeighbours: missing };
}

/** Text for the model. Never presents a stale / flagged / low card as fact. */
export function formatLookup(r: CardLookupResult, symbol: string): string {
  if (r.candidates?.length) {
    return [`Several symbols match "${symbol}". Call again with one qualified name:`,
      ...r.candidates.map(c => `- ${c.qualifiedName} (${c.kind}) ${c.file}`)].join('\n');
  }
  if (!r.found || !r.card) return `No knowledge card for "${symbol}" yet. Use getFantomFunction / getFantomType / searchFantomCode instead.`;
  const c = r.card;
  const head = `${c.qualifiedName} (${c.kind}) — ${c.readStatus} · confidence ${c.confidence.toFixed(2)} · writer ${c.writerModel} · checker ${c.checkerModel || 'none'} · built ${c.builtAt.slice(0, 10)}`;
  const where = `${c.filePath}:${c.lineStart}-${c.lineEnd}`;
  const lines = [head, where];
  if (c.readStatus === 'fresh') {
    lines.push('', c.text.trim());
    if (c.claims.length) lines.push('', 'Claims:', ...c.claims.slice(0, 12).map(cl => `- ${cl.text} [${cl.file}:${cl.line}]`));
  } else {
    const why = c.readStatus === 'stale' ? 'its source code changed since it was built'
      : c.readStatus === 'flagged' ? 'the checker did not confirm its claims'
        : 'its confidence is below the floor';
    lines.push('', `Not shown as fact: ${why}. Read the code at ${where}.`);
  }
  if (c.sources.length) {
    // The sha256 each source file had when the card was built. The server
    // already compared it (readStatus); a coder with the file open can check
    // too: `shasum -a 256 <file>` must match, or the card is stale.
    lines.push('', 'Sources (sha256 when built):');
    for (const s of c.sources.slice(0, 10)) lines.push(`- ${s.file}:${s.lineStart}-${s.lineEnd} sha256=${s.hash}`);
  }
  if (r.neighbours.length) {
    lines.push('', 'Neighbours (from the code graph):');
    for (const n of r.neighbours) lines.push(`- ${n.relation} ${n.name}${n.summary ? `: ${n.summary}` : n.readStatus ? ` (${n.readStatus})` : ' (no card)'}`);
  }
  return lines.join('\n');
}

export interface CardListRow { qualifiedName: string; kind: string; readStatus: CardReadStatus; confidence: number; summary: string; file: string }

export async function listCardSummaries(deps: LookupDeps, input: {
  projectId: number; file?: string; kind?: string; status?: CardReadStatus; limit?: number; offset?: number;
}): Promise<{ total: number; rows: CardListRow[]; byStatus: Record<CardReadStatus, number> }> {
  const byNode = pickPerNode(await deps.cardsForProject(input.projectId), deps.savedWriter());
  const byStatus: Record<CardReadStatus, number> = { fresh: 0, stale: 0, flagged: 0, 'low-confidence': 0 };
  const rows: CardListRow[] = [];
  for (const c of byNode.values()) {
    if (input.file && !c.filePath.replace(/\\/g, '/').endsWith(input.file.replace(/\\/g, '/'))) continue;
    if (input.kind && c.kind !== input.kind) continue;
    const st = readStatus(c, deps);
    byStatus[st]++;
    if (input.status && st !== input.status) continue;
    rows.push({ qualifiedName: c.qualifiedName, kind: c.kind, readStatus: st, confidence: c.confidence, summary: st === 'fresh' ? firstSentence(c.text) : '', file: c.filePath });
  }
  rows.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  const offset = Math.max(input.offset ?? 0, 0);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return { total: rows.length, rows: rows.slice(offset, offset + limit), byStatus };
}

/** Real dependencies for the server. */
export async function liveLookupDeps(): Promise<LookupDeps> {
  const store = await import('./cardStore.js');
  const facts = await import('./cardFacts.js');
  const settings = await import('./cardSettings.js');
  const hashCache = new Map<string, string | null>();
  return {
    cardsForProject: id => store.cardsForProject(id),
    fileHash: file => {
      if (!hashCache.has(file)) hashCache.set(file, facts.sha256File(facts.localPath(file)));
      return hashCache.get(file) ?? null;
    },
    minConfidence: () => settings.getCardSettings().minConfidence,
    savedWriter: () => settings.getCardSettings().writerModel,
  };
}
