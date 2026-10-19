/**
 * planIndexRunDelete — what "delete this parse" removes, and when it refuses.
 * Pure planner; no Prisma, no Lance.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { planIndexRunDelete, type RunSummary, type RunChange } from '../fantom-code/indexRunDelete.js';
import { beginProjectIndexing, isProjectIndexing, _resetActiveIndexingForTests } from '../fantom-code/activeIndexing.js';

function run(id: number, minute: number, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    startedAt: new Date(Date.UTC(2026, 9, 1, 12, minute)),
    finishedAt: new Date(Date.UTC(2026, 9, 1, 12, minute, 30)),
    force: false,
    isSeedingRun: false,
    trigger: 'manual',
    errorMessage: null,
    ...extra,
  };
}

const changes: RunChange[] = [
  { qualifiedName: 'pod::A.a', changeType: 'added', filePath: '/p/A.fan' },
  { qualifiedName: 'pod::A.b', changeType: 'modified', filePath: '/p/A.fan' },
  { qualifiedName: 'pod::B.c', changeType: 'removed', filePath: '/p/B.fan' },
];

function plan(target: RunSummary, runs: RunSummary[], changedLater: string[] = [], projectIndexing = false) {
  return planIndexRunDelete({
    projectId: 7, target, runs, changes, edgeChangeCount: 4,
    changedLater: new Set(changedLater), projectIndexing,
  });
}

describe('planIndexRunDelete', () => {
  it('latest run: invalidates all its symbols and marks its files for re-parse', () => {
    const r1 = run(1, 0, { isSeedingRun: true }), r2 = run(2, 5);
    const p = plan(r2, [r1, r2]);
    expect(p.isLatest).toBe(true);
    expect(p.refusal).toBeNull();
    expect(p.vectorQualifiedNames.sort()).toEqual(['pod::A.a', 'pod::A.b', 'pod::B.c']);
    expect(p.reparseFiles).toEqual(['/p/A.fan', '/p/B.fan']);
    expect(p.apiChanges).toEqual({ added: 1, modified: 1, removed: 1, total: 3, capped: false });
    expect(p.edgeChanges).toBe(4);
  });

  it('past run: skips symbols a later run changed again (removed, then re-added)', () => {
    const r1 = run(1, 0), r2 = run(2, 5), r3 = run(3, 10);
    const p = plan(r2, [r1, r2, r3], ['pod::B.c', 'pod::A.b']);
    expect(p.isLatest).toBe(false);
    expect(p.vectorQualifiedNames).toEqual(['pod::A.a']);
    expect(p.reparseFiles).toEqual([]);
  });

  it('a later forced run means no vectors are touched', () => {
    const r1 = run(1, 0), r2 = run(2, 5), r3 = run(3, 10, { force: true });
    const p = plan(r2, [r1, r2, r3]);
    expect(p.vectorQualifiedNames).toEqual([]);
    expect(p.vectorSkipReason).toMatch(/#3 was a forced reindex/);
  });

  it('refuses the only run', () => {
    const r1 = run(1, 0, { isSeedingRun: true });
    const p = plan(r1, [r1]);
    expect(p.isOnly).toBe(true);
    expect(p.refusal).toMatch(/only indexing run/);
  });

  it('refuses while the project is indexing; an unfinished run otherwise counts as crashed', () => {
    const r1 = run(1, 0), r2 = run(2, 5, { finishedAt: null });
    expect(plan(r2, [r1, r2], [], true).refusal).toMatch(/being indexed/);
    const crashed = plan(r2, [r1, r2]);
    expect(crashed.refusal).toBeNull();
    expect(crashed.unfinished).toBe(true);
  });
});

describe('activeIndexing', () => {
  beforeEach(() => _resetActiveIndexingForTests());

  it('counts overlapping passes and ends idempotently', () => {
    const end1 = beginProjectIndexing(7);
    const end2 = beginProjectIndexing(7);
    end1(); end1();
    expect(isProjectIndexing(7)).toBe(true);
    end2();
    expect(isProjectIndexing(7)).toBe(false);
  });
});
