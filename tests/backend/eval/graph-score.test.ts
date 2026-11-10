/**
 * Graph-vs-truth scoring maths (V2_STAGE3_SPEC 3b-B.3). Pure: fake truth
 * files and fake graph results, no repos.
 */
import { describe, it, expect } from 'vitest';
import { aggregateGraph, graphErrorCase, macroOf, median, microOf, scoreGraphCase, scoreSets } from '../../../eval/lib/graph-score';
import { TRUTH_LIMITATIONS, TRUTH_VERSION, type CaseTruthFile, type ProjectDirTruth } from '../../../eval/lib/graph-truth';
import type { PackageGraphHits, ProjectDirGraph } from '../../../eval/lib/predict-graph';
import type { GraphCaseResult } from '../../../eval/lib/types';

function truthDir(projectDir: string, packages: ProjectDirTruth['packages'], reexportTruth: 'ok' | 'unavailable' = 'ok'): ProjectDirTruth {
  return {
    projectDir,
    files: 10,
    specifiers: 20,
    unresolvedRelative: 1,
    bareByName: 5,
    reexportTruth,
    timing: { directMs: 3, reexportMs: 7 },
    packages
  };
}

function truthFile(dirs: ProjectDirTruth[]): CaseTruthFile {
  return { truthVersion: TRUTH_VERSION, caseId: 'c', baseCommit: 'a'.repeat(40), tsVersion: 'x', generatedAt: '', limitations: TRUTH_LIMITATIONS, projectDirs: dirs };
}

function hits(partial: Partial<PackageGraphHits>): PackageGraphHits {
  return { direct: [], reexport: [], wrapper: [], aliasOnly: [], configRefOnly: [], nonJs: [], isWorkspace: false, ...partial };
}

function graphDir(projectDir: string, packages: Record<string, PackageGraphHits>, unresolved = 1, total = 100): ProjectDirGraph {
  return {
    projectDir,
    files: 12,
    buildMs: 50,
    unresolved: { totalEdges: total, unresolved, pct: unresolved / total, byReason: { 'not-found': unresolved } },
    topUnresolved: [{ reason: 'not-found', specifier: './gen', count: unresolved }],
    packages
  };
}

