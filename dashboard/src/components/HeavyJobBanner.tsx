'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { cancelHeavyJob, useHeavyJob } from '../lib/heavyJob';

/** Banner on every page while a heavy job holds the fleet (3.12 item 6). */
export function HeavyJobBanner() {
  const { data } = useHeavyJob();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  if (!data?.active || !data.message) return null;
  const page = data.progress?.page;
  const canCancel = data.holder?.kind === 'axon-index';
  return (
    <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-sm px-4 py-2 flex items-center gap-3 flex-wrap">
      <span className="font-medium">{data.message}</span>
      {page && <Link href={page} className="underline">Open</Link>}
      {canCancel && (
        <button
          className="px-2 py-0.5 rounded border border-amber-400 hover:bg-amber-100"
          onClick={async () => {
            setErr(null);
            try { await cancelHeavyJob(); qc.invalidateQueries({ queryKey: ['heavy-job'] }); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
          }}
        >Cancel</button>
      )}
      {err && <span className="text-red-700">{err}</span>}
    </div>
  );
}
