import { describe, it, expect } from '@jest/globals';
import { projectForClientPath } from '../admin/sessionContext.js';

const rows = [
  { id: 6, path: '/mirror/mac-alper/mcpfantom' },
  { id: 1, path: '/mirror/mac-alper/bassgCommon' },
  { id: 9, path: '/srv/local/proj' },
];

describe('projectForClientPath', () => {
  it('matches a server path directly', () => {
    expect(projectForClientPath(rows, '/srv/local/proj/src', '/mirror')?.project.id).toBe(9);
  });
  it('maps a Mac cwd onto the sidecar mirror', () => {
    const m = projectForClientPath(rows, '/Users/dev/Code/mcpfantom/claudePlugin', '/mirror');
    expect(m?.project.id).toBe(6);
    expect(m?.clientRoot).toBe('/Users/dev/Code/mcpfantom');
  });
  it('returns null for an unknown folder', () => {
    expect(projectForClientPath(rows, '/Users/dev/Code/other', '/mirror')).toBeNull();
  });
  it('refuses a tie across sidecars', () => {
    const two = [...rows, { id: 7, path: '/mirror/linux-bob/mcpfantom' }];
    expect(projectForClientPath(two, '/Users/dev/Code/mcpfantom', '/mirror')).toBeNull();
  });
});
