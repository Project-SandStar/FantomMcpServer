/**
 * Graph tab settings: precedence (saved > env > default), validation, and the
 * live pool shrink (idle stores close oldest first, busy ones never).
 */
import {
  resolveGraphKnob, resolveAllGraphKnobs, validateGraphPatch, sanitizeGraphSaved,
  saveGraphSettings, getSavedGraphSettings, graphSetting, projectFanout, __setGraphSettingsForTest,
} from '../graph/graphSettings.js';
import { trimPoolEntries, type TrimmableEntry } from '../graph/projectGraphConnection.js';
import { graphMemoryWarning } from '../admin/graphSettingsRoutes.js';

describe('graph settings precedence', () => {
  it('uses the code default when nothing is set', () => {
    expect(resolveGraphKnob('maxOpen', {}, {})).toEqual({ value: 16, source: 'default' });
    expect(resolveGraphKnob('queryThreads', {}, {}, 112)).toEqual({ value: 4, source: 'default' });
    expect(resolveGraphKnob('queryThreads', {}, {}, 2)).toEqual({ value: 2, source: 'default' });
  });

  it('uses the env var when nothing is saved', () => {
    expect(resolveGraphKnob('maxOpen', {}, { FANTOM_GRAPH_MAX_OPEN: '16' })).toEqual({ value: 16, source: 'env' });
    expect(resolveGraphKnob('maxOpen', {}, { FANTOM_GRAPH_MAX_OPEN: '8' })).toEqual({ value: 8, source: 'env' });
  });

  it('a saved value beats the env var', () => {
    expect(resolveGraphKnob('maxOpen', { maxOpen: 12 }, { FANTOM_GRAPH_MAX_OPEN: '16' })).toEqual({ value: 12, source: 'saved' });
  });

  it('an invalid env value falls back to the default', () => {
    expect(resolveGraphKnob('maxOpen', {}, { FANTOM_GRAPH_MAX_OPEN: 'abc' }).source).toBe('default');
    expect(resolveGraphKnob('maxOpen', {}, { FANTOM_GRAPH_MAX_OPEN: '0' }).source).toBe('default');
  });

  it('saving one knob does not pin the others (env stays in force)', () => {
    __setGraphSettingsForTest({});
    try {
      const { next } = validateGraphPatch({ projectFanout: 6 }, getSavedGraphSettings(), {});
      const saved = saveGraphSettings(next);
      expect(saved).toEqual({ projectFanout: 6 });
      const eff = resolveAllGraphKnobs(getSavedGraphSettings(), { FANTOM_GRAPH_MAX_OPEN: '16' });
      expect(eff.maxOpen).toEqual({ value: 16, source: 'env' });
      expect(eff.projectFanout).toEqual({ value: 6, source: 'saved' });
      expect(graphSetting('projectFanout')).toBe(6);
    } finally {
      __setGraphSettingsForTest(null);
    }
  });

  it('null clears a saved value', () => {
    const { problems, next } = validateGraphPatch({ maxOpen: null }, { maxOpen: 10, relatedLimit: 5 }, {});
    expect(problems).toEqual([]);
    expect(next).toEqual({ relatedLimit: 5 });
  });
});

describe('graph settings validation', () => {
  it('rejects out-of-range, non-integer and unknown keys', () => {
    expect(validateGraphPatch({ maxOpen: 1 }, {}, {}).problems[0]).toMatch(/maxOpen must be an integer between 2 and 64/);
    expect(validateGraphPatch({ maxOpen: 100 }, {}, {}).problems).toHaveLength(1);
    expect(validateGraphPatch({ maxOpen: 8.5 }, {}, {}).problems).toHaveLength(1);
    expect(validateGraphPatch({ bogus: 1 }, {}, {}).problems[0]).toMatch(/unknown setting/);
    expect(validateGraphPatch({ poolMemFraction: 0.1 }, {}, {}).problems).toEqual([]);
  });

  it('checks min <= max on the merged effective values', () => {
    expect(validateGraphPatch({ bufferMinMiB: 300 }, {}, {}).problems[0]).toMatch(/bufferMinMiB \(300\) must be <= bufferMaxMiB \(256\)/);
    expect(validateGraphPatch({ bufferMinMiB: 300 }, {}, { FANTOM_GRAPH_DB_BUFFER_MAX_MIB: '512' }).problems).toEqual([]);
    expect(validateGraphPatch({ bufferMinMiB: 300, bufferMaxMiB: 400 }, {}, {}).problems).toEqual([]);
  });

  it('keeps the search fan-out at or below half the pool cap', () => {
    expect(validateGraphPatch({ projectFanout: 8 }, {}, { FANTOM_GRAPH_MAX_OPEN: '16' }).problems).toEqual([]);
    expect(validateGraphPatch({ projectFanout: 9 }, {}, { FANTOM_GRAPH_MAX_OPEN: '16' }).problems[0]).toMatch(/projectFanout \(9\) must be <= half of maxOpen/);
    expect(validateGraphPatch({ maxOpen: 8 }, {}, {}).problems).toEqual([]);
    // Default fan-out 4 > 6 / 2: lowering the cap needs a lower fan-out too.
    expect(validateGraphPatch({ maxOpen: 6 }, {}, {}).problems).toHaveLength(1);
    expect(validateGraphPatch({ maxOpen: 6, projectFanout: 3 }, {}, {}).problems).toEqual([]);
    // An env pair that breaks the rule does not block an unrelated save.
    expect(validateGraphPatch({ relatedLimit: 5 }, {}, { FANTOM_GRAPH_MAX_OPEN: '4' }).problems).toEqual([]);
  });

  it('projectFanout() clamps an env value above half the cap', () => {
    const prev = { ...process.env };
    __setGraphSettingsForTest({});
    try {
      process.env.FANTOM_GRAPH_MAX_OPEN = '8';
      process.env.FANTOM_GRAPH_PROJECT_FANOUT = '12';
      expect(projectFanout()).toBe(4);
      __setGraphSettingsForTest({ projectFanout: 3 });
      expect(projectFanout()).toBe(3);
    } finally {
      process.env.FANTOM_GRAPH_MAX_OPEN = prev.FANTOM_GRAPH_MAX_OPEN;
      process.env.FANTOM_GRAPH_PROJECT_FANOUT = prev.FANTOM_GRAPH_PROJECT_FANOUT;
      if (prev.FANTOM_GRAPH_MAX_OPEN === undefined) delete process.env.FANTOM_GRAPH_MAX_OPEN;
      if (prev.FANTOM_GRAPH_PROJECT_FANOUT === undefined) delete process.env.FANTOM_GRAPH_PROJECT_FANOUT;
      __setGraphSettingsForTest(null);
    }
  });

  it('sanitize drops bad stored values', () => {
    expect(sanitizeGraphSaved({ maxOpen: 999, relatedLimit: 4, junk: 1 })).toEqual({ relatedLimit: 4 });
    expect(sanitizeGraphSaved(null)).toEqual({});
  });
});

