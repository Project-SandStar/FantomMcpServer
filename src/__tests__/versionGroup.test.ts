/**
 * Version groups: key derivation from the six real instances plus the
 * instance-less Fantom SDK pods, the selector grammar, and numeric range
 * compare. Pure functions only — no Prisma.
 */
import {
  versionGroupForProject,
  parseVersionSelector,
  versionInSelector,
  compareVersions,
  sortGroups,
  normaliseSelectors,
} from '../projects/versionGroup.js';

describe('normaliseSelectors', () => {
  it('splits one string on , ; |', () => {
    expect(normaliseSelectors('haxall 4.0.6, skyspark 3.1.12 | fantom')).toEqual(['haxall 4.0.6', 'skyspark 3.1.12', 'fantom']);
  });
  it('accepts arrays and drops blanks', () => {
    expect(normaliseSelectors(['haxall/4.0.6', '', ' skyspark 3.1 '])).toEqual(['haxall/4.0.6', 'skyspark 3.1']);
    expect(normaliseSelectors(undefined)).toEqual([]);
  });
  it('keeps a range intact (the dash is not a separator)', () => {
    expect(normaliseSelectors('skyspark 3.1.1-3.1.12')).toEqual(['skyspark 3.1.1-3.1.12']);
  });
});

describe('versionGroupForProject', () => {
  it('uses the instance type and version', () => {
    const g = versionGroupForProject({ name: 'Haxall 4.0.6:core/hx', instance: { type: 'haxall', version: '4.0.6' } });
    expect(g).toEqual({ key: 'haxall/4.0.6', product: 'haxall', version: '4.0.6', line: '4.0', label: 'Haxall 4.0.6' });
  });

  it('reads the number out of a prefixed instance version ("skyspark-3.1.8")', () => {
    const g = versionGroupForProject({ name: 'x', instance: { type: 'skyspark', version: 'skyspark-3.1.8' } });
    expect(g.key).toBe('skyspark/3.1.8');
    expect(g.label).toBe('SkySpark 3.1.8');
  });

  it('groups Fantom SDK pods by the version in their name', () => {
    expect(versionGroupForProject({ name: 'fantom.1.0.83.sys' }).key).toBe('fantom/1.0.83');
    expect(versionGroupForProject({ name: 'fantom.1.0.78.compilerJs' }).label).toBe('Fantom 1.0.78');
  });

  it('falls back to the fantom-<ver> path segment', () => {
    const g = versionGroupForProject({ name: 'sys', path: '/Users/x/fantom/fantom-1.0.82/src/sys' });
    expect(g.key).toBe('fantom/1.0.82');
  });

  it('is "other" when nothing identifies a product', () => {
    expect(versionGroupForProject({ name: 'SoundSuite', path: '/Users/x/Code/soundsuite' }).key).toBe('other');
  });

  it('groups by product alone when the instance version is unreadable', () => {
    const g = versionGroupForProject({ name: 'x', instance: { type: 'haxall', version: 'dev' } });
    expect(g).toMatchObject({ key: 'haxall', product: 'haxall', version: null });
  });
});

describe('parseVersionSelector', () => {
  it('exact', () => {
    expect(parseVersionSelector('haxall 4.0.6')).toMatchObject({ product: 'haxall', version: '4.0.6', line: null });
    expect(parseVersionSelector('haxall/4.0.6').version).toBe('4.0.6');
    expect(parseVersionSelector('Haxall  4.0.6 ').version).toBe('4.0.6');
  });
  it('line', () => {
    expect(parseVersionSelector('skyspark 3.1')).toMatchObject({ product: 'skyspark', line: '3.1', version: null });
    expect(parseVersionSelector('skyspark 3.1.x').line).toBe('3.1');
  });
  it('range', () => {
    expect(parseVersionSelector('skyspark 3.1.1-3.1.12')).toMatchObject({ from: '3.1.1', to: '3.1.12' });
    expect(parseVersionSelector('skyspark 3.1.1 - 3.1.12').to).toBe('3.1.12');
  });
  it('product only', () => {
    expect(parseVersionSelector('fantom')).toMatchObject({ product: 'fantom', version: null, line: null, from: null });
  });
  it('version only', () => {
    expect(parseVersionSelector('4.0.6')).toMatchObject({ product: null, version: '4.0.6' });
  });
  it('rejects junk and backwards ranges', () => {
    expect(() => parseVersionSelector('')).toThrow();
    expect(() => parseVersionSelector('latest')).toThrow(/cannot read/);
    expect(() => parseVersionSelector('skyspark 3.1.12-3.1.1')).toThrow(/backwards/);
  });
});

