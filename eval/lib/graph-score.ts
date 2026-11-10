/**
 * `eval -- graph` (V2_STAGE3_SPEC 3b-B.3): graph `direct ∪ reexport` vs the
 * TypeScript truth, per package and per case, plus unresolved %.
 *
 * Measurement only, never a test gate. Public and private cases go to
 * separate files (same routing as `run`, `results.ts`); a private case's
 * file carries numbers only: no sample paths, no specifiers.
 *
 * Side effects (clone, truth build, graph build) are injected so the
 * scoring and privacy rules are tested without git or real repos.
 */
import { promises as fs } from 'fs';
import path from 'path';
import ts from 'typescript';
// Relative import on purpose (not `@/…`): see predict-v1.ts (R1).
import { atomicWriteJson } from '../../src/lib/storage/atomic';
import { TRUTH_LIMITATIONS, TRUTH_VERSION, type CaseTruthFile } from './graph-truth';
import { prefixed, type ProjectDirGraph } from './predict-graph';
import { LabelCollisionError, localDate, resultFilePath } from './results';
import {
  GRAPH_RESULT_SCHEMA_VERSION,
  type GraphAggregate,
  type GraphCaseResult,
  type GraphPackageResult,
  type GraphPackageSource,
  type GraphResultFile,
  type GraphSample,
  type GraphUnresolved,
  type LoadedCase,
  type SetScore,
  type ToolInfo,
  type Visibility
} from './types';

export const GRAPH_SAMPLE = 20;
export const RECALL_TARGET = 0.95;
export const PRECISION_TARGET = 0.9;
export const UNRESOLVED_TARGET = 0.02;

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

function mean(values: Array<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? (xs[mid] as number) : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2;
}

export function scoreSets(truth: ReadonlySet<string>, predicted: ReadonlySet<string>): SetScore {
  let tp = 0;
  for (const p of predicted) if (truth.has(p)) tp += 1;
  return {
    truth: truth.size,
    predicted: predicted.size,
    tp,
    precision: ratio(tp, predicted.size),
    recall: ratio(tp, truth.size)
  };
}

/** Sums counts; precision/recall recomputed from the sums (micro average). */
export function microOf(scores: readonly SetScore[]): SetScore {
  const truth = scores.reduce((s, x) => s + x.truth, 0);
  const predicted = scores.reduce((s, x) => s + x.predicted, 0);
  const tp = scores.reduce((s, x) => s + x.tp, 0);
  return { truth, predicted, tp, precision: ratio(tp, predicted), recall: ratio(tp, truth) };
}

export function macroOf(scores: ReadonlyArray<Pick<SetScore, 'precision' | 'recall'>>): { precision: number | null; recall: number | null } {
  return { precision: mean(scores.map((s) => s.precision)), recall: mean(scores.map((s) => s.recall)) };
}

interface PkgAcc {
  truth: Set<string>;
  graph: Set<string>;
  wrapper: number;
  aliasOnly: number;
  configRefOnly: number;
  workspace: boolean;
}

export interface ScoreCaseInput {
  c: Pick<LoadedCase, 'id' | 'tags' | 'visibility'>;
  truth: CaseTruthFile;
  truthCached: boolean;
  graphs: readonly ProjectDirGraph[];
  packagesFor(projectDir: string): readonly string[];
}

