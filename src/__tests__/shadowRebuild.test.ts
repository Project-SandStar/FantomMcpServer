/**
 * Project-level work queue, single-writer store, promotion, and the
 * pause / resume / discard lifecycle.
 *
 * Three invariants worth stating plainly, because each corresponds to a real
 * incident:
 *
 *  - No project is ever claimed twice (duplicated embedding work).
 *  - No two writes to one LanceDB table overlap — appends, deletes AND
 *    compaction (a lost manifest commit).
 *  - A halt that is not an explicit Discard keeps the shadow (a stop that
 *    preserved 225,008 rows across 324 projects once read as total loss).
 */

import { jest } from '@jest/globals';
import {
  createProjectQueue, decidePromotion, resolveMaxConcurrentProjects, haltRequested,
  DEFAULT_MAX_CONCURRENT_PROJECTS, MAX_CONCURRENT_PROJECTS_CAP,
} from '../admin/shadowRebuild.js';
import {
  createJob, requestPause, requestCancel, updateJob, getJob,
  findPausedJob, findActiveJob, __resetJobsForTest,
} from '../admin/reembedJobs.js';
import {
  enqueueWrite, enqueueTableWrite, tableKey,
  __resetVectorWriteQueueForTest, vectorWriteQueueStats,
} from '../embedding/vectorWriteQueue.js';

beforeEach(() => {
  __resetVectorWriteQueueForTest();
  __resetJobsForTest();
});

describe('project queue — claimed exactly once', () => {
  it('hands each project to one worker and no more', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const queue = createProjectQueue(ids);
    const seen: number[] = [];

    await Promise.all(Array.from({ length: 6 }, async () => {
      for (;;) {
        const pid = queue.claim();
        if (pid === undefined) return;
        seen.push(pid);
        await new Promise(r => setTimeout(r, Math.random() * 3));
        queue.release(pid);
      }
    }));

    expect(seen.sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
    expect(queue.inFlight).toBe(0);
    expect(queue.remaining).toBe(0);
  });

  it('runs several projects concurrently rather than one at a time', async () => {
    const queue = createProjectQueue([1, 2, 3, 4, 5, 6]);
    let peak = 0, active = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (;;) {
        const pid = queue.claim();
        if (pid === undefined) return;
        active++; peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 15));
        active--; queue.release(pid);
      }
    }));
    expect(peak).toBeGreaterThan(1);
  });

  it('releases a claim when the work throws, so a failure never strands a project', async () => {
    const queue = createProjectQueue([1]);
    const pid = queue.claim()!;
    try {
      await Promise.reject(new Error('boom'));
    } catch { /* expected */ } finally {
      queue.release(pid);
    }
    expect(queue.inFlight).toBe(0);
    expect(queue.orphaned).toEqual([]);
  });

  it('reports a claim never released — a worker killed mid-project', () => {
    const queue = createProjectQueue([7, 8]);
    queue.claim();
    expect(queue.orphaned).toEqual([7]);
  });
});

describe('single-writer store', () => {
  it('never overlaps two writes to the same table', async () => {
    let active = 0, peak = 0;
    const write = () => enqueueWrite('code_vectors', async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });
    await Promise.all([write(), write(), write(), write(), write()]);
    expect(peak).toBe(1);
  });

  it('serializes COMPACTION against appends — the case concurrency introduced', async () => {
    // Compaction rewrites fragments; an append landing mid-optimize is the
    // manifest conflict this codebase has no retry for. Both go through the
    // same slot, so one can never start while the other runs.
    const log: string[] = [];
    const append = () => enqueueWrite('code_vectors_b', async () => {
      log.push('append-start');
      await new Promise(r => setTimeout(r, 5));
      log.push('append-end');
    });
    const compact = () => enqueueWrite('code_vectors_b', async () => {
      log.push('compact-start');
      await new Promise(r => setTimeout(r, 5));
      log.push('compact-end');
    });
    await Promise.all([append(), compact(), append()]);
    // Every start is immediately followed by its own end — no interleaving.
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i + 1]).toBe(log[i].replace('-start', '-end'));
    }
  });

  it('preserves submission order', async () => {
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map(n => enqueueWrite('t', async () => {
      await new Promise(r => setTimeout(r, 5 - n));
      order.push(n);
    })));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('lets a shadow slot write in parallel with the live one', async () => {
    let concurrent = 0, peak = 0;
    const w = (key: string) => enqueueWrite(key, async () => {
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
    });
    await Promise.all([w('code_vectors'), w('code_vectors_b')]);
    expect(peak).toBe(2);
  });

  it('does not let one failed write poison the writes queued behind it', async () => {
    const results: string[] = [];
    const bad = enqueueWrite('t', async () => { throw new Error('append failed'); });
    const good = enqueueWrite('t', async () => { results.push('ok'); });
    await expect(bad).rejects.toThrow('append failed');
    await good;
    expect(results).toEqual(['ok']);
  });

  it('drains its depth counter when everything settles', async () => {
    await Promise.allSettled([
      enqueueWrite('t', async () => {}),
      enqueueWrite('t', async () => { throw new Error('x'); }),
    ]);
    expect(vectorWriteQueueStats()).toEqual([]);
  });

  it('keys by table name, and two handles to one table share a slot', async () => {
    expect(tableKey({ name: 'code_vectors' })).toBe('code_vectors');
    expect(tableKey({})).toBe('__default__');
    let peak = 0, active = 0;
    const w = (t: unknown) => enqueueTableWrite(t, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });
    await Promise.all([w({ name: 'code_vectors' }), w({ name: 'code_vectors' })]);
    expect(peak).toBe(1);
  });
});

