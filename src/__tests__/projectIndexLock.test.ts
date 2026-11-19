/**
 * At most one index pass per project at a time. The 2026-11-05 bulk
 * admin-reindex ran #959 and #960 for one project at once: indexProject took
 * no lock (only reindexFiles did, and only per service instance).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { _resetActiveIndexingForTests, isProjectIndexing } from '../fantom-code/activeIndexing.js';

const { CodeIndexingService } = await import('../fantom-code/codeIndexingService.js');

type Probe = { running: number; max: number; order: string[] };

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A service whose real work is replaced by a slow probe. */
function service(probe: Probe, tag: string): any {
  const s: any = new CodeIndexingService({} as any);
  const work = (label: string) => async () => {
    probe.running++;
    probe.max = Math.max(probe.max, probe.running);
    probe.order.push(`${label} start`);
    await tick(20);
    probe.order.push(`${label} end`);
    probe.running--;
    return { label } as any;
  };
  s.indexProjectImpl = (_p: unknown, o: { trigger?: string }) => work(`${tag}:index:${o.trigger}`)();
  s.reindexFilesLocked = () => work(`${tag}:files`)();
  s.rebuildGraphLocked = () => work(`${tag}:graph`)();
  return s;
}

const project = (id: number) => ({ id, name: `p${id}`, path: `/p/${id}` }) as any;

describe('per-project index lock', () => {
  let probe: Probe;
  beforeEach(() => {
    _resetActiveIndexingForTests();
    probe = { running: 0, max: 0, order: [] };
  });

  it('two indexProject calls for one project do not overlap', async () => {
    const s = service(probe, 'a');
    const [r1, r2] = await Promise.all([
      s.indexProject(project(7), { trigger: 'admin-reindex' }),
      s.indexProject(project(7), { trigger: 'auto' }),
    ]);
    expect(probe.max).toBe(1);
    expect(probe.order).toEqual([
      'a:index:admin-reindex start', 'a:index:admin-reindex end',
      'a:index:auto start', 'a:index:auto end',
    ]);
    expect(r1.label).toBe('a:index:admin-reindex');
    expect(r2.label).toBe('a:index:auto');
    expect(isProjectIndexing(7)).toBe(false);
  });

  it('serializes indexProject, reindexFiles and rebuildGraph across service instances', async () => {
    const a = service(probe, 'a'), b = service(probe, 'b');
    await Promise.all([
      a.indexProject(project(7), { trigger: 'admin-reindex' }),
      b.reindexFiles({ projectId: 7, paths: ['/p/7/A.fan'] }),
      a.rebuildGraph(7),
    ]);
    expect(probe.max).toBe(1);
    expect(probe.order).toHaveLength(6);
  });

  it('marks a waiting pass busy, and a failed pass does not block the next', async () => {
    const s = service(probe, 'a');
    s.indexProjectImpl = async () => { await tick(10); throw new Error('boom'); };
    const first = s.indexProject(project(7), {});
    const second = s.reindexFiles({ projectId: 7, paths: [] });
    expect(isProjectIndexing(7)).toBe(true);
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toEqual({ label: 'a:files' });
    expect(isProjectIndexing(7)).toBe(false);
  });

  it('different projects still run in parallel', async () => {
    const s = service(probe, 'a');
    await Promise.all([s.indexProject(project(1), {}), s.indexProject(project(2), {})]);
    expect(probe.max).toBe(2);
  });
});
