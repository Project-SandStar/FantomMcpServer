/**
 * Version groups: every indexed project belongs to one product/version line
 * ("haxall/4.0.6", "skyspark/3.1.12", "fantom/1.0.83", or "other"), derived at
 * read time from `fantom_projects` + `instances`. Nothing is stored; the map is
 * cached in memory and invalidated when projects or instances change.
 *
 * One selector string is honoured everywhere (MCP tools, admin routes, the
 * dashboard sidebar):
 *   "haxall 4.0.6"            exact version
 *   "skyspark 3.1"            a line (any patch): also "3.1.x"
 *   "skyspark 3.1.1-3.1.12"   inclusive range
 *   "haxall"                  the whole product
 *   "haxall/4.0.6"            the group key form
 * Versions compare as numeric tuples — "3.10.0" > "3.9.0" — never as strings.
 */
import { getPrismaClient } from '../db/prisma.js';

export type VersionProduct = 'skyspark' | 'haxall' | 'fantom' | 'other';

export interface VersionGroup {
  /** 'haxall/4.0.6', 'skyspark/3.1.12', 'fantom/1.0.83', 'other' */
  key: string;
  product: VersionProduct;
  /** Normalised 'major.minor.patch' (or 'major.minor' when that is all we know); null for 'other'. */
  version: string | null;
  /** 'major.minor' — the line the version belongs to; null for 'other'. */
  line: string | null;
  /** 'SkySpark 3.1.12' */
  label: string;
}

export interface VersionSelector {
  product: VersionProduct | null;
  /** Exact version when given as x.y.z */
  version: string | null;
  /** 'x.y' when the selector names a line (x.y or x.y.x) */
  line: string | null;
  from: string | null;
  to: string | null;
  /** The text as given, for echoing back. */
  raw: string;
}

export interface VersionGroupSummary extends VersionGroup {
  projectCount: number;
  projectIds: number[];
}

const PRODUCT_LABEL: Record<VersionProduct, string> = {
  skyspark: 'SkySpark',
  haxall: 'Haxall',
  fantom: 'Fantom',
  other: 'Other',
};
/** Sidebar / listing order. */
export const PRODUCT_ORDER: VersionProduct[] = ['skyspark', 'haxall', 'fantom', 'other'];

const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;
const FANTOM_NAME_RE = /^fantom\.(\d+\.\d+\.\d+)\./;
const FANTOM_PATH_RE = /[\\/]fantom-(\d+\.\d+\.\d+)[\\/]/;

type Tuple = [number, number, number];

export function parseVersionTuple(s: string | null | undefined): Tuple | null {
  if (!s) return null;
  const m = VERSION_RE.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] !== undefined ? Number(m[3]) : 0];
}

