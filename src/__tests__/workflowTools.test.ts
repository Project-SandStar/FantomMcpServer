/**
 * listWorkflows / getWorkflow MCP tools: same ACL as workflow:// resources,
 * section pick, and the plugin build emits pointer skills only.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { WorkflowManager } from '../workflows/workflowManager.js';
import { WorkflowAcl, type WorkflowUser } from '../workflows/workflowAccess.js';
import { listWorkflowsForUser, getWorkflowForUser, pickSection } from '../workflows/workflowTools.js';

const admin: WorkflowUser = { username: 'root', role: 'admin' };
const ann: WorkflowUser = { username: 'ann', role: 'user' };
const eve: WorkflowUser = { username: 'eve', role: 'user' };

describe('workflow tools', () => {
  let dir: string;
  let deps: { manager: WorkflowManager; acl: WorkflowAcl; projectInstance: (p: string) => string | null };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wftools-'));
    fs.writeFileSync(path.join(dir, 'create-pod.md'),
      '# Create Pod\n\nMake a pod.\n\n## Layout\n\nsrc/ and build.fan.\n\n```\n# not a heading\n```\n\n### Sub\n\nDeep.\n\n## Compile Step\n\nRun fan build.fan.\n');
    const manager = new WorkflowManager(dir);
    manager.loadWorkflows();
    const projectInstance = (pid: string) => (pid === '7' ? '3' : null);
    const acl = new WorkflowAcl(dir, projectInstance);
    acl.setMember('7', 'ann', 'editor');
    manager.saveWorkflow('project/7/deploy', '# Deploy\n\nSteps for seven.', false, { user: 'ann' });
    manager.saveWorkflow('project/8/create-pod', '# Pod for eight\n\nHidden.', false, { user: 'root' });
    manager.saveWorkflow('instance/3/common', '# Common\n\nShared.', false, { user: 'root' });
    manager.saveWorkflow('personal/ann/draft', '# Draft\n\nMine.', false, { user: 'ann' });
    deps = { manager, acl, projectInstance };
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const names = (u: WorkflowUser, a = {}) => listWorkflowsForUser(deps, u, a).workflows.map(w => w.name).sort();

  it('listWorkflows shows only what the caller may view', () => {
    expect(names(admin)).toEqual(['create-pod', 'instance/3/common', 'personal/ann/draft', 'project/7/deploy', 'project/8/create-pod']);
    expect(names(ann)).toEqual(['create-pod', 'instance/3/common', 'personal/ann/draft', 'project/7/deploy']);
    expect(names(eve)).toEqual(['create-pod']);
  });

  it('listWorkflows filters by scope, projectId and query', () => {
    expect(names(ann, { scope: 'personal' })).toEqual(['personal/ann/draft']);
    expect(names(admin, { projectId: 7 })).toEqual(['create-pod', 'instance/3/common', 'personal/ann/draft', 'project/7/deploy']);
    expect(names(admin, { query: 'pod' })).toEqual(['create-pod', 'project/8/create-pod']);
    const item = listWorkflowsForUser(deps, ann, { scope: 'project' }).workflows[0];
    expect(item).toMatchObject({ name: 'project/7/deploy', projectId: '7', scope: 'project', uri: 'workflow://project/7/deploy', description: 'Steps for seven.' });
    expect(() => listWorkflowsForUser(deps, ann, { scope: 'bogus' })).toThrow(/Unknown scope/);
  });

  it('getWorkflow resolves slug, id and uri; denies what is not visible', () => {
    const r = getWorkflowForUser(deps, ann, { name: 'workflow://project/7/deploy' });
    expect(r.ok && r.content).toContain('Steps for seven');
    const g = getWorkflowForUser(deps, eve, { name: 'create-pod' });
    expect(g.ok && g.name).toBe('create-pod');
    // a bare slug = the global id (as workflow://<slug>); visible variants are named
    const a = getWorkflowForUser(deps, admin, { name: 'create-pod' });
    expect(a.ok && a.name).toBe('create-pod');
    expect(a.ok && a.otherMatches).toEqual(['project/8/create-pod']);
    expect(getWorkflowForUser(deps, ann, { name: 'deploy' }).ok).toBe(true); // scoped-only slug
    for (const name of ['project/7/deploy', 'personal/ann/draft', 'workflow://instance/3/common']) {
      const d = getWorkflowForUser(deps, eve, { name });
      expect(d.ok).toBe(false);
      expect(!d.ok && d.error).toMatch(/not found or not visible/);
    }
    expect(getWorkflowForUser(deps, ann, { name: '' }).ok).toBe(false);
  });

  it('getWorkflow picks a section by heading text or slug and lists headings', () => {
    const r = getWorkflowForUser(deps, eve, { name: 'create-pod', section: 'layout' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.section).toBe('Layout');
    expect(r.content).toContain('build.fan');
    expect(r.content).toContain('Deep.');           // subsection kept
    expect(r.content).not.toContain('fan build');   // next ## section cut
    expect(r.sections.map(s => s.heading)).toEqual(['Create Pod', 'Layout', 'Sub', 'Compile Step']); // fenced "# not" skipped
    const s = getWorkflowForUser(deps, eve, { name: 'create-pod', section: 'compile-step' });
    expect(s.ok && s.content).toMatch(/^## Compile Step/);
    const miss = getWorkflowForUser(deps, eve, { name: 'create-pod', section: 'nope' });
    expect(!miss.ok && miss.error).toMatch(/Sections: Create Pod \| Layout/);
    expect(pickSection('# A\n\nx', 'zzz')).toBeNull();
  });

  it('getWorkflow truncates at maxChars', () => {
    const r = getWorkflowForUser(deps, eve, { name: 'create-pod', maxChars: 20 });
    expect(r.ok && r.truncated).toBe(true);
    expect(r.ok && r.content).toContain('[... truncated');
  });
});

describe('plugin build: workflow skills are pointers', () => {
  it('wf-* SKILL.md has name + description and calls getWorkflow, no workflow body', () => {
    const repo = process.cwd();
    execFileSync('node', [path.join(repo, 'claudePlugin', 'scripts', 'build.mjs')], { cwd: repo, stdio: 'pipe' });
    const skills = path.join(repo, 'claudePlugin', 'dist', 'skills');
    const wf = fs.readdirSync(skills).filter(s => s.startsWith('wf-'));
    const sources = fs.readdirSync(path.join(repo, 'workflows')).filter(f => f.endsWith('.md'));
    expect(wf.length).toBe(sources.length);
    for (const f of sources) {
      const slug = f.replace(/\.md$/, '');
      const md = fs.readFileSync(path.join(skills, `wf-${slug}`, 'SKILL.md'), 'utf8');
      expect(md).toMatch(new RegExp(`^name: wf-${slug}$`, 'm'));
      expect(md).toMatch(/^description: .+/m);
      expect(md).toContain(`getWorkflow({name: "${slug}"})`);
      expect(md).toMatch(/Never read local workflow files/);
      expect(md.length).toBeLessThan(1500);
      // no line of the source body (beyond the title) is copied in
      const src = fs.readFileSync(path.join(repo, 'workflows', f), 'utf8');
      const bodyLines = src.split('\n').map(l => l.trim()).filter(l => l.length > 40 && !l.startsWith('#'));
      const body = md.split('\n---\n').slice(1).join('\n');
      for (const l of bodyLines.slice(0, 20)) expect(body).not.toContain(l);
    }
  });
});
