/**
 * Card staleness.
 *
 * - After a re-index: every card whose source file hash changed turns
 *   `stale`; fresh cards that link to a stale card's node (callers of a
 *   changed signature, containers) turn `check`. With autoRefresh on, a
 *   stale-only rebuild starts for the project.
 * - At serve time: `verifyFresh` re-hashes the source files of the chosen
 *   cards, so a stale card is never served even if the hook never ran.
 */
import { createLogger } from '../utils/index.js';
import { cardsForProject, setCardStatus, type KnowledgeCard } from './cardStore.js';
import { sha256File, localPath } from './cardFacts.js';
import { getCardSettings, projectInScope } from './cardSettings.js';

const logger = createLogger('knowledge-cards');

/** True when every source file of the card still has its stored hash. */
export function sourcesUnchanged(card: KnowledgeCard, hashCache = new Map<string, string | null>()): boolean {
  for (const s of card.sources) {
    let h = hashCache.get(s.file);
    if (h === undefined) { h = sha256File(localPath(s.file)); hashCache.set(s.file, h); }
    if (!h || h !== s.hash) return false;
  }
  return true;
}

/** Split cards into fresh (servable) and newly stale; marks the stale ones in the table. */
export async function verifyFresh(cards: KnowledgeCard[]): Promise<{ fresh: KnowledgeCard[]; stale: KnowledgeCard[] }> {
  const cache = new Map<string, string | null>();
  const fresh: KnowledgeCard[] = [];
  const stale: KnowledgeCard[] = [];
  for (const c of cards) {
    if (c.status === 'fresh' && sourcesUnchanged(c, cache)) fresh.push(c);
    else stale.push(c);
  }
  const mark = stale.filter(c => c.status === 'fresh').map(c => c.rowId);
  if (mark.length) await setCardStatus(mark, 'stale').catch(err => logger.warn(`mark stale failed: ${(err as Error).message}`));
  return { fresh, stale };
}

export interface StaleScan { cards: number; stale: number; check: number }

/** Re-hash every card of a project; mark stale cards and their graph neighbours. */
export async function scanProjectStaleness(projectId: number): Promise<StaleScan> {
  const cards = await cardsForProject(projectId);
  const cache = new Map<string, string | null>();
  const staleIds: string[] = [];
  const staleNodes = new Set<string>();
  for (const c of cards) {
    if (c.status === 'stale') { staleNodes.add(c.nodeId); continue; }
    if (!sourcesUnchanged(c, cache)) { staleIds.push(c.rowId); staleNodes.add(c.nodeId); }
  }
  const checkIds = cards
    .filter(c => c.status === 'fresh' && !staleIds.includes(c.rowId))
    .filter(c => c.links.some(l => staleNodes.has(l.nodeId) && (l.relation === 'callee' || l.relation === 'contains' || l.relation === 'extends' || l.relation === 'implements')))
    .map(c => c.rowId);
  await setCardStatus(staleIds, 'stale');
  await setCardStatus(checkIds, 'check');
  return { cards: cards.length, stale: staleIds.length, check: checkIds.length };
}

/**
 * Hook for the indexer: called after a project re-index. Never throws, never
 * blocks the indexer (the caller does not await it).
 */
export async function onProjectReindexed(projectId: number): Promise<void> {
  try {
    const { cardTableExists } = await import('./cardStore.js');
    if (!(await cardTableExists())) return;
    const scan = await scanProjectStaleness(projectId);
    if (scan.stale || scan.check) logger.info(`project ${projectId}: ${scan.stale} cards stale, ${scan.check} to check`);
    const s = getCardSettings();
    if (s.enabled && s.autoRefresh && projectInScope(projectId, s) && (scan.stale || scan.check)) {
      const { startBuild } = await import('./cardBuilder.js');
      startBuild(projectId, { onlyStale: true });
    }
  } catch (err) {
    logger.warn(`card staleness after re-index of ${projectId} failed: ${(err as Error).message}`);
  }
}