/** One case: per-package scores over (projectDir-prefixed) files, micro + macro, unresolved, samples. */
export function scoreGraphCase(input: ScoreCaseInput): GraphCaseResult {
  const isPublic = input.c.visibility === 'public';
  const acc = new Map<string, PkgAcc>();
  const unresolvedTotals = { totalEdges: 0, unresolved: 0, byReason: {} as Record<string, number> };
  let packagesQueried = 0;
  let reexportOk = true;
  const files = { graph: 0, truth: 0 };
  const truthMs = { direct: 0, reexport: 0 };
  const truthStats = { specifiers: 0, unresolvedRelative: 0, bareByName: 0 };
  let buildMs = 0;
  const topUnresolved: NonNullable<GraphCaseResult['topUnresolved']> = [];

  for (const g of input.graphs) {
    const t = input.truth.projectDirs.find((d) => d.projectDir === g.projectDir);
    if (t === undefined) throw new Error(`no truth for projectDir ${g.projectDir}`);
    if (t.reexportTruth !== 'ok') reexportOk = false;
    files.graph += g.files;
    files.truth += t.files;
    buildMs += g.buildMs;
    truthMs.direct += t.timing.directMs;
    truthMs.reexport += t.timing.reexportMs;
    truthStats.specifiers += t.specifiers;
    truthStats.unresolvedRelative += t.unresolvedRelative;
    truthStats.bareByName += t.bareByName;
    unresolvedTotals.totalEdges += g.unresolved.totalEdges;
    unresolvedTotals.unresolved += g.unresolved.unresolved;
    for (const [reason, n] of Object.entries(g.unresolved.byReason)) {
      unresolvedTotals.byReason[reason] = (unresolvedTotals.byReason[reason] ?? 0) + (n ?? 0);
    }
    for (const u of g.topUnresolved) topUnresolved.push({ projectDir: g.projectDir, ...u });

    const pkgs = [...new Set(input.packagesFor(g.projectDir))];
    packagesQueried += pkgs.length;
    for (const pkg of pkgs) {
      let a = acc.get(pkg);
      if (a === undefined) {
        a = { truth: new Set(), graph: new Set(), wrapper: 0, aliasOnly: 0, configRefOnly: 0, workspace: false };
        acc.set(pkg, a);
      }
      const tp = t.packages[pkg];
      for (const p of [...(tp?.direct ?? []), ...(tp?.reexport ?? [])]) a.truth.add(prefixed(g.projectDir, p));
      const gp = g.packages[pkg];
      if (gp !== undefined) {
        for (const p of [...gp.direct, ...gp.reexport]) a.graph.add(prefixed(g.projectDir, p));
        a.wrapper += gp.wrapper.length;
        a.aliasOnly += gp.aliasOnly.length;
        a.configRefOnly += gp.configRefOnly.length;
        if (gp.isWorkspace) a.workspace = true;
      }
    }
  }

  const packages: GraphPackageResult[] = [];
  const graphOnly: GraphSample[] = [];
  const truthOnly: GraphSample[] = [];
  for (const name of [...acc.keys()].sort()) {
    const a = acc.get(name) as PkgAcc;
    if (a.truth.size === 0 && a.graph.size === 0 && a.wrapper === 0 && a.aliasOnly === 0 && a.configRefOnly === 0) continue;
    packages.push({
      name,
      ...scoreSets(a.truth, a.graph),
      wrapperHits: a.wrapper,
      aliasOnlyHits: a.aliasOnly,
      configRefOnlyHits: a.configRefOnly,
      workspace: a.workspace
    });
    if (a.workspace) continue;
    for (const p of [...a.graph].sort()) if (!a.truth.has(p)) graphOnly.push({ pkg: name, path: p });
    for (const p of [...a.truth].sort()) if (!a.graph.has(p)) truthOnly.push({ pkg: name, path: p });
  }
  const scored = packages.filter((p) => !p.workspace && (p.truth > 0 || p.predicted > 0));
  const unresolved: GraphUnresolved = {
    totalEdges: unresolvedTotals.totalEdges,
    unresolved: unresolvedTotals.unresolved,
    pct: ratio(unresolvedTotals.unresolved, unresolvedTotals.totalEdges),
    byReason: unresolvedTotals.byReason
  };
  const result: GraphCaseResult = {
    id: input.c.id,
    tags: input.c.tags,
    status: 'ok',
    files,
    buildMs,
    truthMs,
    truthCached: input.truthCached,
    reexportTruth: reexportOk ? 'ok' : 'unavailable',
    packagesQueried,
    micro: microOf(scored),
    macro: macroOf(scored),
    packages,
    wrapperHits: packages.reduce((s, p) => s + p.wrapperHits, 0),
    aliasOnlyHits: packages.reduce((s, p) => s + p.aliasOnlyHits, 0),
    configRefOnlyHits: packages.reduce((s, p) => s + p.configRefOnlyHits, 0),
    workspacePackages: packages.filter((p) => p.workspace).length,
    unresolved,
    truthStats
  };
  if (isPublic) {
    result.graphOnlySample = graphOnly.slice(0, GRAPH_SAMPLE);
    result.truthOnlySample = truthOnly.slice(0, GRAPH_SAMPLE);
    result.topUnresolved = topUnresolved.sort((x, y) => y.count - x.count || (x.specifier < y.specifier ? -1 : 1)).slice(0, 15);
  }
  return result;
}