describe('versionInSelector', () => {
  const sky = (v: string) => versionGroupForProject({ name: 'x', instance: { type: 'skyspark', version: v } });
  const hax = (v: string) => versionGroupForProject({ name: 'x', instance: { type: 'haxall', version: v } });

  it('exact matches only that version', () => {
    const sel = parseVersionSelector('haxall 4.0.6');
    expect(versionInSelector(hax('4.0.6'), sel)).toBe(true);
    expect(versionInSelector(hax('4.0.4'), sel)).toBe(false);
    expect(versionInSelector(sky('4.0.6'), sel)).toBe(false);
  });
  it('line matches any patch', () => {
    const sel = parseVersionSelector('skyspark 3.1');
    expect(versionInSelector(sky('3.1.8'), sel)).toBe(true);
    expect(versionInSelector(sky('3.1.12'), sel)).toBe(true);
    expect(versionInSelector(sky('4.0.4'), sel)).toBe(false);
  });
  it('range is inclusive and numeric', () => {
    const sel = parseVersionSelector('skyspark 3.1.1-3.1.12');
    expect(versionInSelector(sky('3.1.1'), sel)).toBe(true);
    expect(versionInSelector(sky('3.1.9'), sel)).toBe(true);
    expect(versionInSelector(sky('3.1.12'), sel)).toBe(true);
    expect(versionInSelector(sky('3.1.13'), sel)).toBe(false);
    expect(versionInSelector(sky('3.0.30'), sel)).toBe(false);
  });
  it('"3.1.12" is not inside "3.1.1-3.1.9"', () => {
    expect(versionInSelector(sky('3.1.12'), parseVersionSelector('skyspark 3.1.1-3.1.9'))).toBe(false);
  });
  it('product only takes every version', () => {
    const sel = parseVersionSelector('fantom');
    expect(versionInSelector(versionGroupForProject({ name: 'fantom.1.0.78.sys' }), sel)).toBe(true);
    expect(versionInSelector(hax('4.0.6'), sel)).toBe(false);
  });
  it('"other" selects the ungrouped projects', () => {
    expect(versionInSelector(versionGroupForProject({ name: 'SoundSuite' }), parseVersionSelector('other'))).toBe(true);
  });
});

describe('compareVersions / sortGroups', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('3.10.0', '3.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.83', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('4.0.6', '4.0.6')).toBe(0);
  });
  it('orders SkySpark, Haxall, Fantom, Other; newest first inside a product', () => {
    const keys = sortGroups([
      versionGroupForProject({ name: 'fantom.1.0.78.sys' }),
      versionGroupForProject({ name: 'SoundSuite' }),
      versionGroupForProject({ name: 'x', instance: { type: 'haxall', version: '4.0.4' } }),
      versionGroupForProject({ name: 'fantom.1.0.83.sys' }),
      versionGroupForProject({ name: 'x', instance: { type: 'skyspark', version: '3.1.12' } }),
      versionGroupForProject({ name: 'x', instance: { type: 'haxall', version: '4.0.6' } }),
      versionGroupForProject({ name: 'x', instance: { type: 'skyspark', version: '4.0.4' } }),
    ]).map((g) => g.key);
    expect(keys).toEqual(['skyspark/4.0.4', 'skyspark/3.1.12', 'haxall/4.0.6', 'haxall/4.0.4', 'fantom/1.0.83', 'fantom/1.0.78', 'other']);
  });
});
