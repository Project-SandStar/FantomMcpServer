/** Axon paths: env wins over saved; proj/ folder accepted in both layouts. */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAxonSettingsWithSources, resolveAxonProjDir, axonPathWarnings } from '../axon/axonSettings.js';

describe('axon settings paths', () => {
  it('env wins over saved, saved over empty', () => {
    const r = getAxonSettingsWithSources({ AXON_PROJECT_PATH: '/axon/proj' } as any, { projectPath: '/Users/x/axon', libraryPath: '/lib' });
    expect(r.settings.projectPath).toBe('/axon/proj');
    expect(r.sources.projectPath).toBe('env');
    expect(r.settings.libraryPath).toBe('/lib');
    expect(r.sources.libraryPath).toBe('saved');
    const e = getAxonSettingsWithSources({} as any, {});
    expect(e.sources.projectPath).toBe('empty');
  });

  it('accepts a checkout with proj/ and a proj/ folder itself', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'axp-'));
    const proj = path.join(tmp, 'checkout', 'proj');
    fs.mkdirSync(path.join(proj, 'inst1', 'p1', 'func'), { recursive: true });
    expect(resolveAxonProjDir(path.join(tmp, 'checkout'))).toEqual({ projDir: proj, layout: 'contains-proj' });
    expect(resolveAxonProjDir(proj)).toEqual({ projDir: proj, layout: 'is-proj' });
    const mirror = path.join(tmp, 'mirror');
    fs.mkdirSync(path.join(mirror, 'inst1', 'p1', 'func'), { recursive: true });
    expect(resolveAxonProjDir(mirror).layout).toBe('is-proj');
    expect(resolveAxonProjDir('').layout).toBe('none');
    expect(axonPathWarnings({ projectPath: path.join(tmp, 'nope'), libraryPath: '' } as any)[0]).toMatch(/does not exist/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('axon library from GitLab', () => {
  it('skips the local library warning when the GitLab clone is in use', () => {
    const s = { projectPath: '', libraryPath: '/nonexistent/axon-library-xyz' } as any;
    expect(axonPathWarnings(s, { projectPath: 'empty', libraryPath: 'saved', url: 'saved' })[0]).toMatch(/does not exist/);
    expect(axonPathWarnings(s, { projectPath: 'empty', libraryPath: 'gitlab', url: 'saved' })).toEqual([]);
  });

  it('clears the saved local libraryPath only when GitLab is on and cloned', async () => {
    const { clearLocalLibraryPathIfGitlab } = await import('../axon/axonGitlab.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'axg-'));
    const file = path.join(tmp, 'cfg.json');
    const repo = 'g/p';
    const write = (enabled: boolean) => fs.writeFileSync(file, JSON.stringify({ axon: { libraryPath: '/Users/mac/lib', gitlab: { enabled, repo } } }));
    write(false);
    fs.mkdirSync(path.join(tmp, 'g__p', '.git'), { recursive: true });
    expect(clearLocalLibraryPathIfGitlab(file, tmp)).toBe(false);
    write(true);
    expect(clearLocalLibraryPathIfGitlab(file, tmp)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.axon.libraryPath).toBe('');
    expect(cfg.axon.gitlab.enabled).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
