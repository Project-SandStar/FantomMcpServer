/**
 * Installer helpers: version rules, PROPFIND parsing, share URL parsing,
 * settings sanitizing, and the job runner's log + single-job rule.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { compareVersions, parseSkysparkInstallerName, pickFantomVersion, tagToVersion } from '../installers/versions.js';
import { parsePropfind, parseNextcloudShareUrl } from '../installers/providers.js';
import { sanitizeInstallerSettings } from '../installers/settings.js';
import {
  startInstallerJob, getInstallerJob, jobLogSince, InstallerBusyError, __resetInstallerJobsForTest,
} from '../installers/jobs.js';

// Real release dates from the GitHub API (2026-11).
const FANTOM = [
  { version: '1.0.84', publishedAt: '2026-10-23T14:24:51Z' },
  { version: '1.0.83', publishedAt: '2026-03-12T16:07:17Z' },
  { version: '1.0.82', publishedAt: '2025-06-26T17:27:56Z' },
  { version: '1.0.81', publishedAt: '2024-12-06T17:28:38Z' },
];

describe('pickFantomVersion', () => {
  it('matches the known-good pairs by release date alone', () => {
    expect(pickFantomVersion({ version: '4.0.7', publishedAt: '2026-10-23T18:08:03Z' }, FANTOM)).toEqual({ version: '1.0.84', rule: 'release-date' });
    expect(pickFantomVersion({ version: '4.0.6', publishedAt: '2026-07-21T13:53:11Z' }, FANTOM)).toEqual({ version: '1.0.83', rule: 'release-date' });
  });
  it('lets the settings table win', () => {
    expect(pickFantomVersion({ version: '4.0.7', publishedAt: '2026-10-23T18:08:03Z' }, FANTOM, { '4.0.7': '1.0.99' }).version).toBe('1.0.99');
  });
  it('reads "Fantom build" from release notes', () => {
    const r = pickFantomVersion({ version: '3.1.12', publishedAt: '2025-06-26T22:30:41Z', body: '- Fantom build 1.0.82\n' }, FANTOM);
    expect(r).toEqual({ version: '1.0.82', rule: 'release-notes' });
  });
  it('gives none when nothing fits', () => {
    expect(pickFantomVersion({ version: '1.0.0', publishedAt: '2000-01-01T00:00:00Z' }, FANTOM).version).toBeNull();
  });
});

describe('version helpers', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('3.1.10', '3.1.9')).toBeGreaterThan(0);
    expect(compareVersions('4.0', '4.0.0')).toBe(0);
  });
  it('reads only canonical SkySpark zip names', () => {
    expect(parseSkysparkInstallerName('skyspark-4.0.7.zip')).toBe('4.0.7');
    expect(parseSkysparkInstallerName('SkySpark-305.zip')).toBeNull();
    expect(parseSkysparkInstallerName('skyspark-3.04.zip')).toBeNull();
  });
  it('maps tags', () => {
    expect(tagToVersion('v4.0.7')).toBe('4.0.7');
    expect(tagToVersion('v4.0.7-rc1')).toBeNull();
  });
});

describe('providers', () => {
  it('parses a Nextcloud PROPFIND body', () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/public.php/webdav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/public.php/webdav/Version%204/skyspark-4.0.7.zip</d:href><d:propstat><d:prop>
        <d:getlastmodified>Thu, 23 Oct 2026 18:00:00 GMT</d:getlastmodified><d:getcontentlength>30606054</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>
    </d:multistatus>`;
    const rows = parsePropfind(xml);
    expect(rows).toHaveLength(2);
    expect(rows[0].isDir).toBe(true);
    expect(rows[1]).toMatchObject({ isDir: false, size: 30606054, href: '/public.php/webdav/Version%204/skyspark-4.0.7.zip' });
  });
  it('turns a share URL into the WebDAV root and token', () => {
    expect(parseNextcloudShareUrl('https://cloud.example.com/s/AbC123')).toEqual({ davUrl: 'https://cloud.example.com/public.php/webdav/', token: 'AbC123' });
    expect(parseNextcloudShareUrl('https://cloud.example.com/index.php/s/AbC123?path=/Version%204').davUrl)
      .toBe('https://cloud.example.com/public.php/webdav/Version%204/');
    expect(() => parseNextcloudShareUrl('https://cloud.example.com/files')).toThrow(/public share/);
  });
});

describe('sanitizeInstallerSettings', () => {
  it('fills defaults and has no source by default', () => {
    const s = sanitizeInstallerSettings({});
    expect(s.skyspark.source).toBeNull();
    expect(s.skyspark.acceptEula).toBe(false);
    expect(s.haxall.fantomVersions['4.0.7']).toBe('1.0.84');
  });
  it('drops bad providers and bad version rows', () => {
    const s = sanitizeInstallerSettings({
      skyspark: { source: { provider: 'ftp', location: 'x' } },
      haxall: { fantomVersions: { '4.0.8': '1.0.85', bad: 'x' }, githubRepo: 'not a repo' },
    });
    expect(s.skyspark.source).toBeNull();
    expect(s.haxall.fantomVersions).toEqual({ '4.0.8': '1.0.85' });
    expect(s.haxall.githubRepo).toBe('haxall/haxall');
  });
});

describe('installer jobs', () => {
  beforeEach(() => __resetInstallerJobsForTest());

  it('runs one job at a time and streams child output into the log', async () => {
    const job = startInstallerJob('haxall-install', 'test', async ctx => {
      ctx.step('echo');
      await ctx.run('sh', ['-c', 'echo hello; echo world 1>&2']);
      return { ok: true };
    });
    expect(() => startInstallerJob('haxall-install', 'second', async () => undefined)).toThrow(InstallerBusyError);
    for (let i = 0; i < 500 && getInstallerJob(job.id)!.status === 'running'; i++) await new Promise(r => setTimeout(r, 20));
    const done = getInstallerJob(job.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.result).toEqual({ ok: true });
    const { lines, next } = jobLogSince(done, 0);
    expect(lines.join('\n')).toMatch(/hello/);
    expect(lines.join('\n')).toMatch(/world/);
    expect(jobLogSince(done, next).lines).toEqual([]);
  });

  it('marks a failing command as failed with the exit code', async () => {
    const job = startInstallerJob('skyspark-install', 'fail', async ctx => { await ctx.run('sh', ['-c', 'exit 3']); });
    for (let i = 0; i < 500 && getInstallerJob(job.id)!.status === 'running'; i++) await new Promise(r => setTimeout(r, 20));
    expect(getInstallerJob(job.id)!.status).toBe('failed');
    expect(getInstallerJob(job.id)!.error).toMatch(/code 3/);
  });
});
