/**
 * Workflow Manager: markdown workflow resources, stored as files.
 *
 * Layout under the workflows folder (FANTOM_WORKFLOWS_DIR, default <cwd>/workflows):
 *
 *   *.md                         scope "global"   (built-in files are seeded here)
 *   instances/<instanceId>/*.md  scope "instance" (seen by members of any project of that instance)
 *   projects/<projectId>/*.md    scope "project"  (seen by the project's members)
 *   users/<username>/*.md        scope "personal" (a draft, seen by its owner only)
 *   .acl.json                    project members + owner of each file (src/workflows/workflowAccess.ts)
 *   .changelog.jsonl             append-only change history (who, when, what)
 *   .trash/                      deleted files (restore = copy back)
 *
 * When the folder is a git repo, each change is also committed (author = user).
 * Global ids stay the plain slug, so old `workflow://<slug>` URIs keep working.
 * Other ids are `<scope>/<scopeId>/<slug>` → `workflow://<scope>/<scopeId>/<slug>`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';

export type WorkflowScope = 'global' | 'instance' | 'project' | 'personal';

export interface WorkflowMetadata {
  id: string;
  title: string;
  description: string;
}

export interface Workflow {
  uri: string;
  metadata: WorkflowMetadata;
  fullContent: string;
  /** File mtime (ms): the version for "no lost edits" checks. */
  mtimeMs: number;
  sizeBytes: number;
  scope: WorkflowScope;
  /** projectId / instanceId / username; '' for global. */
  scopeId: string;
  slug: string;
  /** Path below the workflows folder. */
  relPath: string;
  /** Global file that also ships in the image. */
  builtin: boolean;
}

export interface ChangeEntry {
  at: string;
  user: string;
  action: 'create' | 'update' | 'delete' | 'restore' | 'copy' | 'members';
  id: string;
  detail?: Record<string, unknown>;
}

/** Workflow slugs become file names: keep them safe. */
const WORKFLOW_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const SCOPE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SCOPE_DIRS: Record<Exclude<WorkflowScope, 'global'>, string> = {
  instance: 'instances', project: 'projects', personal: 'users',
};

export function isValidWorkflowId(id: string): boolean {
  return WORKFLOW_ID_RE.test(id);
}

/** `slug` or `<scope>/<scopeId>/<slug>` → parts, or null when malformed. */
export function parseWorkflowId(id: string): { scope: WorkflowScope; scopeId: string; slug: string } | null {
  const parts = id.split('/');
  if (parts.length === 1) return WORKFLOW_ID_RE.test(id) ? { scope: 'global', scopeId: '', slug: id } : null;
  if (parts.length !== 3) return null;
  const [scope, scopeId, slug] = parts;
  if (!(scope in SCOPE_DIRS) || !SCOPE_ID_RE.test(scopeId) || !WORKFLOW_ID_RE.test(slug)) return null;
  if ((scope === 'project' || scope === 'instance') && !/^\d+$/.test(scopeId)) return null;
  return { scope: scope as WorkflowScope, scopeId, slug };
}

export function makeWorkflowId(scope: WorkflowScope, scopeId: string, slug: string): string {
  return scope === 'global' ? slug : `${scope}/${scopeId}/${slug}`;
}

/**
 * Folder the server reads and writes workflows in. `FANTOM_WORKFLOWS_DIR`
 * wins (Docker: a folder on the cache volume, so edits survive a recreate);
 * else `<cwd>/workflows`.
 */
export function resolveWorkflowsDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const v = env.FANTOM_WORKFLOWS_DIR?.trim();
  return v ? path.resolve(cwd, v) : path.join(cwd, 'workflows');
}

/**
 * Folder with the workflows shipped in the image (`workflows-builtin`, Docker)
 * or the repo's `workflows/` (dev). Returns '' when neither exists.
 */
export function resolveBuiltinWorkflowsDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const v = env.FANTOM_WORKFLOWS_BUILTIN_DIR?.trim();
  for (const c of [v ? path.resolve(cwd, v) : '', path.join(cwd, 'workflows-builtin'), path.join(cwd, 'workflows')]) {
    if (c && fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * Copy built-in `*.md` files into the writable folder when they are missing.
 * Never overwrites a file that exists (an edit wins). Returns the copied names.
 */
export function seedWorkflowsDir(builtinDir: string, targetDir: string): string[] {
  if (!builtinDir || path.resolve(builtinDir) === path.resolve(targetDir)) return [];
  if (!fs.existsSync(builtinDir)) return [];
  fs.mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];
  for (const f of fs.readdirSync(builtinDir)) {
    if (!f.endsWith('.md')) continue;
    const dst = path.join(targetDir, f);
    if (fs.existsSync(dst)) continue;
    try {
      fs.copyFileSync(path.join(builtinDir, f), dst, fs.constants.COPYFILE_EXCL);
      copied.push(f);
    } catch { /* raced with another writer: theirs wins */ }
  }
  return copied;
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#+\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractDescription(content: string): string | null {
  let foundHeading = false;
  let description = '';
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) { if (description) break; continue; }
    if (!foundHeading && t.startsWith('#')) { foundHeading = true; continue; }
    if (t.startsWith('#')) { if (description) break; continue; }
    if (foundHeading) description += (description ? ' ' : '') + t;
  }
  return description || null;
}

export class WorkflowConflictError extends Error {}

export class WorkflowManager {
  private workflows: Map<string, Workflow> = new Map();
  private workflowDir: string;
  private builtinNames = new Set<string>();
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private onChangeListeners: Array<() => void> = [];

  constructor(workflowDir: string, builtinDir = '') {
    this.workflowDir = workflowDir;
    if (builtinDir && fs.existsSync(builtinDir)) {
      for (const f of fs.readdirSync(builtinDir)) if (f.endsWith('.md')) this.builtinNames.add(f.replace(/\.md$/, ''));
    }
  }

  getDir(): string { return this.workflowDir; }
  dirExists(): boolean { return fs.existsSync(this.workflowDir); }

