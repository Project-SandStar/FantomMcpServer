/**
 * SkySpark: list installer zips from the configured source, install a
 * version that is not an instance yet, build its docs, index and embed them.
 *
 * Docs (tested on 3.1.12 and 4.0.7 zips):
 *   - 4.x: `bin/fan docgen -dir <root>/doc/` works on a fresh unzip. No
 *     license, no running server.
 *   - 3.x: `docgen` boots the host database first and fails with
 *     "NotSetupErr: Host db file does not exist" on a fresh unzip. After
 *     `bin/setup` (EULA, su user, "Update license from cloud? n") docgen works,
 *     still with no license. Setup accepts the SkyFoundry EULA, so it only
 *     runs when the admin turned on "Accept the SkySpark EULA" in settings.
 *     Otherwise the 3.x fallback is `bin/fan compilerDoc -all` (API docs for
 *     every pod, but not the SkySpark manual chapters docgen adds).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JobContext } from './jobs.js';
import { createProvider, type InstallerFile } from './providers.js';
import { getInstallerSettings, readInstallerSecret, SKYSPARK_SECRET } from './settings.js';
import { compareVersions, parseSkysparkInstallerName } from './versions.js';
import { chmodBin, indexAndEmbedDocs, javaEnv, listInstances, resolveJdkHome, unpackSingleDir, upsertInstance } from './common.js';

export interface SkysparkInstaller {
  version: string;
  file: InstallerFile;
  instanceId: number | null;
}

export interface SkysparkCheck {
  installers: SkysparkInstaller[];
  missing: string[];
  /** Files that look like SkySpark installers but have no x.y.z version in the name. */
  unrecognized: string[];
  minVersion: string;
}

async function listInstallers(): Promise<{ files: InstallerFile[] }> {
  const settings = getInstallerSettings();
  const provider = createProvider(settings.skyspark.source, readInstallerSecret(SKYSPARK_SECRET));
  return { files: await provider.list() };
}

export async function checkSkyspark(): Promise<SkysparkCheck> {
  const settings = getInstallerSettings();
  const { files } = await listInstallers();
  const instances = (await listInstances()).filter(i => i.type === 'skyspark');
  const byVersion = new Map<string, InstallerFile>();
  const unrecognized: string[] = [];
  for (const f of files) {
    if (!/\.zip$/i.test(f.name) || !/skyspark/i.test(f.name)) continue;
    const v = parseSkysparkInstallerName(f.name);
    if (!v) { unrecognized.push(f.folder ? `${f.folder}/${f.name}` : f.name); continue; }
    if (!byVersion.has(v)) byVersion.set(v, f);
  }
  const installers = [...byVersion.entries()]
    .filter(([v]) => compareVersions(v, settings.skyspark.minVersion) >= 0)
    .map(([version, file]) => ({ version, file, instanceId: instances.find(i => i.version === version)?.id ?? null }))
    .sort((a, b) => compareVersions(b.version, a.version));
  return {
    installers,
    missing: installers.filter(i => i.instanceId === null).map(i => i.version),
    unrecognized,
    minVersion: settings.skyspark.minVersion,
  };
}

/** Answer bin/setup's prompts (3.x). The su password is random and not kept: the install is for docs only. */
function setupAnswers(): (line: string, write: (s: string) => void) => void {
  const pass = crypto.randomBytes(18).toString('base64url');
  const answered = new Set<string>();
  const rules: [RegExp, string][] = [
    [/Run setup for above dir\? \(y\/n\)>\s*$/, 'y'],
    [/Accept\? \(y\/n\)>\s*$/, 'y'],
    [/su username>\s*$/, 'su'],
    [/su password>\s*$/, pass],
    [/su password \(confirm\)>\s*$/, pass],
    [/http port \[\d+\]>\s*$/, ''],
    [/Update license from cloud\? \(y\/n\)>\s*$/, 'n'],
    [/Apply setup options\? \(y\/n\)>\s*$/, 'y'],
  ];
  let buffer = '';
  return (chunk, write) => {
    buffer = (buffer + chunk).slice(-400);
    for (const [re, answer] of rules) {
      const key = re.source;
      if (answered.has(key) || !re.test(buffer)) continue;
      answered.add(key);
      buffer = '';
      write(answer + '\n');
      return;
    }
  };
}

