'use client';

/**
 * Server-side folder picker. The server lists only folders inside its browse
 * roots (GET /admin/fs/dirs, FANTOM_BROWSE_ROOTS). Use PathInput for a text
 * field with a "Browse…" button; FolderPickerModal for the dialog alone.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Folder, Loader2, X } from 'lucide-react';
import { api, ServerDirHint } from '@/lib/api';

const HINT_LABEL: Record<ServerDirHint, string> = {
  'skyspark-home': 'SkySpark home',
  'haxall-home': 'Haxall home',
  'fantom-home': 'Fantom home',
  docs: 'docs',
  pod: 'Fantom pod',
  'axon-project': 'Axon project',
  'axon-proj': 'Axon proj/',
};

const HINT_CLASS: Record<ServerDirHint, string> = {
  'skyspark-home': 'bg-blue-100 text-blue-800',
  'haxall-home': 'bg-purple-100 text-purple-800',
  'fantom-home': 'bg-indigo-100 text-indigo-800',
  docs: 'bg-amber-100 text-amber-800',
  pod: 'bg-green-100 text-green-800',
  'axon-project': 'bg-teal-100 text-teal-800',
  'axon-proj': 'bg-teal-100 text-teal-800',
};

export function HintBadge({ hint }: { hint?: ServerDirHint }) {
  if (!hint) return null;
  return <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${HINT_CLASS[hint]}`}>{HINT_LABEL[hint]}</span>;
}

export interface FolderPickerModalProps {
  open: boolean;
  /** Folder to open first; falls back to the first root when not allowed. */
  initialPath?: string;
  title?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPickerModal(props: FolderPickerModalProps) {
  // Mounted only while open, so each open starts fresh.
  return props.open ? <PickerDialog {...props} /> : null;
}

function PickerDialog({ initialPath, title = 'Choose a server folder', onSelect, onClose }: FolderPickerModalProps) {
  const start = initialPath?.trim() || undefined;
  const [cwd, setCwd] = useState<string | undefined>(start);
  const [filter, setFilterRaw] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const q = useQuery({
    queryKey: ['server-dirs', cwd ?? ''],
    queryFn: async () => {
      try { return await api.listServerDirs(cwd); } catch (e) {
        // A typed path that is not allowed or missing: open the first root instead.
        if (cwd !== undefined && cwd === start) return api.listServerDirs();
        throw e;
      }
    },
    retry: false,
  });

  const data = q.data;
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (data?.entries ?? []).filter(e => !f || e.name.toLowerCase().includes(f));
  }, [data, filter]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => { filterRef.current?.focus(); }, [data?.path]);

  const setFilter = (v: string) => { setFilterRaw(v); setActive(0); };
  const go = (p: string) => { setCwd(p); setFilter(''); };
  const crumbs = data ? (() => {
    const rel = data.path.slice(data.root.length).split('/').filter(Boolean);
    const out = [{ name: data.root, path: data.root }];
    let acc = data.root;
    for (const r of rel) { acc = `${acc.replace(/\/$/, '')}/${r}`; out.push({ name: r, path: acc }); }
    return out;
  })() : [];

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, Math.max(shown.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (data) onSelect(data.path); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) go(shown[active].path); }
    else if (e.key === 'Backspace' && !filter && data?.parent) { e.preventDefault(); go(data.parent); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className="bg-white text-gray-900 rounded-lg shadow-xl w-full max-w-2xl flex flex-col max-h-[80vh]"
        onMouseDown={e => e.stopPropagation()} onKeyDown={onKey}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="p-1 text-gray-500 hover:text-gray-800" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-4 py-2 border-b space-y-2">
          <div className="flex gap-2 items-center">
            <select className="rounded-md border border-gray-300 py-1 px-2 text-sm font-mono"
              value={data?.root ?? ''} onChange={e => go(e.target.value)} aria-label="Root folder">
              {(data?.roots ?? []).map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="button" disabled={!data?.parent} onClick={() => data?.parent && go(data.parent)}
              className="p-1.5 border rounded-md disabled:opacity-40 hover:bg-gray-50" title="Up one folder (Backspace)" aria-label="Up one folder">
              <ArrowUp className="w-4 h-4" />
            </button>
            <input ref={filterRef} value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter folders…"
              className="flex-1 rounded-md border border-gray-300 py-1 px-2 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <div className="flex flex-wrap items-center text-sm font-mono text-gray-600">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center">
                {i > 0 && <span className="mx-1 text-gray-400">/</span>}
                <button type="button" className="hover:text-blue-700 hover:underline" onClick={() => go(c.path)}>{c.name}</button>
              </span>
            ))}
            <HintBadge hint={data?.hint} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-[200px]">
          {q.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : q.isError && !data ? (
            <div className="p-4 text-sm text-red-700">{q.error instanceof Error ? q.error.message : 'Could not list folders'}</div>
          ) : (
            <ul ref={listRef} className="divide-y divide-gray-100">
              {shown.map((e, i) => (
                <li key={e.path} data-idx={i}>
                  <button type="button" onClick={() => go(e.path)} onMouseEnter={() => setActive(i)}
                    className={`w-full flex items-center px-4 py-1.5 text-left text-sm ${i === active ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <Folder className="w-4 h-4 mr-2 text-gray-400 shrink-0" />
                    <span className="font-mono truncate">{e.name}</span>
                    <HintBadge hint={e.hint} />
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="p-4 text-sm text-gray-500">{filter ? 'No folders match.' : 'No sub-folders.'}</li>}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t">
          <div className="text-xs text-gray-500">
            {data && <>{data.entries.length} folders{data.fileCount ? ` · ${data.fileCount} files` : ''}{data.truncated ? ' · list cut at 500' : ''}</>}
            <span className="ml-2 hidden sm:inline">↑↓ move · Enter open · Backspace up · Ctrl+Enter select</span>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50">Cancel</button>
            <button type="button" disabled={!data} onClick={() => data && onSelect(data.path)}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50">
              Select this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface PathInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  required?: boolean;
  /** Classes for the text input (the page's own style). */
  inputClassName?: string;
  buttonClassName?: string;
  className?: string;
  pickerTitle?: string;
}

/** Text input plus "Browse…" that opens the server folder picker. */
export function PathInput({ value, onChange, placeholder, readOnly, required, inputClassName, buttonClassName, className, pickerTitle }: PathInputProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`flex gap-2 ${className ?? ''}`}>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        readOnly={readOnly} required={required} spellCheck={false}
        className={inputClassName ?? 'flex-1 min-w-0 rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'} />
      <button type="button" disabled={readOnly} onClick={() => setOpen(true)}
        className={buttonClassName ?? 'px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap'}>
        Browse…
      </button>
      <FolderPickerModal open={open} initialPath={value} title={pickerTitle}
        onClose={() => setOpen(false)} onSelect={p => { onChange(p); setOpen(false); }} />
    </div>
  );
}
