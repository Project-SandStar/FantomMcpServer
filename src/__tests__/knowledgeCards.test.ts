import { describe, it, expect } from '@jest/globals';
import { sanitizeCardSettings, validateCardInput } from '../knowledge/cardSettings.js';
import { claimAllowed, podOf } from '../knowledge/cardFacts.js';
import { parseJsonReply, estimateCost, renderCardText } from '../knowledge/cardBuilder.js';

describe('knowledge card settings', () => {
  it('defaults are off and safe', () => {
    const s = sanitizeCardSettings({});
    expect(s.enabled).toBe(false);
    expect(s.useForAsks).toBe(false);
    expect(s.checkPass).toBe(true);
    expect(s.minConfidence).toBe(0.8);
    expect(s.writerModel).toBe('qwen/qwen3.7-flash');
    expect(s.checkerModel).toBe('deepseek/deepseek-v4-flash');
  });
  it('clamps out-of-range values and rejects bad model ids', () => {
    const s = sanitizeCardSettings({ minConfidence: 7, concurrency: 99, writerModel: 'bad id' });
    expect(s.minConfidence).toBe(1);
    expect(s.concurrency).toBe(8);
    expect(s.writerModel).toBe('qwen/qwen3.7-flash');
  });
  it('validation names each bad field', () => {
    const p = validateCardInput({ minConfidence: 2, concurrency: 1.5, writerModel: 'x', projectScope: 'some' });
    expect(p.length).toBe(4);
    expect(validateCardInput({ minConfidence: 0.9, writerModel: 'z-ai/glm-5.3-flash' })).toEqual([]);
    expect(validateCardInput({ writerModel: 'z-ai/glm-5.3-flash:batch' }).length).toBe(1);
  });
});

describe('claim sources', () => {
  const allowed = new Map<string, Array<[number, number]>>([['/src/a/fan/Foo.fan', [[10, 40]]]]);
  it('keeps claims inside the supplied ranges (±2)', () => {
    expect(claimAllowed(allowed, '/src/a/fan/Foo.fan', 12)).toBe(true);
    expect(claimAllowed(allowed, '/src/a/fan/Foo.fan', 42)).toBe(true);
    expect(claimAllowed(allowed, 'fan/Foo.fan', 20)).toBe(true);
  });
  it('cuts claims outside them or in other files', () => {
    expect(claimAllowed(allowed, '/src/a/fan/Foo.fan', 80)).toBe(false);
    expect(claimAllowed(allowed, '/src/a/fan/Bar.fan', 20)).toBe(false);
  });
  it('podOf finds the folder holding fan/', () => {
    expect(podOf('/x/src/hxConn/fan/ConnPoint.fan')).toBe('hxConn');
    expect(podOf('/x/lib/thing.ts')).toBe('lib');
  });
});

describe('builder helpers', () => {
  it('parses JSON out of fenced or chatty replies', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Sure: {"b":2} done')).toEqual({ b: 2 });
    expect(parseJsonReply('no json')).toBeNull();
  });
  it('estimates cost from prices', () => {
    const s = sanitizeCardSettings({});
    const usd = estimateCost(100, s, { 'qwen/qwen3.7-flash': { in: 0.03, out: 0.13 }, 'deepseek/deepseek-v4-flash': { in: 0.09, out: 0.18 } });
    expect(usd).toBeGreaterThan(0.01);
    expect(usd).toBeLessThan(0.2);
  });
  it('renders card text with sources', () => {
    const t = renderCardText(
      { nodeId: 'n', kind: 'function', name: 'f', qualifiedName: 'A.f', filePath: 'a.fan', lineStart: 3, lineEnd: 9, fanIn: 0 },
      { summary: 'Does f.', claims: [{ text: 'Calls g', file: 'a.fan', line: 5 }], dropped: 0, costUsd: 0 },
    );
    expect(t).toContain('A.f (a.fan:3)');
    expect(t).toContain('- Calls g [a.fan:5]');
  });
});