export function graphErrorCase(c: Pick<LoadedCase, 'id' | 'tags'>, message: string): GraphCaseResult {
  const empty: SetScore = { truth: 0, predicted: 0, tp: 0, precision: null, recall: null };
  return {
    id: c.id,
    tags: c.tags,
    status: 'error',
    error: message,
    files: { graph: 0, truth: 0 },
    buildMs: 0,
    truthMs: { direct: 0, reexport: 0 },
    truthCached: false,
    reexportTruth: 'unavailable',
    packagesQueried: 0,
    micro: empty,
    macro: { precision: null, recall: null },
    packages: [],
    wrapperHits: 0,
    aliasOnlyHits: 0,
    configRefOnlyHits: 0,
    workspacePackages: 0,
    unresolved: { totalEdges: 0, unresolved: 0, pct: null, byReason: {} },
    truthStats: { specifiers: 0, unresolvedRelative: 0, bareByName: 0 }
  };
}

export function aggregateGraph(cases: readonly GraphCaseResult[]): GraphAggregate {
  const ok = cases.filter((c) => c.status === 'ok');
  const micro = microOf(ok.map((c) => c.micro));
  const macro = macroOf(ok.map((c) => c.micro));
  const medianUnresolvedPct = median(ok.map((c) => c.unresolved.pct).filter((v): v is number => v !== null));
  const recallMet = micro.recall !== null && micro.recall >= RECALL_TARGET;
  const precisionMet = micro.precision !== null && micro.precision >= PRECISION_TARGET;
  const unresolvedMet = medianUnresolvedPct !== null && medianUnresolvedPct <= UNRESOLVED_TARGET;
  return {
    micro,
    macro,
    medianUnresolvedPct,
    errors: cases.length - ok.length,
    targets: {
      recallTarget: RECALL_TARGET,
      precisionTarget: PRECISION_TARGET,
      unresolvedTarget: UNRESOLVED_TARGET,
      recallMet,
      precisionMet,
      unresolvedMet,
      met: recallMet && precisionMet && unresolvedMet
    }
  };
}

// ---------------------------------------------------------------- run

/** `<date>-<label>-graph.json`, public in `resultsDir`, private in `resultsDir/private`. */
export function graphResultPath(resultsDir: string, visibility: Visibility, date: string, label: string): string {
  return resultFilePath(resultsDir, visibility, date, `${label}-graph`);
}

/** Every dependency name in `<cloneDir>/<projectDir>/package.json` (empty when missing). */
export async function readDeclaredPackages(cloneDir: string, projectDir: string): Promise<string[]> {
  const file = path.join(cloneDir, projectDir, 'package.json');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = json[field];
    if (deps !== null && typeof deps === 'object') for (const k of Object.keys(deps)) names.add(k);
  }
  return [...names].sort();
}

export interface GraphRunDeps {
  prepare(c: LoadedCase): Promise<string>;
  truth(c: LoadedCase, cloneDir: string): Promise<{ truth: CaseTruthFile; cached: boolean }>;
  graph(c: LoadedCase, cloneDir: string, packagesFor: (projectDir: string) => readonly string[]): Promise<ProjectDirGraph[]>;
  declared(cloneDir: string, projectDir: string): Promise<string[]>;
  log(line: string): void;
}

