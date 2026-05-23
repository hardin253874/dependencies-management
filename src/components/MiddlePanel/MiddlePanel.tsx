'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppContext } from '../AppContext';
import { SortFilterToolbar, type FilterChips, type SortKey } from './SortFilterToolbar';
import { DependencyList } from './DependencyList';
import { sortDeps, filterDeps } from '@/lib/client/depSorting';
import type { DependencyEntry, VoltaInfo } from '@/lib/api-types';
import styles from './MiddlePanel.module.css';

/**
 * Debounce window (ms) for the dep-search input. Spec §13 / Stage 4 plan
 * notes that 300+ dep projects should not lag on keystrokes; we debounce the
 * heavy `filterDeps + sortDeps` pass to one tick after the user stops typing.
 */
const SEARCH_DEBOUNCE_MS = 200;

const DEFAULT_FILTERS: FilterChips = {
  all: true,
  outdated: false,
  vulnerable: false,
  deprecated: false,
  dev: false,
  runtime: false
};

export function MiddlePanel(): JSX.Element {
  const {
    activeProjectSlug,
    activeProject,
    activeProjectLoading,
    activeProjectError,
    activeProjectRefreshing,
    refreshActiveProjectFromDisk,
    selectDep,
    activeDepName
  } = useAppContext();
  const [sort, setSort] = useState<SortKey>('outdatedSeverity');
  const [filters, setFilters] = useState<FilterChips>(DEFAULT_FILTERS);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  /**
   * Debounce the search term so each keystroke does not retrigger the
   * O(N log N) sort + filter pass for 300+ deps. The input stays controlled
   * via `search`; only the heavy memo waits for the debounced value.
   */
  useEffect(() => {
    if (search === '') {
      // Clearing the input is felt instantly; no debounce.
      setDebouncedSearch('');
      return;
    }
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  /**
   * Stage 1 carry-over: wire the toolbar's Update button to the project
   * refresh endpoint. Stage 1 BE shipped `POST /api/projects/:slug/refresh`.
   */
  const onUpdate = () => {
    void refreshActiveProjectFromDisk();
  };

  const groupedDeps = useMemo(() => {
    const real = activeProject?.dependencies ?? [];
    // Synthesize Volta entries from `project.volta` so toolchain pins render
    // alongside real deps and clicking one opens View [A]. Phase 2 doesn't
    // currently scan toolchain entries, so badges stay in the "?" state until
    // a future BE iteration adds toolchain analysis.
    const voltaSynth = synthesizeVoltaEntries(activeProject?.volta ?? null);
    const list = [...voltaSynth, ...real];
    const term = debouncedSearch.trim().toLowerCase();
    const searched = term ? list.filter((d) => d.name.toLowerCase().includes(term)) : list;
    const filtered = filterDeps(searched, filters);
    const sorted = sortDeps(filtered, sort);
    return {
      volta: sorted.filter((d) => d.section === 'volta'),
      dependencies: sorted.filter((d) => d.section === 'dependencies'),
      devDependencies: sorted.filter((d) => d.section === 'devDependencies')
    };
  }, [activeProject, sort, filters, debouncedSearch]);

  return (
    <aside
      id="middle-panel"
      role="complementary"
      aria-label="Dependencies"
      className={styles.middle}
    >
      {!activeProjectSlug ? (
        <div className={styles.empty} role="status">
          Pick a project to view dependencies
        </div>
      ) : activeProjectLoading && !activeProject ? (
        <div className={styles.empty} role="status">
          Loading dependencies…
        </div>
      ) : activeProjectError ? (
        <div className={styles.empty} role="alert">
          {activeProjectError}
        </div>
      ) : !activeProject ? (
        <div className={styles.empty} role="status">
          No dependency data yet.
        </div>
      ) : (
        <>
          <SortFilterToolbar
            search={search}
            onSearchChange={setSearch}
            sort={sort}
            onSortChange={setSort}
            filters={filters}
            onFiltersChange={setFilters}
            onUpdateProject={onUpdate}
            refreshing={activeProjectRefreshing}
          />
          <DependencyList
            groups={groupedDeps}
            activeDep={activeDepName}
            onSelectDep={selectDep}
          />
        </>
      )}
    </aside>
  );
}

/**
 * Turn a `VoltaInfo` block into `DependencyEntry[]` so the list renderer can
 * treat toolchain pins as regular entries.
 *
 * Volta pins exact versions (no ranges), so both `declaredRange` and
 * `installedVersion` are the pinned version. Badges are left in the
 * unscanned (`null`) state — Phase 2 hasn't been taught about toolchain
 * entries yet.
 */
function synthesizeVoltaEntries(volta: VoltaInfo | null): DependencyEntry[] {
  if (!volta) return [];
  const out: DependencyEntry[] = [];
  const add = (name: 'node' | 'npm' | 'yarn', version: string | null | undefined): void => {
    if (!version) return;
    out.push({
      name,
      section: 'volta',
      declaredRange: version,
      installedVersion: version,
      badges: {
        outdatedSeverity: null,
        hasCve: null,
        deprecated: null,
        lastScannedAt: null
      }
    });
  };
  add('node', volta.node);
  add('npm', volta.npm);
  add('yarn', volta.yarn);
  return out;
}
