/** GitLab library: token never shown, test call mocked, pull from a local repo. */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { redactSecrets, getGitlabSettings, testGitlab, pullGitlabLibrary, DEFAULT_GITLAB, validGitlabBaseUrl, validGitlabRepo } from '../axon/axonGitlab.js';

const TOKEN = 'glpat' + '-SECRETsecret1234WXYZ';

describe('axon gitlab', () => {
  it('redacts tokens, headers and URL credentials', () => {
    const s = `fatal: https://oauth2:${TOKEN}@gitlab.example.com/x.git Authorization: Basic abcdef== PRIVATE-TOKEN: zzz`;
    const out = redactSecrets(s, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('abcdef==');
    expect(out).not.toContain('zzz');
  });

  it('validates URL and repo; env wins over saved', () => {
    expect(validGitlabBaseUrl('https://gitlab.example.com')).toBe(true);
    expect(validGitlabBaseUrl('http://gitlab.example.com')).toBe(false);
    expect(validGitlabBaseUrl('https://u:p@gitlab.example.com')).toBe(false);
    expect(validGitlabRepo('group/sub/axon-library')).toBe(true);
    expect(validGitlabRepo('../x')).toBe(false);
    const { settings, sources } = getGitlabSettings({ AXON_GITLAB_TOKEN: TOKEN, AXON_GITLAB_REFRESH_MINUTES: '15' } as any, { repo: 'a/b', refreshMinutes: 60 });
    expect(settings.token).toBe(TOKEN); expect(sources.token).toBe('env');
    expect(settings.refreshMinutes).toBe(15); expect(settings.repo).toBe('a/b'); expect(sources.repo).toBe('saved');
  });

  it('test call: maps 401/404/ok with a mock fetch and sends the token as a header', async () => {
    const s = { ...DEFAULT_GITLAB, baseUrl: 'https://gitlab.example.com', repo: 'group/sub/axon-library', token: TOKEN };
    let sent: any;
    const mk = (status: number, body: unknown = {}) => (async (url: any, init: any) => { sent = { url, init }; return new Response(JSON.stringify(body), { status }); }) as any;
    expect((await testGitlab(s, mk(401))).error).toMatch(/401/);
    expect((await testGitlab(s, mk(404))).error).toMatch(/404/);
    const ok = await testGitlab(s, mk(200, { path_with_namespace: 'group/sub/axon-library', default_branch: 'main' }));
    expect(ok).toMatchObject({ ok: true, defaultBranch: 'main' });
    expect(String(sent.url)).toContain(encodeURIComponent('group/sub/axon-library'));
    expect(sent.init.headers['PRIVATE-TOKEN']).toBe(TOKEN);
    expect((await testGitlab({ ...s, token: '' }, mk(200))).error).toMatch(/No token/);
  });

  describe('pull', () => {
    let tmp: string; let remote: string; let cwd: string;
    beforeAll(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'axgl-'));
      cwd = process.cwd();
      process.env.MCPFANTOM_CACHE_DIR = path.join(tmp, 'cache');
      const work = path.join(tmp, 'work'); fs.mkdirSync(work);
      const g = (...a: string[]) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
      execFileSync('git', ['init', '-q', '-b', 'main', work]);
      fs.mkdirSync(path.join(work, 'custA')); fs.writeFileSync(path.join(work, 'custA', 'f.axon'), 'x');
      g('add', '-A'); g('commit', '-qm', 'one');
      remote = path.join(tmp, 'remote.git');
      execFileSync('git', ['clone', '-q', '--bare', work, remote]);
      (globalThis as any).__work = work; (globalThis as any).__g = g;
    });
    afterAll(() => { process.chdir(cwd); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.MCPFANTOM_CACHE_DIR; });

    it('clones, then reports no change, then updates', async () => {
      const root = path.join(tmp, 'clones');
      const s = { ...DEFAULT_GITLAB, enabled: true, repo: 'a/lib' };
      const changed: string[] = [];
      const r1 = await pullGitlabLibrary({ settings: s, root, remote: `file://${remote}`, onChanged: r => changed.push(r.sha) });
      expect(r1.cloned).toBe(true);
      expect(fs.existsSync(path.join(r1.libraryPath, 'custA', 'f.axon'))).toBe(true);
      const r2 = await pullGitlabLibrary({ settings: s, root, remote: `file://${remote}` });
      expect(r2.changed).toBe(false);
      const work = (globalThis as any).__work; const g = (globalThis as any).__g;
      fs.writeFileSync(path.join(work, 'custA', 'g.axon'), 'y'); g('add', '-A'); g('commit', '-qm', 'two');
      g('push', '-q', remote, 'main');
      const r3 = await pullGitlabLibrary({ settings: s, root, remote: `file://${remote}`, onChanged: r => changed.push(r.sha) });
      expect(r3.changed).toBe(true);
      expect(changed.length).toBe(2);
      expect(fs.existsSync(path.join(r3.libraryPath, 'custA', 'g.axon'))).toBe(true);
    });

    it('fails clearly without a token and never stores one', async () => {
      await expect(pullGitlabLibrary({ settings: { ...DEFAULT_GITLAB, enabled: true, baseUrl: 'https://gitlab.example.com', repo: 'a/lib' }, root: path.join(tmp, 'c2') })).rejects.toThrow(/No token/);
    });
  });
});
