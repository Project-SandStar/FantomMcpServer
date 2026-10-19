/**
 * Lazy indexing, git side (lazy-incremental-indexing.md 3.2): reflog
 * classification, nested-root ownership, diff → change set → task.
 * Temp git repos only; a temp SQLite DB for the root registry.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseReflogLine, kindFromMessage, classifyHeadMove, entriesSince, readReflogTail, isSwitchLike,
} from '../indexing/gitReflog.js';
import { ownerOf, pathspecsFor, innerRootsOf, syncProjectRoots, discoverNestedGitDirs } from '../indexing/gitRoots.js';
import { computeRootChanges, parseNameStatusZ, parseRawZ, mapDiffEntries, type GitProjectInput } from '../indexing/gitChangeSource.js';
import { planForChangeSet } from '../indexing/taskPlanner.js';
import { PRIORITY, type ChangeSet } from '../indexing/types.js';
import { createTestDb, addProject, sh, initRepo, write, type TestDb } from '../indexing/__testSupport__/lazyIndexTestDb.js';

const tsScanner = { accepts: (p: string) => /\.(ts|js)$/.test(p) };
const OPTS = { reflogTail: 64, maxCommitsPerRun: 500, retries: 0, retryMs: 10 };
const head = (dir: string) => sh(dir, 'rev-parse', 'HEAD').trim();
const commitAll = (dir: string, msg: string) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', msg); };
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('reflog classification', () => {
  it('maps reflog messages to kinds', () => {
    expect(kindFromMessage('commit: add x')).toBe('edit');
    expect(kindFromMessage('commit (initial): first')).toBe('edit');
    expect(kindFromMessage('cherry-pick: fix')).toBe('edit');
    expect(kindFromMessage('commit (amend): fix')).toBe('rewrite');
    expect(kindFromMessage('commit (merge): Merge branch x')).toBe('integrate');
    expect(kindFromMessage('merge feature: Fast-forward')).toBe('integrate');
    expect(kindFromMessage('pull: Fast-forward')).toBe('integrate');
    expect(kindFromMessage('pull origin main: Merge made')).toBe('integrate');
    expect(kindFromMessage('rebase (finish): returning to refs/heads/main')).toBe('rewrite');
    expect(kindFromMessage('rebase -i (finish): returning to refs/heads/x')).toBe('rewrite');
    expect(kindFromMessage('rebase (pick): msg')).toBeNull();
    expect(kindFromMessage('rebase (start): checkout main')).toBeNull();
    expect(kindFromMessage('checkout: moving from main to feature')).toBe('switch');
    expect(kindFromMessage('reset: moving to HEAD~3')).toBe('switch');
    expect(kindFromMessage('something new')).toBe('unknown');
  });

  it('classifies with the ancestry check and the newest non-ignored line', () => {
    const e = (m: string, n: number) => parseReflogLine(`${'a'.repeat(40)} ${String(n).repeat(40)} T <t@t> 17000000${n}0 +0000\t${m}`)!;
    expect(classifyHeadMove([e('commit: x', 1)], true, true).kind).toBe('edit');
    // edit that is not a fast-forward of the base → rewrite
    expect(classifyHeadMove([e('commit: x', 1)], false, true).kind).toBe('rewrite');
    // a rebase: the picks are ignored, finish decides
    expect(classifyHeadMove([e('rebase (start): checkout main', 1), e('rebase (pick): a', 2), e('rebase (finish): returning', 3)], false, true).kind).toBe('rewrite');
    // switch stays switch even when linear
    expect(classifyHeadMove([e('checkout: moving from a to b', 1)], true, true).kind).toBe('switch');
    expect(classifyHeadMove([], true, false).kind).toBe('none');
    expect(classifyHeadMove([], true, true).kind).toBe('unknown');
    expect(isSwitchLike({ kind: 'rewrite', reflog: '', linear: false }, 51, 50)).toBe(true);
    expect(isSwitchLike({ kind: 'rewrite', reflog: '', linear: false }, 5, 50)).toBe(false);
  });

  it('reads the real reflog and resumes after the stored ident', () => {
    const dir = initRepo(tmp('lazy-reflog-'));
    write(path.join(dir, 'a.ts'), 'a');
    commitAll(dir, 'one');
    write(path.join(dir, 'a.ts'), 'b');
    commitAll(dir, 'two');
    const all = readReflogTail(path.join(dir, '.git'), 64);
    expect(all.map(x => x.message)).toEqual(['commit (initial): one', 'commit: two']);
    expect(entriesSince(all, all[0].ident).map(x => x.message)).toEqual(['commit: two']);
    expect(entriesSince(all, 'gone 123')).toHaveLength(2); // rotated out → all
    sh(dir, 'checkout', '-q', '-b', 'feat');
    const after = entriesSince(readReflogTail(path.join(dir, '.git'), 64), all[1].ident);
    expect(classifyHeadMove(after, true, false).kind).toBe('switch');
  });
});

describe('diff parsing', () => {
  it('parses -z name-status and raw output, drops submodules', () => {
    const ns = parseNameStatusZ('M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0A\0n.ts\0');
    expect(mapDiffEntries(ns)).toEqual({
      added: ['n.ts'], modified: ['a.ts'], removed: ['gone.ts'],
      renamed: [{ from: 'old.ts', to: 'new.ts', similarity: 87 }], unmerged: false,
    });
    const raw = parseRawZ(':100644 100644 aaa bbb M\0a.ts\0:160000 160000 ccc ddd M\0vendor/sub\0:100644 100644 e f R100\0x.ts\0y.ts\0');
    expect(raw.map(r => r.status)).toEqual(['M', 'X', 'R']);
    expect(raw[2]).toMatchObject({ from: 'x.ts', path: 'y.ts', similarity: 100 });
  });
});

describe('nested roots: ownership', () => {
  const roots = [{ root: '/r' }, { root: '/r/a/inner' }, { root: '/r/a/inner/deep' }];
  it('longest root wins', () => {
    expect(ownerOf('/r/x.ts', roots)?.root).toBe('/r');
    expect(ownerOf('/r/a/inner/x.ts', roots)?.root).toBe('/r/a/inner');
    expect(ownerOf('/r/a/inner/deep/z/x.ts', roots)?.root).toBe('/r/a/inner/deep');
    expect(ownerOf('/r/a/innerX/x.ts', roots)?.root).toBe('/r'); // segment boundary
    expect(ownerOf('/elsewhere/x.ts', roots)).toBeNull();
  });
  it('outer pathspecs exclude inner roots', () => {
    expect(innerRootsOf('/r', roots).map(r => r.root)).toEqual(['/r/a/inner', '/r/a/inner/deep']);
    expect(pathspecsFor('/r/a', '/r', roots)).toEqual(['a', ':(exclude)a/inner/', ':(exclude)a/inner/deep/']);
    expect(pathspecsFor('/r', '/r/a/inner', roots)).toEqual(['.', ':(exclude)deep/']);
  });
});

describe('git change source (temp repos)', () => {
  let db: TestDb;
  let outer: string;
  let inner: string;
  let projectId: number;

  beforeAll(async () => {
    db = await createTestDb();
    outer = initRepo(tmp('lazy-outer-'));
    write(path.join(outer, 'src/a.ts'), 'export const a = 1;\n');
    write(path.join(outer, 'src/b.ts'), 'export const b = 1;\n');
    write(path.join(outer, 'README.md'), 'x');
    commitAll(outer, 'init');
    // A clone nested in the project, gitignored by the outer repo.
    write(path.join(outer, '.gitignore'), 'tools/\n');
    commitAll(outer, 'ignore tools');
    inner = initRepo(path.join(outer, 'tools/inner'));
    write(path.join(inner, 'lib.ts'), 'export const i = 1;\n');
    commitAll(inner, 'inner init');
    projectId = await addProject(db.prisma, 'p', outer);
  });
  afterAll(async () => {
    await db.close();
    fs.rmSync(outer, { recursive: true, force: true });
  });

  const input = (base: string | null): GitProjectInput => ({
    projectId, projectPath: outer, projectReal: outer, lastIndexedCommit: base, scanner: tsScanner,
  });

  it('registers the outer and the nested root with a parent link', async () => {
    expect(discoverNestedGitDirs(outer)).toEqual([path.join(outer, 'tools/inner')]);
    const r = await syncProjectRoots(db.prisma, { id: projectId, name: 'p', path: outer });
    expect(r.mode).toBe('git');
    const rows = await db.prisma.gitRoot.findMany({ orderBy: { root: 'asc' } });
    expect(rows.map(x => x.root)).toEqual([outer, inner]);
    expect(rows[1].parentRootId).toBe(rows[0].id);
    const states = await db.prisma.projectGitState.findMany({ where: { projectId } });
    expect(states).toHaveLength(2);
    expect((await db.prisma.fantomProject.findUnique({ where: { id: projectId } }))!.indexMode).toBe('git');
  });

  it('seeds when the base is NULL, unchanged when base = HEAD', async () => {
    const root = (await db.prisma.gitRoot.findUnique({ where: { root: outer } }))!;
    const all = await db.prisma.gitRoot.findMany();
    const seed = await computeRootChanges(root, all, [input(null)], OPTS);
    expect(seed.projects[0].kind).toBe('seed');
    const same = await computeRootChanges(root, all, [input(head(outer))], OPTS);
    expect(same.projects[0].kind).toBe('unchanged');
  });

  it('turns a commit into a parse task with source files only', async () => {
    const root = (await db.prisma.gitRoot.findUnique({ where: { root: outer } }))!;
    const all = await db.prisma.gitRoot.findMany();
    const base = head(outer);
    write(path.join(outer, 'src/a.ts'), 'export const a = 2;\n');
    write(path.join(outer, 'src/c.ts'), 'export const c = 1;\n');
    write(path.join(outer, 'README.md'), 'y');
    fs.rmSync(path.join(outer, 'src/b.ts'));
    commitAll(outer, 'edit');
    // A commit in the nested repo never shows in the outer diff.
    write(path.join(inner, 'lib.ts'), 'export const i = 2;\n');
    commitAll(inner, 'inner edit');

    const res = await computeRootChanges(root, all, [input(base)], OPTS);
    expect(res.headMove.kind).toBe('edit');
    const pc = res.projects[0];
    expect(pc.kind).toBe('changes');
    const cs = (pc as { changeSet: ChangeSet }).changeSet;
    expect(cs.modified).toEqual([path.join(outer, 'src/a.ts')]);
    expect(cs.added).toEqual([path.join(outer, 'src/c.ts')]);
    expect(cs.removed).toEqual([path.join(outer, 'src/b.ts')]);
    expect(cs.git!.fromCommit).toBe(base);
    expect(cs.git!.toCommit).toBe(head(outer));
    expect(cs.git!.commits.map(c => c.subject)).toEqual(['edit']);
    expect(cs.git!.commits[0].files.sort()).toEqual([path.join(outer, 'src/a.ts'), path.join(outer, 'src/b.ts'), path.join(outer, 'src/c.ts')].sort());

    const plan = planForChangeSet(cs, { isPrimary: false, projectFiles: 100, maxChangedShareForIncremental: 0.4, maxFilesPerDiff: 5000, rewriteAsSwitchFiles: 50 })!;
    expect(plan.kind).toBe('parse');
    expect(plan.priority).toBe(PRIORITY.normal);
    expect(plan.payload.paths.sort()).toEqual([path.join(outer, 'src/a.ts'), path.join(outer, 'src/c.ts')].sort());
    expect(plan.payload.removed).toEqual([path.join(outer, 'src/b.ts')]);

    // The nested root sees its own commit.
    const innerRoot = (await db.prisma.gitRoot.findUnique({ where: { root: inner } }))!;
    const innerBase = sh(inner, 'rev-parse', 'HEAD~1').trim();
    const ir = await computeRootChanges(innerRoot, all, [{ ...input(innerBase) }], OPTS);
    const ics = (ir.projects[0] as { changeSet: ChangeSet }).changeSet;
    expect(ics.modified).toEqual([path.join(outer, 'tools/inner/lib.ts')]);
  });

  it('a rename is a rename; a big share or a switch goes to full-reindex / priority 90', async () => {
    const root = (await db.prisma.gitRoot.findUnique({ where: { root: outer } }))!;
    const all = await db.prisma.gitRoot.findMany();
    const base = head(outer);
    sh(outer, 'mv', 'src/c.ts', 'src/d.ts');
    commitAll(outer, 'rename');
    const res = await computeRootChanges(root, all, [input(base)], OPTS);
    const cs = (res.projects[0] as { changeSet: ChangeSet }).changeSet;
    expect(cs.renamed).toEqual([{ from: path.join(outer, 'src/c.ts'), to: path.join(outer, 'src/d.ts'), similarity: 100 }]);

    const share = planForChangeSet(cs, { isPrimary: true, projectFiles: 2, maxChangedShareForIncremental: 0.4, maxFilesPerDiff: 5000, rewriteAsSwitchFiles: 50 })!;
    expect(share.kind).toBe('full-reindex');
    expect(share.priority).toBe(PRIORITY.background);

    sh(outer, 'checkout', '-q', '-b', 'other', base);
    // Indexed at main's tip; HEAD is now `other` at the old base.
    const sw = await computeRootChanges({ ...root, lastReflogIdent: res.reflogIdent }, all, [input(sh(outer, 'rev-parse', 'main').trim())], OPTS);
    expect(sw.headMove.kind).toBe('switch');
    const swcs = (sw.projects[0] as { changeSet: ChangeSet }).changeSet;
    const p = planForChangeSet(swcs, { isPrimary: true, projectFiles: 100, maxChangedShareForIncremental: 0.4, maxFilesPerDiff: 5000, rewriteAsSwitchFiles: 50 })!;
    expect(p.kind).toBe('parse');
    expect(p.checkout).toBe(true);
    expect(p.priority).toBe(PRIORITY.background);
  });

  it('a missing base asks for a sha scan', async () => {
    const root = (await db.prisma.gitRoot.findUnique({ where: { root: outer } }))!;
    const all = await db.prisma.gitRoot.findMany();
    const res = await computeRootChanges(root, all, [input('0123456789abcdef0123456789abcdef01234567')], OPTS);
    expect(res.projects[0].kind).toBe('sha-scan');
  });

  it('a vanished nested .git drops its state; the outer root takes over', async () => {
    fs.rmSync(path.join(inner, '.git'), { recursive: true, force: true });
    await syncProjectRoots(db.prisma, { id: projectId, name: 'p', path: outer });
    const rows = await db.prisma.gitRoot.findMany();
    expect(rows.map(r => r.root)).toEqual([outer]);
  });
});