  private loadFile(filePath: string, scope: WorkflowScope, scopeId: string): void {
    const file = path.basename(filePath);
    const slug = file.replace(/\.md$/, '');
    if (!WORKFLOW_ID_RE.test(slug)) return;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stat = fs.statSync(filePath);
      const id = makeWorkflowId(scope, scopeId, slug);
      this.workflows.set(id, {
        uri: `workflow://${id}`,
        metadata: { id, title: extractTitle(content) || slug, description: extractDescription(content) || '' },
        fullContent: content,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        scope, scopeId, slug,
        relPath: path.relative(this.workflowDir, filePath),
        builtin: scope === 'global' && this.builtinNames.has(slug),
      });
    } catch (error) {
      console.error(`Failed to load workflow file ${filePath}:`, error);
    }
  }

  /** Load every scope folder. */
  loadWorkflows(): void {
    this.workflows.clear();
    if (!fs.existsSync(this.workflowDir)) {
      console.error(`Workflow directory does not exist: ${this.workflowDir}`);
      return;
    }
    for (const f of fs.readdirSync(this.workflowDir)) {
      if (f.endsWith('.md')) this.loadFile(path.join(this.workflowDir, f), 'global', '');
    }
    for (const [scope, dir] of Object.entries(SCOPE_DIRS) as Array<[WorkflowScope, string]>) {
      const base = path.join(this.workflowDir, dir);
      if (!fs.existsSync(base)) continue;
      for (const sub of fs.readdirSync(base, { withFileTypes: true })) {
        if (!sub.isDirectory() || !SCOPE_ID_RE.test(sub.name)) continue;
        if ((scope === 'project' || scope === 'instance') && !/^\d+$/.test(sub.name)) continue;
        for (const f of fs.readdirSync(path.join(base, sub.name))) {
          if (f.endsWith('.md')) this.loadFile(path.join(base, sub.name, f), scope, sub.name);
        }
      }
    }
  }

  getWorkflowList(): Workflow[] { return Array.from(this.workflows.values()); }
  getWorkflow(id: string): Workflow | undefined { return this.workflows.get(id); }
  /** `workflow://<id>` → workflow. */
  getWorkflowByUri(uri: string): Workflow | undefined {
    return uri.startsWith('workflow://') ? this.workflows.get(uri.slice('workflow://'.length)) : undefined;
  }
  getWorkflowCount(): number { return this.workflows.size; }
  hasWorkflow(id: string): boolean { return this.workflows.has(id); }
  reload(): void { this.loadWorkflows(); }

  private filePathFor(id: string): string {
    const p = parseWorkflowId(id);
    if (!p) throw new Error(`Invalid workflow id "${id}" (letters, digits, - and _ only)`);
    if (p.scope === 'global') return path.join(this.workflowDir, `${p.slug}.md`);
    return path.join(this.workflowDir, SCOPE_DIRS[p.scope], p.scopeId, `${p.slug}.md`);
  }

  /**
   * Write a workflow file and reload at once. Temp file + rename, so a reader
   * never sees half a file. `mustExist` true = update only, false = create only.
   * `expectedMtimeMs` (update): 409-style conflict when the file changed since.
   */
  saveWorkflow(id: string, content: string, mustExist: boolean, opts: { user?: string; expectedMtimeMs?: number; action?: ChangeEntry['action'] } = {}): Workflow {
    const filePath = this.filePathFor(id);
    const existing = this.workflows.get(id);
    if (mustExist && !existing) throw new Error(`Workflow "${id}" not found`);
    if (!mustExist && existing) throw new Error(`Workflow "${id}" already exists`);
    if (existing && opts.expectedMtimeMs !== undefined && Math.abs(existing.mtimeMs - opts.expectedMtimeMs) > 1) {
      throw new WorkflowConflictError(`Workflow "${id}" changed since you loaded it`);
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
    const text = content.endsWith('\n') ? content : content + '\n';
    fs.writeFileSync(tmpPath, text, 'utf-8');
    fs.renameSync(tmpPath, filePath);
    this.recordChange({
      at: new Date().toISOString(), user: opts.user ?? 'system', action: opts.action ?? (existing ? 'update' : 'create'), id,
      detail: { bytesBefore: existing?.sizeBytes ?? 0, bytesAfter: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) },
    });
    this.reload();
    this.notifyChange();
    return this.workflows.get(id)!;
  }

  /** Move the file to .trash/ and reload. Returns false when it did not exist. */
  deleteWorkflow(id: string, user = 'system'): boolean {
    if (!parseWorkflowId(id) || !this.workflows.has(id)) return false;
    const src = this.filePathFor(id);
    const trash = path.join(this.workflowDir, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(src, path.join(trash, `${id.replace(/\//g, '__')}.${Date.now()}.md`));
    this.recordChange({ at: new Date().toISOString(), user, action: 'delete', id });
    this.reload();
    this.notifyChange();
    return true;
  }

  /** Change history, newest first; one id or all. */
  getHistory(id?: string, limit = 200): ChangeEntry[] {
    const file = path.join(this.workflowDir, '.changelog.jsonl');
    if (!fs.existsSync(file)) return [];
    const out: ChangeEntry[] = [];
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line) as ChangeEntry; if (!id || e.id === id) out.push(e); } catch { /* skip bad line */ }
    }
    return out.reverse().slice(0, limit);
  }

  /** Append to the change log; commit when the folder is a git repo. */
  recordChange(e: ChangeEntry): void {
    try {
      fs.mkdirSync(this.workflowDir, { recursive: true });
      fs.appendFileSync(path.join(this.workflowDir, '.changelog.jsonl'), JSON.stringify(e) + '\n', 'utf-8');
    } catch (err) {
      console.error('workflow change log write failed:', err);
    }
    if (fs.existsSync(path.join(this.workflowDir, '.git'))) {
      const who = e.user.replace(/[^A-Za-z0-9_.-]/g, '_') || 'fantom';
      execFile('git', ['-C', this.workflowDir, 'add', '-A'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err) => {
        if (err) return;
        execFile('git', ['-C', this.workflowDir, '-c', `user.name=${who}`, '-c', `user.email=${who}@fantom.local`,
          'commit', '-q', '-m', `${e.action} ${e.id} (${who})`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, () => { /* nothing to commit is fine */ });
      });
    }
  }

  private notifyChange(): void {
    for (const l of this.onChangeListeners) {
      try { l(); } catch (err) { console.error('workflow onChange listener failed:', err); }
    }
  }

  /** Subscribe to "workflows changed" (MCP resources/list_changed). */
  onChange(listener: () => void): () => void {
    this.onChangeListeners.push(listener);
    return () => { this.onChangeListeners = this.onChangeListeners.filter(l => l !== listener); };
  }

  /** Watch the folder tree; reload on .md changes (250 ms debounce). */
  startWatching(): void {
    if (this.watcher) return;
    if (!fs.existsSync(this.workflowDir)) {
      console.error(`Cannot watch missing workflow directory: ${this.workflowDir}`);
      return;
    }
    try {
      this.watcher = fs.watch(this.workflowDir, { persistent: false, recursive: true }, (_event, filename) => {
        if (!filename || !String(filename).endsWith('.md') || String(filename).includes('.trash')) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.reload();
          this.notifyChange();
        }, 250);
      });
    } catch (err) {
      console.error(`Failed to watch workflow directory ${this.workflowDir}:`, err);
    }
  }

  stopWatching(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); this.reloadTimer = null; }
  }
}
