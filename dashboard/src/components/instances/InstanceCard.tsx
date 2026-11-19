'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, FantomInstance } from '@/lib/api';

/** One menu row in the card's "⋯" menu. */
interface MenuAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  separatorBefore?: boolean;
}

/** Small "⋯" dropdown. Closes on outside click and on Escape. */
export function ActionMenu({ actions, label = 'More actions', trigger }: { actions: MenuAction[]; label?: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={trigger ? '' : 'h-8 w-8 flex items-center justify-center rounded-md text-gray-600 hover:bg-gray-100'}
      >
        {trigger ?? <span className="text-lg leading-none">⋯</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
          {actions.map(a => (
            <div key={a.label}>
              {a.separatorBefore && <div className="my-1 border-t border-gray-100" />}
              <button
                type="button"
                role="menuitem"
                title={a.title}
                disabled={a.disabled}
                onClick={() => { setOpen(false); a.onClick(); }}
                className={`block w-full px-3 py-1.5 text-left text-sm disabled:opacity-40 ${a.danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                {a.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'gray', title }: { label: string; value: React.ReactNode; tone?: 'gray' | 'green' | 'amber'; title?: string }) {
  const color = tone === 'green' ? 'text-green-700' : tone === 'amber' ? 'text-amber-700' : 'text-gray-800';
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`text-sm font-medium truncate ${color}`}>{value}</div>
    </div>
  );
}

const fmt = (n?: number) => (n ?? 0).toLocaleString();

export interface InstanceCardProps {
  instance: FantomInstance;
  isActive: boolean;
  isIndexingSource: boolean;
  installerBusy: boolean;
  onSetActive: () => void;
  onValidate: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onIndexSource: () => void;
  onSetHome: () => void;
  onCompileHome: () => void;
}

/**
 * Compact instance card: name + badges, a stats row (docs and code), the path,
 * and two controls: "Docs" and a "⋯" menu with every other action.
 */
export function InstanceCard(p: InstanceCardProps) {
  const { instance } = p;
  const isHaxall = instance.type === 'haxall';
  const isProduct = isHaxall || instance.type === 'skyspark';
  const hasSourcePath = !!instance.sourcePath?.trim();

  const docs = useQuery({
    queryKey: ['doc-status', instance.id],
    queryFn: () => api.getInstanceDocStatus(instance.id),
    staleTime: 60_000,
  });
  const src = useQuery({
    queryKey: ['source-status', instance.id],
    queryFn: () => api.getInstanceSourceStatus(instance.id),
    enabled: isProduct,
    staleTime: 60_000,
  });

  const d = docs.data;
  const s = src.data;

  const actions: MenuAction[] = [
    ...(!p.isActive ? [{ label: 'Set active', onClick: p.onSetActive }] : []),
    ...(isProduct && hasSourcePath ? [{ label: p.isIndexingSource ? 'Indexing source…' : 'Index source code', onClick: p.onIndexSource, disabled: p.isIndexingSource }] : []),
    ...(isHaxall ? [
      { label: 'Set home', onClick: p.onSetHome, title: 'Find <path>/home (bin + lib) and save it as the instance path' },
      { label: 'Compile home', onClick: p.onCompileHome, disabled: p.installerBusy, title: 'Rebuild home (pods + docs) from source, then index and embed the docs' },
    ] : []),
    { label: 'Validate', onClick: p.onValidate },
    { label: 'Edit', onClick: p.onEdit },
    { label: 'Delete', onClick: p.onDelete, danger: true, separatorBefore: true },
  ];

  return (
    <div className={`bg-white rounded-lg shadow-sm border min-w-0 ${p.isActive ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200'}`}>
      <div className="p-4 space-y-3">
        {/* Title row */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className={`font-semibold truncate ${instance.isValid ? 'text-gray-900' : 'text-red-600'}`}>{instance.name}</h3>
              {p.isActive && <span className="text-[11px] bg-blue-600 text-white px-1.5 py-0.5 rounded">Active</span>}
              {!instance.isValid && <span className="text-[11px] bg-red-100 text-red-800 px-1.5 py-0.5 rounded">Invalid</span>}
              {instance.fantomVersion && <span className="text-[11px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">Fantom {instance.fantomVersion}</span>}
            </div>
            <div className="mt-1 text-xs text-gray-500 font-mono truncate" title={instance.path}>{instance.path}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Link href={`/instance-docs?id=${instance.id}`} className="px-3 py-1.5 text-sm rounded-md bg-purple-50 text-purple-700 hover:bg-purple-100">Docs</Link>
            <ActionMenu actions={actions} label={`Actions for ${instance.name}`} />
          </div>
        </div>

        {/* Stats row: docs + code */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-t border-gray-100 pt-3">
          <Stat
            label="Docs"
            tone={d?.hasCache ? 'green' : 'amber'}
            value={docs.isLoading ? '…' : d?.hasCache ? `${fmt(d.itemCount)} items` : 'Not indexed'}
            title={d?.lastIndexed ? `Indexed ${new Date(d.lastIndexed).toLocaleString()}` : undefined}
          />
          {isProduct ? (
            <>
              <Stat
                label="Code pods"
                tone={s?.hasCache ? 'green' : 'amber'}
                value={src.isLoading ? '…' : !s?.hasSourcePath ? 'No source' : s.hasCache ? fmt(s.podCount) : 'Not indexed'}
                title={s?.sourcePath}
              />
              <Stat label="Functions" value={s?.hasCache ? fmt(s.totalFunctions) : '—'} />
              <Stat label="Types" value={s?.hasCache ? fmt(s.totalTypes) : '—'} />
            </>
          ) : (
            <Stat label="Fan" value={<span className="font-mono text-xs">{instance.fanExecutable}</span>} />
          )}
        </div>
        {instance.description && <div className="text-xs text-gray-500">{instance.description}</div>}
      </div>
    </div>
  );
}
