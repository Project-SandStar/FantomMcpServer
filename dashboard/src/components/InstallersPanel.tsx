'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, HaxallCheck, SkysparkCheck, InstallerJob } from '@/lib/api';

/** Live log of one installer job; polls until it ends. */
export function InstallerJobLog({ jobId, onDone }: { jobId: string; onDone?: (job: InstallerJob) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [job, setJob] = useState<InstallerJob | null>(null);
  const next = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    let stop = false;
    next.current = 0; // a new jobId remounts this component (key), so lines start empty
    const tick = async () => {
      try {
        const r = await api.getInstallerJob(jobId, next.current);
        if (stop) return;
        next.current = r.next;
        if (r.lines.length) setLines(prev => [...prev, ...r.lines].slice(-2000));
        setJob(r);
        if (r.status !== 'running') { doneRef.current?.(r); return; }
      } catch { /* retry */ }
      if (!stop) setTimeout(tick, 1500);
    };
    void tick();
    return () => { stop = true; };
  }, [jobId]);

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);

  const color = job?.status === 'failed' ? 'text-red-700' : job?.status === 'succeeded' ? 'text-green-700' : 'text-blue-700';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium">{job?.label ?? jobId}</span>
        <span className={color}>{job?.status ?? 'loading'}</span>
        {job?.status === 'running' && <span className="text-gray-500">{job.step}</span>}
        {job?.status === 'running' && (
          <button className="ml-auto text-red-600 hover:underline" onClick={() => api.cancelInstallerJob(jobId)}>Cancel</button>
        )}
      </div>
      {job?.error && <div className="text-sm text-red-700">{job.error}</div>}
      {job?.notes?.map((n, i) => <div key={i} className="text-sm text-amber-800 bg-amber-50 rounded px-2 py-1">{n}</div>)}
      <pre ref={box} className="bg-gray-900 text-gray-100 text-xs p-3 rounded h-64 overflow-auto whitespace-pre-wrap">{lines.join('\n')}</pre>
    </div>
  );
}

export type InstallerCheckRequest = { product: 'haxall' | 'skyspark'; n: number } | null;

/**
 * Results of "Check & add Haxall" / "Check & add SkySpark" plus the job log.
 * The check buttons live in the page header ("+ Add" menu); they pass `request`.
 * Renders nothing while there is nothing to show.
 */
export function InstallersPanel({ jobId, setJobId, request }: {
  jobId: string | null;
  setJobId: (id: string | null) => void;
  request?: InstallerCheckRequest;
}) {
  const qc = useQueryClient();
  const [haxall, setHaxall] = useState<HaxallCheck | null>(null);
  const [skyspark, setSkyspark] = useState<SkysparkCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = useQuery({ queryKey: ['installer-job-active'], queryFn: api.getActiveInstallerJob, refetchInterval: jobId ? false : 10000 });
  useEffect(() => {
    const a = active.data;
    if (a && 'id' in a && !jobId) setJobId(a.id);
  }, [active.data, jobId, setJobId]);

  const checkH = useMutation({ mutationFn: api.checkHaxall, onSuccess: d => { setHaxall(d); setError(null); }, onError: e => setError((e as Error).message) });
  const checkS = useMutation({ mutationFn: api.checkSkyspark, onSuccess: d => { setSkyspark(d); setError(null); }, onError: e => setError((e as Error).message) });
  const start = useMutation({
    mutationFn: ({ product, version }: { product: 'haxall' | 'skyspark'; version: string }) =>
      product === 'haxall' ? api.installHaxall(version) : api.installSkyspark(version),
    onSuccess: r => { setJobId(r.jobId); setError(null); },
    onError: e => setError((e as Error).message),
  });

  // Run a check when the header menu asks for one.
  const lastReq = useRef(0);
  useEffect(() => {
    if (!request || request.n === lastReq.current) return;
    lastReq.current = request.n;
    if (request.product === 'haxall') { setSkyspark(null); checkH.mutate(); }
    else { setHaxall(null); checkS.mutate(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const busy = !!jobId;
  const btn = 'px-3 py-1.5 text-sm rounded-md disabled:opacity-50 whitespace-nowrap';
  const checking = checkH.isPending || checkS.isPending;

  if (!checking && !error && !haxall && !skyspark && !jobId) return null;

  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-4 min-w-0">
      {checking && <div className="text-sm text-gray-600">Checking {checkH.isPending ? 'Haxall releases on GitHub' : 'SkySpark installers'}…</div>}
      {error && <div className="text-sm text-red-700 break-words">{error}</div>}

      {(haxall || skyspark) && (
        <div className="flex items-center">
          <span className="font-medium text-gray-900">{haxall ? `Haxall releases (from ${haxall.minVersion})` : `SkySpark installers (from ${skyspark!.minVersion})`}</span>
          <button className="ml-auto text-sm text-gray-500 hover:underline" onClick={() => { setHaxall(null); setSkyspark(null); }}>Close</button>
        </div>
      )}

      {haxall && (
        <div className="text-sm overflow-x-auto">
          <table className="w-full">
            <tbody>
              {haxall.releases.map(r => (
                <tr key={r.version} className="border-t">
                  <td className="py-1 font-mono">{r.version}</td>
                  <td className="text-gray-500">{r.publishedAt.slice(0, 10)}</td>
                  <td className="text-gray-500">Fantom {r.fantomVersion ?? '?'} <span className="text-xs">({r.fantomRule})</span></td>
                  <td>{r.instanceId ? <span className="text-green-700">instance {r.instanceId}{r.hasDocs ? ', docs' : ', no docs'}</span> : <span className="text-amber-700">missing</span>}</td>
                  <td className="text-right">
                    {!r.instanceId && (
                      <button className={`${btn} bg-green-600 text-white hover:bg-green-700`} disabled={busy || !r.fantomVersion}
                        onClick={() => start.mutate({ product: 'haxall', version: r.version })}>Build &amp; add</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {skyspark && (
        <div className="text-sm">
          <div className="max-h-64 overflow-auto">
            <table className="w-full">
              <tbody>
                {skyspark.installers.map(r => (
                  <tr key={r.version} className="border-t">
                    <td className="py-1 font-mono">{r.version}</td>
                    <td className="text-gray-500">{r.file.folder ? `${r.file.folder}/` : ''}{r.file.name}{r.file.size ? ` (${(r.file.size / 1048576).toFixed(0)} MB)` : ''}</td>
                    <td>{r.instanceId ? <span className="text-green-700">instance {r.instanceId}</span> : <span className="text-amber-700">missing</span>}</td>
                    <td className="text-right">
                      {!r.instanceId && (
                        <button className={`${btn} bg-green-600 text-white hover:bg-green-700`} disabled={busy}
                          onClick={() => start.mutate({ product: 'skyspark', version: r.version })}>Install &amp; add</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {skyspark.unrecognized.length > 0 && (
            <div className="text-gray-500 mt-1">Not recognized (no x.y.z in the name): {skyspark.unrecognized.join(', ')}</div>
          )}
        </div>
      )}

      {jobId && (
        <div>
          <InstallerJobLog key={jobId} jobId={jobId} onDone={() => { qc.invalidateQueries({ queryKey: ['instances'] }); }} />
          <button className="text-sm text-gray-500 hover:underline mt-1" onClick={() => setJobId(null)}>Close log</button>
        </div>
      )}
    </div>
  );
}
