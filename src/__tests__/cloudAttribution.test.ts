/**
 * Cloud attribution, end to end, without a cloud run.
 *
 * `code-embedding` now runs on the SideCar + OpenRouter policy, so a project
 * can be embedded partly or wholly by an OpenRouter-backed provider. The
 * operator needs to see that in the per-project column — a cloud contribution
 * that renders as a local GPU is worse than no attribution at all.
 *
 * The chain under test:
 *
 *   VirtualEmbeddingProvider.getSidecarName()  →  container.providerName
 *                                              =  virtualProviderName(host, role)
 *                                              =  `<PCName>-OR-<Role>`
 *   credit(provider, n)                        →  served.set(name, …)
 *   recordProjectEmbedding({ servedBy })       →  projectEmbeddingMeta.json
 *   /admin/vectors/stats                       →  embeddingServedBy / fanout
 *
 * The two attribution writers (`semanticSearchService.buildProjectEmbeddings`
 * for the auto pipeline and the re-embed job in `admin/routes.ts`) both key
 * their map by `getSidecarName()`, so both carry the virtual name unchanged.
 * What this file pins is the naming contract at both ends of that chain: the
 * name a virtual provider reports, and the `-OR-` test every consumer uses to
 * call it cloud.
 */

import { virtualProviderName, pcName } from '../sidecars/virtualContainers.js';
import { getFleetEmbeddingSplit, __setMetaPathForTest } from '../embedding/projectEmbeddingMeta.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('the name a cloud provider is attributed under', () => {
  it('is <PCName>-OR-<Role>, with the mDNS suffix stripped', () => {
    expect(virtualProviderName('BASWS35', 'code-embedding')).toBe('BASWS35-OR-CodeEmbedding');
    expect(virtualProviderName('Alpers-Mac-mini.local', 'code-embedding'))
      .toBe('Alpers-Mac-mini-OR-CodeEmbedding');
    expect(pcName('mcpserver.local')).toBe('mcpserver');
  });

  it('never carries the upstream provider — that convention is deliberate', () => {
    // DeepInfra is the pinned upstream for qwen3-embedding-4b. The operator's
    // unit of attribution is the machine whose key and policy served the
    // texts, not whichever backend OpenRouter routed to.
    for (const role of ['embedding', 'code-embedding', 'reranker', 'code-assistant'] as const) {
      expect(virtualProviderName('BASWS35', role)).not.toMatch(/deepinfra|fireworks/i);
    }
  });

  it('is distinguishable from the local GPU on the same machine', () => {
    // Both exist at once: BASWS35's local Ollama and BASWS35's cloud route.
    // If these collided, the column could not tell them apart at all.
    expect(virtualProviderName('BASWS35', 'code-embedding')).not.toBe('BASWS35');
  });
});

describe('the -OR- test every consumer uses to call a provider cloud', () => {
  // The same predicate as getFleetEmbeddingSplit() on the server and
  // isCloudProvider() in dashboard/src/components/ProjectVectorTable.tsx.
  const isCloud = (n: string) => n.includes('-OR-');

  it('flags every virtual provider name', () => {
    for (const role of ['embedding', 'code-embedding', 'reranker', 'code-assistant'] as const) {
      expect(isCloud(virtualProviderName('BASWS35', role))).toBe(true);
    }
  });

  it('flags no real local host in the fleet', () => {
    for (const host of ['BASWS35', 'Alpers-Mac-mini.local', 'mcpserver.local', 'gpu-01', 'gpu-02', 'in-process']) {
      expect(isCloud(host)).toBe(false);
    }
  });
});

describe('the fleet split separates cloud from local', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-meta-'));
    __setMetaPathForTest(path.join(dir, 'projectEmbeddingMeta.json'));
  });
  afterEach(() => {
    __setMetaPathForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('marks <PCName>-OR-<Role> rows cloud and local hosts not', () => {
    fs.writeFileSync(path.join(dir, 'projectEmbeddingMeta.json'), JSON.stringify({
      // A mixed project: local GPUs plus the cloud route on the same machine.
      '1': {
        projectId: 1, embeddedAt: '2026-09-15T00:00:00.000Z',
        servedBy: [
          { name: 'BASWS35', texts: 800 },
          { name: 'BASWS35-OR-CodeEmbedding', texts: 150 },
          { name: 'mcpserver.local', texts: 50 },
        ],
      },
      // A project served ENTIRELY by cloud — one servedBy entry. This is the
      // shape that used to fall through the per-project column's `> 1` gate
      // and render with the local satellite icon.
      '2': {
        projectId: 2, embeddedAt: '2026-09-15T00:00:00.000Z',
        servedBy: [{ name: 'gpu-01-OR-CodeEmbedding', texts: 400 }],
      },
      // A row from before cloud existed: no servedBy at all.
      '3': { projectId: 3, embeddedAt: '2026-06-01T00:00:00.000Z', sidecarName: 'BASWS35' },
    }));

    const split = getFleetEmbeddingSplit();
    const byName = new Map(split.map(s => [s.provider, s]));

    expect(byName.get('BASWS35')).toMatchObject({ texts: 800, projects: 1, cloud: false });
    expect(byName.get('BASWS35-OR-CodeEmbedding')).toMatchObject({ texts: 150, projects: 1, cloud: true });
    expect(byName.get('gpu-01-OR-CodeEmbedding')).toMatchObject({ texts: 400, projects: 1, cloud: true });
    expect(byName.get('mcpserver.local')).toMatchObject({ texts: 50, cloud: false });
    // The legacy row contributes nothing and breaks nothing.
    expect(split.reduce((n, s) => n + s.projects, 0)).toBe(4);
    // Sorted by texts, descending.
    expect(split.map(s => s.provider)).toEqual([
      'BASWS35', 'gpu-01-OR-CodeEmbedding', 'BASWS35-OR-CodeEmbedding', 'mcpserver.local',
    ]);
  });

  it('is empty rather than throwing when nothing has been recorded', () => {
    expect(getFleetEmbeddingSplit()).toEqual([]);
  });
});
