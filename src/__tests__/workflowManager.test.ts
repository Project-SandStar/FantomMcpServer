/**
 * Dashboard edits go through WorkflowManager.saveWorkflow / deleteWorkflow.
 * They must write the file, reload the in-memory list at once and notify
 * listeners (the MCP server sends resources/list_changed from that), and must
 * never let an id escape the workflows directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowManager, isValidWorkflowId } from '../workflows/workflowManager.js';

describe('WorkflowManager edits', () => {
  let dir: string;
  let wm: WorkflowManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
    fs.writeFileSync(path.join(dir, 'alpha.md'), '# Alpha\n\nFirst one.\n');
    wm = new WorkflowManager(dir);
    wm.loadWorkflows();
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('saves an existing workflow, reloads and notifies', () => {
    let calls = 0;
    wm.onChange(() => { calls++; });
    const w = wm.saveWorkflow('alpha', '# Alpha v2\n\nBetter.', true);
    expect(w.metadata.title).toBe('Alpha v2');
    expect(w.metadata.description).toBe('Better.');
    expect(fs.readFileSync(path.join(dir, 'alpha.md'), 'utf-8')).toBe('# Alpha v2\n\nBetter.\n');
    expect(calls).toBe(1);
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates and deletes', () => {
    wm.saveWorkflow('beta', '# Beta\n\nNew.\n', false);
    expect(wm.getWorkflowCount()).toBe(2);
    expect(() => wm.saveWorkflow('beta', '# x', false)).toThrow(/already exists/);
    expect(wm.deleteWorkflow('beta')).toBe(true);
    expect(wm.hasWorkflow('beta')).toBe(false);
    expect(wm.deleteWorkflow('beta')).toBe(false);
  });

  it('refuses ids that are not a plain slug', () => {
    expect(() => wm.saveWorkflow('missing', '# x', true)).toThrow(/not found/);
    for (const bad of ['../etc', 'a/b', '.hidden', '', 'a.md']) {
      expect(isValidWorkflowId(bad)).toBe(false);
      expect(() => wm.saveWorkflow(bad, '# x', false)).toThrow(/Invalid workflow id/);
    }
  });
});
