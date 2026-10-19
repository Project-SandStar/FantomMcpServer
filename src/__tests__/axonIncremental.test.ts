/**
 * Phase 4 / 3.12 (Axon): unchanged projects are skipped without a provider
 * call, a changed project embeds only changed functions and deletes only
 * their rows, force rebuilds, the boot scan starts no job when nothing
 * changed, the lock is taken per project, providers refresh per project, and
 * a heavy-job refusal names the holder. Parser, LanceDB and providers are fakes.
 */
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-inc-'));
process.env.MCPFANTOM_CACHE_DIR = cacheDir;
afterAll(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); });

const DIMS = 4;
type Rec = { id: string; name: string; hash: string; projectId: string; source: 'proj'; instance: string; project: string };
let projects: Record<string, Rec[]> = {};
const rec = (pid: string, name: string, hash: string): Rec => ({ id: `${pid}:${name}`, name, hash, projectId: pid, source: 'proj', instance: 'i', project: pid });

const embedded: string[] = [];
let providerCalls = 0;
let providerSelects = 0;
const provider = { initialize: async () => {}, getSidecarName: () => 'fake' };
const deletedNames: Array<{ projectId: string; names: string[] }> = [];
const deletedProjects: string[] = [];
const added: Array<Record<string, unknown>> = [];
let lockEvents: string[] = [];

jest.unstable_mockModule('../axon/axonSettings.js', () => ({
  getAxonSettings: () => ({ enabled: true, autoIndex: true }),
  getAxonProjDir: () => '/x/proj', getAxonLibraryDir: () => '/x/lib',
  resolveAxonEmbeddingModel: () => ({ model: 'm', dimensions: DIMS }),
}));
jest.unstable_mockModule('../axon/axonProjParser.js', () => ({
  buildAxonEmbeddingChunksFor: (r: Rec) => [{ chunkIndex: 0, chunkCount: 1, text: `${r.name}:${r.hash}`, lineStart: 1, lineEnd: 2 }],
}));
jest.unstable_mockModule('../axon/axonLibraryParser.js', () => ({
  scanAllAxonProjects: () => Object.keys(projects).map(pid => ({ projectId: pid, source: 'proj', instance: 'i', project: pid, functionCount: projects[pid].length })),
  parseAnyAxonProject: (ref: { projectId: string }) => projects[ref.projectId].map(r => ({ ...r, qualifiedName: r.name, signature: '', paramDefs: [], tags: [], doc: '', relPath: '', lineStart: 1, lineEnd: 2 })),
  isLibraryProjectId: () => false,
}));
jest.unstable_mockModule('../axon/axonLance.js', () => ({
  ensureAxonTableForWrite: async () => ({ add: async (rows: Record<string, unknown>[]) => { added.push(...rows); } }),
  deleteAxonProjectVectors: async (pid: string) => { deletedProjects.push(pid); },
  deleteAxonFunctionVectors: async (pid: string, names: string[]) => { deletedNames.push({ projectId: pid, names }); },
  countAxonVectorsByProject: async () => new Map(), listAxonVectorIds: async () => new Set(), getAxonTableStats: async () => ({}),
}));
jest.unstable_mockModule('../embedding/providers/embeddingProvider.js', () => ({
  selectAllEmbeddingProvidersWithCloud: async () => { providerSelects++; return [provider]; },
  embedBatchFanout: async (_p: unknown, texts: string[]) => {
    providerCalls++;
    embedded.push(...texts);
    lockEvents.push(`embed:${gate.getHeavyJob()?.kind ?? 'none'}`);
    return texts.map(() => new Float32Array(DIMS));
  },
}));

const gate = await import('../embedding/embedGate.js');
const ax = await import('../axon/axonIndexer.js');

function newJob(): any {
  return { id: 't', kind: 'axon-index', scope: { force: false }, status: 'queued', startedAt: new Date().toISOString(),
    projectsTotal: 0, projectsDone: 0, functionsTotal: 0, functionsEmbedded: 0, model: 'm', dimensions: DIMS, providers: [], errors: [] };
}
const run = (opts: any = {}) => ax.runAxonIndex(newJob(), { cache: null, batchSize: 10, ...opts });

beforeEach(() => {
  embedded.length = 0; providerCalls = 0; providerSelects = 0; added.length = 0;
  deletedNames.length = 0; deletedProjects.length = 0; lockEvents = [];
  gate._resetHeavyJobLockForTests();
});

