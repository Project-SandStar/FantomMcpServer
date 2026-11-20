/**
 * Graph-store tuning knobs, settable from the dashboard ("Graph" tab on
 * /dashboard/config/#graph) under the top-level `graphSettings` key of
 * config/fantomMcpServer-config.json.
 *
 * Precedence per knob: saved dashboard value > env var > code default.
 * Only keys the user set are stored, so saving one knob never pins the
 * others (a host env such as FANTOM_GRAPH_MAX_OPEN=16 keeps working).
 *
 * Read through readConfigFileWithRecovery (cached 2 s, cleared on save) and
 * written with atomicWriteConfigFile, like every other writer of that file.
 */
import os from 'os';
import path from 'path';
import { readConfigFileWithRecovery, atomicWriteConfigFile } from '../config/index.js';

/** When a changed value takes effect. */
export type GraphApply = 'live' | 'next-open' | 'restart';

export interface GraphKnobDef {
  env: string;
  /** null = computed at run time (see `autoLabel`). */
  def: number | null;
  min: number;
  max: number;
  step?: number;
  integer: boolean;
  apply: GraphApply;
  label: string;
  help: string;
  autoLabel?: string;
}

export const GRAPH_KNOBS = {
  maxOpen: {
    env: 'FANTOM_GRAPH_MAX_OPEN', def: 16, min: 2, max: 64, integer: true, apply: 'live',
    label: 'Open stores cap',
    help: 'Most project stores open at once (LRU). Lowering it closes idle stores now; busy stores close when their query ends. Below ~8 an ask thrashes (open/evict/reopen).',
  },
  bufferFixedMiB: {
    env: 'FANTOM_GRAPH_DB_BUFFER_MIB', def: 0, min: 0, max: 2048, integer: true, apply: 'next-open',
    label: 'Fixed buffer pool per store (MiB)',
    help: '0 = auto size (5 x store file, between min and max, capped by the memory budget). Any other value skips the sizing.',
  },
  bufferMinMiB: {
    env: 'FANTOM_GRAPH_DB_BUFFER_MIN_MIB', def: 32, min: 8, max: 1024, integer: true, apply: 'next-open',
    label: 'Buffer pool floor (MiB)', help: 'Smallest auto-sized pool.',
  },
  bufferMaxMiB: {
    env: 'FANTOM_GRAPH_DB_BUFFER_MAX_MIB', def: 256, min: 16, max: 2048, integer: true, apply: 'next-open',
    label: 'Buffer pool ceiling (MiB)', help: 'Largest auto-sized pool. Must be >= the floor.',
  },
  poolMemFraction: {
    env: 'FANTOM_GRAPH_POOL_MEM_FRACTION', def: 0.0625, min: 0.01, max: 0.5, step: 0.0025, integer: false, apply: 'next-open',
    label: 'Memory share for all pools',
    help: 'Share of the memory limit split across the open-stores cap; bounds each auto-sized pool.',
  },
  dbMaxMiB: {
    env: 'FANTOM_GRAPH_DB_MAX_MIB', def: 256, min: 64, max: 8192, integer: true, apply: 'next-open',
    label: 'Max store size (MiB)', help: 'Virtual mmap reserved per store. Raise only if a store outgrows it.',
  },
  queryThreads: {
    env: 'FANTOM_GRAPH_QUERY_THREADS', def: null, min: 1, max: 32, integer: true, apply: 'next-open',
    label: 'Threads per graph query', autoLabel: 'min(CPUs, 4)',
    help: 'Each thread pins its own pages; many threads overflow small pools (seen at 16+ on a 112-CPU host).',
  },
  mainBufferMiB: {
    env: 'FANTOM_LADYBUG_BUFFER_MIB', def: 512, min: 64, max: 8192, integer: true, apply: 'restart',
    label: 'Shared graph DB buffer pool (MiB)', help: 'Pool of the legacy shared store (.cache/fantom-graph.db).',
  },
  projectFanout: {
    env: 'FANTOM_GRAPH_PROJECT_FANOUT', def: 4, min: 1, max: 32, integer: true, apply: 'live',
    label: 'Search fan-out: projects at a time',
    help: 'Project stores one search reads at once (all-project fetch, stale-id re-join, graph metrics, related nodes). At most half the open-stores cap, or the fan-out evicts its own stores.',
  },
  relatedLimit: {
    env: 'FANTOM_GRAPH_RELATED_LIMIT', def: 3, min: 1, max: 20, integer: true, apply: 'live',
    label: 'Related nodes per hit', help: 'Callers and callees attached to each search hit.',
  },
  nodeCountConcurrency: {
    env: 'FANTOM_GRAPH_NODE_COUNT_CONCURRENCY', def: 3, min: 1, max: 16, integer: true, apply: 'live',
    label: 'Node-count scan: projects at a time', help: 'Embed planning and coverage count nodes per project store.',
  },
} as const satisfies Record<string, GraphKnobDef>;

export type GraphKnob = keyof typeof GRAPH_KNOBS;
export const GRAPH_KNOB_NAMES = Object.keys(GRAPH_KNOBS) as GraphKnob[];

export type GraphSaved = Partial<Record<GraphKnob, number>>;
export type GraphSource = 'saved' | 'env' | 'default';

export interface GraphEffective {
  value: number;
  source: GraphSource;
}

function inRange(name: GraphKnob, n: number): boolean {
  const d: GraphKnobDef = GRAPH_KNOBS[name];
  return Number.isFinite(n) && n >= d.min && n <= d.max && (!d.integer || Number.isInteger(n));
}

