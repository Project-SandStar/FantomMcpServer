/**
 * Role-aware host selection: a host is asked for a role only when its own
 * status says it runs that role. Snapshot shapes: WS heartbeat (`roles` +
 * `containers` keyed by role), register frame (`containers` as `ss-<role>`
 * names), HTTP `/api/status` (same as heartbeat).
 */
import { rolesFromSnapshot } from '../sidecars/sidecarRoles.js';

describe('rolesFromSnapshot', () => {
  it('reads roles keys and running containers keyed by role', () => {
    const r = rolesFromSnapshot({
      roles: { ocr: {}, cuda: {} },
      containers: {
        ocr: { status: 'running' },
        cuda: { status: 'running' },
        'rlm-sandbox': { status: 'exited', exists: true },
      },
    });
    expect([...r].sort()).toEqual(['cuda', 'ocr']);
  });

  it('counts a role only when its container runs (roles map may lag)', () => {
    const r = rolesFromSnapshot({ containers: { 'rlm-sandbox': { status: 'running' } } });
    expect(r.has('rlm-sandbox')).toBe(true);
    expect(rolesFromSnapshot({ containers: { 'rlm-sandbox': { status: 'not_found', exists: false } } }).has('rlm-sandbox')).toBe(false);
  });

  it('reads the register frame form (container names)', () => {
    const r = rolesFromSnapshot({ containers: ['ss-cuda', 'ss-ocr'] });
    expect([...r].sort()).toEqual(['cuda', 'ocr']);
    expect(r.has('rlm-sandbox')).toBe(false);
  });

  it('is empty for junk', () => {
    expect(rolesFromSnapshot(null).size).toBe(0);
    expect(rolesFromSnapshot('html').size).toBe(0);
    expect(rolesFromSnapshot({}).size).toBe(0);
  });
});
