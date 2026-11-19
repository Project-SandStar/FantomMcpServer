/**
 * Haxall: find GitHub releases that are not instances yet, build one into
 * `<installRoot>/haxall-<ver>/home` with scripts/haxall/build.sh, register the
 * instance, then index and embed its docs.
 *
 * Inputs the build needs, all fetched when missing:
 *   - Fantom release   <fantomRoot>/fantom-<fv>      (GitHub fantom-lang/fantom)
 *   - haystack-defs    <haystackDefsDir>/lib/fan    (cloned + built with Fantom)
 *   - xeto             <xetoRoot>/<ver>/xeto        (clone at the last commit
 *                       before the Haxall release; the dir must be named xeto)
 *   - Haxall source    <installRoot>/haxall-<ver>   (GitHub tag tarball)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getInstallRoot } from '../utils/installRoot.js';
import type { FantomInstance } from '../fantom/types.js';
import type { JobContext } from './jobs.js';
import { getInstallerSettings, type InstallerSettings } from './settings.js';
import { compareVersions, pickFantomVersion, tagToVersion, type ReleaseInfo } from './versions.js';
import {
  chmodBin, downloadUrl, githubReleases, indexAndEmbedDocs, javaEnv, listInstances,
  resolveJdkHome, unpackSingleDir, updateInstancePath, upsertInstance,
} from './common.js';

export interface HaxallRelease {
  version: string;
  publishedAt: string;
  fantomVersion: string | null;
  fantomRule: string;
  instanceId: number | null;
  instancePath: string | null;
  hasDocs: boolean;
}

export interface HaxallCheck {
  releases: HaxallRelease[];
  missing: string[];
  minVersion: string;
}

function hasDocsAt(inst: FantomInstance | undefined): boolean {
  if (!inst) return false;
  const p = inst.path;
  return [path.join(p, 'doc'), path.join(p, 'home', 'doc')].some(d => {
    try { return fs.readdirSync(d).length > 0; } catch { return false; }
  });
}

async function fetchReleases(settings: InstallerSettings): Promise<{ haxall: (ReleaseInfo & { tag: string })[]; fantom: ReleaseInfo[] }> {
  const [haxall, fantom] = await Promise.all([githubReleases(settings.haxall.githubRepo), githubReleases('fantom-lang/fantom')]);
  return {
    haxall: haxall.filter(r => tagToVersion(r.tag)),
    fantom: fantom.filter(r => tagToVersion(r.tag)).map(r => ({ ...r, version: tagToVersion(r.tag)! })),
  };
}

export async function checkHaxall(): Promise<HaxallCheck> {
  const settings = getInstallerSettings();
  const { haxall, fantom } = await fetchReleases(settings);
  const instances = (await listInstances()).filter(i => i.type === 'haxall');
  const releases: HaxallRelease[] = haxall
    .filter(r => compareVersions(r.version, settings.haxall.minVersion) >= 0)
    .map(r => {
      const inst = instances.find(i => i.version === r.version);
      const fv = pickFantomVersion(r, fantom, settings.haxall.fantomVersions);
      return {
        version: r.version, publishedAt: r.publishedAt, fantomVersion: fv.version, fantomRule: fv.rule,
        instanceId: inst?.id ?? null, instancePath: inst?.path ?? null, hasDocs: hasDocsAt(inst),
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version));
  return { releases, missing: releases.filter(r => r.instanceId === null).map(r => r.version), minVersion: settings.haxall.minVersion };
}

async function ensureFantom(ctx: JobContext, settings: InstallerSettings, fv: string): Promise<string> {
  const dir = path.join(settings.haxall.fantomRoot, `fantom-${fv}`);
  if (fs.existsSync(path.join(dir, 'bin', 'fan'))) { ctx.log(`Fantom ${fv}: ${dir}`); return dir; }
  ctx.step(`Download Fantom ${fv}`);
  fs.mkdirSync(settings.haxall.fantomRoot, { recursive: true });
  const zip = path.join(settings.haxall.fantomRoot, `fantom-${fv}.zip`);
  await downloadUrl(ctx, `https://github.com/fantom-lang/fantom/releases/download/v${fv}/fantom-${fv}.zip`, zip);
  await unpackSingleDir(ctx, zip, settings.haxall.fantomRoot, `fantom-${fv}`);
  fs.rmSync(zip, { force: true });
  chmodBin(dir);
  return dir;
}

/**
 * haystack-defs pods are not in git; build them with Fantom. FAN_ENV points
 * the build at the checkout: without it `fan` writes the pods into the Fantom
 * release's own lib/fan.
 */
