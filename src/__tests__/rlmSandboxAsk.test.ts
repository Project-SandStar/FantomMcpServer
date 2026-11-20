/**
 * runSandboxAsk: one whole-question call to an ss-rlm-sandbox host. Every
 * failure must come back as { ok: false, reason } so the ask can report it.
 */

import { jest } from '@jest/globals';

const sc = { id: 'sc1', name: 'HOST-A', host: '10.0.0.1', protocol: 'http' };
let roleHosts: any[] = [];
let masterUrl: string | null = 'http://master:3848';

jest.unstable_mockModule('../sidecars/sidecarRoles.js', () => ({
  hostsForRole: jest.fn(async () => roleHosts),
}));
jest.unstable_mockModule('../sidecars/registry.js', () => ({
  listSidecars: jest.fn(() => [sc]),
}));
// canonicalMasterUrl is synchronous and lives in sandboxSlots.ts now.
jest.unstable_mockModule('../sidecars/sandboxSlots.js', () => ({
  canonicalMasterUrl: jest.fn(() => masterUrl ?? undefined),
}));

const { runSandboxAsk } = await import('../embedding/rlmSandbox.js');

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

function fetchWith(chat: (url: string, init: RequestInit) => Promise<Response>, healthy = true) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/health')) return healthy ? json(200, { status: 'ok', model: 'm' }) : json(503, { status: 'down' });
    return chat(url, init!);
  }) as unknown as typeof fetch;
}

const base = { question: 'who calls foo?', context: '[1] foo', deadlineMs: 30_000, askId: 'ask1', projectId: 11 };

beforeEach(() => {
  roleHosts = [{ sidecar: sc, hasRole: true }];
  masterUrl = 'http://master:3848';
});

it('no host with the role', async () => {
  roleHosts = [];
  const r = await runSandboxAsk({ ...base, fetchImpl: fetchWith(async () => json(200, {})) });
  expect(r).toMatchObject({ ok: false, reason: 'no sidecar runs the rlm-sandbox role' });
});

it('no healthy host', async () => {
  const r = await runSandboxAsk({ ...base, fetchImpl: fetchWith(async () => json(200, {}), false) });
  expect(r.ok).toBe(false);
  expect((r as { reason: string }).reason).toMatch(/^no healthy sandbox host \(HOST-A/);
});

it('HTTP 409 (identity rejected) is reported with its message', async () => {
  const r = await runSandboxAsk({ ...base, fetchImpl: fetchWith(async () => json(409, { error: { message: 'unknown master' } })) });
  expect(r).toMatchObject({ ok: false, reason: 'HTTP 409: unknown master', host: 'HOST-A' });
});

it('timeout is reported as a timeout', async () => {
  const fetchImpl = fetchWith(async (_u, init) => new Promise<Response>((_res, rej) => {
    init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  }));
  const r = await runSandboxAsk({ ...base, deadlineMs: 1_200, fetchImpl });
  expect(r).toMatchObject({ ok: false, host: 'HOST-A', timedOut: true });
  expect((r as { reason: string }).reason).toMatch(/^timed out after/);
});

it('success: sends identity headers and a non-streaming body, returns the text', async () => {
  let sent: RequestInit | undefined;
  const onHost = jest.fn();
  const r = await runSandboxAsk({
    ...base, onHost,
    fetchImpl: fetchWith(async (url, init) => {
      expect(url).toBe('http://10.0.0.1:8101/v1/chat/completions');
      sent = init;
      return json(200, { choices: [{ message: { content: ' the answer ' } }] });
    }),
  });
  expect(r).toMatchObject({ ok: true, text: 'the answer', host: 'HOST-A' });
  expect(onHost).toHaveBeenCalledWith('HOST-A');
  const h = sent!.headers as Record<string, string>;
  expect(h['X-SoundSuite-Master']).toBe('http://master:3848');
  expect(h['X-FantomMCP-Ask']).toBe('ask1');
  expect(JSON.parse(String(sent!.body)).stream).toBe(false);
});

it('no master URL known', async () => {
  masterUrl = null;
  const r = await runSandboxAsk({ ...base, fetchImpl: fetchWith(async () => json(200, {})) });
  expect(r).toMatchObject({ ok: false, reason: 'no master URL known to identify Fantom to the sandbox' });
});
