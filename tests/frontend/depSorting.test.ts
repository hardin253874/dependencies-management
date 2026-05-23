/**
 * Stage 2 — default sort + filter chip semantics.
 *
 * Spec §7.3: default sort = "Outdated severity descending, tiebreak by name
 * ascending". Filter chips operate per Tasks/frontend-stage-2.md Decision §D7.
 */
import { describe, expect, it } from 'vitest';
import type { DependencyEntry } from '@/lib/api-types';
import { sortDeps, filterDeps } from '@/lib/client/depSorting';

function dep(
  name: string,
  overrides: Partial<DependencyEntry> = {}
): DependencyEntry {
  const defaultBadges = {
    outdatedSeverity: null as DependencyEntry['badges']['outdatedSeverity'],
    hasCve: false as boolean | null,
    deprecated: false as boolean | null,
    lastScannedAt: '2026-05-23T00:00:00.000Z' as string | null
  };
  const { badges, ...rest } = overrides;
  return {
    name,
    section: 'dependencies',
    declaredRange: '^1.0.0',
    installedVersion: '1.0.0',
    ...rest,
    badges: { ...defaultBadges, ...(badges ?? {}) }
  };
}

describe('sortDeps (default: outdatedSeverity desc, tiebreak by name asc)', () => {
  it('orders major-outdated first, then minor/patch, CVE, deprecated, clean, unscanned', () => {
    const list: DependencyEntry[] = [
      dep('clean', { badges: { outdatedSeverity: null, hasCve: false, deprecated: false, lastScannedAt: 'x' } }),
      dep('major', { badges: { outdatedSeverity: 'major', hasCve: false, deprecated: false, lastScannedAt: 'x' } }),
      dep('cve-only', { badges: { outdatedSeverity: null, hasCve: true, deprecated: false, lastScannedAt: 'x' } }),
      dep('minor', { badges: { outdatedSeverity: 'minor', hasCve: false, deprecated: false, lastScannedAt: 'x' } }),
      dep('deprecated', { badges: { outdatedSeverity: null, hasCve: false, deprecated: true, lastScannedAt: 'x' } }),
      dep('unscanned', { badges: { outdatedSeverity: null, hasCve: null, deprecated: null, lastScannedAt: null } })
    ];
    const sorted = sortDeps(list, 'outdatedSeverity');
    expect(sorted.map((d) => d.name)).toEqual([
      'major',
      'minor',
      'cve-only',
      'deprecated',
      'clean',
      'unscanned'
    ]);
  });

  it('breaks ties within a bucket by name ascending', () => {
    const list: DependencyEntry[] = [
      dep('zlib', { badges: { outdatedSeverity: 'major', hasCve: false, deprecated: false, lastScannedAt: 'x' } }),
      dep('atomic', { badges: { outdatedSeverity: 'major', hasCve: false, deprecated: false, lastScannedAt: 'x' } }),
      dep('middleware', { badges: { outdatedSeverity: 'major', hasCve: false, deprecated: false, lastScannedAt: 'x' } })
    ];
    expect(sortDeps(list, 'outdatedSeverity').map((d) => d.name)).toEqual([
      'atomic',
      'middleware',
      'zlib'
    ]);
  });

  it('sortDeps(name) is straight alpha ascending', () => {
    const list = [dep('b'), dep('a'), dep('c')];
    expect(sortDeps(list, 'name').map((d) => d.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterDeps chip semantics', () => {
  const list: DependencyEntry[] = [
    dep('outdated-runtime', {
      section: 'dependencies',
      badges: { outdatedSeverity: 'major', hasCve: false, deprecated: false, lastScannedAt: 'x' }
    }),
    dep('vulnerable-runtime', {
      section: 'dependencies',
      badges: { outdatedSeverity: null, hasCve: true, deprecated: false, lastScannedAt: 'x' }
    }),
    dep('deprecated-dev', {
      section: 'devDependencies',
      badges: { outdatedSeverity: null, hasCve: false, deprecated: true, lastScannedAt: 'x' }
    }),
    dep('clean-dev', {
      section: 'devDependencies',
      badges: { outdatedSeverity: null, hasCve: false, deprecated: false, lastScannedAt: 'x' }
    })
  ];

  it('"all" passes everything through', () => {
    const filtered = filterDeps(list, {
      all: true,
      outdated: false,
      vulnerable: false,
      deprecated: false,
      dev: false,
      runtime: false
    });
    expect(filtered.map((d) => d.name).sort()).toEqual([
      'clean-dev',
      'deprecated-dev',
      'outdated-runtime',
      'vulnerable-runtime'
    ]);
  });

  it('"outdated" keeps only deps with non-null outdatedSeverity', () => {
    const filtered = filterDeps(list, {
      all: false,
      outdated: true,
      vulnerable: false,
      deprecated: false,
      dev: false,
      runtime: false
    });
    expect(filtered.map((d) => d.name)).toEqual(['outdated-runtime']);
  });

  it('"vulnerable" keeps only deps with hasCve === true', () => {
    const filtered = filterDeps(list, {
      all: false,
      outdated: false,
      vulnerable: true,
      deprecated: false,
      dev: false,
      runtime: false
    });
    expect(filtered.map((d) => d.name)).toEqual(['vulnerable-runtime']);
  });

  it('"deprecated" keeps only deps with deprecated === true', () => {
    const filtered = filterDeps(list, {
      all: false,
      outdated: false,
      vulnerable: false,
      deprecated: true,
      dev: false,
      runtime: false
    });
    expect(filtered.map((d) => d.name)).toEqual(['deprecated-dev']);
  });

  it('"dev" + "deprecated" combine AND-wise', () => {
    const filtered = filterDeps(list, {
      all: false,
      outdated: false,
      vulnerable: false,
      deprecated: true,
      dev: true,
      runtime: false
    });
    expect(filtered.map((d) => d.name)).toEqual(['deprecated-dev']);
  });

  it('"runtime" alone restricts to dependencies section', () => {
    const filtered = filterDeps(list, {
      all: false,
      outdated: false,
      vulnerable: false,
      deprecated: false,
      dev: false,
      runtime: true
    });
    expect(filtered.map((d) => d.name).sort()).toEqual(['outdated-runtime', 'vulnerable-runtime']);
  });

  it('"dev" + "runtime" cancels the section restriction', () => {
    const filtered = filterDeps(list, {
      all: false,
      outdated: false,
      vulnerable: false,
      deprecated: false,
      dev: true,
      runtime: true
    });
    expect(filtered.length).toBe(list.length);
  });
});
