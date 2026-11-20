/**
 * Dashboard Memory Usage card: RSS measured against the RSS guard, with the
 * container limit / RAM as the basis when the guard is off.
 */
import { memoryUsageView, resolveRssGuard } from '../utils/rssGuard.js';

describe('memoryUsageView', () => {
  it('measures RSS against the guard', () => {
    const v = memoryUsageView(7987, { mb: 15053, source: 'container' }, 16726, 65536);
    expect(v.basis).toBe('guard');
    expect(v.basisMb).toBe(15053);
    expect(v.percentage).toBe(53.1);
    expect(v.level).toBe('ok');
    expect(v.guardSource).toBe('container');
  });

  it('warns at 85% and is danger at 95% of the guard', () => {
    const g = { mb: 10000, source: 'env' as const };
    expect(memoryUsageView(8499, g, null, 65536).level).toBe('ok');
    expect(memoryUsageView(8500, g, null, 65536).level).toBe('warn');
    expect(memoryUsageView(9499, g, null, 65536).level).toBe('warn');
    expect(memoryUsageView(9500, g, null, 65536).level).toBe('danger');
    expect(memoryUsageView(12000, g, null, 65536).percentage).toBe(120);
  });

  it('uses the container limit when the guard is disabled', () => {
    const v = memoryUsageView(8000, { mb: 0, source: 'config' }, 16000, 65536);
    expect(v.basis).toBe('container');
    expect(v.basisMb).toBe(16000);
    expect(v.percentage).toBe(50);
    expect(v.guardMb).toBe(0);
  });

  it('falls back to total RAM with the guard off and no container', () => {
    const v = memoryUsageView(16384, { mb: 0, source: 'env' }, null, 65536);
    expect(v.basis).toBe('ram');
    expect(v.percentage).toBe(25);
    expect(v.level).toBe('ok');
  });
});

describe('resolveRssGuard source', () => {
  const saved = process.env.FANTOM_RSS_GUARD_MB;
  afterEach(() => {
    if (saved === undefined) delete process.env.FANTOM_RSS_GUARD_MB;
    else process.env.FANTOM_RSS_GUARD_MB = saved;
  });

  it('reports env as the source, including 0 (disabled)', () => {
    process.env.FANTOM_RSS_GUARD_MB = '12000';
    expect(resolveRssGuard()).toEqual({ mb: 12000, source: 'env' });
    process.env.FANTOM_RSS_GUARD_MB = '0';
    expect(resolveRssGuard()).toEqual({ mb: 0, source: 'env' });
  });
});
