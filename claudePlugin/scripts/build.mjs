#!/usr/bin/env node
// Build claudePlugin/dist from claudePlugin/src plus the workflow skills
// generated from ../workflows/*.md. No dependencies, Node 20+.
//
//   node scripts/build.mjs            build
//   node scripts/build.mjs --check    build, then `claude plugin validate`
//
// dist/ is the plugin root Claude Code loads (marketplace.json source "./dist").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const REPO = path.resolve(PLUGIN, '..');
const SRC = path.join(PLUGIN, 'src');
const DIST = path.join(PLUGIN, 'dist');
const WORKFLOWS = path.join(REPO, 'workflows');

const check = process.argv.includes('--check');
const log = s => process.stdout.write(s + '\n');

// 1. version from the server package.json: one number for server and plugin.
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const version = rootPkg.version;

// 2. clean copy of src/
fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SRC, DIST, { recursive: true });

// 3. stamp the version
const manifestPath = path.join(DIST, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// Two marketplaces: claudePlugin/ (local installs, source ./dist) and the
// repo root (git installs, source ./claudePlugin/dist).
for (const marketPath of [
  path.join(PLUGIN, '.claude-plugin', 'marketplace.json'),
  path.join(REPO, '.claude-plugin', 'marketplace.json'),
]) {
  if (!fs.existsSync(marketPath)) continue;
  const market = JSON.parse(fs.readFileSync(marketPath, 'utf8'));
  market.metadata = { ...(market.metadata || {}), version };
  for (const p of market.plugins) if (p.name === manifest.name) p.version = version;
  fs.writeFileSync(marketPath, JSON.stringify(market, null, 2) + '\n');
}

// 4. LICENSE
fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(DIST, 'LICENSE'));

// 5. workflow skills: one per workflows/*.md, name wf-<file>
const DESC = {
  // hand-tuned one-liners; the rest come from the file's first lines
  'ai-coding-loop': 'Learn, change, reindex: keep the Fantom MCP index live while coding.',
  'api-migration-reference': 'SkySpark 3.x to 4.0 API table: every deprecated call and its replacement.',
  'connector-workflow': 'Build a SkySpark 3.1 connector with the connExt framework, step by step.',
  'create-pod': 'Create a new Fantom pod from scratch: build.fan, layout, compile, test.',
  'create-skyspark-extension': 'Create a SkySpark extension pod that registers in Settings > Exts.',
  'explore-code-relations': 'Walk a codebase with the call graph tools: callers, impact, neighbors.',
  'haxall-basics': 'Haxall introduction: runtime, libs, Axon, folio, and how pieces fit.',
  'haxall-coding-standards': 'Haxall 4.0.4 coding standards from 913 source files.',
  'haxall-methods-workflow': 'Haxall 4.0.4 method and workflow patterns: ext lifecycle, actors, folio.',
  'setup-fantom-mcp': 'Connect a client to the Fantom MCP server and keep the index live.',
  'skyspark-4x-migration': 'Migrate SkySpark 3.x extensions and projects to 4.0: step by step.',
  'unit-testing': 'Write Fantom unit tests: Test class, verify methods, fant runner.',
  'use-fanr': 'Publish and manage Fantom pods with fanr.',
  'xeto-spec-guide': 'Write Xeto specs for SkySpark 4.0 extensions and functions.',
};

function stripMd(s) {
  return s.replace(/[`*_>#]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

function describe(slug, text) {
  if (DESC[slug]) return DESC[slug];
  const lines = text.split('\n');
  const title = stripMd((lines.find(l => l.startsWith('# ')) || slug).replace(/^#\s*/, ''));
  const body = lines.find(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('```'));
  const d = body ? `${title}: ${stripMd(body)}` : title;
  return d.length > 120 ? d.slice(0, 117).replace(/\s+\S*$/, '') + '...' : d;
}

const yamlStr = s => JSON.stringify(s);

const skillsDir = path.join(DIST, 'skills');
const files = fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.md')).sort();
let made = 0;
for (const f of files) {
  const slug = f.replace(/\.md$/, '');
  const text = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
  const name = `wf-${slug}`;
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  // `$` followed by a digit or ARGUMENTS would be expanded by Claude Code.
  const body = text.replace(/\$(?=\d|ARGUMENTS)/g, '\\$');
  const skill = [
    '---',
    `name: ${name}`,
    `description: ${yamlStr(describe(slug, text))}`,
    '---',
    '',
    `<!-- generated from workflows/${f} by claudePlugin/scripts/build.mjs; edit the source, not this file -->`,
    '',
    body.trimEnd(),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skill);
  made++;
}

// 6. build info and a package.json so `npx`/`npm pack` work on dist/
fs.writeFileSync(path.join(DIST, 'BUILD.json'), JSON.stringify({
  version, workflows: files.map(f => f.replace(/\.md$/, '')),
}, null, 2) + '\n');
fs.writeFileSync(path.join(DIST, 'package.json'), JSON.stringify({
  name: 'fantom-mcp-plugin',
  version,
  description: manifest.description,
  license: 'SEE LICENSE IN LICENSE',
  type: 'module',
  bin: { 'fantom-mcp': 'bin/fantom-mcp.mjs' },
  engines: { node: '>=20' },
}, null, 2) + '\n');

const skillCount = fs.readdirSync(skillsDir).length;
log(`built ${path.relative(process.cwd(), DIST) || DIST}: v${version}, ${skillCount} skills (${made} workflows), hooks ${fs.readdirSync(path.join(DIST, 'hooks')).filter(f => f.endsWith('.mjs')).length}`);

if (check) {
  try {
    const out = execFileSync('claude', ['plugin', 'validate', DIST], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    log(out.trim().split('\n').pop());
  } catch (e) {
    process.stdout.write(String(e.stdout || '') + String(e.stderr || ''));
    process.exit(1);
  }
}
