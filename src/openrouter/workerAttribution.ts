/**
 * Which OpenRouter pool worker served an embed call.
 *
 * Direct-path rows are credited per bulk pool slot, `worker1` … `workerN`
 * (N = the live Workers setting), not to one provider name. The direct
 * provider tags each vector array it returns; the attribution hooks read the
 * tag back. No key or request detail is kept, only slot → text count.
 */

/** Attribution name for a bulk pool slot (1-based). */
export function workerName(slot: number): string { return `worker${slot}`; }

const splits = new WeakMap<object, Record<string, number>>();

/** Tag a vector array with the worker split that produced it. */
export function tagWorkerSplit(vectors: object, split: Record<string, number>): void {
  splits.set(vectors, split);
}

/** The worker split for a vector array, or undefined when it has none. */
export function workerSplitOf(vectors: unknown): Record<string, number> | undefined {
  return vectors && typeof vectors === 'object' ? splits.get(vectors) : undefined;
}

/**
 * Names to credit for `count` texts served by `provider`: the worker split
 * when the vectors carry one, else the provider's own name.
 */
export function servedAttribution(provider: unknown, count: number, vectors?: unknown): Array<[string, number]> {
  const split = workerSplitOf(vectors);
  if (split) return Object.entries(split);
  const name = (provider as { getSidecarName?: () => string } | null)?.getSidecarName?.() ?? 'in-process';
  return [[name, count]];
}
