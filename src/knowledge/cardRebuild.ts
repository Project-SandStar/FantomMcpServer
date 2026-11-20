/**
 * Rebuild of selected knowledge cards (POST /admin/knowledge-cards/rebuild).
 *
 * Each card is rebuilt with its OWN writer model (read from the stored row,
 * never parsed from the row id: model ids contain ':'), through the same
 * per-card path as a normal build: buildOne (writer → check → one rewrite),
 * the bulk worker lane, `concurrency` jobs in flight, the sidecar per-host
 * limit (inside the sidecar client), the daily cap and the stop after six
 * failed calls with nothing built.
 *
 * Targets are read from the live graph, so a stale card gets the current
 * line numbers. A node that is gone is skipped and its old card is kept.
 *
 * Jobs have their own map and run one at a time; (project, writer) groups
 * inside a job run one after another, so only one graph store is in use at a
 * time. Normal builds (startBuild / stopBuild) are not touched.
 */
import { createLogger } from '../utils/index.js';
import type { KnowledgeCard } from './cardStore.js';
import type { KnowledgeCardSettings } from './cardSettings.js';
import type { CardFacts, CardTarget } from './cardFacts.js';

const logger = createLogger('knowledge-cards');

export interface RebuildDeps {
  settings(): KnowledgeCardSettings;
  loadCards(rowIds: string[]): Promise<KnowledgeCard[]>;
  projectName(projectId: number): Promise<string>;
  targetsForNodes(projectId: number, nodeIds: string[], s: KnowledgeCardSettings, projectName: string): Promise<{ targets: CardTarget[]; missing: string[] }>;
  gatherFacts(projectId: number, targets: CardTarget[]): Promise<CardFacts[]>;
  buildOne(f: CardFacts, s: KnowledgeCardSettings, writer: string, projectId: number): Promise<KnowledgeCard | null>;
  encoder(): Promise<{ embedBatch(t: string[]): Promise<Float32Array[]>; getModelName(): string }>;
  upsert(items: Array<{ card: KnowledgeCard; vector: Float32Array | number[] }>): Promise<void>;
  /** Remove the old cards a rebuild replaced (writer changed). */
  deleteCards?(rowIds: string[]): Promise<number>;
  /** After a job: rebuild the BM25 index, clear the fact file cache. */
  finish(): Promise<void>;
  assertLive(model: string): Promise<void>;
  chatUsable(model: string): boolean;
  isFree(s: KnowledgeCardSettings, writer: string): boolean;
  capReached(s: KnowledgeCardSettings): boolean;
}

export type RebuildState = 'queued' | 'running' | 'done' | 'stopped' | 'failed';

export interface RebuildGroup {
  projectId: number; writerModel: string; cards: number; built: number;
  state: 'waiting' | 'running' | 'done' | 'skipped' | 'failed' | 'stopped';
  error?: string;
}

export interface RebuildJob {
  id: string;
  state: RebuildState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Row ids asked for. */
  requested: number;
  /** Cards found in the table (the rest are counted in skipped as "not found"). */
  found: number;
  built: number;
  flagged: number;
  firstCheckFails: number;
  failedCalls: number;
  costUsd: number;
  groups: RebuildGroup[];
  skippedCount: number;
  /** First 200 skipped cards with the reason. */
  skipped: Array<{ rowId: string; reason: string }>;
  error?: string;
}

/** Most row ids one rebuild may take. */
export const MAX_REBUILD_IDS = 20_000;
const BATCH = 8;

