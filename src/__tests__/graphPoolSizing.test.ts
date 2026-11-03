/**
 * Per-project LadybugDB buffer-pool sizing, the query thread cap, and the
 * one-thread retry on a full pool. Regression for 2026-11-03: on a 112-CPU
 * host a 24 MiB pool overflowed on a 7 MB store and failed the whole ask.
 */

import { jest } from '@jest/globals';
import {
  computeProjectBufferPoolMiB,
  resolveGraphQueryThreads,
  runWithPoolFullRetry,
  isBufferPoolError,
} from '../graph/graphPoolSizing.js';

const POOL_FULL = 'Buffer manager exception: Unable to allocate memory! The buffer pool is full and no memory could be freed!';
const GiB = 1024;

describe('computeProjectBufferPoolMiB', () => {
  const base = { maxOpen: 8, memLimitMiB: 16 * GiB };

  it('uses the floor for small stores', () => {
    expect(computeProjectBufferPoolMiB({ ...base, fileMiB: 0 })).toBe(32);
    expect(computeProjectBufferPoolMiB({ ...base, fileMiB: 4 })).toBe(32);
  });

  it('grows with the store file (5x)', () => {
    expect(computeProjectBufferPoolMiB({ ...base, fileMiB: 15 })).toBe(75);
  });

  it('caps at the memory budget per open store', () => {
    // 16 GiB x 0.0625 / 8 = 128 MiB
    expect(computeProjectBufferPoolMiB({ ...base, fileMiB: 27 })).toBe(128);
    expect(computeProjectBufferPoolMiB({ ...base, fileMiB: 500 })).toBe(128);
  });

  it('keeps all open pools well under the 75% RSS guard', () => {
    const pool = computeProjectBufferPoolMiB({ ...base, fileMiB: 10_000 });
    expect(pool * base.maxOpen).toBeLessThan(16 * GiB * 0.75 * 0.1);
  });

  it('never goes below the floor on a small machine', () => {
    expect(computeProjectBufferPoolMiB({ fileMiB: 100, maxOpen: 16, memLimitMiB: 2 * GiB })).toBe(32);
  });

  it('honours the hard max and a fixed override', () => {
    expect(computeProjectBufferPoolMiB({ fileMiB: 100, maxOpen: 1, memLimitMiB: 64 * GiB })).toBe(256);
    expect(computeProjectBufferPoolMiB({ fileMiB: 100, maxOpen: 1, memLimitMiB: 64 * GiB, maxMiB: 512 })).toBe(500);
    expect(computeProjectBufferPoolMiB({ ...base, fileMiB: 100, fixedMiB: 64 })).toBe(64);
  });

  it('honours a custom floor and memory fraction', () => {
    expect(computeProjectBufferPoolMiB({ ...base, fileMiB: 1, minMiB: 48 })).toBe(48);
    expect(computeProjectBufferPoolMiB({ ...base, fileMiB: 100, memFraction: 0.25 })).toBe(256);
  });
});

describe('resolveGraphQueryThreads', () => {
  const saved = process.env.FANTOM_GRAPH_QUERY_THREADS;
  afterEach(() => {
    if (saved === undefined) delete process.env.FANTOM_GRAPH_QUERY_THREADS;
    else process.env.FANTOM_GRAPH_QUERY_THREADS = saved;
  });

  it('caps a large host at 4 threads', () => {
    delete process.env.FANTOM_GRAPH_QUERY_THREADS;
    expect(resolveGraphQueryThreads(112)).toBe(4);
    expect(resolveGraphQueryThreads(2)).toBe(2);
    expect(resolveGraphQueryThreads(0)).toBe(1);
  });

  it('takes the env override', () => {
    process.env.FANTOM_GRAPH_QUERY_THREADS = '12';
    expect(resolveGraphQueryThreads(112)).toBe(12);
  });
});

describe('runWithPoolFullRetry', () => {
  function fakeConn() {
    const calls: number[] = [];
    return { calls, setMaxNumThreadForExec: (n: number) => { calls.push(n); } };
  }

  it('returns the first result without touching threads', async () => {
    const conn = fakeConn();
    await expect(runWithPoolFullRetry(conn, 4, async () => 'ok')).resolves.toBe('ok');
    expect(conn.calls).toEqual([]);
  });

  it('retries a full pool once on 1 thread, then restores', async () => {
    const conn = fakeConn();
    let n = 0;
    const onRetry = jest.fn();
    const out = await runWithPoolFullRetry(conn, 4, async () => {
      n++;
      if (n === 1) throw new Error(POOL_FULL);
      return 'rows';
    }, onRetry);
    expect(out).toBe('rows');
    expect(n).toBe(2);
    expect(conn.calls).toEqual([1, 4]);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('throws when the retry also fails, and still restores threads', async () => {
    const conn = fakeConn();
    await expect(runWithPoolFullRetry(conn, 4, async () => { throw new Error(POOL_FULL); }))
      .rejects.toThrow(/buffer pool is full/);
    expect(conn.calls).toEqual([1, 4]);
  });

  it('does not retry other errors', async () => {
    const conn = fakeConn();
    let n = 0;
    await expect(runWithPoolFullRetry(conn, 4, async () => { n++; throw new Error('Parser exception'); }))
      .rejects.toThrow('Parser exception');
    expect(n).toBe(1);
    expect(conn.calls).toEqual([]);
  });

  it('recognises the pool-full message', () => {
    expect(isBufferPoolError(new Error(POOL_FULL))).toBe(true);
    expect(isBufferPoolError('IO exception')).toBe(false);
  });
});
