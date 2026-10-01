/**
 * A register frame must find the sidecar entry the operator re-pointed to a
 * different address (LAN → Tailscale), or it duplicates the host on every boot.
 */
import { sameHostname } from '../sidecars/soundsuiteMaster.js';

describe('sameHostname', () => {
  it('ignores .local and case', () => {
    expect(sameHostname('Alpers-Mac-mini.local', 'Alpers-Mac-mini')).toBe(true);
    expect(sameHostname('alpers-mac-mini', 'Alpers-Mac-mini.local')).toBe(true);
  });
  it('accepts an operator suffix on the registered name', () => {
    expect(sameHostname('BASWS41-gpu01', 'BASWS41')).toBe(true);
    expect(sameHostname('BASWS41 (gpu-01)', 'BASWS41')).toBe(true);
    expect(sameHostname('BASWS41(gpu)', 'BASWS41')).toBe(true);
  });
  it('does not match a different host or a prefix collision', () => {
    expect(sameHostname('BASWS41-gpu01', 'BASWS4')).toBe(false);
    expect(sameHostname('BASWS34-gpu02', 'BASWS41')).toBe(false);
    expect(sameHostname('', 'BASWS41')).toBe(false);
  });
});
