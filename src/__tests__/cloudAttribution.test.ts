/**
 * Cloud attribution, end to end, without a cloud run.
 *
 * `code-embedding` can run on Fantom's direct OpenRouter client, so a project
 * can be embedded partly or wholly by an OpenRouter-backed provider. The
 * operator needs to see that in the per-project column — a cloud contribution
 * that renders as a local GPU is worse than no attribution at all.
 *
 * The chain under test:
 *
 *   DirectOpenRouterEmbeddingProvider.getSidecarName()  →  providerNameFor(role)
 *                                                       =  `Fantom-OR-<Role>`
 *   credit(provider, n)                        →  served.set(name, …)
 *   recordProjectEmbedding({ servedBy })       →  projectEmbeddingMeta.json
 *   /admin/vectors/stats                       →  embeddingServedBy / fanout
 *
 * The two attribution writers (`semanticSearchService.buildProjectEmbeddings`
 * for the auto pipeline and the re-embed job in `admin/routes.ts`) both key
 * their map by `getSidecarName()`, so both carry the cloud name unchanged.
 * What this file pins is the naming contract at both ends of that chain: the
 * name a cloud provider reports, and the `-OR-` test every consumer uses to
 * call it cloud.
 */

import { providerNameFor } from '../openrouter/roles.js';
import { getFleetEmbeddingSplit, __setMetaPathForTest } from '../embedding/projectEmbeddingMeta.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROLES = ['embedding', 'code-embedding', 'reranker', 'code-assistant', 'rlm'] as const;

describe('the name a cloud provider is attributed under', () => {
  it('is Fantom-OR-<Role>: Fantom itself calls OpenRouter now, no sidecar host', () => {
    expect(providerNameFor('code-embedding')).toBe('Fantom-OR-CodeEmbedding');
    expect(providerNameFor('embedding')).toBe('Fantom-OR-Embedding');
    expect(providerNameFor('reranker')).toBe('Fantom-OR-Reranker');
  });

  it('never carries the upstream provider — that convention is deliberate', () => {
    for (const role of ROLES) {
      expect(providerNameFor(role)).not.toMatch(/deepinfra|fireworks|nebius/i);
    }
  });

  it('is distinct per role', () => {
    expect(new Set(ROLES.map(providerNameFor)).size).toBe(ROLES.length);
  });
});

describe('the -OR- test every consumer uses to call a provider cloud', () => {
  // The same predicate as getFleetEmbeddingSplit() on the server and
  // isCloudProvider() in dashboard/src/components/ProjectVectorTable.tsx.
  const isCloud = (n: string) => n.includes('-OR-');

  it('flags every cloud provider name', () => {
    for (const role of ROLES) {
      expect(isCloud(providerNameFor(role))).toBe(true);
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
