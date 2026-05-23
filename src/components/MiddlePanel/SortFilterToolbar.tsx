'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './SortFilterToolbar.module.css';

export type SortKey = 'outdatedSeverity' | 'name' | 'hasCve' | 'deprecated';

export interface FilterChips {
  all: boolean;
  outdated: boolean;
  vulnerable: boolean;
  deprecated: boolean;
  dev: boolean;
  runtime: boolean;
}

interface Props {
  search: string;
  onSearchChange: (next: string) => void;
  sort: SortKey;
  onSortChange: (next: SortKey) => void;
  filters: FilterChips;
  onFiltersChange: (next: FilterChips) => void;
  onUpdateProject: () => void;
  refreshing: boolean;
}

const CHIPS: ReadonlyArray<{ key: keyof FilterChips; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'outdated', label: 'Outdated' },
  { key: 'vulnerable', label: 'Vulnerable' },
  { key: 'deprecated', label: 'Deprecated' },
  { key: 'dev', label: 'dev' },
  { key: 'runtime', label: 'runtime' }
];

export function SortFilterToolbar({
  search,
  onSearchChange,
  sort,
  onSortChange,
  filters,
  onFiltersChange,
  onUpdateProject,
  refreshing
}: Props): JSX.Element {
  // Maintain a local mirror of the search value so the input value is always
  // the latest user keystroke. A purely-controlled input relying on `search`
  // would drop characters whenever the parent prop is updated asynchronously
  // (e.g., via React batching or external state). The local state is the
  // source of truth for the DOM; we propagate to the parent in onChange and
  // adopt the prop when it changes externally.
  const [localSearch, setLocalSearch] = useState(search);
  const lastEmitted = useRef(search);

  useEffect(() => {
    if (search !== lastEmitted.current) {
      // Parent reset the search externally — sync the input.
      setLocalSearch(search);
      lastEmitted.current = search;
    }
  }, [search]);

  const handleSearchInput = (next: string) => {
    setLocalSearch(next);
    lastEmitted.current = next;
    onSearchChange(next);
  };

  const toggleChip = (key: keyof FilterChips) => {
    if (key === 'all') {
      onFiltersChange({
        all: true,
        outdated: false,
        vulnerable: false,
        deprecated: false,
        dev: false,
        runtime: false
      });
      return;
    }
    const next = { ...filters, [key]: !filters[key], all: false };
    // If none selected, fall back to "all".
    const anyOn = next.outdated || next.vulnerable || next.deprecated || next.dev || next.runtime;
    if (!anyOn) next.all = true;
    onFiltersChange(next);
  };

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Dependency filters">
      <div className={styles.row}>
        <label className={styles.searchLabel}>
          <span className="sr-only">Search dependencies</span>
          <span aria-hidden="true" className={styles.searchIcon}>
            ⌕
          </span>
          <input
            type="search"
            value={localSearch}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder="Search"
            className={styles.searchInput}
            spellCheck={false}
            autoComplete="off"
            data-testid="dep-search"
          />
        </label>
        <label className={styles.sortLabel}>
          <span className="sr-only">Sort</span>
          <select
            value={sort}
            onChange={(e) => onSortChange(e.target.value as SortKey)}
            className={styles.sortSelect}
          >
            <option value="outdatedSeverity">Outdated severity</option>
            <option value="name">Name</option>
            <option value="hasCve">Has CVE</option>
            <option value="deprecated">Deprecated</option>
          </select>
        </label>
        <button
          type="button"
          className={styles.updateBtn}
          onClick={onUpdateProject}
          disabled={refreshing}
          aria-label="Update project from disk"
        >
          <span aria-hidden="true" className={styles.updateIcon}>
            ↻
          </span>
          <span>Update</span>
        </button>
      </div>
      <div className={styles.chips}>
        {CHIPS.map((chip) => {
          const isOn = filters[chip.key];
          return (
            <button
              key={chip.key}
              type="button"
              aria-pressed={isOn}
              data-testid={`filter-chip-${chip.key}`}
              className={[styles.chip, isOn ? styles.chipOn : ''].filter(Boolean).join(' ')}
              onClick={() => toggleChip(chip.key)}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
