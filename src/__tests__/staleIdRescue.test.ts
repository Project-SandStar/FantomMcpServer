import { describe, it, expect } from '@jest/globals';
import { matchStaleRow } from '../embedding/semanticSearchService.js';

const n = (id: string, qualifiedName: string, filePath: string, lineStart: number) => ({ id, qualifiedName, filePath, lineStart });

describe('matchStaleRow (stale vector id → graph node)', () => {
  const nodes = [
    n('g1', 'asn1::Asn', '/a/Asn.fan', 14),
    n('g2', 'asn1::Asn.make', '/a/Asn.fan', 30),
    n('g3', 'asn1::Asn.make', '/a/Asn.fan', 80),
    n('g4', 'asn1::Asn', '/b/Asn.fan', 14),
  ];
  it('matches on qualified name and file', () => {
    expect(matchStaleRow({ qualifiedName: 'asn1::Asn', filePath: '/a/Asn.fan', lineStart: 14 }, nodes)?.id).toBe('g1');
    expect(matchStaleRow({ qualifiedName: 'asn1::Asn', filePath: '/b/Asn.fan' }, nodes)?.id).toBe('g4');
  });
  it('picks the overload nearest the row line', () => {
    expect(matchStaleRow({ qualifiedName: 'asn1::Asn.make', filePath: '/a/Asn.fan', lineStart: 75 }, nodes)?.id).toBe('g3');
    expect(matchStaleRow({ qualifiedName: 'asn1::Asn.make', filePath: '/a/Asn.fan', lineStart: 31 }, nodes)?.id).toBe('g2');
  });
  it('no match when the file differs or the name is gone', () => {
    expect(matchStaleRow({ qualifiedName: 'asn1::Asn', filePath: '/c/Asn.fan' }, nodes)).toBeUndefined();
    expect(matchStaleRow({ qualifiedName: 'asn1::Gone', filePath: '/a/Asn.fan' }, nodes)).toBeUndefined();
  });
});

import { forEachBounded } from '../embedding/semanticSearchService.js';
describe('forEachBounded', () => {
  it('visits every item, never more than `limit` at once', async () => {
    let live = 0, peak = 0; const seen: number[] = [];
    await forEachBounded([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 5));
      seen.push(n); live--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });
  it('empty list is fine', async () => { await forEachBounded([], 4, async () => { throw new Error('no'); }); });
});