describe('Axon incremental index (3.12)', () => {
  beforeAll(() => {
    fs.rmSync(path.join(cacheDir, 'axon-embedding-meta.json'), { force: true });
    projects = { A: [rec('A', 'f1', 'h1'), rec('A', 'f2', 'h2')], B: [rec('B', 'g1', 'k1')] };
  });

  it('first run embeds everything (no meta)', async () => {
    const j = await run();
    expect(j.status).toBe('done');
    expect(embedded.sort()).toEqual(['f1:h1', 'f2:h2', 'g1:k1']);
    expect(j.functionsEmbedded).toBe(3);
  });

  it('second run with no change: every project skipped, no provider selected or called', async () => {
    const j = await run();
    expect(j.status).toBe('done');
    expect(providerCalls).toBe(0);
    expect(providerSelects).toBe(0);
    expect(j.projectsSkipped).toBe(2);
    expect(j.functionsSkipped).toBe(3);
    expect(added).toHaveLength(0);
    expect(gate.getHeavyJob()).toBeNull();
  });

  it('one changed + one removed function: embeds only that one, deletes only their rows', async () => {
    projects.A = [rec('A', 'f1', 'h1-new')];
    const j = await run();
    expect(embedded).toEqual(['f1:h1-new']);
    expect(deletedProjects).toEqual([]);
    expect(deletedNames).toEqual([{ projectId: 'A', names: ['f1', 'f2'] }]);
    const a = j.projectStats!.find(p => p.projectId === 'A')!;
    expect(a).toMatchObject({ status: 'done', embedded: 1, deleted: 1, skipped: 0 });
    expect(j.projectStats!.find(p => p.projectId === 'B')!.status).toBe('skipped');
  });

  it('boot scan: no change → nothing changed; a change names only that project', async () => {
    expect((await ax.scanAxonChanges()).changed).toEqual([]);
    projects.B = [rec('B', 'g1', 'k2')];
    expect((await ax.scanAxonChanges()).changed).toEqual(['B']);
  });

  it('projectIds scopes the run to the changed projects', async () => {
    const j = await run({ projectIds: ['B'] });
    expect(j.projectsTotal).toBe(1);
    expect(embedded).toEqual(['g1:k2']);
  });

  it('force rebuilds every function and replaces project rows', async () => {
    const j = await run({ force: true });
    expect(embedded.sort()).toEqual(['f1:h1-new', 'g1:k2']);
    expect(deletedProjects.sort()).toEqual(['A', 'B']);
    expect(j.projectsSkipped).toBe(0);
  });

  it('a text-layout, model or dims change in meta counts as full', () => {
    const r = [rec('A', 'f1', 'h') as any];
    const pm: any = { hashes: { f1: 'h' }, model: 'm', dimensions: DIMS, embedTextVersion: 2 };
    expect(ax.planAxonProject(r, pm, 'm', DIMS).skip).toBe(true);
    expect(ax.planAxonProject(r, { ...pm, embedTextVersion: 1 }, 'm', DIMS).full).toBe(true);
    expect(ax.planAxonProject(r, pm, 'other', DIMS).full).toBe(true);
    expect(ax.planAxonProject(r, pm, 'm', 8).full).toBe(true);
  });

  it('takes the lock per project and releases it between projects', async () => {
    projects.A = [rec('A', 'f1', 'z1')];
    projects.B = [rec('B', 'g1', 'z2')];
    const seen: Array<string | null> = [];
    const orig = gate.getHeavyJob;
    const j = ax.runAxonIndex(newJob(), { cache: null, providers: undefined });
    // While the job runs, a code embed queued behind it gets the lock between projects.
    const waiter = gate.waitForHeavyJob('code-reembed', 'project 275', { pollMs: 5 } as any).then(release => {
      seen.push(orig()?.kind ?? null);
      release();
    });
    await Promise.all([j, waiter]);
    expect(seen).toEqual(['code-reembed']);
    expect(lockEvents.every(e => e === 'embed:axon-index')).toBe(true);
    expect(providerSelects).toBe(2); // refreshed per project
    expect(gate.getHeavyJob()).toBeNull();
  });
});

describe('named refusals (3.12 item 6)', () => {
  it('a 409 names kind, scope, progress, providers and ETA', () => {
    const release = gate.acquireHeavyJob('axon-index', 'all');
    const started = new Date(Date.now() - 10 * 60_000).toISOString();
    gate.setHeavyJobProgress('axon-index', { projectsDone: 17, projectsTotal: 121, itemsDone: 760, itemsTotal: 4996, itemsLabel: 'functions', providers: ['a'], startedAt: started, page: '/axon' });
    let err: any;
    try { gate.acquireHeavyJob('code-reembed', 'project 275'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(gate.HeavyJobBusyError);
    expect(err.humanMessage).toMatch(/^Axon indexing \(all\) is running \(project 18\/121, 760\/4996 functions, 1 provider, started \d\d:\d\d, ETA \d+ min\)\. Code re-embedding \(project 275\) will start when it finishes or cancel it on the Axon page\.$/);
    const s = gate.getHeavyJobStatus();
    expect(s.active).toBe(true);
    expect(s.message).toContain('project 18/121');
    expect(s.etaMin).toBeGreaterThan(0);
    release();
    expect(gate.getHeavyJobStatus().active).toBe(false);
  });
});
