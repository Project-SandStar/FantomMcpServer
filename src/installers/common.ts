/**
 * Shared steps for the Haxall and SkySpark installers: GitHub API, file
 * download, unzip, JDK environment, and the doc index + embed at the end.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getFantomDatabase } from '../fantom/database.js';
import type { FantomInstance } from '../fantom/types.js';
import type { JobContext } from './jobs.js';
import { GITHUB_SECRET, readInstallerSecret, type InstallerSettings } from './settings.js';
import type { ReleaseInfo } from './versions.js';

export async function githubJson<T>(url: string): Promise<T> {
  const token = readInstallerSecret(GITHUB_SECRET);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fantom-mcp-installer',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub API rate limit (HTTP ${res.status}). Add a GitHub token in Settings > Installer sources.`);
  }
  if (!res.ok) throw new Error(`GitHub API ${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Releases of `owner/repo`, newest first, drafts and pre-releases left out. */
export async function githubReleases(repo: string): Promise<(ReleaseInfo & { tag: string })[]> {
  const rows = await githubJson<any[]>(`https://api.github.com/repos/${repo}/releases?per_page=100`);
  return rows
    .filter(r => !r.draft && !r.prerelease)
    .map(r => ({ tag: String(r.tag_name), version: String(r.tag_name).replace(/^v/, ''), publishedAt: String(r.published_at), body: String(r.body ?? '') }));
}

