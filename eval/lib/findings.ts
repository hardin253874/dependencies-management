/**
 * Golden-finding sheet: `run` renders a Markdown table per case with a blank
 * `verdict` column; a person fills it in; `score-findings` parses it back.
 *
 * Parsing is strict on purpose — a typo'd verdict or a dropped row must fail
 * loudly (naming the line) rather than silently shift a recall number, and a
 * blank verdict is never defaulted to anything.
 */
import type { FindingGroupScore, FindingVerdict, FindingsScore, GoldenExpected, GoldenFinding } from './types';

export const VERDICTS: readonly FindingVerdict[] = ['found', 'partial', 'missed', 'n/a'];
const VERDICT_SCORE: Record<Exclude<FindingVerdict, 'n/a'>, number> = { found: 1, partial: 0.5, missed: 0 };
const HEADER = ['id', 'phase', 'expected', 'title', 'evidence hit', 'verdict', 'note'];
const CASE_HEADING_RE = /^## Case: (\S+)\s*$/;

export interface SheetCase {
  caseId: string;
  findings: readonly GoldenFinding[];
  /** phase id → predicted paths, for the evidence-hit hint. */
  predicted: ReadonlyMap<string, readonly string[]>;
}

export class FindingsSheetError extends Error {
  constructor(readonly problems: string[]) {
    super(`findings sheet has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    this.name = 'FindingsSheetError';
  }
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function evidenceHint(f: GoldenFinding, predicted: ReadonlyMap<string, readonly string[]>): string {
  const files = f.evidenceFiles ?? [];
  if (files.length === 0) return '—';
  const set = new Set(predicted.get(f.phase) ?? []);
  const hits = files.filter((p) => set.has(p)).length;
  return `${hits}/${files.length} files predicted`;
}

export function renderFindingsSheet(resultsFileName: string, cases: readonly SheetCase[]): string {
  const lines: string[] = [
    `# Findings sheet — ${resultsFileName}`,
    '',
    `Fill the \`verdict\` column with one of: ${VERDICTS.join(', ')}. Leave it blank to skip an item.`,
    'Do not add, remove or reorder rows. Then run `npm run eval -- score-findings <results.json>`.',
    ''
  ];
  for (const c of cases) {
    lines.push(`## Case: ${c.caseId}`, '');
    lines.push(`| ${HEADER.join(' | ')} |`);
    lines.push(`|${HEADER.map(() => '----').join('|')}|`);
    for (const f of c.findings) {
      const cells = [f.id, f.phase, f.expected, escapeCell(f.title), evidenceHint(f, c.predicted), '', ''];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * Parse a filled sheet. `expected` lists, per case, the finding ids the
 * sheet must contain exactly once each. Throws FindingsSheetError with every
 * problem found.
 */
export function parseFindingsSheet(
  markdown: string,
  expected: ReadonlyArray<{ caseId: string; findingIds: readonly string[] }>
): Map<string, Map<string, FindingVerdict | null>> {
  const problems: string[] = [];
  const wanted = new Map(expected.map((e) => [e.caseId, new Set(e.findingIds)] as const));
  const out = new Map<string, Map<string, FindingVerdict | null>>();
  const caseLine = new Map<string, number>();
  // Rows seen per case, including rows rejected for a bad verdict, so a bad
  // verdict is not also reported as a missing row.
  const seen = new Map<string, Set<string>>();
  let current: string | null = null;

  markdown.split(/\r?\n/).forEach((line, idx) => {
    const lineNo = idx + 1;
    const heading = CASE_HEADING_RE.exec(line);
    if (heading !== null) {
      const id = heading[1] as string;
      if (!wanted.has(id)) {
        problems.push(`line ${lineNo}: unknown case "${id}"`);
        current = null;
      } else if (out.has(id)) {
        problems.push(`line ${lineNo}: case "${id}" appears twice`);
        current = null;
      } else {
        out.set(id, new Map());
        seen.set(id, new Set());
        caseLine.set(id, lineNo);
        current = id;
      }
      return;
    }
    if (!line.trim().startsWith('|')) return;
    const cells = splitRow(line);
    if (cells[0] === 'id' || cells.every((c) => /^:?-+:?$/.test(c))) return;
    if (current === null) {
      problems.push(`line ${lineNo}: table row outside a known "## Case:" section`);
      return;
    }
    if (cells.length !== HEADER.length) {
      problems.push(`line ${lineNo}: expected ${HEADER.length} columns, found ${cells.length}`);
      return;
    }
    const findingId = cells[0] as string;
    const rows = out.get(current) as Map<string, FindingVerdict | null>;
    if (!(wanted.get(current) as Set<string>).has(findingId)) {
      problems.push(`line ${lineNo}: extra row "${findingId}" (not a golden finding of ${current})`);
      return;
    }
    const seenRows = seen.get(current) as Set<string>;
    if (seenRows.has(findingId)) {
      problems.push(`line ${lineNo}: row "${findingId}" appears twice`);
      return;
    }
    seenRows.add(findingId);
    const verdict = cells[5] as string;
    if (verdict === '') {
      rows.set(findingId, null);
    } else if ((VERDICTS as readonly string[]).includes(verdict)) {
      rows.set(findingId, verdict as FindingVerdict);
    } else {
      problems.push(`line ${lineNo}: unknown verdict "${verdict}" for ${findingId} (allowed: ${VERDICTS.join(', ')} or blank)`);
    }
  });

  for (const [caseId, ids] of wanted) {
    const seenRows = seen.get(caseId);
    if (seenRows === undefined) {
      problems.push(`case "${caseId}" is missing from the sheet`);
      continue;
    }
    for (const id of ids) {
      if (!seenRows.has(id)) {
        problems.push(`line ${caseLine.get(caseId)}: case "${caseId}" is missing row "${id}"`);
      }
    }
  }
  if (problems.length > 0) throw new FindingsSheetError(problems);
  return out;
}

function group(): FindingGroupScore {
  return { n: 0, score: 0, recall: null };
}

const GROUP_KEY: Record<GoldenExpected, 'expectedYes' | 'expectedPartial' | 'expectedNo' | 'l3'> = {
  yes: 'expectedYes',
  partial: 'expectedPartial',
  no: 'expectedNo',
  l3: 'l3'
};

export function scoreFindings(
  findings: readonly GoldenFinding[],
  verdicts: ReadonlyMap<string, FindingVerdict | null>,
  scoredAt: string
): FindingsScore {
  const out: FindingsScore = {
    scoredAt,
    expectedYes: group(),
    expectedPartial: group(),
    expectedNo: group(),
    l3: group(),
    unscored: 0,
    unverifiedGoldenSet: findings.some((f) => !f.verified)
  };
  for (const f of findings) {
    const v = verdicts.get(f.id) ?? null;
    if (v === null || v === 'n/a') {
      out.unscored += 1;
      continue;
    }
    const g = out[GROUP_KEY[f.expected]];
    g.n += 1;
    g.score += VERDICT_SCORE[v];
  }
  for (const key of ['expectedYes', 'expectedPartial', 'expectedNo', 'l3'] as const) {
    const g = out[key];
    g.recall = g.n === 0 ? null : g.score / g.n;
  }
  return out;
}
