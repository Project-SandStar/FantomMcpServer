import { describe, it, expect } from '@jest/globals';
import { mapPath, parsePathMappingsEnv, sanitizePathMappings } from '../utils/pathMapping.js';

const rows = [
  { from: '/home/user/skyspark', to: '/mirror/mac-user/skyspark' },
  { from: '/home/user', to: '/mirror/mac-user/home' },
];

describe('pathMapping', () => {
  it('maps the longest prefix at a folder boundary', () => {
    expect(mapPath('/home/user/skyspark/skyspark-3.1.12', rows)).toBe('/mirror/mac-user/skyspark/skyspark-3.1.12');
    expect(mapPath('/home/user/skyspark', rows)).toBe('/mirror/mac-user/skyspark');
    expect(mapPath('/home/user/skysparkX/a', rows)).toBe('/mirror/mac-user/home/skysparkX/a');
    expect(mapPath('/home/userX/a', rows)).toBe('/home/userX/a');
  });
  it('keeps null, empty and unmatched paths', () => {
    expect(mapPath(null, rows)).toBeNull();
    expect(mapPath('', rows)).toBe('');
    expect(mapPath('/opt/x', rows)).toBe('/opt/x');
  });
  it('parses env and drops bad rows', () => {
    expect(parsePathMappingsEnv('/a/=/b; /c=/d ;bad;=x')).toEqual([{ from: '/a', to: '/b' }, { from: '/c', to: '/d' }]);
    expect(sanitizePathMappings([{ from: '/a', to: '/a' }, { from: '', to: '/b' }, null])).toEqual([]);
  });
});
