'use client';

import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';

export interface ProjectsSidebarEntry<TId = string | number> {
  id: TId;
  label: string;
  sublabel?: string;
  count?: number;
  /** 'warn' renders the sublabel in amber — e.g. a project with no vectors. */
  tone?: 'warn';
}

interface ProjectsSidebarProps<TId> {
  title?: string;
  entries: ProjectsSidebarEntry<TId>[];
  selectedId: TId | null;
  onSelect: (id: TId) => void;
  emptyMessage?: ReactNode;
  // When true, the list grows to fill the viewport instead of capping at 70vh.
  fillHeight?: boolean;
  // When true, render a filter text input at the top.
  filterable?: boolean;
  filterPlaceholder?: string;
}

// Reusable left-side Projects column.
// Used on /fantom-pods and /graph-3d so users can switch project
// without hunting through dropdowns.
export function ProjectsSidebar<TId extends string | number>({
  title = 'Projects',
  entries,
  selectedId,
  onSelect,
  emptyMessage,
  fillHeight = false,
  filterable = false,
  filterPlaceholder = 'Filter…',
}: ProjectsSidebarProps<TId>) {
  const [query, setQuery] = useState('');
  // Bring the selected row into view when selection arrives from outside the
  // list (URL param, auto-select) — otherwise a deep-linked project is
  // highlighted somewhere below the fold and looks unselected.
  const activeRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const filtered = useMemo(() => {
    if (!filterable || !query.trim()) return entries;
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        e.label.toLowerCase().includes(q) ||
        (e.sublabel && e.sublabel.toLowerCase().includes(q)),
    );
  }, [entries, filterable, query]);

  return (
    <aside
      className={`w-full lg:w-[18%] lg:min-w-[250px] lg:max-w-[330px] border border-gray-200 rounded-lg bg-white p-3 lg:sticky lg:top-4 ${
        fillHeight ? 'lg:h-[calc(100vh-32px)] flex flex-col' : 'h-fit'
      }`}
    >
      <h2 className="text-sm font-semibold text-gray-900 mb-2 uppercase tracking-wide">
        {title}
      </h2>
      {filterable && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={filterPlaceholder}
          className="w-full mb-2 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      )}
      {filtered.length === 0 ? (
        <div className="text-xs text-gray-500 px-1 py-2">
          {entries.length === 0
            ? emptyMessage ?? 'No projects'
            : 'No matches'}
        </div>
      ) : (
        <ul
          className={`space-y-1 overflow-y-auto ${
            fillHeight ? 'flex-1 min-h-0' : 'max-h-[70vh]'
          }`}
        >
          {filtered.map((entry) => {
            const active = selectedId === entry.id;
            return (
              <li key={String(entry.id)} ref={active ? activeRef : undefined}>
                <button
                  type="button"
                  onClick={() => onSelect(entry.id)}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                    active
                      ? 'bg-blue-50 text-blue-700 border border-blue-200'
                      : 'hover:bg-gray-50 text-gray-700 border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{entry.label}</span>
                    {typeof entry.count === 'number' && (
                      <span className="text-xs text-gray-500 shrink-0">
                        {entry.count}
                      </span>
                    )}
                  </div>
                  {entry.sublabel && (
                    <div className={`text-xs truncate ${entry.tone === 'warn' ? 'text-amber-600' : 'text-gray-500'}`}>
                      {entry.sublabel}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