export async function downloadUrl(ctx: JobContext, url: string, dest: string): Promise<void> {
  ctx.log(`Download ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'fantom-mcp-installer' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let n = 0, nextLog = 10 * 1024 * 1024;
  const src = Readable.fromWeb(res.body as any);
  src.on('data', (c: Buffer) => { n += c.length; if (n >= nextLog) { ctx.log(`  ${(n / 1048576).toFixed(0)} MB`); nextLog += 10 * 1024 * 1024; } });
  await pipeline(src, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  ctx.log(`  done, ${(n / 1048576).toFixed(1)} MB`);
}

/**
 * Unpack an archive into `parent` and return the single top-level folder it
 * made (its name is not assumed). Unpacks into a scratch folder first, so a
 * failed unpack never leaves a half-written install.
 */
export async function unpackSingleDir(ctx: JobContext, archive: string, parent: string, finalName: string): Promise<string> {
  const scratch = path.join(parent, `.unpack-${Date.now()}`);
  fs.mkdirSync(scratch, { recursive: true });
  try {
    if (/\.zip$/i.test(archive)) await ctx.run('unzip', ['-q', '-o', archive, '-d', scratch]);
    else await ctx.run('tar', ['-xzf', archive, '-C', scratch]);
    const tops = fs.readdirSync(scratch).filter(n => !n.startsWith('.') && n !== '__MACOSX');
    let root: string;
    if (tops.length === 1 && fs.statSync(path.join(scratch, tops[0])).isDirectory()) root = path.join(scratch, tops[0]);
    else root = scratch; // files at the archive root
    const dest = path.join(parent, finalName);
    if (fs.existsSync(dest)) throw new Error(`target already exists: ${dest}`);
    fs.renameSync(root, dest);
    return dest;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function chmodBin(dir: string): void {
  const bin = path.join(dir, 'bin');
  if (!fs.existsSync(bin)) return;
  for (const f of fs.readdirSync(bin)) {
    const p = path.join(bin, f);
    try { if (fs.statSync(p).isFile() && !/\.(bat|exe|cmd)$/i.test(f)) fs.chmodSync(p, 0o755); } catch { /* skip */ }
  }
}

/** JDK home for builds: settings, then JAVA_HOME. Throws if neither has bin/java. */
export function resolveJdkHome(settings: InstallerSettings): string {
  for (const c of [settings.jdkHome, process.env.JAVA_HOME ?? '']) {
    if (c && fs.existsSync(path.join(c, 'bin', 'java'))) return c;
  }
  throw new Error('No JDK 17 found. Set "JDK home" in Settings > Installer sources (or JAVA_HOME on the server).');
}

export function javaEnv(jdkHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: jdkHome, ...extra };
  env.PATH = `${path.join(jdkHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`;
  // A server-wide FAN_HOME / FAN_ENV must not leak into a build.
  for (const k of ['FAN_HOME', 'FAN_ENV', 'FAN_ENV_PATH']) if (!(k in extra)) delete env[k];
  return env;
}

export async function listInstances(): Promise<FantomInstance[]> {
  const db = getFantomDatabase();
  await db.initialize();
  return db.getAllInstances();
}

async function invalidateGroups(): Promise<void> {
  (await import('../projects/versionGroup.js')).invalidateVersionGroupCache();
}

/** Create the instance, or update the one of this type + version. */
export async function upsertInstance(input: {
  type: 'haxall' | 'skyspark'; version: string; path: string; sourcePath?: string; fantomVersion?: string; fantomSourcePath?: string; description?: string;
}): Promise<FantomInstance> {
  const db = getFantomDatabase();
  await db.initialize();
  const all = await db.getAllInstances();
  const existing = all.find(i => i.type === input.type && i.version === input.version);
  const name = `${input.type === 'haxall' ? 'Haxall' : 'SkySpark'} ${input.version}`;
  const fields = {
    path: input.path, type: input.type, version: input.version, sourcePath: input.sourcePath,
    fantomVersion: input.fantomVersion, fantomSourcePath: input.fantomSourcePath, description: input.description,
  };
  const inst = existing
    ? await db.updateInstance(existing.id, fields)
    : await db.createInstance({ name, ...fields });
  await invalidateGroups();
  if (!inst) throw new Error(`could not save instance ${name}`);
  return inst;
}

export async function updateInstancePath(id: number, newPath: string, extra: Record<string, string | undefined> = {}): Promise<FantomInstance> {
  const db = getFantomDatabase();
  await db.initialize();
  const inst = await db.updateInstance(id, { path: newPath, ...extra });
  await invalidateGroups();
  if (!inst) throw new Error(`instance ${id} not found`);
  return inst;
}

/**
 * Index the instance docs (forceRefresh: the doc folder may have moved), then
 * embed them unless the all-instances docs embed job is running (two writers
 * on the docs table at once would race); then say so instead.
 */
export async function indexAndEmbedDocs(ctx: JobContext, instanceId: number): Promise<Record<string, unknown>> {
  ctx.step(`Index docs for instance ${instanceId}`);
  const { parseInstanceDocs } = await import('../parser/local/index.js');
  const parsed = await parseInstanceDocs({ instanceId, forceRefresh: true });
  ctx.log(`Indexed ${parsed.items.length} doc items in ${parsed.duration} ms (${parsed.errors?.length ?? 0} errors)`);
  if (parsed.items.length === 0) {
    ctx.note(`No docs were indexed for instance ${instanceId}. Check that the doc folder exists.`);
    return { docItems: 0 };
  }

  ctx.step(`Embed docs for instance ${instanceId}`);
  const pipe = await import('../embedding/docsEmbeddingPipeline.js');
  const active = pipe.getActiveEmbedJob();
  if (active) {
    ctx.note(`The all-instances docs embed job ${active.jobId} is running, so instance ${instanceId} was not embedded now. Press "Embed This Instance" on the docs page when it ends.`);
    return { docItems: parsed.items.length, embedded: null };
  }
  let lastLog = 0;
  let r: Awaited<ReturnType<typeof pipe.embedInstanceDocs>>;
  try {
    r = await pipe.embedInstanceDocs(instanceId, { forceRefresh: false }, (done, total) => {
      if (Date.now() - lastLog > 5000) { lastLog = Date.now(); ctx.log(`  embedded ${done}/${total}`); }
    });
  } catch (e) {
    // The install and the doc index are done; only the vectors are missing.
    ctx.note(`Docs indexed, but embedding failed: ${(e as Error).message}. Press "Embed This Instance" on the docs page to retry.`);
    return { docItems: parsed.items.length, embedded: 0, embedError: (e as Error).message };
  }
  if (r.error) {
    ctx.note(`Docs indexed, but embedding failed: ${r.error}`);
  } else {
    ctx.log(`Embedded ${r.embedded}, already there ${r.alreadyExists}, skipped ${r.skipped} (${r.duration} ms)`);
  }
  return { docItems: parsed.items.length, embedded: r.embedded ?? 0, embedError: r.error ?? null };
}