async function ensureHaystackDefs(ctx: JobContext, settings: InstallerSettings, fantomDir: string, jdk: string): Promise<string> {
  const dir = settings.haxall.haystackDefsDir;
  if (fs.existsSync(path.join(dir, 'lib', 'fan', 'ph.pod'))) { ctx.log(`haystack-defs: ${dir}`); return dir; }
  ctx.step('Get and build haystack-defs');
  if (!fs.existsSync(path.join(dir, 'src', 'build.fan'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await ctx.run('git', ['clone', '--depth', '1', settings.haxall.haystackDefsRepoUrl, dir]);
  }
  await ctx.run(path.join(fantomDir, 'bin', 'fan'), ['src/build.fan', 'compile'], {
    cwd: dir, env: javaEnv(jdk, { FAN_HOME: fantomDir, FAN_ENV: 'util::PathEnv', FAN_ENV_PATH: dir }),
  });
  if (!fs.existsSync(path.join(dir, 'lib', 'fan', 'ph.pod'))) throw new Error(`haystack-defs build made no lib/fan/ph.pod in ${dir}`);
  return dir;
}

/** Xeto clone for this Haxall version, detached at the last commit before the release. */
async function ensureXeto(ctx: JobContext, settings: InstallerSettings, version: string, publishedAt: string | null): Promise<string> {
  const dir = path.join(settings.haxall.xetoRoot, version, 'xeto');
  if (fs.existsSync(path.join(dir, 'src'))) { ctx.log(`xeto: ${dir}`); return dir; }
  ctx.step(`Get xeto for Haxall ${version}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await ctx.run('git', ['clone', '--filter=blob:none', '--no-checkout', settings.haxall.xetoRepoUrl, dir]);
  let rev = 'HEAD';
  if (publishedAt) {
    const { execFileSync } = await import('node:child_process');
    const r = execFileSync('git', ['-C', dir, 'rev-list', '-1', `--before=${publishedAt}`, 'HEAD'], { encoding: 'utf-8' }).trim();
    if (r) rev = r;
  }
  ctx.log(`xeto revision ${rev} (last commit before ${publishedAt ?? 'now'})`);
  await ctx.run('git', ['-C', dir, 'checkout', '--detach', rev]);
  return dir;
}

/**
 * Make sure `<installRoot>/haxall-<ver>/src` exists. The GitHub tag tarball
 * comes first: a tree on the sidecar mirror is not a full copy (the file sync
 * leaves out .jar files such as src/conn/sedona/sedona.jar, and the build
 * stops on them). `copyFrom` is the fallback when GitHub cannot be reached.
 */
async function ensureSource(ctx: JobContext, settings: InstallerSettings, version: string, copyFrom?: string): Promise<string> {
  const root = path.join(settings.haxall.installRoot, `haxall-${version}`);
  if (fs.existsSync(path.join(root, 'src', 'build.fan'))) { ctx.log(`Haxall source: ${root}`); return root; }
  fs.mkdirSync(settings.haxall.installRoot, { recursive: true });
  ctx.step(`Download Haxall ${version} source`);
  const tgz = path.join(settings.haxall.installRoot, `haxall-${version}.tar.gz`);
  try {
    await downloadUrl(ctx, `https://github.com/${settings.haxall.githubRepo}/archive/refs/tags/v${version}.tar.gz`, tgz);
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    await unpackSingleDir(ctx, tgz, settings.haxall.installRoot, `haxall-${version}`);
    return root;
  } catch (e) {
    if (!copyFrom || !fs.existsSync(path.join(copyFrom, 'src', 'build.fan'))) throw e;
    ctx.note(`GitHub download failed (${(e as Error).message}); copying the source from ${copyFrom}. A mirrored tree may miss .jar files.`);
  } finally {
    fs.rmSync(tgz, { force: true });
    fs.rmSync(`${tgz}.part`, { force: true });
  }
  ctx.step(`Copy Haxall ${version} source from ${copyFrom}`);
  fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(copyFrom!)) {
    if (['home', 'lib', 'fan.props', '.git'].includes(name)) continue;
    await ctx.run('cp', ['-R', path.join(copyFrom!, name), path.join(root, name)]);
  }
  return root;
}

export function buildScriptPath(): string {
  return path.join(getInstallRoot(), 'scripts', 'haxall', 'build.sh');
}

/** Build one version end to end. `copyFrom`: an existing tree to take the source from. */
export async function buildHaxall(ctx: JobContext, version: string, opts: { copyFrom?: string; instanceId?: number } = {}): Promise<Record<string, unknown>> {
  const settings = getInstallerSettings();
  const jdk = resolveJdkHome(settings);
  ctx.log(`JDK: ${jdk}`);

  ctx.step('Read releases');
  let rel: (ReleaseInfo & { tag: string }) | undefined;
  let fantomRels: ReleaseInfo[] = [];
  try {
    const r = await fetchReleases(settings);
    rel = r.haxall.find(x => x.version === version);
    fantomRels = r.fantom;
  } catch (e) {
    ctx.log(`GitHub releases not available (${(e as Error).message}); using the settings table only.`);
  }
  const fv = pickFantomVersion(rel ?? { version, publishedAt: '' }, fantomRels, settings.haxall.fantomVersions);
  if (!fv.version) throw new Error(`No Fantom version known for Haxall ${version}. Add it to the Fantom version table in Settings > Installer sources.`);
  ctx.log(`Haxall ${version} -> Fantom ${fv.version} (rule: ${fv.rule})`);

  const fantomDir = await ensureFantom(ctx, settings, fv.version);
  const defsDir = await ensureHaystackDefs(ctx, settings, fantomDir, jdk);
  const xetoDir = await ensureXeto(ctx, settings, version, rel?.publishedAt ?? null);
  const root = await ensureSource(ctx, settings, version, opts.copyFrom);

  ctx.step(`Build Haxall ${version}`);
  const script = buildScriptPath();
  if (!fs.existsSync(script)) throw new Error(`build script not found: ${script}`);
  await ctx.run('bash', [script, version, '--fantom', fv.version], {
    cwd: path.dirname(script),
    env: javaEnv(jdk, {
      BUILD_ENV: '/dev/null', VERSIONS_FILE: '/dev/null',
      HAXALL_ROOT: settings.haxall.installRoot, FANTOM_ROOT: settings.haxall.fantomRoot,
      HAYSTACK_DIR: defsDir, XETO_DIR: xetoDir, JDK_HOME: jdk,
    }),
  });
  const home = path.join(root, 'home');
  const docCount = fs.existsSync(path.join(home, 'doc')) ? fs.readdirSync(path.join(home, 'doc')).length : 0;
  const podCount = fs.existsSync(path.join(home, 'lib', 'fan')) ? fs.readdirSync(path.join(home, 'lib', 'fan')).length : 0;
  ctx.log(`home: ${home} (${podCount} pods, ${docCount} doc entries)`);
  if (docCount === 0) throw new Error(`build finished but ${home}/doc is empty`);

  ctx.step('Save instance');
  const fields = { sourcePath: path.join(root, 'src'), fantomVersion: fv.version, fantomSourcePath: fantomDir };
  const inst = opts.instanceId
    ? await updateInstancePath(opts.instanceId, home, fields)
    : await upsertInstance({ type: 'haxall', version, path: home, ...fields, description: `Built from GitHub v${version}` });
  ctx.log(`Instance ${inst.id} (${inst.name}) -> ${home}`);

  const docs = await indexAndEmbedDocs(ctx, inst.id);
  return { version, instanceId: inst.id, home, pods: podCount, docEntries: docCount, fantomVersion: fv.version, ...docs };
}

/** "Compile home": rebuild an existing instance's version and point it at the new home. */
export async function compileInstanceHome(ctx: JobContext, inst: FantomInstance): Promise<Record<string, unknown>> {
  if (!inst.version) throw new Error(`instance ${inst.id} has no version`);
  const root = path.basename(inst.path) === 'home' ? path.dirname(inst.path) : inst.path;
  return buildHaxall(ctx, inst.version, { copyFrom: root, instanceId: inst.id });
}

/** True when `dir` looks like a runtime home (bin/ and lib/). */
function isHome(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'bin')) && fs.existsSync(path.join(dir, 'lib'));
}

/** "Set home": find the runtime home for an instance path. Null when none. */
export function detectHome(instancePath: string): string | null {
  const root = path.basename(instancePath) === 'home' ? path.dirname(instancePath) : instancePath;
  for (const c of [path.join(root, 'home'), instancePath, root]) {
    if (isHome(c) && (path.basename(c) === 'home' || fs.existsSync(path.join(c, 'lib', 'fan')))) return c;
  }
  return null;
}
