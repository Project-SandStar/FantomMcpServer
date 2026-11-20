/**
 * ORDW-05: bounded vector write buffer with grouped commits.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  submitRows, waitForRoom, getVectorWriteStats, __resetVectorWriteBufferForTest, type RowGroup,
} from '../embedding/vectorWriteBuffer.js';
import { enqueueTableWrite, __resetVectorWriteQueueForTest } from '../embedding/vectorWriteQueue.js';
import {
  clampSetting, sanitizeVectorWriteSettings, VECTOR_WRITE_LIMITS, __setVectorWriteSettingsForTest,
} from '../embedding/vectorWriteSettings.js';

type Row = { key: string; v: number; bad?: boolean };

/** A fake table: rows by key, a log of commits, an optional gate on add. */
function fakeTable(name = 'code_vectors') {
  const t = {
    name,
    rows: [] as Row[],
    commits: [] as number[],
    active: 0,
    peak: 0,
    gate: null as Promise<void> | null,
  };
  return t;
}
type Fake = ReturnType<typeof fakeTable>;

const commit = async (table: unknown, groups: RowGroup<Row>[]) => {
  const t = table as Fake;
  t.active++;
  t.peak = Math.max(t.peak, t.active);
  try {
    if (t.gate) await t.gate;
    const keys = new Set(groups.map(g => g.key));
    t.rows = t.rows.filter(r => !keys.has(r.key)); // delete
    const add = groups.flatMap(g => g.rows);
    if (add.some(r => r.bad)) throw new Error('add failed');
    t.rows.push(...add);
    t.commits.push(add.length);
  } finally {
    t.active--;
  }
};

const groups = (prefix: string, n: number, perGroup = 1, extra: Partial<Row> = {}): RowGroup<Row>[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `${prefix}${i}`,
    rows: Array.from({ length: perGroup }, (_, c) => ({ key: `${prefix}${i}`, v: c, ...extra })),
  }));

function gated(t: Fake): () => void {
  let open!: () => void;
  t.gate = new Promise<void>(r => { open = r; });
  return () => { t.gate = null; open(); };
}

const tick = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  __resetVectorWriteQueueForTest();
  __resetVectorWriteBufferForTest();
  __setVectorWriteSettingsForTest({ maxPendingRows: 2000, writeBatchRows: 1000 });
});

