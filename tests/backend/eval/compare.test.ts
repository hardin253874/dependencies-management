/**
 * Compare tool (v2 Stage 0.9).
 */
import { describe, it, expect } from 'vitest';
import { compareResults } from '../../../eval/lib/compare';
import { buildResultFile } from '../../../eval/lib/results';
import { scorePhase } from '../../../eval/lib/score';
import type { CaseResult, ResultFile, TruthSet, Visibility } from '../../../eval/lib/types';

const truth4: TruthSet = {
  kept: ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => ({ path: p, kind: 'source' as const, status: 'M' })),
  dropped: [],
  addedCount: 0,
  outOfScope: []
};

function okCase(id: string, predicted: string[], phaseId = 'main'): CaseResult {
  return {
    id,
    tags: ['t1'],
    status: 'ok',
    filesScanned: 10,
    durationMs: 1,
    costUsd: 0,
    phases: [scorePhase({ id: phaseId, packages: ['react'], tags: ['t1'] }, truth4, predicted)],
    findings: null
  };
}

function file(label: string, cases: CaseResult[], visibility: Visibility = 'public'): ResultFile {
  return buildResultFile({
    label,
    generatedAt: '2026-11-09T00:00:00.000Z',
    predictor: 'v1-code-scan',
    tool: { commit: 'abc', dirty: false },
    visibility,
    cases
  });
}

describe('compareResults', () => {
  it('computes deltas, including null handling', () => {
    const md = compareResults(file('a', [okCase('x-case', ['a.ts'])]), file('b', [okCase('x-case', ['a.ts', 'b.ts'])]));
    // recall 0.25 → 0.5; precision 1 → 1
    expect(md).toContain('| x-case · main | 1.000 | 1.000 | 0.000 | 0.250 | 0.500 | +0.250 |');
    const nulls = compareResults(file('a', [okCase('x-case', [])]), file('b', [okCase('x-case', ['a.ts'])]));
    expect(nulls).toContain('| x-case · main | n/a | 1.000 | — |');
  });

  it('shows a case missing on one side as —, not 0', () => {
    const md = compareResults(file('a', [okCase('x-case', ['a.ts'])]), file('b', [okCase('y-case', ['a.ts'])]));
    expect(md).toContain('| x-case · main | 1.000 | — | — | 0.250 | — | — |');
    expect(md).toContain('| y-case · main | — | 1.000 | — | — | 0.250 | — |');
  });

  it('refuses a visibility mismatch', () => {
    expect(() => compareResults(file('a', []), file('b', [], 'private'))).toThrow(/public file with a private file/);
  });

  it('refuses a different schemaVersion', () => {
    const b = { ...file('b', []), schemaVersion: 2 } as unknown as ResultFile;
    expect(() => compareResults(file('a', []), b)).toThrow(/schemaVersion 2/);
  });

  it('orders rows by case id, then tags, then the aggregate', () => {
    const md = compareResults(
      file('a', [okCase('zeta-case', ['a.ts']), okCase('alpha-case', ['a.ts'])]),
      file('b', [okCase('alpha-case', ['a.ts'])])
    );
    const labels = md
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| row'))
      .map((l) => l.split('|')[1]?.trim());
    expect(labels).toEqual([
      'alpha-case · main',
      'zeta-case · main',
      'tag:t1 (micro)',
      'aggregate (micro)',
      'aggregate (macro)'
    ]);
  });
});
