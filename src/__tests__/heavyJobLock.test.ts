// `jest` is not a global under ESM — it has to be imported. This suite never
// ran before (ts-jest was compiling every suite as CommonJS and failing on
// `import.meta`), so the missing import was invisible.
import { jest } from '@jest/globals';
import {
  acquireHeavyJob, waitForHeavyJob, getHeavyJob, getHeavyJobQueue, isHeavyJobActive,
  HeavyJobBusyError, _resetHeavyJobLockForTests,
} from '../embedding/embedGate.js';

describe('heavy-job lock', () => {
  beforeEach(() => _resetHeavyJobLockForTests());

  test('acquire / release', () => {
    expect(getHeavyJob()).toBeNull();
    const release = acquireHeavyJob('code-reembed', 'full');
    expect(getHeavyJob()).toMatchObject({ kind: 'code-reembed', label: 'full' });
    expect(isHeavyJobActive()).toBe(true);
    release();
    expect(getHeavyJob()).toBeNull();
    expect(isHeavyJobActive()).toBe(false);
    release(); // idempotent
    expect(getHeavyJob()).toBeNull();
  });

  test('busy throws HeavyJobBusyError with the holder', () => {
    acquireHeavyJob('axon-index', 'all');
    expect(() => acquireHeavyJob('code-reindex', 'project 7')).toThrow(HeavyJobBusyError);
    try {
      acquireHeavyJob('code-reindex', 'project 7');
    } catch (e) {
      expect((e as HeavyJobBusyError).holder).toMatchObject({ kind: 'axon-index', label: 'all' });
    }
  });

  test('waiters are served FIFO on release', async () => {
    const r1 = acquireHeavyJob('code-reembed', 'full');
    const order: string[] = [];
    const p2 = waitForHeavyJob('axon-index', 'library').then(rel => { order.push('axon'); return rel; });
    const p3 = waitForHeavyJob('code-reindex', 'project 3').then(rel => { order.push('reindex'); return rel; });
    expect(getHeavyJobQueue().map(w => w.kind)).toEqual(['axon-index', 'code-reindex']);
    // A direct acquire may not jump the queue.
    expect(() => acquireHeavyJob('axon-index', 'jumper')).toThrow(HeavyJobBusyError);

    r1();
    const r2 = await p2;
    expect(getHeavyJob()).toMatchObject({ kind: 'axon-index', label: 'library' });
    expect(getHeavyJobQueue()).toHaveLength(1);
    r2();
    const r3 = await p3;
    expect(getHeavyJob()).toMatchObject({ kind: 'code-reindex' });
    r3();
    expect(getHeavyJob()).toBeNull();
    expect(order).toEqual(['axon', 'reindex']);
  });

  test('a stale release cannot drop a later holder', async () => {
    const r1 = acquireHeavyJob('code-reembed', 'full');
    const p2 = waitForHeavyJob('axon-index', 'all');
    r1();
    const r2 = await p2;
    r1(); // stale: must not release the axon holder
    expect(getHeavyJob()).toMatchObject({ kind: 'axon-index' });
    r2();
    expect(getHeavyJob()).toBeNull();
  });

  test('waiting can be aborted', async () => {
    acquireHeavyJob('code-reembed', 'full');
    const ac = new AbortController();
    const onWaiting = jest.fn();
    const p = waitForHeavyJob('axon-index', 'all', { signal: ac.signal, onWaiting });
    expect(onWaiting).toHaveBeenCalledWith(expect.objectContaining({ kind: 'code-reembed' }));
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(getHeavyJobQueue()).toHaveLength(0);
  });
});
