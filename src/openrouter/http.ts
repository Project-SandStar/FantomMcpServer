/**
 * One keep-alive HTTP agent for every OpenRouter call.
 *
 * undici's own `fetch` with its own `Agent` (never an npm Agent handed to the
 * global fetch: two undici copies do not share types). Keeping TLS
 * connections open saves a handshake (~100-300 ms) per call.
 */
import { Agent, fetch as undiciFetch } from 'undici';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_ALPHA_URL = 'https://openrouter.ai/api/alpha';

let agent: Agent | null = null;
let agentConnections = 0;

/** Connections = enough for every worker + the interactive lane + spare. */
export function openRouterAgent(connections = 16): Agent {
  if (!agent || connections > agentConnections) {
    const old = agent;
    agent = new Agent({
      connections,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 300_000,
      pipelining: 1,
      connect: { timeout: 15_000 },
    });
    agentConnections = connections;
    if (old) void old.close().catch(() => undefined);
  }
  return agent;
}

export interface OrResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type OrFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<OrResponse>;

/** Test seam: replace the transport. */
let fetchImpl: OrFetch | null = null;
export function __setOpenRouterFetchForTest(f: OrFetch | null): void { fetchImpl = f; }

export const orFetch: OrFetch = (url, init) => {
  if (fetchImpl) return fetchImpl(url, init);
  return undiciFetch(url, { ...init, dispatcher: openRouterAgent() }) as unknown as Promise<OrResponse>;
};
