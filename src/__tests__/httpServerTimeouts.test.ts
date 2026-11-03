import { describe, it, expect } from '@jest/globals';
import { createServer } from 'http';
import { applyHttpServerTimeouts, DEFAULT_KEEPALIVE_MS } from '../utils/httpServerTimeouts.js';

describe('applyHttpServerTimeouts', () => {
  it('keeps idle sockets longer than the proxy (Caddy: 2 min) and headersTimeout above it', () => {
    const s = createServer();
    const r = applyHttpServerTimeouts(s, {});
    expect(r.keepAliveTimeout).toBe(DEFAULT_KEEPALIVE_MS);
    expect(DEFAULT_KEEPALIVE_MS).toBeGreaterThan(120_000);
    expect(r.headersTimeout).toBeGreaterThan(r.keepAliveTimeout);
  });
  it('honours FANTOM_HTTP_KEEPALIVE_MS', () => {
    const s = createServer();
    expect(applyHttpServerTimeouts(s, { FANTOM_HTTP_KEEPALIVE_MS: '200000' }).keepAliveTimeout).toBe(200_000);
  });
});
