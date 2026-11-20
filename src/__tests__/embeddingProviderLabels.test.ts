// @ts-nocheck -- imports a dashboard module outside rootDir (src); types are checked by the dashboard tsc.
/** Per-project "embedded by" labels: workers, one legacy sidecar group, local hosts. */
import { describe, it, expect } from '@jest/globals';
import * as labels from '../../dashboard/src/lib/embeddingProviderLabels.js';

describe('dashboard label rules', () => {
  it('classifies the four name shapes', () => {
    expect(labels.providerKind('worker3')).toBe('worker');
    expect(labels.providerKind('Fantom-OR-CodeEmbedding')).toBe('direct');
    expect(labels.providerKind('BASWS34-gpu02-OR-CodeEmbedding')).toBe('legacy');
    expect(labels.providerKind('Alpers-Mac-mini.local')).toBe('local');
    expect(labels.providerKind('workerless-host')).toBe('local');
  });

  it('labels workers by slot, legacy routes as one group, local hosts by name', () => {
    expect(labels.providerLabel('worker1')).toBe('worker1');
    expect(labels.providerLabel('mcpserver-OR-CodeEmbedding')).toBe(labels.LEGACY_SIDECAR_LABEL);
    expect(labels.providerLabel('Fantom-OR-Embedding')).toBe(labels.DIRECT_LABEL);
    expect(labels.providerLabel('Alpers-Mac-mini.local')).toBe('Alpers-Mac-mini');
    expect(labels.isCloudProvider('worker2')).toBe(true);
    expect(labels.isCloudProvider('BASWS35')).toBe(false);
  });

  it('folds every old PC name into one legacy entry', () => {
    const out = labels.groupServedBy([
      { name: 'BASWS34-gpu02-OR-CodeEmbedding', texts: 70 },
      { name: 'mcpserver-OR-CodeEmbedding', texts: 20 },
      { name: 'BASWS35-OR-CodeEmbedding', texts: 10 },
    ]);
    expect(out).toEqual([{ label: 'legacy sidecar route', cloud: true, texts: 100, pct: 100 }]);
    expect(JSON.stringify(out)).not.toMatch(/BASWS|mcpserver/);
  });

  it('shows direct rows per worker, sorted by share, and keeps local hosts', () => {
    const out = labels.groupServedBy([
      { name: 'worker2', texts: 35 },
      { name: 'worker1', texts: 40 },
      { name: 'BASWS35', texts: 25 },
    ]);
    expect(out.map(x => `${x.cloud ? '☁' : '🛰'} ${x.label} ${x.pct}%`)).toEqual([
      '☁ worker1 40%', '☁ worker2 35%', '🛰 BASWS35 25%',
    ]);
  });

  it('does not call a direct run served by workers a failover', () => {
    const w = [{ name: 'worker1' }, { name: 'worker2' }];
    expect(labels.isFailover('Fantom-OR-CodeEmbedding', 'worker1', w)).toBe(false);
    expect(labels.isFailover('BASWS35', 'worker1', w)).toBe(true);
    expect(labels.isFailover('BASWS35', 'BASWS35', [{ name: 'BASWS35' }])).toBe(false);
    expect(labels.isFailover('A', 'B', null)).toBe(true);
    expect(labels.isFailover(null, 'B', w)).toBe(false);
  });

  it('groups the fleet fan-out strip the same way', () => {
    const out = labels.groupFleetSplit([
      { provider: 'BASWS34-gpu02-OR-CodeEmbedding', texts: 50, projects: 200 },
      { provider: 'mcpserver-OR-CodeEmbedding', texts: 30, projects: 260 },
      { provider: 'worker1', texts: 40, projects: 5 },
      { provider: 'BASWS35', texts: 10, projects: 3 },
    ]);
    expect(out).toEqual([
      { label: 'legacy sidecar route', cloud: true, texts: 80, projects: 260 },
      { label: 'worker1', cloud: true, texts: 40, projects: 5 },
      { label: 'BASWS35', cloud: false, texts: 10, projects: 3 },
    ]);
  });
});
