/**
 * Golden-finding sheet (v2 Stage 0.8): render → strict parse → score.
 */
import { describe, it, expect } from 'vitest';
import {
  FindingsSheetError,
  parseFindingsSheet,
  renderFindingsSheet,
  scoreFindings
} from '../../../eval/lib/findings';
import type { FindingVerdict, GoldenFinding } from '../../../eval/lib/types';

function finding(id: string, expected: GoldenFinding['expected'], extra: Partial<GoldenFinding> = {}): GoldenFinding {
  return { id, phase: 'p1', title: `title ${id}`, category: 'cat', expected, verified: true, ...extra };
}

const findings: GoldenFinding[] = [
  finding('G01', 'yes', { evidenceFiles: ['src/a.tsx', 'src/b.tsx'] }),
  finding('G02', 'yes', { title: 'pipe | in title' }),
  finding('G03', 'partial'),
  finding('G04', 'l3')
];
const expectedIds = [{ caseId: 'private-fixture', findingIds: findings.map((f) => f.id) }];

function sheet(): string {
  return renderFindingsSheet('2026-11-09-x.json', [
    { caseId: 'private-fixture', findings, predicted: new Map([['p1', ['src/a.tsx']]]) }
  ]);
}

/** Fill the verdict cell (6th column) of the row for `id`. */
function fill(md: string, id: string, verdict: string): string {
  return md
    .split('\n')
    .map((line) => {
      if (!line.startsWith(`| ${id} |`)) return line;
      const cells = line.split(/(?<!\\)\|/);
      cells[6] = ` ${verdict} `;
      return cells.join('|');
    })
    .join('\n');
}

describe('renderFindingsSheet', () => {
  it('renders the evidence hint and blank verdicts', () => {
    const md = sheet();
    expect(md).toContain('## Case: private-fixture');
    expect(md).toContain('| G01 | p1 | yes | title G01 | 1/2 files predicted |  |  |');
    expect(md).toContain('| G03 | p1 | partial | title G03 | — |  |  |');
    expect(md).toContain('pipe \\| in title');
  });
});

describe('parseFindingsSheet', () => {
  it('round-trips: blank verdicts stay null, filled ones parse', () => {
    let md = sheet();
    md = fill(md, 'G01', 'found');
    md = fill(md, 'G02', 'partial');
    md = fill(md, 'G04', 'n/a');
    const parsed = parseFindingsSheet(md, expectedIds).get('private-fixture');
    expect(parsed?.get('G01')).toBe('found');
    expect(parsed?.get('G02')).toBe('partial');
    expect(parsed?.get('G03')).toBeNull();
    expect(parsed?.get('G04')).toBe('n/a');
  });

  it('rejects an unknown verdict and names the line', () => {
    const md = fill(sheet(), 'G01', 'yes');
    const lineNo = md.split('\n').findIndex((l) => l.startsWith('| G01 |')) + 1;
    expect(() => parseFindingsSheet(md, expectedIds)).toThrow(new RegExp(`line ${lineNo}: unknown verdict "yes"`));
  });

  it('rejects a missing row', () => {
    const md = sheet()
      .split('\n')
      .filter((l) => !l.startsWith('| G03 |'))
      .join('\n');
    expect(() => parseFindingsSheet(md, expectedIds)).toThrow(/missing row "G03"/);
  });

  it('rejects an extra row and a duplicated row', () => {
    const extra = sheet().replace('| G04 |', '| G99 | p1 | yes | x | — |  |  |\n| G04 |');
    expect(() => parseFindingsSheet(extra, expectedIds)).toThrow(/extra row "G99"/);
    const dup = sheet().replace('| G04 |', '| G03 | p1 | partial | x | — |  |  |\n| G04 |');
    expect(() => parseFindingsSheet(dup, expectedIds)).toThrow(/row "G03" appears twice/);
  });

  it('rejects a missing case and an unknown case', () => {
    expect(() => parseFindingsSheet('# empty\n', expectedIds)).toThrow(/case "private-fixture" is missing/);
    const other = sheet().replace('## Case: private-fixture', '## Case: someone-else');
    expect(() => parseFindingsSheet(other, expectedIds)).toThrow(FindingsSheetError);
  });

  it('reports a bad verdict once, not also as a missing row', () => {
    try {
      parseFindingsSheet(fill(sheet(), 'G02', 'maybe'), expectedIds);
      expect.unreachable();
    } catch (e) {
      expect((e as FindingsSheetError).problems).toHaveLength(1);
    }
  });
});

describe('scoreFindings', () => {
  const many: GoldenFinding[] = [
    finding('Y1', 'yes'),
    finding('Y2', 'yes'),
    finding('Y3', 'yes'),
    finding('Y4', 'yes'),
    finding('Y5', 'yes'),
    finding('N1', 'no', { verified: false })
  ];

  it('scores 2 found + 1 partial of 4 yes as 0.625 and excludes unscored', () => {
    const v = new Map<string, FindingVerdict | null>([
      ['Y1', 'found'],
      ['Y2', 'found'],
      ['Y3', 'partial'],
      ['Y4', 'missed'],
      ['Y5', null],
      ['N1', 'n/a']
    ]);
    const s = scoreFindings(many, v, '2026-11-09T00:00:00.000Z');
    expect(s.expectedYes).toEqual({ n: 4, score: 2.5, recall: 0.625 });
    expect(s.expectedNo).toEqual({ n: 0, score: 0, recall: null });
    expect(s.unscored).toBe(2);
  });

  it('flags an unverified golden set', () => {
    expect(scoreFindings(many, new Map(), 'x').unverifiedGoldenSet).toBe(true);
    expect(scoreFindings(many.slice(0, 5), new Map(), 'x').unverifiedGoldenSet).toBe(false);
  });
});
