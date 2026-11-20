/**
 * Knowledge card bulk tools: rebuild queue (only the given ids, each with its
 * own writer), bulk routes (admin only, delete, id limits), project counts,
 * select-all ids across pages.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createRebuildQueue, type RebuildDeps } from '../knowledge/cardRebuild.js';
import { registerKnowledgeCardBulkRoutes } from '../admin/knowledgeCardBulkRoutes.js';
import { projectCounts, matchCards, filterCards, rowIdsParam, projectScopeParam, MAX_IDS_PER_REQUEST } from '../admin/knowledgeCardViewerRoutes.js';
import type { KnowledgeCard } from '../knowledge/cardStore.js';
import type { KnowledgeCardSettings } from '../knowledge/cardSettings.js';
import type { CardTarget, CardFacts } from '../knowledge/cardFacts.js';

function card(p: Partial<KnowledgeCard>): KnowledgeCard {
  return {
    rowId: 'r', nodeId: 'n', projectId: 1, kind: 'function', name: 'f', qualifiedName: 'a::f', filePath: 'a.fan',
    lineStart: 1, lineEnd: 10, text: 'function a::f\nDoes things.', claims: [], links: [], sources: [],
    writerModel: 'w/one', checkerModel: 'c/x', builtAt: '2026-11-01T00:00:00Z', confidence: 0.9,
    checkResult: 'pass', firstCheck: 'pass', attempts: 1, writerCostUsd: 0.001, checkerCostUsd: 0.001,
    status: 'fresh', embedModel: '', ...p,
  };
}

const S = { writerModel: 'w/one', checkPass: true, checkerModel: 'c/x', concurrency: 2, dailyCapUsd: 2, minConfidence: 0.8 } as unknown as KnowledgeCardSettings;

function fakeDeps(store: KnowledgeCard[], over: Partial<RebuildDeps> = {}) {
  const calls: Array<{ nodeId: string; writer: string; projectId: number }> = [];
  const upserted: KnowledgeCard[] = [];
  let finished = 0;
  const deps: RebuildDeps = {
    settings: () => S,
    loadCards: async ids => store.filter(c => ids.includes(c.rowId)),
    projectName: async id => `p${id}`,
    targetsForNodes: async (_p, nodeIds) => ({
      targets: nodeIds.filter(n => n !== 'gone').map(n => ({ nodeId: n, kind: 'function', name: n, qualifiedName: n, filePath: 'x.fan', lineStart: 5, lineEnd: 9, fanIn: 0 }) as CardTarget),
      missing: nodeIds.filter(n => n === 'gone'),
    }),
    gatherFacts: async (_p, ts) => ts.map(t => ({ target: t, factText: '', allowed: new Map(), sources: [], links: [] }) as CardFacts),
    buildOne: async (f, _s, writer, projectId) => {
      calls.push({ nodeId: f.target.nodeId, writer, projectId });
      return card({ rowId: `${projectId}:${f.target.nodeId}:${writer}`, nodeId: f.target.nodeId, projectId, writerModel: writer });
    },
    encoder: async () => ({ embedBatch: async t => t.map(() => new Float32Array(2)), getModelName: () => 'emb' }),
    upsert: async items => { upserted.push(...items.map(i => i.card)); },
    finish: async () => { finished++; },
    assertLive: async () => {},
    chatUsable: m => !m.endsWith(':batch'),
    isFree: () => false,
    capReached: () => false,
    ...over,
  };
  return { deps, calls, upserted, finished: () => finished };
}

describe('rebuild queue', () => {
  const store = [
    card({ rowId: '1:a:w/one', nodeId: 'a', projectId: 1, writerModel: 'w/one' }),
    card({ rowId: '1:b:w/two:free', nodeId: 'b', projectId: 1, writerModel: 'w/two:free' }),
    card({ rowId: '2:c:w/one', nodeId: 'c', projectId: 2, writerModel: 'w/one' }),
    card({ rowId: '2:d:w/one', nodeId: 'd', projectId: 2, writerModel: 'w/one' }),
    card({ rowId: '1:gone:w/one', nodeId: 'gone', projectId: 1, writerModel: 'w/one' }),
  ];

  it('rebuilds only the given ids with the SAVED writer and removes the replaced old cards', async () => {
    const deleted: string[] = [];
    // Saved writer is w/two:free (a model id with ':'); two of the old cards were w/one.
    const f = fakeDeps(store, { deleteCards: async (ids: string[]) => { deleted.push(...ids); return ids.length; } });
    const saved = f.deps.settings();
    f.deps.settings = () => ({ ...saved, writerModel: 'w/two:free' });
    const q = createRebuildQueue(f.deps);
    const job = q.start(['1:a:w/one', '1:b:w/two:free', '2:c:w/one', 'nope']);
    expect(job.requested).toBe(4);
    await q.idle();
    expect(f.calls.sort((x, y) => x.nodeId.localeCompare(y.nodeId))).toEqual([
      { nodeId: 'a', writer: 'w/two:free', projectId: 1 },
      { nodeId: 'b', writer: 'w/two:free', projectId: 1 },
      { nodeId: 'c', writer: 'w/two:free', projectId: 2 },
    ]);
    const done = q.get(job.id)!;
    expect(done.state).toBe('done');
    expect(done.found).toBe(3);
    expect(done.built).toBe(3);
    expect(done.groups.map(g => [g.projectId, g.writerModel, g.cards])).toEqual([[1, 'w/two:free', 2], [2, 'w/two:free', 1]]);
    // Old cards with another writer are replaced; the one already on the saved writer is overwritten in place.
    expect(deleted.sort()).toEqual(['1:a:w/one', '2:c:w/one']);
    expect(done.skipped).toEqual([{ rowId: 'nope', reason: 'card not found' }]);
    expect(f.upserted.map(c => c.embedModel)).toEqual(['emb', 'emb', 'emb']);
    expect(f.finished()).toBe(1);
  });

  it('keeps the old card when the node left the graph', async () => {
    const f = fakeDeps(store);
    const q = createRebuildQueue(f.deps);
    const job = q.start(['1:gone:w/one']);
    await q.idle();
    const j = q.get(job.id)!;
    expect(f.calls).toEqual([]);
    expect(f.upserted).toEqual([]);
    expect(j.skipped[0].reason).toMatch(/no longer in the graph/);
    expect(j.groups[0].state).toBe('skipped');
  });

  it('stops at the daily cap for paid writers and skips offline / batch-only writers', async () => {
    const capped = fakeDeps(store, { capReached: () => true });
    const q = createRebuildQueue(capped.deps);
    const j1 = q.start(['1:a:w/one', '2:c:w/one']);
    await q.idle();
    expect(capped.calls).toEqual([]);
    expect(q.get(j1.id)!.state).toBe('stopped');
    expect(q.get(j1.id)!.error).toMatch(/daily cap/);

    // The saved writer is offline: nothing is built and the old cards stay.
    const offline = fakeDeps(store, { assertLive: async m => { if (m === 'w/one') throw new Error('sidecar offline'); } });
    const q2 = createRebuildQueue(offline.deps);
    const j2 = q2.start(['1:a:w/one', '1:b:w/two:free']);
    await q2.idle();
    expect(offline.calls).toEqual([]);
    expect(q2.get(j2.id)!.groups[0]).toMatchObject({ state: 'failed', error: 'sidecar offline' });
  });

  it('stops a group after six failed calls with nothing built', async () => {
    const many = Array.from({ length: 10 }, (_, i) => card({ rowId: `1:n${i}:w/one`, nodeId: `n${i}` }));
    let n = 0;
    const f = fakeDeps(many, { buildOne: async () => { n++; throw new Error('boom'); } });
    const q = createRebuildQueue(f.deps);
    const job = q.start(many.map(c => c.rowId));
    await q.idle();
    expect(n).toBe(6);
    expect(q.get(job.id)!.state).toBe('failed');
  });

  it('refuses an empty list and runs jobs one after another', async () => {
    const f = fakeDeps(store);
    const q = createRebuildQueue(f.deps);
    expect(() => q.start([])).toThrow(/empty/);
    const a = q.start(['1:a:w/one']);
    const b = q.start(['2:c:w/one']);
    expect(q.get(b.id)!.state).toBe('queued');
    await q.idle();
    expect(q.list().map(j => j.id)).toEqual([b.id, a.id]);
    expect(f.calls.map(c => c.nodeId)).toEqual(['a', 'c']);
  });
});

describe('bulk routes', () => {
  let server: Server; let base: string;
  let role: 'admin' | 'user' | null;
  let started: string[][]; let deleted: string[][];

  beforeEach(async () => {
    role = 'admin'; started = []; deleted = [];
    const a = express();
    a.use(express.json());
    const router = Router();
    router.use((req: Request, _res: Response, next: NextFunction) => {
      if (role) req.user = { id: '1', username: 'u', role, createdAt: '' } as any;
      next();
    });
    const fakeQueue = {
      start: (ids: string[]) => { started.push(ids); return { id: 'rb-1', state: 'queued', requested: ids.length } as any; },
      get: (id: string) => (id === 'rb-1' ? ({ id, state: 'running' } as any) : null),
      list: () => [],
      stop: () => true,
      idle: async () => {},
    };
    registerKnowledgeCardBulkRoutes(router, {
      queue: async () => fakeQueue,
      deleteCards: async ids => { deleted.push(ids); return ids.length; },
      capBlocked: async () => null,
    });
    a.use('/admin', router);
    await new Promise<void>(ok => { server = a.listen(0, () => ok()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise(r => server.close(r)); });

  const post = (p: string, body: unknown) => fetch(base + '/admin' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('rebuild passes exactly the given ids and returns a job id', async () => {
    const r = await post('/knowledge-cards/rebuild', { rowIds: ['1:a:w/x', '1:a:w/x', '2:b:w/y:free'] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).job.id).toBe('rb-1');
    expect(started).toEqual([['1:a:w/x', '2:b:w/y:free']]);
    expect((await fetch(base + '/admin/knowledge-cards/rebuild/rb-1')).status).toBe(200);
    expect((await fetch(base + '/admin/knowledge-cards/rebuild/zzz')).status).toBe(404);
  });

  it('delete passes exactly the given ids', async () => {
    const r = await post('/knowledge-cards/delete', { rowIds: ['1:a:w/x'] });
    expect(((await r.json()) as any).deleted).toBe(1);
    expect(deleted).toEqual([['1:a:w/x']]);
  });

  it('non-admin gets 403, no user gets 401, and nothing runs', async () => {
    role = 'user';
    expect((await post('/knowledge-cards/rebuild', { rowIds: ['x'] })).status).toBe(403);
    expect((await post('/knowledge-cards/delete', { rowIds: ['x'] })).status).toBe(403);
    expect((await fetch(base + '/admin/knowledge-cards/rebuild/rb-1')).status).toBe(403);
    role = null;
    expect((await post('/knowledge-cards/delete', { rowIds: ['x'] })).status).toBe(401);
    expect(started).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('rejects empty, non-string and too-long id lists', async () => {
    expect((await post('/knowledge-cards/rebuild', { rowIds: [] })).status).toBe(400);
    expect((await post('/knowledge-cards/delete', {})).status).toBe(400);
    expect((await post('/knowledge-cards/delete', { rowIds: [1, 2] })).status).toBe(400);
    const big = Array.from({ length: MAX_IDS_PER_REQUEST + 1 }, (_, i) => `1:n${i}:w`);
    expect((await post('/knowledge-cards/rebuild', { rowIds: big })).status).toBe(400);
    expect(started).toEqual([]);
  });
});

describe('viewer helpers for the projects column and select all', () => {
  it('projectScopeParam takes ids and "all"', () => {
    expect(projectScopeParam('all')).toBe('all');
    expect(projectScopeParam('126')).toBe(126);
    expect(projectScopeParam('0')).toBeNull();
    expect(projectScopeParam('x')).toBeNull();
    expect(projectScopeParam(undefined)).toBeNull();
  });

  it('rowIdsParam dedupes and validates', () => {
    expect(rowIdsParam(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(typeof rowIdsParam('a')).toBe('string');
    expect(typeof rowIdsParam(['a', 3])).toBe('string');
  });

  it('counts per project, listed projects with no cards, builds and rebuilds in progress', () => {
    const out = projectCounts({
      rows: [
        { projectId: 126, status: 'fresh', confidence: 0.9 },
        { projectId: 126, status: 'fresh', confidence: 0.5 },
        { projectId: 126, status: 'flagged', confidence: 0.2 },
        { projectId: 275, status: 'stale', confidence: 0.9 },
      ],
      minConfidence: 0.8,
      projects: [{ id: 126, name: 'hxConn' }, { id: 275, name: 'asn1' }, { id: 9, name: 'zz' }],
      listed: [9],
      runs: [{ projectId: 275, built: 41, targets: 60 }],
      jobs: [{ state: 'running', groups: [{ projectId: 126, cards: 16, built: 3, state: 'running' }, { projectId: 9, cards: 2, built: 2, state: 'done' }] }],
    });
    expect(out.all).toEqual({ total: 4, good: 1, low: 1, stale: 1, failed: 1, building: true });
    expect(out.projects.map(p => [p.name, p.total, p.failed, p.stale, p.building])).toEqual([
      ['asn1', 1, 0, 1, { built: 41, targets: 60 }],
      ['hxConn', 3, 1, 0, { built: 3, targets: 16 }],
      ['zz', 0, 0, 0, null],
    ]);
    expect(out.rebuilds).toBe(1);
  });

  it('select all returns every matching id across pages; status counts follow the other filters', () => {
    const cards = Array.from({ length: 250 }, (_, i) => card({
      rowId: `1:n${i}:w`, nodeId: `n${i}`, status: i % 5 === 0 ? 'flagged' : 'fresh', kind: i % 2 ? 'class' : 'function',
    }));
    const page = filterCards(cards, { mark: 'failed', limit: 20 }, 0.8);
    expect(page.rows.length).toBe(20);
    expect(page.total).toBe(50);
    const { hit } = matchCards(cards, { mark: 'failed' }, 0.8);
    expect(hit.length).toBe(50);
    expect(new Set(hit.map(h => h.r.rowId)).size).toBe(50);
    const byKind = filterCards(cards, { kind: 'function' }, 0.8);
    expect(byKind.marks).toEqual({ all: 125, good: 100, low: 0, stale: 0, failed: 25 });
  });
});
