/**
 * Live "thinking" feed for an ask.
 *
 * An ask is one POST that can run for two minutes; nobody watching a spinner
 * can tell whether the RLM is asking good questions or stuck. Each ask that
 * carries an `askId` publishes what it does — the plan, every tool question
 * it asks, what came back, the model's interim thoughts, stage changes — into
 * an in-memory log the dashboard polls (`GET /admin/vectors/ask/:id/events`).
 * The MCP path forwards the same lines as `notifications/progress` messages.
 *
 * In-memory on purpose: the feed is only meaningful while the ask runs and a
 * few minutes after; it is not history. Bounded per ask and swept by age.
 */
export interface AskEvent {
  seq: number;
  /** ms since the ask started */
  t: number;
  kind: 'stage' | 'plan' | 'round' | 'ask' | 'answer' | 'thought' | 'done' | 'error';
  text: string;
  /** Pairs an 'answer' with its 'ask'. */
  id?: string;
  detail?: string;
  items?: string[];
  ms?: number;
}

interface AskLog { startedAt: number; events: AskEvent[]; done: boolean; endedAt: number | null }

const logs = new Map<string, AskLog>();
const MAX_EVENTS = 400;
const KEEP_MS = 15 * 60_000;
const MAX_ASKS = 200;

function sweep(): void {
  const now = Date.now();
  for (const [id, l] of logs) {
    if ((l.endedAt ?? l.startedAt) + KEEP_MS < now) logs.delete(id);
  }
  if (logs.size > MAX_ASKS) {
    const oldest = [...logs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt).slice(0, logs.size - MAX_ASKS);
    for (const [id] of oldest) logs.delete(id);
  }
}

export function startAsk(askId: string): void {
  sweep();
  logs.set(askId, { startedAt: Date.now(), events: [], done: false, endedAt: null });
}

export function emitAskEvent(askId: string, e: Omit<AskEvent, 'seq' | 't'> & { t?: number }): void {
  const l = logs.get(askId);
  if (!l || l.done) return;
  if (l.events.length >= MAX_EVENTS) return;
  l.events.push({ ...e, seq: l.events.length + 1, t: e.t ?? Date.now() - l.startedAt });
}

export function endAsk(askId: string, error?: string): void {
  const l = logs.get(askId);
  if (!l) return;
  if (error) emitAskEvent(askId, { kind: 'error', text: error });
  l.done = true;
  l.endedAt = Date.now();
}

export function getAskEvents(askId: string, since = 0): { events: AskEvent[]; done: boolean; known: boolean } {
  const l = logs.get(askId);
  if (!l) return { events: [], done: true, known: false };
  return { events: l.events.filter(e => e.seq > since), done: l.done, known: true };
}
