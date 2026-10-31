/**
 * Mirror projects the admin can edit (fileSystemSideCar docs/admin-screens.md,
 * Fantom "Sidecar sync" page).
 *
 * Stored in the runtime config file under `sidecarSync.mirror`:
 *   { auto: boolean, projects: [{ name, path }], updatedAt }
 * Until the admin saves once, the list comes from FANTOM_MIRROR_PROJECTS
 * (the startup seed, see mirror.ts). The first save writes the seed plus the
 * change, and from then on the settings win over the env var.
 *
 * Every path must sit under the mirror root as {root}/{sidecar}/{rootName}[/...]
 * because the receiver hook only maps paths there.
 */

import * as path from 'path';
import { atomicWriteConfigFile, readConfigFileWithRecovery } from '../config/index.js';
import { MIRROR_PROJECTS_ENV, mirrorProjectSpecs, mirrorRoot, type MirrorProjectSpec } from './mirror.js';

export interface MirrorSettings {
  /** 'env' until the admin saves once; then 'settings'. */
  source: 'env' | 'settings';
  /** Also register every {root}/{sidecar}/{rootName} folder. */
  auto: boolean;
  projects: MirrorProjectSpec[];
  updatedAt: string | null;
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class MirrorSettingsError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function readMirrorSettings(configPath: string, env: NodeJS.ProcessEnv = process.env): MirrorSettings {
  const file = readConfigFileWithRecovery(configPath);
  const m = file?.sidecarSync?.mirror;
  if (isObj(m) && Array.isArray(m.projects)) {
    const projects = m.projects
      .filter((p: unknown): p is MirrorProjectSpec => isObj(p) && typeof p.name === 'string' && typeof p.path === 'string')
      .map((p: MirrorProjectSpec) => ({ name: p.name, path: p.path }));
    return { source: 'settings', auto: m.auto === true, projects, updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : null };
  }
  const raw = env[MIRROR_PROJECTS_ENV]?.trim();
  const auto = raw === 'auto';
  return { source: 'env', auto, projects: auto ? [] : mirrorProjectSpecs(env), updatedAt: null };
}

function writeMirrorSettings(configPath: string, s: Pick<MirrorSettings, 'auto' | 'projects'>): MirrorSettings {
  const file = readConfigFileWithRecovery(configPath) ?? {};
  const sync = isObj(file.sidecarSync) ? file.sidecarSync : {};
  const updatedAt = new Date().toISOString();
  sync.mirror = { auto: s.auto, projects: s.projects, updatedAt };
  file.sidecarSync = sync;
  atomicWriteConfigFile(configPath, file);
  return { source: 'settings', auto: s.auto, projects: s.projects, updatedAt };
}

/** {sidecar, root} for a path under the mirror root, or null. */
export function mirrorLocation(p: string, root: string): { sidecar: string; root: string } | null {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.length >= 2 ? { sidecar: parts[0], root: parts[1] } : null;
}

/** Check and normalise one entry. Throws MirrorSettingsError. */
export function validateMirrorSpec(input: unknown, env: NodeJS.ProcessEnv = process.env): MirrorProjectSpec {
  if (!isObj(input)) throw new MirrorSettingsError('body must be an object');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const raw = typeof input.path === 'string' ? input.path.trim() : '';
  if (!NAME_RE.test(name)) throw new MirrorSettingsError('name must be 1-100 letters, digits, ".", "_" or "-"');
  if (!raw || !path.isAbsolute(raw) || raw.includes('\0')) throw new MirrorSettingsError('path must be an absolute path');
  const p = path.resolve(raw);
  const root = mirrorRoot(env);
  if (!mirrorLocation(p, root)) throw new MirrorSettingsError(`path must be under ${root}/{sidecar}/{root}`);
  return { name, path: p };
}

export function addMirrorProject(configPath: string, input: unknown, env: NodeJS.ProcessEnv = process.env): MirrorSettings {
  const spec = validateMirrorSpec(input, env);
  const cur = readMirrorSettings(configPath, env);
  if (cur.projects.some(p => p.name === spec.name)) throw new MirrorSettingsError(`mirror project "${spec.name}" already exists`, 409);
  if (cur.projects.some(p => p.path === spec.path)) throw new MirrorSettingsError(`path ${spec.path} is already a mirror project`, 409);
  return writeMirrorSettings(configPath, { auto: cur.auto, projects: [...cur.projects, spec] });
}

export function editMirrorProject(configPath: string, name: string, input: unknown, env: NodeJS.ProcessEnv = process.env): MirrorSettings {
  const cur = readMirrorSettings(configPath, env);
  const i = cur.projects.findIndex(p => p.name === name);
  if (i < 0) throw new MirrorSettingsError(`mirror project "${name}" not found`, 404);
  const body = isObj(input) ? input : {};
  const spec = validateMirrorSpec({ name: body.name ?? cur.projects[i].name, path: body.path ?? cur.projects[i].path }, env);
  if (cur.projects.some((p, j) => j !== i && p.name === spec.name)) throw new MirrorSettingsError(`mirror project "${spec.name}" already exists`, 409);
  if (cur.projects.some((p, j) => j !== i && p.path === spec.path)) throw new MirrorSettingsError(`path ${spec.path} is already a mirror project`, 409);
  const projects = cur.projects.slice();
  projects[i] = spec;
  return writeMirrorSettings(configPath, { auto: cur.auto, projects });
}

export function removeMirrorProject(configPath: string, name: string, env: NodeJS.ProcessEnv = process.env): { settings: MirrorSettings; removed: MirrorProjectSpec } {
  const cur = readMirrorSettings(configPath, env);
  const removed = cur.projects.find(p => p.name === name);
  if (!removed) throw new MirrorSettingsError(`mirror project "${name}" not found`, 404);
  return { settings: writeMirrorSettings(configPath, { auto: cur.auto, projects: cur.projects.filter(p => p !== removed) }), removed };
}

export function setMirrorAuto(configPath: string, auto: unknown, env: NodeJS.ProcessEnv = process.env): MirrorSettings {
  if (typeof auto !== 'boolean') throw new MirrorSettingsError('auto must be true or false');
  const cur = readMirrorSettings(configPath, env);
  return writeMirrorSettings(configPath, { auto, projects: cur.projects });
}

/** Explicit projects plus, when auto is on, every mirror folder (first entry for a path wins). */
export function effectiveMirrorSpecs(s: MirrorSettings, env: NodeJS.ProcessEnv = process.env): MirrorProjectSpec[] {
  const out = [...s.projects];
  if (s.auto) {
    const seen = new Set(out.map(p => p.path));
    for (const a of mirrorProjectSpecs({ ...env, [MIRROR_PROJECTS_ENV]: 'auto' })) {
      if (!seen.has(a.path)) { out.push(a); seen.add(a.path); }
    }
  }
  return out;
}