describe('vector write buffer', () => {
  it('groups 2500 rows into 3 commits of at most 1000', async () => {
    const t = fakeTable();
    const stored = await submitRows(t, commit, groups('n', 2500));
    expect(stored).toBe(2500);
    expect(t.commits).toEqual([1000, 1000, 500]);
    expect(t.rows).toHaveLength(2500);
    const s = getVectorWriteStats();
    expect(s.totals.commits).toBe(3);
    expect(s.totals.rowsWritten).toBe(2500);
    expect(s.totals.bufferRows).toBe(0);
    expect(s.writeConcurrency).toBe(1);
  });

  it('applies back-pressure: a producer waits while the buffer is full and resumes after a drain', async () => {
    __setVectorWriteSettingsForTest({ maxPendingRows: 200, writeBatchRows: 100 });
    const t = fakeTable();
    const open = gated(t);
    const a = submitRows(t, commit, groups('a', 150));
    let bDone = false;
    const b = submitRows(t, commit, groups('b', 100)).then(n => { bDone = true; return n; });
    await tick();
    let s = getVectorWriteStats().tables.find(x => x.table === 'code_vectors')!;
    expect(s.bufferRows).toBe(150);
    expect(s.waitingProducers).toBe(1);
    let roomReady = false;
    const room = waitForRoom(t, 100).then(() => { roomReady = true; });
    await tick();
    expect(roomReady).toBe(false);
    expect(bDone).toBe(false);
    open();
    expect(await a).toBe(150);
    expect(await b).toBe(100);
    await room;
    expect(roomReady).toBe(true);
    s = getVectorWriteStats().tables.find(x => x.table === 'code_vectors')!;
    expect(s.bufferRows).toBe(0);
    expect(s.producerWaitMs).toBeGreaterThanOrEqual(0);
    expect(t.rows).toHaveLength(250);
  });

  it('never holds more than maxPendingRows plus one call under many producers', async () => {
    __setVectorWriteSettingsForTest({ maxPendingRows: 300, writeBatchRows: 100 });
    const t = fakeTable();
    let peak = 0;
    const slow = async (table: unknown, g: RowGroup<Row>[]) => {
      peak = Math.max(peak, getVectorWriteStats().totals.bufferRows);
      await new Promise(r => setTimeout(r, 2));
      await commit(table, g);
    };
    await Promise.all(Array.from({ length: 20 }, (_, i) => submitRows(t, slow, groups(`p${i}-`, 50))));
    expect(peak).toBeLessThanOrEqual(300);
    expect(t.rows).toHaveLength(1000);
  });

  it('runs one writer at a time per table, also against direct writes', async () => {
    __setVectorWriteSettingsForTest({ maxPendingRows: 20000, writeBatchRows: 100 });
    const t = fakeTable();
    const direct = () => enqueueTableWrite(t, async () => {
      t.active++; t.peak = Math.max(t.peak, t.active);
      await tick();
      t.active--;
    });
    await Promise.all([
      submitRows(t, commit, groups('a', 250)),
      direct(),
      submitRows(t, commit, groups('b', 250)),
      direct(),
      submitRows(t, commit, groups('c', 250)),
    ]);
    expect(t.peak).toBe(1);
    expect(t.rows).toHaveLength(750);
  });

  it('keeps order against a direct delete: rows before it are deleted, rows after it survive', async () => {
    const t = fakeTable();
    const open = gated(t);
    const a = submitRows(t, commit, groups('x', 10));
    await tick(); // rows are ordered by when they enter the buffer
    const del = enqueueTableWrite(t, async () => { t.rows = []; });
    const b = submitRows(t, commit, groups('y', 5));
    open();
    await Promise.all([a, del, b]);
    expect(t.rows.map(r => r.key).sort()).toEqual(['y0', 'y1', 'y2', 'y3', 'y4']);
  });

  it('never splits one group across commits', async () => {
    __setVectorWriteSettingsForTest({ maxPendingRows: 2000, writeBatchRows: 100 });
    const t = fakeTable();
    await submitRows(t, commit, [...groups('a', 99), ...groups('big', 1, 3)]);
    expect(t.commits).toEqual([99, 3]);
    expect(t.rows.filter(r => r.key === 'big0')).toHaveLength(3);
  });

  it('lets the later producer win when two bring the same group into one commit', async () => {
    const t = fakeTable();
    const open = gated(t);
    const first = submitRows(t, commit, groups('blk', 1));
    await tick();
    const p1 = submitRows(t, commit, [{ key: 'n', rows: [{ key: 'n', v: 1 }, { key: 'n', v: 2 }] }]);
    const p2 = submitRows(t, commit, [{ key: 'n', rows: [{ key: 'n', v: 9 }] }]);
    open();
    await Promise.all([first, p1, p2]);
    expect(t.rows.filter(r => r.key === 'n').map(r => r.v)).toEqual([9]);
  });

  it('surfaces a failed commit to its producer only and loses no rows of the others', async () => {
    const t = fakeTable();
    const open = gated(t);
    const blocker = submitRows(t, commit, groups('blk', 1));
    await tick();
    const good1 = submitRows(t, commit, groups('g', 10));
    const bad = submitRows(t, commit, groups('b', 5, 1, { bad: true }));
    const good2 = submitRows(t, commit, groups('h', 10));
    open();
    await expect(bad).rejects.toThrow('add failed');
    expect(await good1).toBe(10);
    expect(await good2).toBe(10);
    await blocker;
    expect(t.rows.filter(r => r.key.startsWith('g'))).toHaveLength(10);
    expect(t.rows.filter(r => r.key.startsWith('h'))).toHaveLength(10);
    expect(t.rows.some(r => r.bad)).toBe(false);
    const s = getVectorWriteStats().totals;
    expect(s.failedCommits).toBeGreaterThanOrEqual(1);
    expect(s.bufferRows).toBe(0);
    // The chain is not poisoned.
    expect(await submitRows(t, commit, groups('z', 3))).toBe(3);
  });

  it('a failure part-way stops that producer and frees its buffered rows', async () => {
    __setVectorWriteSettingsForTest({ maxPendingRows: 2000, writeBatchRows: 100 });
    const t = fakeTable();
    const rows = [...groups('ok', 100), ...groups('bad', 100, 1, { bad: true }), ...groups('late', 100)];
    await expect(submitRows(t, commit, rows)).rejects.toThrow('add failed');
    expect(t.rows).toHaveLength(100); // first commit stays, as before
    expect(getVectorWriteStats().totals.bufferRows).toBe(0);
  });

  it('keeps tables apart', async () => {
    const a = fakeTable('code_vectors');
    const b = fakeTable('code_vectors_b');
    const openA = gated(a);
    const pa = submitRows(a, commit, groups('a', 10));
    expect(await submitRows(b, commit, groups('b', 10))).toBe(10);
    openA();
    expect(await pa).toBe(10);
  });
});

describe('vector write settings', () => {
  it('clamps to range and falls back to the default', () => {
    const r = VECTOR_WRITE_LIMITS.maxPendingRows;
    expect(clampSetting(50, r)).toBe(100);
    expect(clampSetting(999999, r)).toBe(20000);
    expect(clampSetting(2500.4, r)).toBe(2500);
    expect(clampSetting(NaN, r)).toBe(2000);
    expect(clampSetting('3000', r)).toBe(2000);
    expect(clampSetting(undefined, r)).toBe(2000);
    expect(sanitizeVectorWriteSettings({ writeBatchRows: 1 })).toEqual({ maxPendingRows: 2000, writeBatchRows: 100 });
    expect(sanitizeVectorWriteSettings({ writeBatchRows: 9000, maxPendingRows: 150 })).toEqual({ maxPendingRows: 150, writeBatchRows: 5000 });
    expect(sanitizeVectorWriteSettings(null)).toEqual({ maxPendingRows: 2000, writeBatchRows: 1000 });
  });

  it('applies a change to the next commit', async () => {
    const t = fakeTable();
    __setVectorWriteSettingsForTest({ writeBatchRows: 100 });
    await submitRows(t, commit, groups('a', 200));
    __setVectorWriteSettingsForTest({ writeBatchRows: 200 });
    await submitRows(t, commit, groups('b', 200));
    expect(t.commits).toEqual([100, 100, 200]);
  });
});
