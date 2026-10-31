/**
 * Scoped workflows (files) and the access rules (decisions 2026-10-30).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowManager, parseWorkflowId, seedWorkflowsDir, WorkflowConflictError } from '../workflows/workflowManager.js';
import { WorkflowAcl, type WorkflowUser } from '../workflows/workflowAccess.js';

const admin: WorkflowUser = { username: 'root', role: 'admin' };
const ann: WorkflowUser = { username: 'ann', role: 'user' };
const bob: WorkflowUser = { username: 'bob', role: 'user' };
const eve: WorkflowUser = { username: 'eve', role: 'user' };

describe('workflow scopes and access', () => {
  let dir: string;
  let wm: WorkflowManager;
  let acl: WorkflowAcl;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfacl-'));
    fs.writeFileSync(path.join(dir, 'glob.md'), '# Global\n\nAll.\n');
    wm = new WorkflowManager(dir);
    wm.loadWorkflows();
    // project 7 is in instance 3; project 8 has no instance
    acl = new WorkflowAcl(dir, (pid) => (pid === '7' ? '3' : null));
    acl.setMember('7', 'ann', 'editor');
    acl.setMember('7', 'bob', 'viewer');
    wm.saveWorkflow('project/7/deploy', '# Deploy\n\nSteps.', false, { user: 'ann' });
    wm.saveWorkflow('instance/3/common', '# Common\n\nShared.', false, { user: 'root' });
    wm.saveWorkflow('personal/ann/draft', '# Draft\n\nMine.', false, { user: 'ann' });
    wm.saveWorkflow('project/8/other', '# Other\n\nHidden.', false, { user: 'root' });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const w = (id: string) => wm.getWorkflow(id)!;

  it('parses ids and keeps old global URIs', () => {
    expect(parseWorkflowId('glob')).toEqual({ scope: 'global', scopeId: '', slug: 'glob' });
    expect(parseWorkflowId('project/7/x')).toEqual({ scope: 'project', scopeId: '7', slug: 'x' });
    expect(parseWorkflowId('project/../x')).toBeNull();
    expect(parseWorkflowId('project/abc/x')).toBeNull();
    expect(parseWorkflowId('nope/1/x')).toBeNull();
    expect(wm.getWorkflowByUri('workflow://glob')?.scope).toBe('global');
    expect(wm.getWorkflowByUri('workflow://project/7/deploy')?.scope).toBe('project');
    expect(fs.existsSync(path.join(dir, 'projects', '7', 'deploy.md'))).toBe(true);
  });

  // role × scope × action table
  const table: Array<[string, WorkflowUser, string, boolean, boolean]> = [
    // label, user, id, canView, canEdit
    ['admin global', admin, 'glob', true, true],
    ['user global', ann, 'glob', true, false],
    ['editor project', ann, 'project/7/deploy', true, true],
    ['viewer project', bob, 'project/7/deploy', true, false],
    ['non-member project', eve, 'project/7/deploy', false, false],
    ['editor sees instance', ann, 'instance/3/common', true, true],
    ['viewer sees instance', bob, 'instance/3/common', true, false],
    ['non-member instance', eve, 'instance/3/common', false, false],
    ['owner draft', ann, 'personal/ann/draft', true, true],
    ['other member draft', bob, 'personal/ann/draft', false, false],
    ['admin draft', admin, 'personal/ann/draft', true, true],
    ['member of 7 on 8', ann, 'project/8/other', false, false],
  ];
  it.each(table)('%s', (_l, user, id, view, edit) => {
    expect(acl.canView(user, w(id))).toBe(view);
    expect(acl.canEdit(user, w(id))).toBe(edit);
  });

  it('create rights', () => {
    expect(acl.canCreate(ann, 'project', '7')).toBe(true);
    expect(acl.canCreate(bob, 'project', '7')).toBe(false);
    expect(acl.canCreate(ann, 'global', '')).toBe(false);
    expect(acl.canCreate(bob, 'personal', 'bob')).toBe(true);
    expect(acl.canCreate(bob, 'personal', 'ann')).toBe(false);
    expect(acl.canCreate(null, 'personal', 'x')).toBe(false);
  });

  it('records changes, not views, and detects stale saves', () => {
    const before = w('project/7/deploy');
    wm.getWorkflow('project/7/deploy');
    wm.saveWorkflow('project/7/deploy', '# Deploy v2\n\nMore.', true, { user: 'ann', expectedMtimeMs: before.mtimeMs });
    expect(() => wm.saveWorkflow('project/7/deploy', '# x\n', true, { user: 'bob', expectedMtimeMs: before.mtimeMs - 10_000 }))
      .toThrow(WorkflowConflictError);
    const h = wm.getHistory('project/7/deploy');
    expect(h.map(e => e.action)).toEqual(['update', 'create']);
    expect(h[0].user).toBe('ann');
    expect(wm.deleteWorkflow('project/7/deploy', 'ann')).toBe(true);
    expect(wm.getHistory('project/7/deploy')[0].action).toBe('delete');
    expect(fs.readdirSync(path.join(dir, '.trash')).length).toBe(1);
  });

  it('seed copy never overwrites an edited file', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wfsrc-'));
    fs.writeFileSync(path.join(src, 'glob.md'), '# Builtin\n');
    fs.writeFileSync(path.join(src, 'newone.md'), '# New\n');
    expect(seedWorkflowsDir(src, dir)).toEqual(['newone.md']);
    expect(fs.readFileSync(path.join(dir, 'glob.md'), 'utf-8')).toBe('# Global\n\nAll.\n');
    expect(seedWorkflowsDir(src, dir)).toEqual([]);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('members: add, list, remove', () => {
    expect(acl.getMembers('7').map(m => m.username)).toEqual(['ann', 'bob']);
    expect(acl.removeMember('7', 'bob')).toBe(true);
    expect(acl.canView(bob, w('project/7/deploy'))).toBe(false);
    expect(acl.removeMember('7', 'bob')).toBe(false);
  });
});
