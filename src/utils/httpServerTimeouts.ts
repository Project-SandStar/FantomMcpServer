import type { Server } from 'http';

/**
 * Keep idle HTTP sockets open longer than the reverse proxy does.
 *
 * Node closes an idle keep-alive socket after 5 s by default. Caddy keeps idle
 * upstream sockets for 2 min and reuses them. When Node closes a socket that
 * Caddy has just written a request to, Caddy reads "connection reset by peer"
 * and answers 502 with an EMPTY body; the dashboard then failed with
 * "Unexpected end of JSON input" (2026-11-03, POST /admin/vectors/search).
 * A blocked event loop makes it worse: the 5 s timer fires late, after Caddy
 * has already sent the next request, and every such socket resets at once.
 *
 * With Node's timeout above the proxy's, the proxy always closes first.
 * `FANTOM_HTTP_KEEPALIVE_MS` overrides the value.
 */
export const DEFAULT_KEEPALIVE_MS = 125_000;

export function applyHttpServerTimeouts(server: Server, env: NodeJS.ProcessEnv = process.env): { keepAliveTimeout: number; headersTimeout: number } {
  const v = Number(env.FANTOM_HTTP_KEEPALIVE_MS);
  const keepAlive = Number.isFinite(v) && v >= 1_000 ? v : DEFAULT_KEEPALIVE_MS;
  server.keepAliveTimeout = keepAlive;
  // Node requires headersTimeout > keepAliveTimeout, or a reused socket can
  // time out while it waits for the next request's headers.
  server.headersTimeout = Math.max(server.headersTimeout ?? 0, keepAlive + 5_000);
  return { keepAliveTimeout: server.keepAliveTimeout, headersTimeout: server.headersTimeout };
}