describe('live pool shrink (trimPoolEntries)', () => {
  function pool(spec: Array<[number, number, number]>): Map<number, TrimmableEntry> {
    return new Map(spec.map(([projectId, lastUsed, inFlight]) => [projectId, { projectId, lastUsed, inFlight }]));
  }

  it('closes idle stores oldest first down to the cap, never busy ones', async () => {
    const m = pool([[1, 100, 0], [2, 50, 1], [3, 10, 0], [4, 200, 0], [5, 30, 0]]);
    const closed: number[] = [];
    const ids = await trimPoolEntries(m, 2, async (id) => { closed.push(id); m.delete(id); }, true);
    expect(ids).toEqual([3, 5, 1]);
    expect(closed).toEqual([3, 5, 1]);
    expect([...m.keys()].sort()).toEqual([2, 4]);
  });

  it('stops above the cap when only busy stores remain', async () => {
    const m = pool([[1, 1, 1], [2, 2, 1], [3, 3, 0]]);
    const ids = await trimPoolEntries(m, 1, async (id) => { m.delete(id); }, true);
    expect(ids).toEqual([3]);
    expect(m.size).toBe(2);
  });

  it('non-inclusive mode leaves room for one open (the evictor before an open)', async () => {
    const m = pool([[1, 1, 0], [2, 2, 0], [3, 3, 0]]);
    await trimPoolEntries(m, 3, async (id) => { m.delete(id); });
    expect([...m.keys()]).toEqual([2, 3]);
  });

  it('does not loop when a close fails to remove the entry', async () => {
    const m = pool([[1, 1, 0], [2, 2, 0]]);
    const ids = await trimPoolEntries(m, 0, async () => { /* no-op */ }, true);
    expect(ids).toEqual([1]);
  });

  it('closes nothing when under the cap', async () => {
    const m = pool([[1, 1, 0]]);
    expect(await trimPoolEntries(m, 16, async () => { throw new Error('no'); }, true)).toEqual([]);
  });
});

describe('graphMemoryWarning', () => {
  it('warns as cap x per-store nears the guard', () => {
    expect(graphMemoryWarning(3000, 8, 16, 14400).level).toBe('ok');
    expect(graphMemoryWarning(11000, 8, 32, 14400).level).toBe('warn');
    expect(graphMemoryWarning(11000, 8, 64, 14400).level).toBe('danger');
    expect(graphMemoryWarning(11000, 8, 64, 0).level).toBe('ok');
  });
});

describe('graph storage summary', () => {
  it('counts project stores, WALs and size; keeps quarantined files apart', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { summarizeGraphDir } = await import('../graph/graphStorageInfo.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphstore-'));
    try {
      fs.writeFileSync(path.join(dir, '1.db'), Buffer.alloc(100));
      fs.writeFileSync(path.join(dir, '2.db'), Buffer.alloc(50));
      fs.writeFileSync(path.join(dir, '2.db.wal'), Buffer.alloc(10));
      fs.writeFileSync(path.join(dir, '3.db.corrupt-2026-10-17'), Buffer.alloc(1000));
      const s = summarizeGraphDir(dir);
      expect(s).toMatchObject({ storeCount: 2, walCount: 1, totalBytes: 160, corruptCount: 1, corruptBytes: 1000 });
      expect(s.lastModified).not.toBeNull();
      expect(summarizeGraphDir(path.join(dir, 'missing')).storeCount).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the installed LadybugDB version', async () => {
    const { ladybugVersion } = await import('../graph/graphStorageInfo.js');
    expect(ladybugVersion(process.cwd())).toMatch(/^\d+\.\d+\.\d+/);
  });
});