export function createRebuildQueue(deps: RebuildDeps) {
  const jobs = new Map<string, RebuildJob>();
  const order: string[] = [];
  const stopFlags = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let seq = 0;

  const skip = (job: RebuildJob, rowId: string, reason: string) => {
    job.skippedCount++;
    if (job.skipped.length < 200) job.skipped.push({ rowId, reason });
  };

  async function runGroup(job: RebuildJob, g: RebuildGroup, cards: KnowledgeCard[], s: KnowledgeCardSettings): Promise<'ok' | 'stop'> {
    const writer = g.writerModel;
    const fail = (why: string) => { g.state = 'failed'; g.error = why.slice(0, 400); for (const c of cards) skip(job, c.rowId, why.slice(0, 200)); };
    if (!deps.chatUsable(writer) || (s.checkPass && !deps.chatUsable(s.checkerModel))) {
      fail(`${deps.chatUsable(writer) ? s.checkerModel : writer} is a batch-only model id; OpenRouter does not serve it on /chat/completions`);
      return 'ok';
    }
    try {
      await deps.assertLive(writer);
      if (s.checkPass) await deps.assertLive(s.checkerModel);
    } catch (err) { fail((err as Error).message); return 'ok'; }

    const byNode = new Map(cards.map(c => [c.nodeId, c]));
    const { targets, missing } = await deps.targetsForNodes(g.projectId, [...byNode.keys()], s, await deps.projectName(g.projectId));
    for (const id of missing) skip(job, byNode.get(id)!.rowId, 'node no longer in the graph; old card kept');
    if (!targets.length) { g.state = 'skipped'; return 'ok'; }

    const encoder = await deps.encoder();
    let groupBuilt = 0;
    let groupFails = 0;
    for (let i = 0; i < targets.length; i += BATCH) {
      if (stopFlags.has(job.id)) { g.state = 'stopped'; return 'stop'; }
      if (!deps.isFree(s, writer) && deps.capReached(s)) {
        g.state = 'stopped';
        job.error = `daily cap $${s.dailyCapUsd} reached`;
        return 'stop';
      }
      const facts = await deps.gatherFacts(g.projectId, targets.slice(i, i + BATCH));
      const built: KnowledgeCard[] = [];
      for (let j = 0; j < facts.length; j += s.concurrency) {
        const part = facts.slice(j, j + s.concurrency);
        const results = await Promise.allSettled(part.map(f => deps.buildOne(f, s, writer, g.projectId)));
        results.forEach((r, k) => {
          const rowId = byNode.get(part[k].target.nodeId)?.rowId ?? part[k].target.nodeId;
          if (r.status === 'fulfilled' && r.value) {
            built.push(r.value);
            job.costUsd += r.value.writerCostUsd + r.value.checkerCostUsd;
            if (r.value.firstCheck === 'fail') job.firstCheckFails++;
            if (r.value.status === 'flagged') job.flagged++;
          } else if (r.status === 'rejected') {
            job.failedCalls++;
            groupFails++;
            const msg = String((r.reason as Error)?.message ?? r.reason).slice(0, 400);
            g.error = msg;
            skip(job, rowId, `card call failed: ${msg.slice(0, 200)}`);
            logger.warn(`card rebuild call failed: ${msg}`);
          } else {
            skip(job, rowId, 'writer returned no card');
          }
        });
        // Same error on every card: stop this group instead of burning the list.
        if (groupBuilt + built.length === 0 && groupFails >= 6) { g.state = 'failed'; return 'ok'; }
      }
      if (built.length) {
        let vecs: Float32Array[];
        try {
          const { embedCardsWithRetry } = await import('./cardBuilder.js');
          vecs = await embedCardsWithRetry(encoder, built.map(c => c.text), { shouldStop: () => stopFlags.has(job.id) });
        } catch (err) {
          // These cards stay as they were (the old card is kept); the rest of the
          // group still gets rebuilt.
          const msg = `card embeddings failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
          g.error = msg;
          for (const c of built) skip(job, c.rowId, msg.slice(0, 200));
          logger.warn(msg);
          continue;
        }
        const model = encoder.getModelName();
        await deps.upsert(built.map((c, k) => ({ card: { ...c, embedModel: model }, vector: vecs[k] })));
        // The new card has a new row id when the writer changed: remove the
        // old card it replaces, so each node keeps one card.
        const replaced = built
          .map(c => byNode.get(c.nodeId))
          .filter((old): old is KnowledgeCard => !!old && old.writerModel !== writer)
          .map(old => old.rowId);
        if (replaced.length && deps.deleteCards) {
          await deps.deleteCards(replaced).catch(err => logger.warn(`card rebuild: could not remove ${replaced.length} replaced card(s): ${(err as Error).message}`));
        }
        groupBuilt += built.length;
        g.built += built.length;
        job.built += built.length;
      }
    }
    g.state = 'done';
    return 'ok';
  }

  async function runJob(job: RebuildJob, rowIds: string[]): Promise<void> {
    if (stopFlags.has(job.id)) { job.state = 'stopped'; return; }
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    const s = deps.settings();
    const cards = await deps.loadCards(rowIds);
    job.found = cards.length;
    const have = new Set(cards.map(c => c.rowId));
    for (const id of rowIds) if (!have.has(id)) skip(job, id, 'card not found');
    // Rebuild with the SAVED writer (Config -> Knowledge cards), not the
    // writer stored on the old card. One group per project.
    const groups = new Map<number, KnowledgeCard[]>();
    for (const c of cards) {
      if (!groups.has(c.projectId)) groups.set(c.projectId, []);
      groups.get(c.projectId)!.push(c);
    }
    const list = [...groups.values()];
    job.groups = list.map(cs => ({ projectId: cs[0].projectId, writerModel: s.writerModel, cards: cs.length, built: 0, state: 'waiting' }));
    try {
      for (let i = 0; i < list.length; i++) {
        const g = job.groups[i];
        if (stopFlags.has(job.id)) { g.state = 'stopped'; continue; }
        g.state = 'running';
        const r = await runGroup(job, g, list[i], s);
        if (r === 'stop') {
          for (const rest of job.groups.slice(i + 1)) rest.state = 'stopped';
          job.state = 'stopped';
          break;
        }
      }
      if (job.state === 'running') job.state = job.groups.length && job.groups.every(g => g.state === 'failed') ? 'failed' : 'done';
    } finally {
      await deps.finish().catch(err => logger.warn(`card rebuild finish failed: ${(err as Error).message}`));
    }
  }

  return {
    /** Queue a rebuild of exactly these row ids. */
    start(rowIds: string[]): RebuildJob {
      const ids = [...new Set(rowIds.filter(id => typeof id === 'string' && id.length > 0))];
      if (!ids.length) throw new Error('rowIds is empty');
      if (ids.length > MAX_REBUILD_IDS) throw new Error(`at most ${MAX_REBUILD_IDS} cards per rebuild`);
      const job: RebuildJob = {
        id: `rb-${Date.now().toString(36)}-${(++seq).toString(36)}`, state: 'queued', createdAt: new Date().toISOString(),
        requested: ids.length, found: 0, built: 0, flagged: 0, firstCheckFails: 0, failedCalls: 0, costUsd: 0,
        groups: [], skippedCount: 0, skipped: [],
      };
      jobs.set(job.id, job);
      order.push(job.id);
      while (order.length > 30) { const old = order.shift()!; const j = jobs.get(old); if (j && (j.state === 'queued' || j.state === 'running')) { order.unshift(old); break; } jobs.delete(old); }
      chain = chain.then(() => runJob(job, ids)).catch(err => {
        job.state = 'failed';
        job.error = String((err as Error)?.message ?? err).slice(0, 400);
        logger.warn(`card rebuild ${job.id} failed: ${job.error}`);
      }).finally(() => {
        job.finishedAt = new Date().toISOString();
        job.costUsd = Math.round(job.costUsd * 1e6) / 1e6;
        stopFlags.delete(job.id);
      });
      return snapshot(job);
    },
    get(id: string): RebuildJob | null { const j = jobs.get(id); return j ? snapshot(j) : null; },
    list(): RebuildJob[] { return order.map(id => jobs.get(id)).filter((j): j is RebuildJob => !!j).map(snapshot).reverse(); },
    stop(id: string): boolean {
      const j = jobs.get(id);
      if (!j || (j.state !== 'queued' && j.state !== 'running')) return false;
      stopFlags.add(id);
      return true;
    },
    /** Resolves when every queued job has finished (tests). */
    idle(): Promise<void> { return chain.then(() => undefined); },
  };
}

function snapshot(j: RebuildJob): RebuildJob {
  return { ...j, groups: j.groups.map(g => ({ ...g })), skipped: j.skipped.slice() };
}

export type RebuildQueue = ReturnType<typeof createRebuildQueue>;

let queue: RebuildQueue | null = null;

/** The server's rebuild queue, wired to the real store, graph and models. */
export async function rebuildQueue(): Promise<RebuildQueue> {
  if (queue) return queue;
  const store = await import('./cardStore.js');
  const facts = await import('./cardFacts.js');
  const builder = await import('./cardBuilder.js');
  const settings = await import('./cardSettings.js');
  const sidecar = await import('./cardSidecar.js');
  queue = createRebuildQueue({
    settings: () => settings.getCardSettings(),
    loadCards: ids => store.cardsByRowIds(ids),
    projectName: async id => {
      try {
        const { getPrismaClient } = await import('../db/prisma.js');
        const p = await getPrismaClient().fantomProject.findUnique({ where: { id }, select: { name: true } });
        return p?.name ?? `project ${id}`;
      } catch { return `project ${id}`; }
    },
    targetsForNodes: facts.targetsForNodes,
    gatherFacts: facts.gatherFacts,
    buildOne: builder.buildOne,
    encoder: builder.cardEncoder,
    upsert: store.upsertCards,
    deleteCards: store.deleteCards,
    finish: async () => { facts.clearFactFileCache(); await store.ensureCardTextIndex(true); },
    assertLive: sidecar.assertSidecarModelLive,
    chatUsable: builder.chatUsable,
    isFree: builder.buildIsFree,
    capReached: builder.capReached,
  });
  return queue;
}
