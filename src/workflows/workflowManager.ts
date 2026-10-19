/**
 * Workflow Manager for dynamic loading of markdown workflow resources
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Metadata extracted from a workflow file
 */
export interface WorkflowMetadata {
  id: string;
  title: string;
  description: string;
}

/**
 * Complete workflow including content and metadata
 */
export interface Workflow {
  uri: string;
  metadata: WorkflowMetadata;
  fullContent: string;
  /** File mtime (ms), so the dashboard can show when it last changed. */
  mtimeMs: number;
  sizeBytes: number;
}

/** Workflow ids become file names: keep them to a safe slug. */
const WORKFLOW_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

export function isValidWorkflowId(id: string): boolean {
  return WORKFLOW_ID_RE.test(id);
}

/**
 * Manages loading and accessing workflow markdown files
 */
export class WorkflowManager {
  private workflows: Map<string, Workflow> = new Map();
  private workflowDir: string;
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private onChangeListeners: Array<() => void> = [];

  constructor(workflowDir: string) {
    this.workflowDir = workflowDir;
  }

  /**
   * Load all .md files from the workflow directory
   */
  loadWorkflows(): void {
    this.workflows.clear();

    if (!fs.existsSync(this.workflowDir)) {
      console.error(`Workflow directory does not exist: ${this.workflowDir}`);
      return;
    }

    const files = fs.readdirSync(this.workflowDir);
    const mdFiles = files.filter(file => file.endsWith('.md'));

    for (const file of mdFiles) {
      try {
        const filePath = path.join(this.workflowDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);

        // Generate ID from filename (remove .md extension)
        const id = file.replace(/\.md$/, '');

        // Extract title from first heading (# Title)
        const title = this.extractTitle(content) || id;

        // Extract description from first paragraph after the title
        const description = this.extractDescription(content) || '';

        const workflow: Workflow = {
          uri: `workflow://${id}`,
          metadata: {
            id,
            title,
            description
          },
          fullContent: content,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
        };

        this.workflows.set(id, workflow);
      } catch (error) {
        console.error(`Failed to load workflow file ${file}:`, error);
      }
    }
  }

  /**
   * Extract the title from the first markdown heading
   */
  private extractTitle(content: string): string | null {
    // Match first heading (# Title or ## Title etc.)
    const headingMatch = content.match(/^#+\s+(.+)$/m);
    return headingMatch ? headingMatch[1].trim() : null;
  }

  /**
   * Extract description from the first paragraph after the title
   */
  private extractDescription(content: string): string | null {
    // Split content into lines
    const lines = content.split('\n');

    // Find the first non-empty, non-heading line after the title
    let foundHeading = false;
    let description = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines
      if (!trimmedLine) {
        // If we've started collecting description, stop at empty line
        if (description) {
          break;
        }
        continue;
      }

      // Skip the title heading
      if (!foundHeading && trimmedLine.startsWith('#')) {
        foundHeading = true;
        continue;
      }

      // Skip subsequent headings
      if (trimmedLine.startsWith('#')) {
        if (description) {
          break;
        }
        continue;
      }

      // Found a paragraph line
      if (foundHeading) {
        description += (description ? ' ' : '') + trimmedLine;
      }
    }

    return description || null;
  }

  /**
   * Get list of all loaded workflows
   */
  getWorkflowList(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  /**
   * Get a specific workflow by ID
   */
  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  /**
   * Get the number of loaded workflows
   */
  getWorkflowCount(): number {
    return this.workflows.size;
  }

  /**
   * Check if a workflow exists
   */
  hasWorkflow(id: string): boolean {
    return this.workflows.has(id);
  }

  /**
   * Reload all workflows from disk
   */
  reload(): void {
    this.loadWorkflows();
  }

  /**
   * Write a workflow file and reload at once, so MCP clients see the change
   * without waiting for the watcher. The write goes to a temp file first and
   * is renamed into place, so a reader never sees half a file.
   * `mustExist` true = update only, false = create only.
   */
  saveWorkflow(id: string, content: string, mustExist: boolean): Workflow {
    if (!isValidWorkflowId(id)) throw new Error(`Invalid workflow id "${id}" (letters, digits, - and _ only)`);
    const exists = this.workflows.has(id);
    if (mustExist && !exists) throw new Error(`Workflow "${id}" not found`);
    if (!mustExist && exists) throw new Error(`Workflow "${id}" already exists`);
    if (!fs.existsSync(this.workflowDir)) fs.mkdirSync(this.workflowDir, { recursive: true });
    const filePath = path.join(this.workflowDir, `${id}.md`);
    const tmpPath = path.join(this.workflowDir, `.${id}.md.${process.pid}.tmp`);
    fs.writeFileSync(tmpPath, content.endsWith('\n') ? content : content + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
    this.reload();
    this.notifyChange();
    return this.workflows.get(id)!;
  }

  /** Delete a workflow file and reload. Returns false when it did not exist. */
  deleteWorkflow(id: string): boolean {
    if (!isValidWorkflowId(id) || !this.workflows.has(id)) return false;
    fs.unlinkSync(path.join(this.workflowDir, `${id}.md`));
    this.reload();
    this.notifyChange();
    return true;
  }

  private notifyChange(): void {
    for (const l of this.onChangeListeners) {
      try { l(); } catch (err) { console.error('workflow onChange listener failed:', err); }
    }
  }

  /**
   * Subscribe to "workflows changed" events. Used by the MCP server to
   * emit a `notifications/resources/list_changed` message when an .md
   * file is added, removed, or edited on disk.
   */
  onChange(listener: () => void): () => void {
    this.onChangeListeners.push(listener);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(l => l !== listener);
    };
  }

  /**
   * Begin watching the workflow directory. Reloads when .md files are
   * added/removed/edited and notifies subscribers. Debounces noisy
   * editor save patterns (write-tmp + rename) with a 250ms idle window.
   * Safe to call multiple times — only the first call attaches a watcher.
   */
  startWatching(): void {
    if (this.watcher) return;
    if (!fs.existsSync(this.workflowDir)) {
      console.error(`Cannot watch missing workflow directory: ${this.workflowDir}`);
      return;
    }
    try {
      this.watcher = fs.watch(this.workflowDir, { persistent: false }, (_event, filename) => {
        // Only react to .md files. fs.watch fires for tmp/swap files too.
        if (!filename || !filename.endsWith('.md')) return;
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

  /**
   * Stop watching (server shutdown).
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }
}
