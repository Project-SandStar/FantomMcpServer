'use client';

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ProjectsSidebarEntry<TId = string | number> {
  id: TId;
  label: string;
  sublabel?: string;
  count?: number;
  /** 'warn' renders the sublabel in amber — e.g. a project with no vectors. */
  tone?: 'warn';
}

/**
 * One node of the optional tree: a version line such as "Haxall 4.0.6".
 * `product` nests it under a product header ("Haxall"); groups without a
 * product sit at the top level. A group row is selectable in its own right
 * (search scope = every project in it) and collapsible.
 */
export interface ProjectsSidebarGroup {
  key: string;
  label: string;
  product?: string;
  productLabel?: string;
  count?: number;
  sublabel?: string;
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
  /** Tree mode. Groups render in the order given; entries whose `groupOf` is
   *  null stay at the top as a flat, pinned list (e.g. "All projects"). */
  groups?: ProjectsSidebarGroup[];
  groupOf?: (entry: ProjectsSidebarEntry<TId>) => string | null;
  /** Groups in the current scope. One key = single select; several = multi. */
  selectedGroupKeys?: string[];
  /** Click on a group label: make it THE scope (replaces the selection). */
  onSelectGroup?: (key: string) => void;
  /** Checkbox on a group row: add to / remove from the scope. Omit to hide the boxes. */
  onToggleGroup?: (key: string) => void;
  /** localStorage key for the collapsed state of the tree. */
  storageKey?: string;
  /** Tooltip for a group label; default speaks of "projects". */
  groupTitle?: (group: ProjectsSidebarGroup, memberCount: number) => string;
}

const CHEVRON = (open: boolean) => (
  <svg viewBox="0 0 20 20" className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} fill="currentColor" aria-hidden>
    <path d="M7 5l6 5-6 5V5z" />
  </svg>
);

