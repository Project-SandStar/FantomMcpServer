import { describe, it, expect } from '@jest/globals';
import { lanceCacheBytes } from '../embedding/lanceConnection.js';

describe('lanceCacheBytes', () => {
  it('defaults to 1 GB index / 256 MB metadata', () => {
    expect(lanceCacheBytes({})).toEqual({ index: 4096n * 1048576n, metadata: 256n * 1048576n });
  });
  it('reads the env overrides; ignores bad values', () => {
    expect(lanceCacheBytes({ FANTOM_LANCE_INDEX_CACHE_MB: '512', FANTOM_LANCE_METADATA_CACHE_MB: 'x' }))
      .toEqual({ index: 512n * 1048576n, metadata: 256n * 1048576n });
  });
});
