/**
 * Sorting + filtering helpers for the middle-panel dependency list.
 *
 * Default sort (spec §7.3): "Outdated severity descending, tiebreak by name
 * ascending". This module also implements alternative sort keys (name,
 * has-CVE, deprecated) and the filter-chip predicate.
 */
import type { DependencyEntry } from '@/lib/api-types';
import type { SortKey, FilterChips } from '@/components/MiddlePanel/SortFilterToolbar';

/**
 * Buckets for the default sort. Lower numbers sort first (highest severity).
 * `unscanned` deps go last so the in-progress scan items don't push real
 * problems off the screen.
 */
function severityBucket(dep: DependencyEntry): number {
  const b = dep.badges;
  if (b.outdatedSeverity === 'major') return 0;
  if (b.outdatedSeverity === 'minor' || b.outdatedSeverity === 'patch') return 1;
  if (b.hasCve === true) return 2;
  if (b.deprecated === true) return 3;
  const unscanned =
    b.outdatedSeverity === null && b.hasCve === null && b.deprecated === null;
  if (!unscanned) return 4;
  return 5;
}

/**
 * Default sort comparator — "Outdated severity descending, tiebreak name
 * ascending" per spec §7.3.
 */
function compareBySeverity(a: DependencyEntry, b: DependencyEntry): number {
  const sa = severityBucket(a);
  const sb = severityBucket(b);
  if (sa !== sb) return sa - sb;
  return a.name.localeCompare(b.name);
}

function compareByName(a: DependencyEntry, b: DependencyEntry): number {
  return a.name.localeCompare(b.name);
}

function compareByHasCve(a: DependencyEntry, b: DependencyEntry): number {
  const av = a.badges.hasCve === true ? 0 : 1;
  const bv = b.badges.hasCve === true ? 0 : 1;
  if (av !== bv) return av - bv;
  return a.name.localeCompare(b.name);
}

function compareByDeprecated(a: DependencyEntry, b: DependencyEntry): number {
  const av = a.badges.deprecated === true ? 0 : 1;
  const bv = b.badges.deprecated === true ? 0 : 1;
  if (av !== bv) return av - bv;
  return a.name.localeCompare(b.name);
}

export function sortDeps(deps: DependencyEntry[], sort: SortKey): DependencyEntry[] {
  const sorted = [...deps];
  switch (sort) {
    case 'outdatedSeverity':
      sorted.sort(compareBySeverity);
      break;
    case 'name':
      sorted.sort(compareByName);
      break;
    case 'hasCve':
      sorted.sort(compareByHasCve);
      break;
    case 'deprecated':
      sorted.sort(compareByDeprecated);
      break;
  }
  return sorted;
}

/**
 * Apply the filter-chip predicate.
 *
 * Semantics per Decision D7:
 *   - `all` short-circuits to identity (no filtering).
 *   - Otherwise, criteria within the same group AND-combine
 *     (e.g., Outdated + Vulnerable = outdated AND has CVE).
 *   - Section chips (`dev`, `runtime`) gate by `dep.section`. Toggling both
 *     selects both sections, which is equivalent to no section filter.
 *   - Toggling no non-all chip falls back to "All" (handled in toolbar).
 */
export function filterDeps(deps: DependencyEntry[], filters: FilterChips): DependencyEntry[] {
  if (filters.all) return deps;
  return deps.filter((dep) => {
    if (filters.outdated && dep.badges.outdatedSeverity === null) return false;
    if (filters.vulnerable && dep.badges.hasCve !== true) return false;
    if (filters.deprecated && dep.badges.deprecated !== true) return false;
    // Section filter — `dev` and `runtime` are not mutually exclusive: if
    // both are off, neither section restriction applies (other criteria
    // already gate); if one is on, only that section passes; if both are
    // on, both sections pass. With three sections (incl. `volta`) we now
    // gate on explicit section equality rather than `isDev` boolean.
    const sectionFilterActive = filters.dev !== filters.runtime;
    if (sectionFilterActive) {
      if (filters.runtime && dep.section !== 'dependencies') return false;
      if (filters.dev && dep.section !== 'devDependencies') return false;
    }
    return true;
  });
}
