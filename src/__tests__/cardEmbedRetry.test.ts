import { describe, it, expect, jest } from '@jest/globals';
import { embedCardsWithRetry } from '../knowledge/cardBuilder.js';

const vec = () => [new Float32Array([1, 2, 3])];

describe('embedCardsWithRetry', () => {
  it('returns at once when the first call works', async () => {
    const sleep = jest.fn(async () => {});
    const enc = { embedBatch: jest.fn(async () => vec()) };
    const out = await embedCardsWithRetry(enc, ['a'], { sleep });
    expect(out).toHaveLength(1);
    expect(enc.embedBatch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a 504 timeout and a 429 quota error, then succeeds', async () => {
    const sleep = jest.fn(async (_ms: number) => {});
    const enc = {
      embedBatch: jest.fn<() => Promise<Float32Array[]>>()
        .mockRejectedValueOnce(new Error('OpenRouter /embeddings HTTP 504: Worker upstream fetch timed out after 60000ms'))
        .mockRejectedValueOnce(new Error('HTTP 429: You exceeded your tokens quota'))
        .mockResolvedValueOnce(vec()),
    };
    const out = await embedCardsWithRetry(enc, ['a'], { sleep });
    expect(out).toHaveLength(1);
    expect(enc.embedBatch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(c => c[0])).toEqual([30_000, 60_000]);
  });

  it('fails at once on a non-transient error', async () => {
    const sleep = jest.fn(async () => {});
    const enc = { embedBatch: jest.fn(async () => { throw new Error('HTTP 400: bad input'); }) };
    await expect(embedCardsWithRetry(enc, ['a'], { sleep })).rejects.toThrow('400');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the wait limit', async () => {
    const sleep = jest.fn(async (_ms: number) => {});
    const enc = { embedBatch: jest.fn(async () => { throw new Error('HTTP 503'); }) };
    await expect(embedCardsWithRetry(enc, ['a'], { sleep, maxWaitMs: 2 * 60_000 })).rejects.toThrow('503');
    // 30 s + 60 s fit in 2 min; the next wait (120 s) would pass it.
    expect(sleep.mock.calls.map(c => c[0])).toEqual([30_000, 60_000]);
  });

  it('stops waiting when a stop is requested', async () => {
    let stop = false;
    const sleep = jest.fn(async () => { stop = true; });
    const enc = { embedBatch: jest.fn(async () => { throw new Error('timed out'); }) };
    await expect(embedCardsWithRetry(enc, ['a'], { sleep, shouldStop: () => stop })).rejects.toThrow('timed out');
    expect(enc.embedBatch).toHaveBeenCalledTimes(1);
  });
});
