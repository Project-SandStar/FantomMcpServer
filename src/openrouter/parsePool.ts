/**
 * Parse big embedding replies off the main thread.
 *
 * A 100-text reply at 4096d is ~8 MB of JSON. `JSON.parse` on that blocks the
 * event loop for tens of ms, and during a re-embed with 6 workers that adds up
 * to searches that stall. A small worker thread parses the bytes and sends
 * back one Float32Array per row, with the buffers transferred (no copy).
 *
 * The worker is built from an inline script (`eval: true`), so it loads the
 * same way under tsx, jest and the built image. Small replies, and any
 * environment where a worker cannot start, parse inline.
 */
import { Worker } from 'node:worker_threads';

export const INLINE_PARSE_MAX_BYTES = 256 * 1024;

export interface ParsedEmbeddings {
  vectors: Float32Array[];
  /** `index` order already applied. */
  model?: string;
  totalTokens?: number;
  cost?: number;
  /** Error text from the body, when it carried one instead of data. */
  error?: string;
}

/** Shared by the worker (as source) and the inline path. */
function parseEmbeddingsBody(text: string): ParsedEmbeddings {
  const json = JSON.parse(text) as {
    data?: Array<{ embedding: number[]; index: number }>;
    model?: string;
    usage?: { total_tokens?: number; cost?: number };
    error?: { message?: string } | string;
  };
  if (!Array.isArray(json.data)) {
    const e = json.error;
    return { vectors: [], error: typeof e === 'string' ? e : e?.message ?? 'reply has no data array' };
  }
  const rows = json.data.slice().sort((a, b) => a.index - b.index);
  return {
    vectors: rows.map(r => Float32Array.from(r.embedding)),
    model: json.model,
    totalTokens: json.usage?.total_tokens,
    cost: json.usage?.cost,
  };
}

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
${parseEmbeddingsBody.toString()}
parentPort.on('message', (m) => {
  try {
    const out = parseEmbeddingsBody(new TextDecoder().decode(m.bytes));
    parentPort.postMessage({ id: m.id, out }, out.vectors.map(v => v.buffer));
  } catch (err) {
    parentPort.postMessage({ id: m.id, err: String(err && err.message || err) });
  }
});
`;

interface Pending { resolve: (p: ParsedEmbeddings) => void; reject: (e: Error) => void }

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();
const stats = { inline: 0, offThread: 0, fallbacks: 0, bytes: 0 };

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    const w = new Worker(WORKER_SRC, { eval: true });
    w.unref();
    w.on('message', (m: { id: number; out?: ParsedEmbeddings; err?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.err) p.reject(new Error(m.err));
      else p.resolve(m.out!);
    });
    const fail = (err: unknown) => {
      worker = null;
      for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(`parse worker died: ${String((err as Error)?.message ?? err)}`)); }
    };
    w.on('error', fail);
    w.on('exit', code => { if (code !== 0) fail(new Error(`exit ${code}`)); worker = null; });
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Parse an embeddings reply. Bytes above the threshold go to the worker. */
export async function parseEmbeddings(bytes: ArrayBuffer, opts: { forceInline?: boolean } = {}): Promise<ParsedEmbeddings> {
  stats.bytes += bytes.byteLength;
  const w = !opts.forceInline && bytes.byteLength > INLINE_PARSE_MAX_BYTES ? getWorker() : null;
  if (!w) {
    stats.inline++;
    return parseEmbeddingsBody(new TextDecoder().decode(bytes));
  }
  const id = nextId++;
  try {
    const out = await new Promise<ParsedEmbeddings>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.ref();
      w.postMessage({ id, bytes }, [bytes]);
    });
    stats.offThread++;
    return out;
  } catch (err) {
    // The bytes were transferred, so they cannot be re-parsed here; the
    // caller retries the request. Only a dead worker gets here.
    stats.fallbacks++;
    throw err;
  } finally {
    if (pending.size === 0) worker?.unref();
  }
}

export function parsePoolStats(): { inline: number; offThread: number; fallbacks: number; mb: number } {
  return { inline: stats.inline, offThread: stats.offThread, fallbacks: stats.fallbacks, mb: Math.round(stats.bytes / 1e5) / 10 };
}

export async function __stopParseWorkerForTest(): Promise<void> {
  const w = worker;
  worker = null;
  workerBroken = false;
  if (w) await w.terminate();
}