/** Env parsing kept as the code had it: a positive finite number, else unset. */
function envValue(name: GraphKnob, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[GRAPH_KNOBS[name].env];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return GRAPH_KNOBS[name].integer ? Math.floor(n) : n;
}

function codeDefault(name: GraphKnob, cpus: number): number {
  if (name === 'queryThreads') return Math.max(1, Math.min(cpus || 1, 4));
  return GRAPH_KNOBS[name].def as number;
}

/** Pure: one knob from saved value, env and default. */
export function resolveGraphKnob(
  name: GraphKnob,
  saved: GraphSaved,
  env: NodeJS.ProcessEnv = process.env,
  cpus: number = os.availableParallelism?.() ?? os.cpus().length,
): GraphEffective {
  const s = saved[name];
  if (typeof s === 'number' && inRange(name, s)) return { value: s, source: 'saved' };
  const e = envValue(name, env);
  if (e !== undefined) return { value: e, source: 'env' };
  return { value: codeDefault(name, cpus), source: 'default' };
}

export function resolveAllGraphKnobs(
  saved: GraphSaved,
  env: NodeJS.ProcessEnv = process.env,
): Record<GraphKnob, GraphEffective> {
  const out = {} as Record<GraphKnob, GraphEffective>;
  for (const k of GRAPH_KNOB_NAMES) out[k] = resolveGraphKnob(k, saved, env);
  return out;
}

/** Keep only known, in-range keys. */
export function sanitizeGraphSaved(raw: unknown): GraphSaved {
  const out: GraphSaved = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of GRAPH_KNOB_NAMES) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'number' && inRange(k, v)) out[k] = v;
  }
  return out;
}

/**
 * Validate a PUT body. Values are numbers (set) or null (clear: back to env /
 * default). Cross-field checks run on the merged EFFECTIVE values.
 */
export function validateGraphPatch(
  patch: Record<string, unknown>,
  current: GraphSaved,
  env: NodeJS.ProcessEnv = process.env,
): { problems: string[]; next: GraphSaved } {
  const problems: string[] = [];
  const next: GraphSaved = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!(GRAPH_KNOB_NAMES as string[]).includes(k)) { problems.push(`unknown setting "${k}"`); continue; }
    const name = k as GraphKnob;
    if (v === null) { delete next[name]; continue; }
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    const d: GraphKnobDef = GRAPH_KNOBS[name];
    if (!inRange(name, n)) {
      problems.push(`${k} must be ${d.integer ? 'an integer ' : ''}between ${d.min} and ${d.max}`);
      continue;
    }
    next[name] = n;
  }
  const eff = resolveAllGraphKnobs(next, env);
  if (eff.bufferMinMiB.value > eff.bufferMaxMiB.value) {
    problems.push(`bufferMinMiB (${eff.bufferMinMiB.value}) must be <= bufferMaxMiB (${eff.bufferMaxMiB.value})`);
  }
  // Only when the patch touches either knob: an env pair that already breaks
  // the rule must not block saving something unrelated (projectFanout()
  // clamps at run time anyway).
  const touchesFanout = 'projectFanout' in patch || 'maxOpen' in patch;
  if (touchesFanout && eff.projectFanout.value > Math.floor(eff.maxOpen.value / 2)) {
    problems.push(`projectFanout (${eff.projectFanout.value}) must be <= half of maxOpen (${eff.maxOpen.value} / 2 = ${Math.floor(eff.maxOpen.value / 2)})`);
  }
  return { problems, next };
}

export function graphConfigPath(): string {
  return path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
}

const CACHE_MS = 2_000;
let cached: { at: number; value: GraphSaved } | null = null;
let override: GraphSaved | null = null;
const listeners = new Set<(eff: Record<GraphKnob, GraphEffective>) => void>();

/** Saved (dashboard) values only. Hot path: cached 2 s. */
export function getSavedGraphSettings(): GraphSaved {
  if (override) return override;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let raw: unknown;
  try { raw = readConfigFileWithRecovery(graphConfigPath())?.graphSettings; } catch { raw = undefined; }
  const value = sanitizeGraphSaved(raw);
  cached = { at: Date.now(), value };
  return value;
}

/** Effective value of one knob (saved > env > default). */
export function graphSetting(name: GraphKnob): number {
  return resolveGraphKnob(name, getSavedGraphSettings()).value;
}

/**
 * Projects one search reads at once. Clamped to half the open-stores cap at
 * run time too, so an env value that breaks the rule cannot thrash the pool.
 */
export function projectFanout(): number {
  const saved = getSavedGraphSettings();
  const cap = resolveGraphKnob('maxOpen', saved).value;
  return Math.max(1, Math.min(resolveGraphKnob('projectFanout', saved).value, Math.floor(cap / 2)));
}

/** Called after a save with the new effective values (e.g. live pool trim). */
export function onGraphSettingsChanged(fn: (eff: Record<GraphKnob, GraphEffective>) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Write the full saved set (already validated). Synchronous read-merge-write. */
export function saveGraphSettings(next: GraphSaved): GraphSaved {
  const clean = sanitizeGraphSaved(next);
  if (override) {
    override = clean;
  } else {
    const file = graphConfigPath();
    const cur = readConfigFileWithRecovery(file) ?? {};
    atomicWriteConfigFile(file, { ...cur, graphSettings: clean });
  }
  cached = null;
  const eff = resolveAllGraphKnobs(clean);
  for (const fn of listeners) { try { fn(eff); } catch { /* a listener must not fail the save */ } }
  return clean;
}

/** Tests: keep settings in memory instead of the config file. null = back to file. */
export function __setGraphSettingsForTest(s: GraphSaved | null): void {
  override = s ? sanitizeGraphSaved(s) : null;
  cached = null;
}