describe('set maths', () => {
  it('precision/recall with overlap, and null (never NaN) on empty sides', () => {
    expect(scoreSets(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b', 'x']))).toEqual({ truth: 4, predicted: 3, tp: 2, precision: 2 / 3, recall: 0.5 });
    expect(scoreSets(new Set(), new Set())).toEqual({ truth: 0, predicted: 0, tp: 0, precision: null, recall: null });
    expect(scoreSets(new Set(['a']), new Set())).toMatchObject({ precision: null, recall: 0 });
    expect(scoreSets(new Set(), new Set(['a']))).toMatchObject({ precision: 0, recall: null });
  });

  it('micro sums counts; macro averages non-null values', () => {
    const a = scoreSets(new Set(['1', '2']), new Set(['1', '2']));
    const b = scoreSets(new Set(['1', '2', '3', '4', '5', '6', '7', '8']), new Set(['1']));
    expect(microOf([a, b])).toEqual({ truth: 10, predicted: 3, tp: 3, precision: 1, recall: 0.3 });
    expect(macroOf([a, b])).toEqual({ precision: 1, recall: (1 + 1 / 8) / 2 });
    expect(macroOf([{ precision: null, recall: null }])).toEqual({ precision: null, recall: null });
  });

  it('median of odd, even and empty lists', () => {
    expect(median([0.3, 0.1, 0.2])).toBe(0.2);
    expect(median([0.4, 0.1, 0.2, 0.3])).toBeCloseTo(0.25);
    expect(median([])).toBeNull();
  });
});

describe('scoreGraphCase', () => {
  const truth = truthFile([
    truthDir('web', { antd: { direct: ['src/a.tsx', 'src/b.tsx'], reexport: ['src/c.tsx'] }, lodash: { direct: ['src/u.ts'], reexport: [] } }),
    truthDir('.', { antd: { direct: ['tools/x.js'], reexport: [] } })
  ]);
  const graphs = [
    graphDir('web', {
      antd: hits({ direct: ['src/a.tsx', 'src/b.tsx'], reexport: ['src/c.tsx', 'src/extra.tsx'], wrapper: ['src/w1.tsx', 'src/w2.tsx'], aliasOnly: ['src/alias.tsx'] }),
      lodash: hits({ direct: [], configRefOnly: ['babel.config.js'] }),
      '@mono/ui': hits({ direct: ['src/a.tsx'], isWorkspace: true })
    }),
    graphDir('.', { antd: hits({ direct: [] }) }, 3, 50)
  ];
  const result = scoreGraphCase({
    c: { id: 'pub', tags: ['t'], visibility: 'public' },
    truth,
    truthCached: true,
    graphs,
    packagesFor: (d) => (d === 'web' ? ['antd', 'lodash', '@mono/ui'] : ['antd'])
  });

  it('scores direct ∪ reexport per package over projectDir-prefixed paths', () => {
    const antd = result.packages.find((p) => p.name === 'antd')!;
    expect(antd).toMatchObject({ truth: 4, predicted: 4, tp: 3, precision: 0.75, recall: 0.75, wrapperHits: 2, aliasOnlyHits: 1 });
    const lodash = result.packages.find((p) => p.name === 'lodash')!;
    expect(lodash).toMatchObject({ truth: 1, predicted: 0, tp: 0, recall: 0, precision: null, configRefOnlyHits: 1 });
  });

  it('alias-only, config-ref-only and workspace packages stay out of micro', () => {
    expect(result.micro).toEqual({ truth: 5, predicted: 4, tp: 3, precision: 0.75, recall: 0.6 });
    expect(result.macro).toEqual({ precision: 0.75, recall: (0.75 + 0) / 2 });
    expect(result.workspacePackages).toBe(1);
    expect(result.packages.find((p) => p.name === '@mono/ui')).toMatchObject({ workspace: true });
    expect(result.graphOnlySample).toEqual([{ pkg: 'antd', path: 'web/src/extra.tsx' }]);
    expect(result.truthOnlySample).toEqual([
      { pkg: 'antd', path: 'tools/x.js' },
      { pkg: 'lodash', path: 'web/src/u.ts' }
    ]);
  });

  it('sums unresolved over projectDirs and reports counts', () => {
    expect(result.unresolved).toEqual({ totalEdges: 150, unresolved: 4, pct: 4 / 150, byReason: { 'not-found': 4 } });
    expect(result).toMatchObject({ wrapperHits: 2, aliasOnlyHits: 1, configRefOnlyHits: 1, packagesQueried: 4, truthCached: true, reexportTruth: 'ok' });
    expect(result.files).toEqual({ graph: 24, truth: 20 });
  });

  it('a timed-out reexport truth marks the case unavailable', () => {
    const r = scoreGraphCase({
      c: { id: 'x', tags: [], visibility: 'public' },
      truth: truthFile([truthDir('.', {}, 'unavailable')]),
      truthCached: false,
      graphs: [graphDir('.', {})],
      packagesFor: () => []
    });
    expect(r.reexportTruth).toBe('unavailable');
    expect(r.micro).toEqual({ truth: 0, predicted: 0, tp: 0, precision: null, recall: null });
  });
});

describe('aggregateGraph', () => {
  function okCase(truth: number, predicted: number, tp: number, pct: number): GraphCaseResult {
    const base = graphErrorCase({ id: 'x', tags: [] }, '');
    return {
      ...base,
      status: 'ok',
      error: undefined,
      micro: { truth, predicted, tp, precision: tp / predicted, recall: tp / truth },
      unresolved: { totalEdges: 100, unresolved: pct * 100, pct, byReason: {} }
    };
  }

  it('micro over cases, macro of case micro, median unresolved, targets', () => {
    const agg = aggregateGraph([okCase(100, 100, 99, 0.01), okCase(10, 10, 5, 0.05), graphErrorCase({ id: 'e', tags: [] }, 'boom')]);
    expect(agg.micro).toEqual({ truth: 110, predicted: 110, tp: 104, precision: 104 / 110, recall: 104 / 110 });
    expect(agg.macro.recall).toBeCloseTo((0.99 + 0.5) / 2);
    expect(agg.medianUnresolvedPct).toBeCloseTo(0.03);
    expect(agg.errors).toBe(1);
    expect(agg.targets).toMatchObject({ recallMet: false, precisionMet: true, unresolvedMet: false, met: false });
  });

  it('all targets met', () => {
    expect(aggregateGraph([okCase(100, 100, 100, 0)]).targets.met).toBe(true);
  });
});