async function buildDocs(ctx: JobContext, root: string, version: string, jdk: string): Promise<string> {
  const settings = getInstallerSettings();
  const fan = path.join(root, 'bin', 'fan');
  const env = javaEnv(jdk);
  const docDir = path.join(root, 'doc');
  const major = parseInt(version.split('.')[0], 10);

  if (major >= 4) {
    ctx.step('Generate docs (docgen)');
    await ctx.run(fan, ['docgen', '-dir', docDir + '/'], { cwd: root, env });
    return 'docgen';
  }

  if (settings.skyspark.acceptEula) {
    ctx.step('Set up var/ for docgen (bin/setup, no license)');
    if (!fs.existsSync(path.join(root, 'var', 'host', 'folio.trio'))) {
      await ctx.run(path.join(root, 'bin', 'setup'), [], { cwd: root, env, input: setupAnswers() });
    }
    ctx.step('Generate docs (docgen)');
    try {
      await ctx.run(fan, ['docgen', '-dir', docDir + '/'], { cwd: root, env });
      return 'docgen';
    } catch (e) {
      ctx.note(`docgen failed (${(e as Error).message}); falling back to compilerDoc.`);
    }
  } else {
    ctx.note('SkySpark 3.x docgen needs bin/setup, which accepts the SkyFoundry EULA. "Accept the SkySpark EULA" is off in settings, so the docs come from compilerDoc (pod API docs, without the SkySpark manual chapters).');
  }
  ctx.step('Generate docs (compilerDoc)');
  await ctx.run(fan, ['compilerDoc', '-all', '-outDir', docDir + '/'], { cwd: root, env });
  return 'compilerDoc';
}

export async function installSkyspark(ctx: JobContext, version: string): Promise<Record<string, unknown>> {
  const settings = getInstallerSettings();
  const jdk = resolveJdkHome(settings);

  ctx.step('List installers');
  const provider = createProvider(settings.skyspark.source, readInstallerSecret(SKYSPARK_SECRET));
  const files = await provider.list();
  const file = files.find(f => parseSkysparkInstallerName(f.name) === version);
  if (!file) throw new Error(`no installer for SkySpark ${version} in the source`);

  const zip = path.join(settings.skyspark.downloadDir, file.name);
  if (fs.existsSync(zip) && (!file.size || fs.statSync(zip).size === file.size)) {
    ctx.log(`Already downloaded: ${zip}`);
  } else {
    ctx.step(`Download ${file.folder ? file.folder + '/' : ''}${file.name}`);
    let next = 10 * 1048576;
    const n = await provider.download(file, zip, b => { if (b >= next) { ctx.log(`  ${(b / 1048576).toFixed(0)} MB`); next += 10 * 1048576; } });
    ctx.log(`  done, ${(n / 1048576).toFixed(1)} MB`);
    if (file.size && n !== file.size) throw new Error(`download size ${n} does not match ${file.size}`);
  }

  const root = path.join(settings.skyspark.installRoot, `skyspark-${version}`);
  if (fs.existsSync(path.join(root, 'bin', 'fan'))) {
    ctx.log(`Already unpacked: ${root}`);
  } else {
    ctx.step(`Unpack to ${root}`);
    fs.mkdirSync(settings.skyspark.installRoot, { recursive: true });
    await unpackSingleDir(ctx, zip, settings.skyspark.installRoot, `skyspark-${version}`);
  }
  chmodBin(root);

  const docsBy = await buildDocs(ctx, root, version, jdk);
  const docEntries = fs.existsSync(path.join(root, 'doc')) ? fs.readdirSync(path.join(root, 'doc')).length : 0;
  ctx.log(`Docs (${docsBy}): ${docEntries} entries in ${path.join(root, 'doc')}`);
  if (docEntries === 0) throw new Error('doc generation made no files');

  ctx.step('Save instance');
  const inst = await upsertInstance({ type: 'skyspark', version, path: root, description: `Installed from ${file.name}` });
  ctx.log(`Instance ${inst.id} (${inst.name}) -> ${root}`);
  const docs = await indexAndEmbedDocs(ctx, inst.id);
  return { version, instanceId: inst.id, path: root, docsBy, docEntries, ...docs };
}
