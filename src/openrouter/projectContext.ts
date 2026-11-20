/**
 * Which project the current async context is embedding for, so the worker
 * pool can round-robin bulk requests between projects in flight.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const projectCtx = new AsyncLocalStorage<number>();

export function runWithOpenRouterProject<T>(projectId: number, fn: () => T): T {
  return projectCtx.run(projectId, fn);
}

export function currentOpenRouterProject(): number | undefined {
  return projectCtx.getStore();
}