// Reusable left-side Projects column.
// Used on /fantom-pods, /graph-3d and /vector-viewer so users can switch
// project without hunting through dropdowns. With `groups` it becomes a
// product → version → project tree; without, the flat list it always was.
export function ProjectsSidebar<TId extends string | number>({
  title = 'Projects',
  entries,
  selectedId,
  onSelect,
  emptyMessage,
  fillHeight = false,
  filterable = false,
  filterPlaceholder = 'Filter…',
  groups,
  groupOf,
  selectedGroupKeys,
  onSelectGroup,
  onToggleGroup,
  storageKey,
  groupTitle,
}: ProjectsSidebarProps<TId>) {
  const selectedGroups = useMemo(() => new Set(selectedGroupKeys ?? []), [selectedGroupKeys]);
  const [query, setQuery] = useState('');
  // Bring the selected row into view when selection arrives from outside the
  // list (URL param, auto-select) — otherwise a deep-linked project is
  // highlighted somewhere below the fold and looks unselected.
  const activeRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, selectedGroupKeys]);

  const treeMode = !!groups && !!groupOf;
  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (e: ProjectsSidebarEntry<TId>) =>
      !q || e.label.toLowerCase().includes(q) || (!!e.sublabel && e.sublabel.toLowerCase().includes(q)),
    [q],
  );

  const filtered = useMemo(() => {
    if (!filterable || !q) return entries;
    return entries.filter(matches);
  }, [entries, filterable, q, matches]);

  // ── Collapsed state (tree mode), remembered per page ───────────────────────
  // Version groups start collapsed; product headers start open. The group that
  // holds the selected project is forced open so a deep link is visible.
  const storage = storageKey ? `projectsSidebar.collapsed.${storageKey}` : null;
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!treeMode) return;
    let initial: string[] | null = null;
    try { if (storage) { const raw = localStorage.getItem(storage); if (raw) initial = JSON.parse(raw); } } catch { /* ignore */ }
    setCollapsed(new Set(initial ?? groups!.map((g) => g.key)));
    // Only on mount / group-set change; user toggles are tracked below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeMode, storage, groups?.length]);
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { if (storage) localStorage.setItem(storage, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, [storage]);

  // ── Tree shape ─────────────────────────────────────────────────────────────
  const tree = useMemo(() => {
    if (!treeMode) return null;
    const byGroup = new Map<string, ProjectsSidebarEntry<TId>[]>();
    const pinned: ProjectsSidebarEntry<TId>[] = [];
    for (const e of entries) {
      const key = groupOf!(e);
      if (key === null) { pinned.push(e); continue; }
      const arr = byGroup.get(key) ?? [];
      arr.push(e);
      byGroup.set(key, arr);
    }
    // Groups the page did not list but entries point at still render, last.
    const known = new Set(groups!.map((g) => g.key));
    const extra: ProjectsSidebarGroup[] = [...byGroup.keys()].filter((k) => !known.has(k)).map((k) => ({ key: k, label: k }));
    const all = [...groups!, ...extra];
    // product → groups
    const products: Array<{ key: string | null; label: string; groups: ProjectsSidebarGroup[] }> = [];
    for (const g of all) {
      const pk = g.product ?? null;
      let p = products.find((x) => x.key === pk);
      if (!p) { p = { key: pk, label: g.productLabel ?? g.product ?? '', groups: [] }; products.push(p); }
      p.groups.push(g);
    }
    return { pinned, byGroup, products };
  }, [treeMode, entries, groups, groupOf]);

  const selectedGroupOfEntry = useMemo(() => {
    if (!treeMode || selectedId === null) return null;
    const e = entries.find((x) => x.id === selectedId);
    return e ? groupOf!(e) : null;
  }, [treeMode, entries, selectedId, groupOf]);

  const renderEntry = (entry: ProjectsSidebarEntry<TId>, indent = 0) => {
    const active = selectedId === entry.id;
    return (
      <li key={String(entry.id)} ref={active ? activeRef : undefined}>
        <button
          type="button"
          onClick={() => onSelect(entry.id)}
          style={indent ? { paddingLeft: `${0.5 + indent * 0.75}rem` } : undefined}
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
                {entry.count.toLocaleString()}
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
  };

  const listClass = `space-y-1 overflow-y-auto ${fillHeight ? 'flex-1 min-h-0' : 'max-h-[70vh]'}`;

  let body: ReactNode;
  if (!treeMode) {
    body = filtered.length === 0 ? (
      <div className="text-xs text-gray-500 px-1 py-2">
        {entries.length === 0 ? emptyMessage ?? 'No projects' : 'No matches'}
      </div>
    ) : (
      <ul className={listClass}>{filtered.map((e) => renderEntry(e))}</ul>
    );
  } else {
    const { pinned, byGroup, products } = tree!;
    const filtering = filterable && !!q;
    const visibleIn = (key: string) => (byGroup.get(key) ?? []).filter((e) => !filtering || matches(e));
    const groupMatches = (g: ProjectsSidebarGroup) => !filtering || g.label.toLowerCase().includes(q) || visibleIn(g.key).length > 0;
    const anyVisible = pinned.some((e) => !filtering || matches(e)) || products.some((p) => p.groups.some(groupMatches));
    body = entries.length === 0 ? (
      <div className="text-xs text-gray-500 px-1 py-2">{emptyMessage ?? 'No projects'}</div>
    ) : !anyVisible ? (
      <div className="text-xs text-gray-500 px-1 py-2">No matches</div>
    ) : (
      <ul className={listClass}>
        {pinned.filter((e) => !filtering || matches(e)).map((e) => renderEntry(e))}
        {products.map((p) => {
          const pgroups = p.groups.filter(groupMatches);
          if (pgroups.length === 0) return null;
          const pKey = `product:${p.key ?? ''}`;
          const pOpen = filtering || !(collapsed?.has(pKey));
          return (
            <li key={pKey}>
              {p.key !== null && (
                <button
                  type="button"
                  onClick={() => toggle(pKey)}
                  className="w-full flex items-center gap-1 px-1 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700"
                >
                  {CHEVRON(pOpen)}
                  <span className="truncate">{p.label}</span>
                  <span className="ml-auto font-normal normal-case tracking-normal text-gray-400">
                    {pgroups.reduce((s, g) => s + (byGroup.get(g.key)?.length ?? 0), 0)}
                  </span>
                </button>
              )}
              {pOpen && (
                <ul className="space-y-0.5">
                  {pgroups.map((g) => {
                    const members = visibleIn(g.key);
                    const total = byGroup.get(g.key)?.length ?? 0;
                    const gActive = selectedGroups.has(g.key);
                    const open = filtering || !(collapsed?.has(g.key)) || selectedGroupOfEntry === g.key;
                    return (
                      <li key={g.key} ref={gActive ? activeRef : undefined}>
                        <div
                          className={`flex items-stretch rounded border ${
                            gActive ? 'bg-blue-50 border-blue-200' : 'border-transparent hover:bg-gray-50'
                          }`}
                        >
                          <button
                            type="button"
                            aria-label={open ? 'Collapse' : 'Expand'}
                            onClick={() => toggle(g.key)}
                            className={`px-1 flex items-center ${gActive ? 'text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
                            style={{ marginLeft: p.key !== null ? '0.5rem' : 0 }}
                          >
                            {CHEVRON(open)}
                          </button>
                          {onToggleGroup && (
                            <label className="flex items-center pr-1 cursor-pointer" title={`${gActive ? 'Remove' : 'Add'} ${g.label} ${gActive ? 'from' : 'to'} the search scope`}>
                              <input
                                type="checkbox"
                                aria-label={`Include ${g.label} in the search scope`}
                                checked={gActive}
                                onChange={() => onToggleGroup(g.key)}
                                className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              />
                            </label>
                          )}
                          <button
                            type="button"
                            // Pages without a group scope (3D graph) use the
                            // label as a second expand/collapse handle.
                            onClick={() => (onSelectGroup ? onSelectGroup(g.key) : toggle(g.key))}
                            title={groupTitle
                              ? groupTitle(g, total)
                              : onSelectGroup
                                ? `Search only the ${total} projects in ${g.label}${onToggleGroup ? ' (tick the box to add it to the current scope)' : ''}`
                                : `${total} projects in ${g.label}`}
                            className={`flex-1 min-w-0 text-left py-1.5 pr-2 text-sm ${gActive ? 'text-blue-700' : 'text-gray-800'}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-medium">{g.label}</span>
                              <span className="text-xs text-gray-500 shrink-0">
                                {total}{typeof g.count === 'number' ? ` · ${g.count.toLocaleString()}` : ''}
                              </span>
                            </div>
                            {g.sublabel && <div className="text-xs text-gray-500 truncate">{g.sublabel}</div>}
                          </button>
                        </div>
                        {open && members.length > 0 && (
                          <ul className="space-y-0.5 mt-0.5">
                            {members.map((e) => renderEntry(e, p.key !== null ? 2 : 1))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

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
      {body}
    </aside>
  );
}