function compareTuple(a: Tuple, b: Tuple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Numeric version compare: negative when a < b. Unparseable sorts first. */
export function compareVersions(a: string | null, b: string | null): number {
  const ta = parseVersionTuple(a);
  const tb = parseVersionTuple(b);
  if (!ta && !tb) return 0;
  if (!ta) return -1;
  if (!tb) return 1;
  return compareTuple(ta, tb);
}

function normaliseVersion(s: string | null | undefined): string | null {
  const t = parseVersionTuple(s);
  if (!t) return null;
  // Keep the patch even when it was absent ("3.1" → "3.1.0") so keys are stable.
  return `${t[0]}.${t[1]}.${t[2]}`;
}

function productFromInstanceType(type: string | null | undefined): VersionProduct | null {
  const t = (type ?? '').toLowerCase();
  if (t === 'skyspark') return 'skyspark';
  if (t === 'haxall') return 'haxall';
  if (t === 'fantom') return 'fantom';
  return null;
}

export interface VersionGroupInput {
  name: string;
  path?: string | null;
  instance?: { type?: string | null; version?: string | null } | null;
}

/** Derive the group for one project. Pure. */
export function versionGroupForProject(p: VersionGroupInput): VersionGroup {
  let product: VersionProduct | null = null;
  let version: string | null = null;

  // 1. Instance wins: its type is the product, its version string carries the
  //    number somewhere ("3.1.12", "skyspark-3.1.8").
  if (p.instance) {
    product = productFromInstanceType(p.instance.type);
    version = normaliseVersion(p.instance.version);
    if (product && !version) {
      // Instance without a parseable version: still group by product.
      return { key: product, product, version: null, line: null, label: PRODUCT_LABEL[product] };
    }
  }
  // 2. Fantom SDK pods: "fantom.1.0.83.sys" or a path under fantom-1.0.83/.
  if (!product) {
    const m = FANTOM_NAME_RE.exec(p.name) ?? (p.path ? FANTOM_PATH_RE.exec(p.path) : null);
    if (m) {
      product = 'fantom';
      version = normaliseVersion(m[1]);
    }
  }
  if (!product || !version) {
    return { key: 'other', product: 'other', version: null, line: null, label: PRODUCT_LABEL.other };
  }
  const t = parseVersionTuple(version) as Tuple;
  const line = `${t[0]}.${t[1]}`;
  return {
    key: `${product}/${version}`,
    product,
    version,
    line,
    label: `${PRODUCT_LABEL[product]} ${version}`,
  };
}

/**
 * Parse a selector. Throws on text it cannot read so a typo in an MCP call
 * comes back as an error, not as an empty result set.
 */
export function parseVersionSelector(input: string): VersionSelector {
  const raw = String(input ?? '');
  const text = raw.trim().toLowerCase().replace(/\//g, ' ').replace(/\s+/g, ' ');
  if (!text) throw new Error('versionGroup: empty selector');
  const m = /^(skyspark|haxall|fantom|other)?\s*v?(\d+\.\d+(?:\.\d+)?|\d+\.\d+\.x)?\s*(?:-\s*v?(\d+\.\d+(?:\.\d+)?))?$/.exec(text);
  if (!m) {
    throw new Error(
      `versionGroup: cannot read "${raw}". Use "haxall 4.0.6", "skyspark 3.1", "skyspark 3.1.1-3.1.12" or "haxall".`,
    );
  }
  const product = (m[1] as VersionProduct | undefined) ?? null;
  const v1 = m[2] ?? null;
  const v2 = m[3] ?? null;
  if (!product && !v1) throw new Error(`versionGroup: cannot read "${raw}"`);
  const sel: VersionSelector = { product, version: null, line: null, from: null, to: null, raw };
  if (!v1) return sel;
  if (v2) {
    sel.from = normaliseVersion(v1);
    sel.to = normaliseVersion(v2);
    if (sel.from && sel.to && compareVersions(sel.from, sel.to) > 0) {
      throw new Error(`versionGroup: range "${raw}" runs backwards`);
    }
    return sel;
  }
  const isLine = /\.x$/.test(v1) || v1.split('.').length === 2;
  if (isLine) {
    const t = parseVersionTuple(v1) as Tuple;
    sel.line = `${t[0]}.${t[1]}`;
  } else {
    sel.version = normaliseVersion(v1);
  }
  return sel;
}

/** Does group `g` fall inside `sel`? Pure. */
export function versionInSelector(g: VersionGroup, sel: VersionSelector): boolean {
  if (sel.product && g.product !== sel.product) return false;
  if (sel.product === 'other') return true;
  if (sel.version) return g.version === sel.version;
  if (sel.line) return g.line === sel.line;
  if (sel.from || sel.to) {
    if (!g.version) return false;
    if (sel.from && compareVersions(g.version, sel.from) < 0) return false;
    if (sel.to && compareVersions(g.version, sel.to) > 0) return false;
    return true;
  }
  // Product only.
  return true;
}

// ---------------------------------------------------------------------------
// Cached project → group map
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  byProject: Map<number, VersionGroup>;
  names: Map<number, string>;
}

const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;

/** Call after a project or instance is added, removed or edited. */
export function invalidateVersionGroupCache(): void {
  cache = null;
}

async function load(): Promise<CacheEntry> {
  const prisma = getPrismaClient();
  const [projects, instances] = await Promise.all([
    prisma.fantomProject.findMany({ select: { id: true, name: true, path: true, instanceId: true } }),
    prisma.instance.findMany({ select: { id: true, type: true, version: true } }),
  ]);
  const inst = new Map(instances.map((i: { id: number; type: string; version: string | null }) => [i.id, i]));
  const byProject = new Map<number, VersionGroup>();
  const names = new Map<number, string>();
  for (const p of projects as Array<{ id: number; name: string; path: string; instanceId: number | null }>) {
    const i = p.instanceId != null ? inst.get(p.instanceId) : null;
    byProject.set(p.id, versionGroupForProject({ name: p.name, path: p.path, instance: i ?? null }));
    names.set(p.id, p.name);
  }
  return { at: Date.now(), byProject, names };
}

async function getCache(): Promise<CacheEntry> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = load().then((c) => { cache = c; return c; }).finally(() => { inFlight = null; });
  return inFlight;
}

