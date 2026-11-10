/**
 * Result-file delta table (pure). A case or tag present on only one side is
 * shown as "—", never as 0, so a dropped case cannot look like a regression
 * to zero (or hide one).
 */
import { RESULT_SCHEMA_VERSION, type PrecisionRecall, type ResultFile } from './types';

export class CompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompareError';
  }
}

const MISSING = '—';

function fmt(v: number | null | undefined): string {
  if (v === undefined) return MISSING;
  if (v === null) return 'n/a';
  return v.toFixed(3);
}

function delta(a: number | null | undefined, b: number | null | undefined): string {
  if (a === undefined || b === undefined || a === null || b === null) return MISSING;
  const d = b - a;
  const s = d.toFixed(3);
  return d > 0 ? `+${s}` : d === 0 ? '0.000' : s;
}

interface Row {
  label: string;
  a?: PrecisionRecall;
  b?: PrecisionRecall;
  findingsA?: number | null;
  findingsB?: number | null;
}

function cells(r: Row, showFindings: boolean): string {
  const cols = [
    r.label,
    fmt(r.a?.precision),
    fmt(r.b?.precision),
    delta(r.a?.precision, r.b?.precision),
    fmt(r.a?.recall),
    fmt(r.b?.recall),
    delta(r.a?.recall, r.b?.recall)
  ];
  if (showFindings) cols.push(delta(r.findingsA, r.findingsB));
  return `| ${cols.join(' | ')} |`;
}

function sorted(keys: Iterable<string>): string[] {
  return Array.from(new Set(keys)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

export function compareResults(a: ResultFile, b: ResultFile): string {
  for (const [name, f] of [
    ['a', a],
    ['b', b]
  ] as const) {
    if (f.schemaVersion !== RESULT_SCHEMA_VERSION) {
      throw new CompareError(
        `file ${name} has schemaVersion ${String(f.schemaVersion)}; this tool reads ${RESULT_SCHEMA_VERSION}`
      );
    }
  }
  if (a.visibility !== b.visibility) {
    throw new CompareError(`refusing to compare a ${a.visibility} file with a ${b.visibility} file`);
  }

  const casesA = new Map(a.cases.map((c) => [c.id, c] as const));
  const casesB = new Map(b.cases.map((c) => [c.id, c] as const));
  const rows: Row[] = [];
  let showFindings = false;

  for (const id of sorted([...casesA.keys(), ...casesB.keys()])) {
    const ca = casesA.get(id);
    const cb = casesB.get(id);
    const phasesA = new Map((ca?.status === 'ok' ? ca.phases : []).map((p) => [p.id, p] as const));
    const phasesB = new Map((cb?.status === 'ok' ? cb.phases : []).map((p) => [p.id, p] as const));
    const fa = ca?.findings?.expectedYes.recall;
    const fb = cb?.findings?.expectedYes.recall;
    if (fa !== undefined && fb !== undefined) showFindings = true;
    const phaseIds = sorted([...phasesA.keys(), ...phasesB.keys()]);
    if (phaseIds.length === 0) {
      rows.push({ label: `${id} (${ca?.status ?? MISSING} / ${cb?.status ?? MISSING})` });
      continue;
    }
    for (const pid of phaseIds) {
      const pa = phasesA.get(pid);
      const pb = phasesB.get(pid);
      const row: Row = { label: `${id} · ${pid}` };
      if (pa !== undefined) row.a = pa;
      if (pb !== undefined) row.b = pb;
      if (fa !== undefined) row.findingsA = fa;
      if (fb !== undefined) row.findingsB = fb;
      rows.push(row);
    }
  }

  for (const tag of sorted([...Object.keys(a.aggregate.byTag), ...Object.keys(b.aggregate.byTag)])) {
    const ta = a.aggregate.byTag[tag];
    const tb = b.aggregate.byTag[tag];
    const row: Row = { label: `tag:${tag} (micro)` };
    if (ta !== undefined) row.a = ta.micro;
    if (tb !== undefined) row.b = tb.micro;
    rows.push(row);
  }
  rows.push({ label: 'aggregate (micro)', a: a.aggregate.micro, b: b.aggregate.micro });
  rows.push({ label: 'aggregate (macro)', a: a.aggregate.macro, b: b.aggregate.macro });

  // v2-agent:subset (Stage 5a.7). Older files have no aggregateSubset: their side shows "—".
  const sa = a.aggregateSubset;
  const sb = b.aggregateSubset;
  if (sa !== undefined || sb !== undefined) {
    for (const tag of sorted([...Object.keys(sa?.byTag ?? {}), ...Object.keys(sb?.byTag ?? {})])) {
      const row: Row = { label: `subset tag:${tag} (micro)` };
      const ta = sa?.byTag[tag];
      const tb = sb?.byTag[tag];
      if (ta !== undefined) row.a = ta.micro;
      if (tb !== undefined) row.b = tb.micro;
      rows.push(row);
    }
    const micro: Row = { label: 'subset aggregate (micro)' };
    const macro: Row = { label: 'subset aggregate (macro)' };
    if (sa !== undefined) {
      micro.a = sa.micro;
      macro.a = sa.macro;
    }
    if (sb !== undefined) {
      micro.b = sb.micro;
      macro.b = sb.macro;
    }
    rows.push(micro, macro);
  }

  const header = ['row', 'P_a', 'P_b', 'ΔP', 'R_a', 'R_b', 'ΔR'];
  if (showFindings) header.push('findings recall Δ');
  return [
    `Comparing **${a.label}** (a, ${a.generatedAt}) → **${b.label}** (b, ${b.generatedAt}) · ${a.visibility}`,
    '',
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => cells(r, showFindings)),
    '',
    `errors: a=${a.aggregate.errors} b=${b.aggregate.errors}`,
    ''
  ].join('\n');
}
