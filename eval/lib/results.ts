/**
 * `run` orchestration + result files. Public and private cases go to
 * separate files, each with its own aggregate, so a public result file can
 * never carry a private id, repo or path.
 *
 * All side effects (clone, git diff, scan) are injected, so the split and
 * exit-code rules are tested without git.
 */
import { promises as fs } from 'fs';
import path from 'path';
// Relative import on purpose (not `@/…`): see predict-v1.ts (R1).
import { atomicWriteJson } from '../../src/lib/storage/atomic';
import { phaseTags } from './corpus';
import { renderFindingsSheet, type SheetCase } from './findings';
import { aggregate, scorePhase } from './score';
import {
  RESULT_SCHEMA_VERSION,
  type CasePrediction,
  type CaseResult,
  type LoadedCase,
  type PredictorId,
  type ResultFile,
  type ToolInfo,
  type TruthSet,
  type Visibility
} from './types';

export interface RunDeps {
  prepare(c: LoadedCase): Promise<string>;
  truth(c: LoadedCase, cloneDir: string): Promise<Array<{ phaseId: string; truth: TruthSet }>>;
  predict(c: LoadedCase, cloneDir: string): Promise<CasePrediction>;
  log(line: string): void;
}

export interface RunOptions {
  cases: readonly LoadedCase[];
  label: string;
  predictor: PredictorId;
  tool: ToolInfo;
  /** `eval/results`; private files go to `<resultsDir>/private`. */
  resultsDir: string;
  now: Date;
  deps: RunDeps;
}

export interface RunOutcome {
  exitCode: 0 | 2;
  written: string[];
  results: ResultFile[];
}

export class LabelCollisionError extends Error {
  constructor(readonly existing: string) {
    super(`results file ${existing} already exists — pick a new --label (results are never overwritten)`);
    this.name = 'LabelCollisionError';
  }
}

/** YYYY-MM-DD in local time (the date a person sees on their machine). */
export function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function resultFilePath(resultsDir: string, visibility: Visibility, date: string, label: string): string {
  const dir = visibility === 'private' ? path.join(resultsDir, 'private') : resultsDir;
  return path.join(dir, `${date}-${label}.json`);
}

export function findingsSheetPath(resultsPath: string): string {
  return resultsPath.replace(/\.json$/i, '') + '.findings.md';
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(2);
}

function errorCase(c: LoadedCase, message: string): CaseResult {
  return {
    id: c.id,
    tags: c.tags,
    status: 'error',
    error: message,
    filesScanned: 0,
    durationMs: 0,
    costUsd: 0,
    phases: [],
    findings: null
  };
}

export async function runCase(
  c: LoadedCase,
  deps: RunDeps
): Promise<{ result: CaseResult; prediction: CasePrediction | null }> {
  try {
    const cloneDir = await deps.prepare(c);
    const truths = await deps.truth(c, cloneDir);
    const prediction = await deps.predict(c, cloneDir);
    const phases = c.phases.map((phase) => {
      const t = truths.find((x) => x.phaseId === phase.id);
      if (t === undefined) throw new Error(`no truth computed for phase ${phase.id}`);
      return scorePhase(
        { id: phase.id, packages: phase.packages.map((p) => p.name), tags: phaseTags(c, phase) },
        t.truth,
        prediction.byPhase.get(phase.id) ?? []
      );
    });
    return {
      result: {
        id: c.id,
        tags: c.tags,
        status: 'ok',
        filesScanned: prediction.filesScanned,
        durationMs: prediction.durationMs,
        // No predictor calls an LLM in round 1.
        costUsd: 0,
        phases,
        findings: null
      },
      prediction
    };
  } catch (e) {
    return { result: errorCase(c, (e as Error).message), prediction: null };
  }
}

export function buildResultFile(args: {
  label: string;
  generatedAt: string;
  predictor: PredictorId;
  tool: ToolInfo;
  visibility: Visibility;
  cases: CaseResult[];
}): ResultFile {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    label: args.label,
    generatedAt: args.generatedAt,
    predictor: args.predictor,
    tool: args.tool,
    visibility: args.visibility,
    cases: args.cases,
    aggregate: aggregate(args.cases)
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runEval(opts: RunOptions): Promise<RunOutcome> {
  const date = localDate(opts.now);
  const visibilities = (['public', 'private'] as const).filter((v) => opts.cases.some((c) => c.visibility === v));
  for (const v of visibilities) {
    const target = resultFilePath(opts.resultsDir, v, date, opts.label);
    if (await exists(target)) throw new LabelCollisionError(target);
  }

  const done: Array<{ c: LoadedCase; result: CaseResult; prediction: CasePrediction | null }> = [];
  for (const c of opts.cases) {
    const { result, prediction } = await runCase(c, opts.deps);
    done.push({ c, result, prediction });
    if (result.status === 'error') {
      opts.deps.log(`${c.id}: ERROR ${result.error ?? ''}`);
    } else {
      const pr = result.phases.map((p) => `${p.id} P=${fmt(p.precision)} R=${fmt(p.recall)}`).join(' · ');
      opts.deps.log(`${c.id}: ${result.filesScanned} files scanned · ${pr}`);
    }
  }

  const written: string[] = [];
  const results: ResultFile[] = [];
  for (const v of visibilities) {
    const mine = done.filter((d) => d.c.visibility === v);
    const file = buildResultFile({
      label: opts.label,
      generatedAt: opts.now.toISOString(),
      predictor: opts.predictor,
      tool: opts.tool,
      visibility: v,
      cases: mine.map((d) => d.result)
    });
    const target = resultFilePath(opts.resultsDir, v, date, opts.label);
    await atomicWriteJson(target, file);
    written.push(target);
    results.push(file);

    const sheetCases: SheetCase[] = mine
      .filter((d) => d.prediction !== null && (d.c.goldenFindings ?? []).length > 0)
      .map((d) => ({
        caseId: d.c.id,
        findings: d.c.goldenFindings ?? [],
        predicted: (d.prediction as CasePrediction).byPhase
      }));
    if (sheetCases.length > 0) {
      const sheet = findingsSheetPath(target);
      // 'wx': a sheet may already hold a person's verdicts — never overwrite it.
      await fs.writeFile(sheet, renderFindingsSheet(path.basename(target), sheetCases), { encoding: 'utf8', flag: 'wx' });
      written.push(sheet);
    }
  }

  const anyError = done.some((d) => d.result.status === 'error');
  return { exitCode: anyError ? 2 : 0, written, results };
}
