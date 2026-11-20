'use client';

/**
 * Workers card on the OpenRouter page: the worker pool and write buffer
 * settings (saved with the page's main Save) plus live pool, write and parse
 * stats from the /openrouter/activity poll.
 *
 * The inputs are seeded from the config query only, never from the poll, so
 * the poll cannot overwrite what the user is typing.
 */

import type {
  OpenRouterConfigResponse, OpenRouterActivityResponse, OpenRouterPoolStats,
  VectorWriteStats, OpenRouterParseStats, SettingRange,
} from '@/lib/api';

/** Not in `poolLimits`; same ranges as src/embedding/vectorWriteSettings.ts. */
const WRITE_LIMITS: Record<'maxPendingRows' | 'writeBatchRows', SettingRange> = {
  maxPendingRows: { min: 100, max: 20000, def: 2000 },
  writeBatchRows: { min: 100, max: 5000, def: 1000 },
};

export type WorkersField = 'workerCount' | 'interactiveSlots' | 'maxPendingRows' | 'writeBatchRows';
export type WorkersDraft = Record<WorkersField, string>;

function storedValues(data: OpenRouterConfigResponse): Record<WorkersField, number | undefined> {
  return {
    workerCount: data.pool?.settings.workerCount,
    interactiveSlots: data.pool?.settings.interactiveSlots,
    maxPendingRows: data.writeStats?.maxPendingRows,
    writeBatchRows: data.writeStats?.writeBatchRows,
  };
}

function rangeOf(data: OpenRouterConfigResponse, f: WorkersField): SettingRange {
  if (f === 'workerCount') return data.poolLimits?.workerCount ?? { min: 1, max: 8, def: 6 };
  if (f === 'interactiveSlots') return data.poolLimits?.interactiveSlots ?? { min: 1, max: 8, def: 2 };
  return WRITE_LIMITS[f];
}

export function workersDraftFrom(data: OpenRouterConfigResponse): WorkersDraft {
  const v = storedValues(data);
  return {
    workerCount: v.workerCount !== undefined ? String(v.workerCount) : '',
    interactiveSlots: v.interactiveSlots !== undefined ? String(v.interactiveSlots) : '',
    maxPendingRows: v.maxPendingRows !== undefined ? String(v.maxPendingRows) : '',
    writeBatchRows: v.writeBatchRows !== undefined ? String(v.writeBatchRows) : '',
  };
}

/** Only fields that changed and are valid. A blank field is never sent. */
export function workersPatch(draft: WorkersDraft | null, data: OpenRouterConfigResponse | undefined): Partial<Record<WorkersField, number>> {
  if (!draft || !data) return {};
  const stored = storedValues(data);
  const out: Partial<Record<WorkersField, number>> = {};
  for (const f of Object.keys(draft) as WorkersField[]) {
    if (draft[f].trim() === '') continue;
    const n = Number(draft[f]);
    const r = rangeOf(data, f);
    if (!Number.isInteger(n) || n < r.min || n > r.max) continue;
    if (n !== stored[f]) out[f] = n;
  }
  return out;
}

function invalid(draft: WorkersDraft, data: OpenRouterConfigResponse, f: WorkersField): boolean {
  if (draft[f].trim() === '') return false;
  const n = Number(draft[f]);
  const r = rangeOf(data, f);
  return !Number.isInteger(n) || n < r.min || n > r.max;
}

const FIELDS: Array<{ f: WorkersField; label: string; help?: string }> = [
  {
    f: 'workerCount', label: 'Workers',
    help: 'One worker = one bulk OpenRouter request in flight. Searches and asks use their own lane and never wait.',
  },
  { f: 'interactiveSlots', label: 'Search and ask slots' },
  { f: 'maxPendingRows', label: 'Max buffered rows per table' },
  { f: 'writeBatchRows', label: 'Rows per write' },
];

