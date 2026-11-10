/**
 * Scorer (v2 Stage 0.6) — pure metrics and aggregation.
 */
import { describe, it, expect } from 'vitest';
import { aggregate, scorePhase } from '../../../eval/lib/score';
import type { CaseResult, PhaseResult, TruthKind, TruthSet } from '../../../eval/lib/types';

function truthOf(entries: Array<[string, TruthKind]>): TruthSet {
  return {
    kept: entries.map(([p, kind]) => ({ path: p, kind, status: 'M' })),
    dropped: [{ path: 'yarn.lock', reason: 'lockfile', status: 'M' }],
    addedCount: 0,
    outOfScope: []
  };
}

const meta = { id: 'main', packages: ['react'], tags: ['react-major'] };

function caseOf(id: string, phases: PhaseResult[], status: 'ok' | 'error' = 'ok', tags: string[] = []): CaseResult {
  return { id, tags, status, filesScanned: 0, durationMs: 0, costUsd: 0, phases, findings: null };
}

describe('scorePhase', () => {
  it('computes the hand example: truth 4, predicted 5, tp 3 → P 0.6, R 0.75', () => {
    const t = truthOf([
      ['a.ts', 'source'],
      ['b.ts', 'source'],
      ['c.ts', 'source'],
      ['d.scss', 'style']
    ]);
    const r = scorePhase(meta, t, ['a.ts', 'b.ts', 'c.ts', 'x.ts', 'y.ts']);
    expect(r.tp).toBe(3);
    expect(r.precision).toBeCloseTo(0.6);
    expect(r.recall).toBeCloseTo(0.75);
    expect(r.recallByKind).toEqual({ source: 1, config: null, style: 0 });
    expect(r.falseNegatives).toEqual(['d.scss']);
    expect(r.falsePositivesCount).toBe(2);
    expect(r.falsePositivesSample).toEqual(['x.ts', 'y.ts']);
    expect(r.droppedCounts).toEqual({ lockfile: 1 });
  });

  it('gives precision null for an empty prediction', () => {
    const r = scorePhase(meta, truthOf([['a.ts', 'source']]), []);
    expect(r.precision).toBeNull();
    expect(r.recall).toBe(0);
  });

  it('gives recall null for an empty truth', () => {
    const r = scorePhase(meta, truthOf([]), ['a.ts']);
    expect(r.recall).toBeNull();
    expect(r.precision).toBe(0);
  });

  it('normalises ./ prefixes and backslashes before matching', () => {
    const r = scorePhase(meta, truthOf([['src/a.ts', 'source']]), ['./src/a.ts', 'src\\a.ts']);
    expect(r.tp).toBe(1);
    expect(r.predictedCount).toBe(1);
  });

  it('caps the false-positive sample at 20', () => {
    const predicted = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
    const r = scorePhase(meta, truthOf([]), predicted);
    expect(r.falsePositivesCount).toBe(30);
    expect(r.falsePositivesSample).toHaveLength(20);
  });
});

describe('aggregate', () => {
  // Phase A: truth 4, predicted 2, tp 2 → P 1, R 0.5. Phase B: truth 1, predicted 4, tp 1 → P 0.25, R 1.
  const phaseA = scorePhase(
    { id: 'a', packages: ['react'], tags: ['complex', 'react-major'] },
    truthOf([
      ['1.ts', 'source'],
      ['2.ts', 'source'],
      ['3.ts', 'source'],
      ['4.ts', 'source']
    ]),
    ['1.ts', '2.ts']
  );
  const phaseB = scorePhase(
    { id: 'b', packages: ['next'], tags: ['next-major'] },
    truthOf([['1.ts', 'source']]),
    ['1.ts', 'x.ts', 'y.ts', 'z.ts']
  );

  it('separates micro from macro on unequal phases', () => {
    const agg = aggregate([caseOf('c1', [phaseA]), caseOf('c2', [phaseB])]);
    expect(agg.micro.precision).toBeCloseTo(3 / 6);
    expect(agg.micro.recall).toBeCloseTo(3 / 5);
    expect(agg.macro.precision).toBeCloseTo((1 + 0.25) / 2);
    expect(agg.macro.recall).toBeCloseTo((0.5 + 1) / 2);
  });

  it('aggregates by merged phase tags', () => {
    const agg = aggregate([caseOf('c1', [phaseA]), caseOf('c2', [phaseB])]);
    expect(Object.keys(agg.byTag)).toEqual(['complex', 'next-major', 'react-major']);
    expect(agg.byTag.complex?.phases).toBe(1);
    expect(agg.byTag.complex?.micro.recall).toBeCloseTo(0.5);
  });

  it('excludes error cases and counts them', () => {
    const agg = aggregate([caseOf('c1', [phaseA]), caseOf('bad', [phaseB], 'error')]);
    expect(agg.errors).toBe(1);
    expect(agg.micro.recall).toBeCloseTo(0.5);
  });

  it('excludes null phase values from macro', () => {
    const empty = scorePhase(meta, truthOf([]), []);
    const agg = aggregate([caseOf('c1', [phaseA, empty])]);
    expect(agg.macro.recall).toBeCloseTo(0.5);
    expect(agg.macro.precision).toBeCloseTo(1);
  });

  it('returns nulls, not NaN, when nothing is scored', () => {
    const agg = aggregate([]);
    expect(agg.micro).toEqual({ precision: null, recall: null });
    expect(agg.macro).toEqual({ precision: null, recall: null });
  });
});
