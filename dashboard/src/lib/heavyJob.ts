/**
 * GET /admin/heavy-job (lazy-incremental-indexing.md 3.12 item 6): the job
 * that holds the heavy-job lock, for the banner and disabled buttons. Kept
 * out of api.ts so that file stays easy to merge.
 */
import { useQuery } from '@tanstack/react-query';
import { getApiBase } from './api';

export interface HeavyJobStatus {
  active: boolean;
  holder: { kind: string; label: string; since: string } | null;
  progress: {
    page?: string; jobId?: string; projectsDone?: number; projectsTotal?: number;
    itemsDone?: number; itemsTotal?: number; itemsLabel?: string; providers?: string[];
    startedAt?: string; currentProject?: string;
  } | null;
  message: string | null;
  etaMin: number | null;
  shadowRebuild: boolean;
}

async function call<T>(endpoint: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const user = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const pass = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const r = await fetch(`${getApiBase()}/admin${endpoint}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${user}:${pass}`) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j?.error === 'string' ? j.error : `HTTP ${r.status}`);
  return j as T;
}

export const getHeavyJob = () => call<HeavyJobStatus>('/heavy-job');
export const cancelHeavyJob = () => call<{ success: boolean }>('/heavy-job/cancel', 'POST');

export function useHeavyJob() {
  return useQuery({ queryKey: ['heavy-job'], queryFn: getHeavyJob, refetchInterval: 5000, retry: false });
}