export interface GraphRunOptions {
  cases: readonly LoadedCase[];
  label: string;
  packages: GraphPackageSource;
  tool: ToolInfo;
  resultsDir: string;
  now: Date;
  deps: GraphRunDeps;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(3);
}

async function runGraphCase(c: LoadedCase, opts: GraphRunOptions): Promise<GraphCaseResult> {
  try {
    const cloneDir = await opts.deps.prepare(c);
    const phaseNames = [...new Set(c.phases.flatMap((p) => p.packages.map((x) => x.name)))].sort();
    const byDir = new Map<string, readonly string[]>();
    for (const d of c.projectDirs) {
      byDir.set(d, opts.packages === 'phase' ? phaseNames : await opts.deps.declared(cloneDir, d));
    }
    const packagesFor = (d: string): readonly string[] => byDir.get(d) ?? [];
    const { truth, cached } = await opts.deps.truth(c, cloneDir);
    const graphs = await opts.deps.graph(c, cloneDir, packagesFor);
    return scoreGraphCase({ c, truth, truthCached: cached, graphs, packagesFor });
  } catch (e) {
    return graphErrorCase(c, (e as Error).message);
  }
}

export function buildGraphResultFile(args: {
  label: string;
  generatedAt: string;
  tool: ToolInfo;
  visibility: Visibility;
  packages: GraphPackageSource;
  cases: GraphCaseResult[];
}): GraphResultFile {
  return {
    kind: 'graph-usage',
    schemaVersion: GRAPH_RESULT_SCHEMA_VERSION,
    label: args.label,
    generatedAt: args.generatedAt,
    tool: args.tool,
    visibility: args.visibility,
    packages: args.packages,
    scoredSet: 'direct+reexport (JS/TS files)',
    truth: { method: 'typescript resolveModuleName + checker alias chains', truthVersion: TRUTH_VERSION, tsVersion: ts.version, limitations: TRUTH_LIMITATIONS },
    cases: args.cases,
    aggregate: aggregateGraph(args.cases)
  };
}

export async function runGraphEval(opts: GraphRunOptions): Promise<{ exitCode: 0 | 2; written: string[]; results: GraphResultFile[] }> {
  const date = localDate(opts.now);
  const visibilities = (['public', 'private'] as const).filter((v) => opts.cases.some((c) => c.visibility === v));
  for (const v of visibilities) {
    const target = graphResultPath(opts.resultsDir, v, date, opts.label);
    if (await exists(target)) throw new LabelCollisionError(target);
  }
  const done: Array<{ c: LoadedCase; result: GraphCaseResult }> = [];
  for (const c of opts.cases) {
    const result = await runGraphCase(c, opts);
    done.push({ c, result });
    if (result.status === 'error') {
      opts.deps.log(`${c.id}: ERROR ${result.error ?? ''}`);
    } else {
      opts.deps.log(
        `${c.id}: ${result.files.graph} files · R=${fmt(result.micro.recall)} P=${fmt(result.micro.precision)} · unresolved ${fmt(result.unresolved.pct)} · build ${result.buildMs} ms${result.truthCached ? ' · truth cached' : ''}`
      );
    }
  }
  const written: string[] = [];
  const results: GraphResultFile[] = [];
  for (const v of visibilities) {
    const file = buildGraphResultFile({
      label: opts.label,
      generatedAt: opts.now.toISOString(),
      tool: opts.tool,
      visibility: v,
      packages: opts.packages,
      cases: done.filter((d) => d.c.visibility === v).map((d) => d.result)
    });
    const target = graphResultPath(opts.resultsDir, v, date, opts.label);
    await atomicWriteJson(target, file);
    written.push(target);
    results.push(file);
  }
  return { exitCode: done.some((d) => d.result.status === 'error') ? 2 : 0, written, results };
}