/** projectId → group for every indexed project. */
export async function getProjectVersionGroups(): Promise<Map<number, VersionGroup>> {
  return (await getCache()).byProject;
}

/** The group of one project, or null when the id is unknown. */
export async function getVersionGroupForProjectId(projectId: number): Promise<VersionGroup | null> {
  return (await getCache()).byProject.get(projectId) ?? null;
}

/** Every group with its member projects, in sidebar order. */
export async function listVersionGroups(): Promise<VersionGroupSummary[]> {
  const { byProject } = await getCache();
  const acc = new Map<string, VersionGroupSummary>();
  for (const [pid, g] of byProject) {
    let s = acc.get(g.key);
    if (!s) {
      s = { ...g, projectCount: 0, projectIds: [] };
      acc.set(g.key, s);
    }
    s.projectCount++;
    s.projectIds.push(pid);
  }
  return sortGroups([...acc.values()]);
}

export function sortGroups<T extends VersionGroup>(groups: T[]): T[] {
  return groups.sort((a, b) => {
    const pa = PRODUCT_ORDER.indexOf(a.product);
    const pb = PRODUCT_ORDER.indexOf(b.product);
    if (pa !== pb) return pa - pb;
    // Newest first within a product.
    return compareVersions(b.version, a.version);
  });
}

export interface ResolvedVersionScope {
  /** The selectors as given, joined with ", " — for echoing back. */
  raw: string;
  selectors: VersionSelector[];
  /** Union of every selector's projects. */
  projectIds: number[];
  /** Group keys that matched, sidebar order. */
  groups: string[];
}

/** Selector input for one call: one string, several strings, or one string
 *  holding several selectors split by "," / ";" / "|". */
export type VersionSelectorInput = string | string[] | null | undefined;

export function normaliseSelectors(input: VersionSelectorInput): string[] {
  const parts = Array.isArray(input) ? input : [input ?? ''];
  return parts
    .flatMap((p) => String(p ?? '').split(/[,;|]/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Selectors → project ids (union). An unreadable selector throws; a readable
 * one that matches nothing returns an empty list (the caller decides what
 * that means).
 */
export async function resolveVersionScope(selector: VersionSelectorInput): Promise<ResolvedVersionScope> {
  const texts = normaliseSelectors(selector);
  if (texts.length === 0) throw new Error('versionGroup: empty selector');
  const selectors = texts.map(parseVersionSelector);
  const { byProject } = await getCache();
  const projectIds: number[] = [];
  const groups = new Map<string, VersionGroup>();
  for (const [pid, g] of byProject) {
    if (!selectors.some((sel) => versionInSelector(g, sel))) continue;
    projectIds.push(pid);
    groups.set(g.key, g);
  }
  return {
    raw: texts.join(', '),
    selectors,
    projectIds,
    groups: sortGroups([...groups.values()]).map((g) => g.key),
  };
}

/**
 * Scope for one tool/route call. `projectId` alone → no change. `versionGroup`
 * alone → `projectIds`. Both → the project must be inside the group, else an
 * error (a silent empty result is what this replaces).
 */
export async function scopeForRequest(args: { projectId?: number; versionGroup?: VersionSelectorInput }): Promise<{
  projectIds?: number[];
  scope: ResolvedVersionScope | null;
}> {
  if (normaliseSelectors(args.versionGroup).length === 0) return { scope: null };
  const scope = await resolveVersionScope(args.versionGroup);
  if (typeof args.projectId === 'number' && !scope.projectIds.includes(args.projectId)) {
    throw new Error(`projectId ${args.projectId} is not in ${describeVersionScope(scope)}`);
  }
  return { projectIds: typeof args.projectId === 'number' ? undefined : scope.projectIds, scope };
}

/** One line for tool output / logs: `versionGroup "haxall 4.0.6" → 62 projects (haxall/4.0.6)`. */
export function describeVersionScope(scope: ResolvedVersionScope): string {
  return `versionGroup "${scope.raw}" → ${scope.projectIds.length} project${scope.projectIds.length === 1 ? '' : 's'}`
    + (scope.groups.length ? ` (${scope.groups.join(', ')})` : '');
}
