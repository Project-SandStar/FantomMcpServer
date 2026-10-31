'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PathInput } from '@/components/ui/FolderPicker';

type Row = { from: string; to: string };

/** Host path prefix → path here. Applied to instance, build, pod and project paths when read. */
export function PathMappingsPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['path-mappings'], queryFn: api.getPathMappings });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (q.data && rows === null) setRows(q.data.saved.map(r => ({ from: r.from, to: r.to })));
  }, [q.data, rows]);

  const save = useMutation({
    mutationFn: (r: Row[]) => api.savePathMappings(r.filter(x => x.from.trim() && x.to.trim())),
    onSuccess: () => { setMsg('Saved.'); qc.invalidateQueries({ queryKey: ['path-mappings'] }); setRows(null); },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'Save failed'),
  });

  const exists = (to: string) => q.data?.saved.find(r => r.to === to)?.toExists;
  const input = 'flex-1 px-3 py-2 border border-gray-300 rounded-md font-mono text-sm';

  return (
    <div className="space-y-3 border-t pt-4 mt-4">
      <div>
        <h3 className="font-medium text-gray-800">Path mappings</h3>
        <p className="text-sm text-gray-600">
          Rewrite a stored path prefix to where the folder is here, for example
          <code className="bg-gray-100 px-1 mx-1 rounded">/home/user/skyspark</code>→
          <code className="bg-gray-100 px-1 mx-1 rounded">/mirror/mac-user/skyspark</code>.
          Applies to instance, Fantom build, pod and project paths and the Fantom source folder. The database keeps the original value.
        </p>
      </div>
      {q.data?.env.length ? (
        <div className="text-sm">
          <div className="text-gray-500">Set by environment (FANTOM_PATH_MAPPINGS), read-only:</div>
          {q.data.env.map((r, i) => (
            <div key={i} className="font-mono">{r.from} → {r.to} {r.toExists ? <span className="text-green-700">ok</span> : <span className="text-yellow-700">missing</span>}</div>
          ))}
        </div>
      ) : null}
      {(rows ?? []).map((r, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input className={input} value={r.from} placeholder="/home/user/skyspark" spellCheck={false}
            onChange={e => setRows((rows ?? []).map((x, j) => j === i ? { ...x, from: e.target.value } : x))} />
          <span>→</span>
          <PathInput className="flex-1" inputClassName={`${input} min-w-0`} value={r.to} placeholder="/mirror/mac-user/skyspark"
            pickerTitle="Choose the server folder"
            onChange={v => setRows((rows ?? []).map((x, j) => j === i ? { ...x, to: v } : x))} />
          <span className="w-16 text-xs">{exists(r.to) === true ? <span className="text-green-700">ok</span> : exists(r.to) === false ? <span className="text-yellow-700">missing</span> : ''}</span>
          <button className="px-2 py-1 text-sm text-red-600" onClick={() => setRows((rows ?? []).filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="flex gap-2">
        <button className="px-3 py-2 border rounded-md text-sm" onClick={() => setRows([...(rows ?? []), { from: '', to: '' }])}>Add mapping</button>
        <button className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm disabled:opacity-50" disabled={save.isPending || rows === null}
          onClick={() => rows && save.mutate(rows)}>{save.isPending ? 'Saving...' : 'Save mappings'}</button>
        {msg && <span className="text-sm text-gray-600 self-center">{msg}</span>}
      </div>
    </div>
  );
}