describe('promotion', () => {
  it('promotes a complete, non-empty shadow', () => {
    expect(decidePromotion(340, 340, 225_008).promote).toBe(true);
  });

  it('refuses an incomplete shadow by default, keeping the live table', () => {
    const d = decidePromotion(324, 340, 225_008);
    expect(d.promote).toBe(false);
    expect(d.reason).toMatch(/incomplete/);
  });

  it('refuses an empty shadow even when "complete"', () => {
    expect(decidePromotion(340, 340, 0).promote).toBe(false);
  });

  it('"Promote anyway" ships a substantially-complete shadow and says what is missing', () => {
    const d = decidePromotion(324, 340, 225_008, true);
    expect(d.promote).toBe(true);
    expect(d.reason).toMatch(/16 missing project/);
    expect(d.reason).toMatch(/NO vectors/);
  });

  it('will not force-promote an empty shadow', () => {
    expect(decidePromotion(0, 340, 0, true).promote).toBe(false);
  });
});

describe('concurrency bound', () => {
  it('defaults to 3 — three concurrent reindexes once tripped the RSS guard', () => {
    expect(resolveMaxConcurrentProjects({})).toBe(DEFAULT_MAX_CONCURRENT_PROJECTS);
    expect(resolveMaxConcurrentProjects({ semanticSearch: {} })).toBe(3);
  });
  it('honours a configured value', () => {
    expect(resolveMaxConcurrentProjects({ semanticSearch: { maxConcurrentProjects: 5 } })).toBe(5);
  });
  it('clamps an absurd value instead of letting it kill the server', () => {
    expect(resolveMaxConcurrentProjects({ semanticSearch: { maxConcurrentProjects: 500 } })).toBe(MAX_CONCURRENT_PROJECTS_CAP);
    expect(resolveMaxConcurrentProjects({ semanticSearch: { maxConcurrentProjects: 0 } })).toBe(DEFAULT_MAX_CONCURRENT_PROJECTS);
    expect(resolveMaxConcurrentProjects({ semanticSearch: { maxConcurrentProjects: -2 } })).toBe(DEFAULT_MAX_CONCURRENT_PROJECTS);
  });
});

describe('pause vs discard', () => {
  it('starts with neither halt flag set', () => {
    const j = createJob('all');
    expect(j.pauseRequested).toBe(false);
    expect(j.cancelRequested).toBe(false);
    expect(haltRequested(j.id)).toBeNull();
  });

  it('pause halts the loop without asking for a discard', () => {
    const j = createJob('all');
    updateJob(j.id, { status: 'running' });
    requestPause(j.id);
    expect(getJob(j.id)!.pauseRequested).toBe(true);
    expect(getJob(j.id)!.cancelRequested).toBe(false);
    expect(haltRequested(j.id)).toBe('paused');
  });

  it('discard halts the loop and is distinguishable from a pause', () => {
    const j = createJob('all');
    updateJob(j.id, { status: 'running' });
    requestCancel(j.id);
    expect(haltRequested(j.id)).toBe('cancelled');
  });

  it('a discard on top of a pause wins — the destructive intent is explicit', () => {
    const j = createJob('all');
    updateJob(j.id, { status: 'running' });
    requestPause(j.id);
    requestCancel(j.id);
    expect(haltRequested(j.id)).toBe('cancelled');
  });

  it('a paused job can still be discarded, but not re-paused', () => {
    const j = createJob('all');
    updateJob(j.id, { status: 'paused' });
    requestPause(j.id);
    expect(getJob(j.id)!.pauseRequested).toBe(false);   // already halted
    requestCancel(j.id);
    expect(getJob(j.id)!.cancelRequested).toBe(true);
  });

  it('a paused job does NOT occupy the single re-embed slot', () => {
    const j = createJob('all');
    updateJob(j.id, { status: 'paused' });
    expect(findActiveJob()).toBeUndefined();
    expect(findPausedJob()?.id).toBe(j.id);
  });

  it('a running job does occupy the slot', () => {
    const j = createJob('all');
    updateJob(j.id, { status: 'running' });
    expect(findActiveJob()?.id).toBe(j.id);
  });

  it('a paused job keeps its progress visible so a pause never looks like a wipe', () => {
    const j = createJob('all');
    updateJob(j.id, { status: 'paused', doneProjects: 324, totalProjects: 340, shadowTable: 'code_vectors_b' });
    const p = findPausedJob()!;
    expect(p.doneProjects).toBe(324);
    expect(p.totalProjects).toBe(340);
    expect(p.shadowTable).toBe('code_vectors_b');
  });

  it('haltRequested is null for an unknown job', () => {
    expect(haltRequested('nope')).toBeNull();
  });
});

describe('no CommonJS in the ESM job runner', () => {
  // `require` is undefined at runtime in this ESM tree, but @types/node
  // declares it, so tsc happily accepts `require('node:fs')` — and a
  // ReferenceError swallowed by a `catch` silently disables whatever it
  // guarded. routes.ts already carries a comment about this exact failure
  // breaking the AST tab; guard the whole file, not one site.
  it('routes.ts never calls require()', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'admin', 'routes.ts'), 'utf-8');
    const hits = src.split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /(^|[^.\w])require\s*\(/.test(line) && !line.trimStart().startsWith('//'));
    expect(hits.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });
});

afterEach(() => jest.restoreAllMocks());
