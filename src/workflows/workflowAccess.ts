/**
 * Workflow access rules. One place: every admin route and MCP tool calls
 * canView / canEdit / canCreate.
 *
 * Data: `<workflows>/.acl.json`
 *   { "projects": { "<projectId>": { "<username>": "viewer" | "editor" } },
 *     "owners":   { "<workflowId>": "<username>" } }
 *
 * Rules (decisions 2026-10-30):
 * - admin: everything.
 * - global (incl. built-in): everyone logged in sees; only admins write.
 * - project: members see; editors edit and create. Members see each other's work.
 * - instance: members of any project of that instance see; editors of such a project edit.
 * - personal: the owner (folder name) only.
 * - Only admins change project members.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Workflow, WorkflowScope } from './workflowManager.js';

export type MemberRole = 'viewer' | 'editor';

export interface WorkflowUser {
  username: string;
  role: 'admin' | 'user';
}

export interface AclFile {
  projects: Record<string, Record<string, MemberRole>>;
  owners: Record<string, string>;
}

/** projectId → instanceId (null when the project has no instance). */
export type ProjectInstanceLookup = (projectId: string) => string | null;

export class WorkflowAcl {
  constructor(private dir: string, private projectInstance: ProjectInstanceLookup = () => null) {}

  setProjectInstanceLookup(fn: ProjectInstanceLookup): void { this.projectInstance = fn; }

  private file(): string { return path.join(this.dir, '.acl.json'); }

  read(): AclFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf-8'));
      return {
        projects: raw && typeof raw.projects === 'object' && raw.projects ? raw.projects : {},
        owners: raw && typeof raw.owners === 'object' && raw.owners ? raw.owners : {},
      };
    } catch {
      return { projects: {}, owners: {} };
    }
  }

  private write(acl: AclFile): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(acl, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, this.file());
  }

  getMembers(projectId: string): Array<{ username: string; role: MemberRole }> {
    const m = this.read().projects[projectId] ?? {};
    return Object.entries(m).map(([username, role]) => ({ username, role })).sort((a, b) => a.username.localeCompare(b.username));
  }

  setMember(projectId: string, username: string, role: MemberRole): void {
    const acl = this.read();
    acl.projects[projectId] = { ...(acl.projects[projectId] ?? {}), [username]: role };
    this.write(acl);
  }

  removeMember(projectId: string, username: string): boolean {
    const acl = this.read();
    if (!acl.projects[projectId]?.[username]) return false;
    delete acl.projects[projectId][username];
    if (Object.keys(acl.projects[projectId]).length === 0) delete acl.projects[projectId];
    this.write(acl);
    return true;
  }

  getOwner(workflowId: string): string | undefined { return this.read().owners[workflowId]; }

  setOwner(workflowId: string, username: string): void {
    const acl = this.read();
    if (acl.owners[workflowId] === username) return;
    acl.owners[workflowId] = username;
    this.write(acl);
  }

  /** Role of a user in a project ('' = not a member). */
  projectRole(user: WorkflowUser, projectId: string): MemberRole | '' {
    return this.read().projects[projectId]?.[user.username] ?? '';
  }

  /** Projects a user belongs to, with role. */
  projectsOf(user: WorkflowUser): Array<{ projectId: string; role: MemberRole }> {
    const out: Array<{ projectId: string; role: MemberRole }> = [];
    for (const [pid, m] of Object.entries(this.read().projects)) if (m[user.username]) out.push({ projectId: pid, role: m[user.username] });
    return out;
  }

  /** Best role in any project of this instance ('' = none). */
  instanceRole(user: WorkflowUser, instanceId: string): MemberRole | '' {
    let best: MemberRole | '' = '';
    for (const { projectId, role } of this.projectsOf(user)) {
      if (this.projectInstance(projectId) !== instanceId) continue;
      if (role === 'editor') return 'editor';
      best = 'viewer';
    }
    return best;
  }

  /** May the user create a workflow in this scope? */
  canCreate(user: WorkflowUser | null, scope: WorkflowScope, scopeId: string): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    switch (scope) {
      case 'global': return false;
      case 'project': return this.projectRole(user, scopeId) === 'editor';
      case 'instance': return this.instanceRole(user, scopeId) === 'editor';
      case 'personal': return scopeId === user.username;
    }
  }

  canView(user: WorkflowUser | null, wf: Pick<Workflow, 'scope' | 'scopeId'>): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    switch (wf.scope) {
      case 'global': return true;
      case 'project': return this.projectRole(user, wf.scopeId) !== '';
      case 'instance': return this.instanceRole(user, wf.scopeId) !== '';
      case 'personal': return wf.scopeId === user.username;
    }
  }

  canEdit(user: WorkflowUser | null, wf: Pick<Workflow, 'scope' | 'scopeId'>): boolean {
    return this.canCreate(user, wf.scope, wf.scopeId);
  }
}
