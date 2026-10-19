/**
 * Phase 3 graph patch (lazy-incremental-indexing.md 3.4, exit checks): a
 * callee edit keeps callers' edges, a 10-line shift changes no id and drops
 * no vector, a rename (same body) is linked and its callers re-point, a
 * reference to a symbol not indexed yet waits in pending_refs and resolves
 * later. Temp SQLite + temp LadybugDB store; regex Fantom parser; no
 * provider calls (embed: false).
 */
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.setTimeout(120_000);

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-gpatch-'));
process.env.MCPFANTOM_CACHE_DIR = cacheDir;

const { CodeIndexingService } = await import('../fantom-code/codeIndexingService.js');
const { ladybugQuery } = await import('../graph/ladybugConnection.js');
const { createTestDb, addProject } = await import('../indexing/__testSupport__/lazyIndexTestDb.js');
const { targetTail } = await import('../indexing/graphPatch.js');

afterAll(async () => {
  try {
    const { closeAllProjectConnections } = await import('../graph/projectGraphConnection.js');
    await closeAllProjectConnections();
  } catch { /* not opened */ }
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const BUILD = `class Build : build::BuildPod
{
  new make()
  {
    podName = "demo"
    depends = ["sys 1.0"]
    srcDirs = [\`fan/\`]
  }
}
`;

const CALLEE = `class Callee
{
  static Int add(Int a, Int b)
  {
    return a + b
  }

  static Int twice(Int a)
  {
    return a * 2
  }
}
`;

const CALLER = `class Caller
{
  static Int run()
  {
    x := Callee.add(1, 2)
    return Callee.twice(x)
  }

  static Int later()
  {
    return Helper.help(3)
  }
}
`;

const HELPER = `class Helper
{
  static Int help(Int a)
  {
    return a + 1
  }
}
`;

type Node = { id: string; qn: string; fp: string; ls: number };

async function nodes(pid: number): Promise<Node[]> {
  return ladybugQuery<Node>(pid, `MATCH (n:CodeNode) RETURN n.id AS id, n.qualified_name AS qn, n.file_path AS fp, n.line_start AS ls ORDER BY n.id`);
}

async function calls(pid: number): Promise<Array<{ s: string; t: string; tid: string }>> {
  return ladybugQuery(pid,
    `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode) WHERE e.edge_type = 'calls'
     RETURN a.qualified_name AS s, b.qualified_name AS t, b.id AS tid ORDER BY s, t`);
}

describe('graph patch', () => {
  it('keeps cross-file edges, ids on a line shift, links renames, resolves pending refs', async () => {
    const db = await createTestDb();
    try {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gpatch-proj-')));
      fs.writeFileSync(path.join(root, 'build.fan'), BUILD);
      fs.mkdirSync(path.join(root, 'fan'));
      const callee = path.join(root, 'fan', 'Callee.fan');
      const caller = path.join(root, 'fan', 'Caller.fan');
      const helper = path.join(root, 'fan', 'Helper.fan');
      fs.writeFileSync(callee, CALLEE);
      fs.writeFileSync(caller, CALLER);

      const pid = await addProject(db.prisma, 'demo', root, 'fantom');
      await db.prisma.fantomProject.update({ where: { id: pid }, data: { parserType: 'regex', keyScheme: 2 } as any });
      const svc = new CodeIndexingService(db.prisma);
      const now = new Date().toISOString();
      await svc.indexProject({
        id: pid, name: 'demo', path: root, language: 'fantom', parserType: 'regex',
        functionCount: 0, typeCount: 0, createdAt: now, updatedAt: now,
      } as any, { trigger: 'manual' });

      const base = await calls(pid);
      expect(base.map(e => `${e.s}->${e.t}`)).toEqual(expect.arrayContaining([
        'demo::Caller.run->demo::Callee.add', 'demo::Caller.run->demo::Callee.twice',
      ]));
      // Helper is not indexed: the reference waits in pending_refs (seeded by the full build).
      const pend0 = await db.prisma.$queryRawUnsafe<Array<{ target_name: string; target_tail: string }>>(
        `SELECT target_name, target_tail FROM pending_refs WHERE project_id = ?`, pid);
      expect(pend0.some(r => r.target_tail === 'help')).toBe(true);

      // ── 1. Edit the callee's body: callers in another file keep their edges.
      fs.writeFileSync(callee, CALLEE.replace('return a + b', 'return b + a'));
      const r1 = await svc.reindexFiles({ projectId: pid, paths: [callee], embed: false });
      expect(r1.patch).toBeDefined();
      expect(r1.patch!.nodesDeleted).toBe(0);
      // add's body changed (and the class span holding it); twice did not.
      const n1 = await nodes(pid);
      const idOf = (qn: string) => n1.find(n => n.qn === qn)!.id;
      expect(r1.patch!.changedIds).toEqual(expect.arrayContaining([idOf('demo::Callee.add')]));
      expect(r1.patch!.changedIds).not.toContain(idOf('demo::Callee.twice'));
      expect(r1.patch!.changedIds).not.toContain(idOf('demo::Caller.run'));
      expect((await calls(pid)).map(e => `${e.s}->${e.t}`)).toEqual(base.map(e => `${e.s}->${e.t}`));

      // ── 2. Insert 10 lines at the top: zero ids change, zero vectors to rewrite.
      const before = await nodes(pid);
      fs.writeFileSync(callee, '// pad\n'.repeat(10) + fs.readFileSync(callee, 'utf8'));
      const r2 = await svc.reindexFiles({ projectId: pid, paths: [callee], embed: false });
      const after = await nodes(pid);
      expect(after.map(n => n.id)).toEqual(before.map(n => n.id));
      expect(r2.patch!.changedIds).toEqual([]);
      expect(r2.patch!.staleVectorIds).toEqual([]);
      expect(r2.patch!.nodesUpdated).toBeGreaterThan(0);
      expect(r2.vectorsDropped).toBe(0);
      expect(r2.embeddedCount).toBe(0);
      const addNode = after.find(n => n.qn === 'demo::Callee.add')!;
      expect(Number(addNode.ls)).toBe(before.find(n => n.qn === 'demo::Callee.add')!.ls + 10);
      expect((await calls(pid)).length).toBe(base.length);

      // ── 3. Rename add → plus (same body): linked, the caller re-points.
      const oldAddId = addNode.id;
      fs.writeFileSync(callee, fs.readFileSync(callee, 'utf8').replace('static Int add(', 'static Int plus('));
      const r3 = await svc.reindexFiles({ projectId: pid, paths: [callee], embed: false });
      expect(r3.patch!.links).toEqual([expect.objectContaining({ kind: 'rename', oldId: oldAddId })]);
      const plus = (await nodes(pid)).find(n => n.qn === 'demo::Callee.plus')!;
      expect(plus).toBeDefined();
      expect(r3.patch!.incomingRepointed).toBe(1);
      const links = await db.prisma.symbolLink.findMany({ where: { projectId: pid, kind: 'rename' } });
      expect(links).toHaveLength(1);
      expect(links[0].newNodeId).toBe(plus.id);
      const c3 = await calls(pid);
      expect(c3.find(e => e.s === 'demo::Caller.run' && e.tid === plus.id)).toBeDefined();
      expect(c3.find(e => e.tid === oldAddId)).toBeUndefined();

      // ── 4. Add Helper.fan: the pending reference from Caller resolves.
      fs.writeFileSync(helper, HELPER);
      const r4 = await svc.reindexFiles({ projectId: pid, paths: [helper], embed: false });
      expect(r4.patch!.pendingResolved).toBeGreaterThanOrEqual(1);
      expect((await calls(pid)).find(e => e.s === 'demo::Caller.later' && e.t === 'demo::Helper.help')).toBeDefined();
      const pend4 = await db.prisma.$queryRawUnsafe<unknown[]>(
        `SELECT id FROM pending_refs WHERE project_id = ? AND target_tail = 'help'`, pid);
      expect(pend4).toHaveLength(0);

      // ── 5. Remove Helper.fan: its incoming edge goes back to pending_refs.
      fs.rmSync(helper);
      const r5 = await svc.reindexFiles({ projectId: pid, paths: [], removed: [helper], embed: false });
      expect(r5.patch!.incomingLost).toBe(1);
      expect((await nodes(pid)).some(n => n.fp === helper)).toBe(false);
      const pend5 = await db.prisma.$queryRawUnsafe<unknown[]>(
        `SELECT id FROM pending_refs WHERE project_id = ? AND target_tail = 'help'`, pid);
      expect(pend5.length).toBeGreaterThanOrEqual(1);
    } finally {
      await db.close();
    }
  });

  it('targetTail takes the last name segment', () => {
    expect(targetTail('demo::Callee.add')).toBe('add');
    expect(targetTail('Callee.add')).toBe('add');
    expect(targetTail('Str')).toBe('Str');
    expect(targetTail('sys::Str')).toBe('Str');
  });
});