export function OpenRouterWorkersCard({
  data, live, draft, setDraft,
}: {
  data: OpenRouterConfigResponse;
  live: OpenRouterActivityResponse | undefined;
  draft: WorkersDraft;
  setDraft: (d: WorkersDraft) => void;
}) {
  const pool: OpenRouterPoolStats | undefined = live?.pool ?? data.pool;
  const write: VectorWriteStats | null = live?.writeStats ?? data.writeStats ?? null;
  const parse: OpenRouterParseStats | undefined = live?.parse;
  const dirty = Object.keys(workersPatch(draft, data)).length > 0;

  return (
    <section>
      <h3 className="text-lg font-semibold text-gray-900 mb-3">Workers</h3>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {FIELDS.map(({ f, label, help }) => {
          const r = rangeOf(data, f);
          const bad = invalid(draft, data, f);
          return (
            <div key={f} className={help ? 'md:col-span-4' : ''}>
              <label className="block text-xs text-gray-600 mb-1">{label} ({r.min}–{r.max})</label>
              <input
                type="number"
                min={r.min}
                max={r.max}
                step={1}
                value={draft[f]}
                onChange={(e) => setDraft({ ...draft, [f]: e.target.value })}
                placeholder={`default ${r.def}`}
                className={`w-full ${help ? 'md:w-40' : ''} px-2 py-1.5 border rounded-md text-sm ${bad ? 'border-red-400' : 'border-gray-300'}`}
              />
              {help && <p className="text-xs text-gray-500 mt-1">{help}</p>}
              {bad && <p className="text-xs text-red-600 mt-1">Must be a whole number from {r.min} to {r.max}.</p>}
            </div>
          );
        })}
      </div>
      {dirty && <p className="text-xs text-blue-700 mt-2">Unsaved. Press Save Settings.</p>}

      {pool && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <MiniStat
              label="Bulk"
              value={`${pool.bulk.running}/${pool.bulk.limit} running`}
              sub={`${pool.bulk.queued} queued · ${pool.bulk.projects} project(s)`}
            />
            <MiniStat
              label="Search and ask"
              value={`${pool.interactive.running}/${pool.interactive.limit} running`}
              sub={`${pool.interactive.queued} queued`}
            />
            <MiniStat
              label="Rate limit (429)"
              value={`${pool.rateLimit.hits} hits · ${pool.rateLimit.state}`}
              sub={`limit ${pool.rateLimit.adaptiveLimit}${pool.rateLimit.coolingDownMs > 0 ? ` · cooling ${Math.ceil(pool.rateLimit.coolingDownMs / 1000)}s` : ''}`}
              warn={pool.rateLimit.state === 'backing-off'}
            />
            <MiniStat
              label="Event loop lag"
              value={`p95 ${Math.round(pool.lag.p95Ms)} ms`}
              sub={`max ${Math.round(pool.lag.maxMs)} ms · lag limit ${pool.lag.lagLimit}`}
              warn={pool.lag.stepsDown > 0}
            />
          </div>

          {Object.keys(pool.byRole).length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left font-medium py-1">Role</th>
                  <th className="text-right font-medium py-1">Running</th>
                  <th className="text-right font-medium py-1">Queued</th>
                  <th className="text-right font-medium py-1">Done</th>
                  <th className="text-right font-medium py-1">Failed</th>
                  <th className="text-right font-medium py-1">429</th>
                  <th className="text-right font-medium py-1">Mean time</th>
                  <th className="text-right font-medium py-1">Mean wait</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pool.byRole).map(([role, s]) => (
                  <tr key={role} className="border-t border-gray-100">
                    <td className="py-1 text-gray-800">{role}</td>
                    <td className="py-1 text-right">{s.running}</td>
                    <td className="py-1 text-right">{s.queued}</td>
                    <td className="py-1 text-right">{s.done}</td>
                    <td className={`py-1 text-right ${s.failed > 0 ? 'text-red-600' : ''}`}>{s.failed}</td>
                    <td className="py-1 text-right">{s.rateLimited}</td>
                    <td className="py-1 text-right">{Math.round(s.meanMs)} ms</td>
                    <td className="py-1 text-right">{Math.round(s.meanWaitMs)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {write && write.tables.length > 0 && (
        <table className="w-full text-xs mt-4">
          <thead className="text-gray-500">
            <tr>
              <th className="text-left font-medium py-1">Write buffer</th>
              <th className="text-right font-medium py-1">Buffered</th>
              <th className="text-right font-medium py-1">Last write</th>
              <th className="text-right font-medium py-1">Mean write</th>
              <th className="text-right font-medium py-1">Rows/s</th>
              <th className="text-right font-medium py-1">Producer wait</th>
            </tr>
          </thead>
          <tbody>
            {write.tables.map(t => (
              <tr key={t.table} className="border-t border-gray-100">
                <td className="py-1 text-gray-800 font-mono">{t.table}</td>
                <td className={`py-1 text-right ${t.bufferRows >= write.maxPendingRows ? 'text-amber-700' : ''}`}>
                  {t.bufferRows}/{write.maxPendingRows}
                </td>
                <td className="py-1 text-right">{Math.round(t.lastCommitMs)} ms</td>
                <td className="py-1 text-right">{Math.round(t.meanCommitMs)} ms</td>
                <td className="py-1 text-right">{Math.round(t.rowsPerSec)}</td>
                <td className="py-1 text-right">{Math.round(t.producerWaitMs)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {parse && (
        <p className="text-xs text-gray-500 mt-2">
          Reply parsing: {parse.inline} inline · {parse.offThread} off-thread
          {parse.fallbacks > 0 ? ` · ${parse.fallbacks} fallbacks` : ''} · {parse.mb} MB
        </p>
      )}
    </section>
  );
}

function MiniStat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`border rounded-md p-2 ${warn ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
      <div className="text-gray-500">{label}</div>
      <div className="font-medium text-gray-900">{value}</div>
      {sub && <div className="text-gray-500">{sub}</div>}
    </div>
  );
}
