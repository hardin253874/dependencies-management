/**
 * `npm run eval -- <command>` entry point: dispatch + I/O only; the logic
 * lives in eval/lib/*. No LLM, no HTTP server, no UI (round 1).
 *
 * Output goes to stdout/stderr directly: this is a CLI whose output *is*
 * the product, not server code, so the app logger does not apply.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Relative import on purpose (not `@/…`): see eval/lib/predict-v1.ts (R1).
import { atomicWriteJson } from '../src/lib/storage/atomic';
import { HELP_TEXT, parseArgs, UsageError, type ParsedCommand } from './lib/args';
import { PinnedCache, resolveCacheDir, type PhaseTruth } from './lib/cache';
import { compareResults, CompareError } from './lib/compare';
import { isLocalPath, loadCorpus, summarise } from './lib/corpus';
import { FindingsSheetError, parseFindingsSheet, scoreFindings } from './lib/findings';
import { createExecGitRunner, GIT_TIMEOUT_MS } from './lib/git';
import { predictV1 } from './lib/predict-v1';
import { findingsSheetPath, LabelCollisionError, runEval } from './lib/results';
import { RESULT_SCHEMA_VERSION, type LoadedCase, type ResultFile, type ToolInfo } from './lib/types';

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(EVAL_DIR, '..');
const DEFAULT_CASES_DIR = path.join(EVAL_DIR, 'corpus', 'cases');
const DEFAULT_LOCAL_FILE = path.join(EVAL_DIR, 'corpus.local.json');
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

class ValidationFailure extends Error {}

async function loadValidCorpus(cmd: { corpus?: string; local?: string }): Promise<LoadedCase[]> {
  const { cases, errors } = await loadCorpus({
    casesDir: cmd.corpus !== undefined ? path.resolve(cmd.corpus) : DEFAULT_CASES_DIR,
    localFile: cmd.local !== undefined ? path.resolve(cmd.local) : DEFAULT_LOCAL_FILE
  });
  if (errors.length > 0) {
    throw new ValidationFailure(`corpus has ${errors.length} error(s):\n  ${errors.join('\n  ')}`);
  }
  return cases;
}

function makeCache(cases: readonly LoadedCase[], cacheDirFlag: string | undefined): PinnedCache {
  const cacheDir = resolveCacheDir({
    ...(cacheDirFlag !== undefined ? { flag: cacheDirFlag } : {}),
    ...(process.env.DEP_AGENT_EVAL_CACHE !== undefined ? { env: process.env.DEP_AGENT_EVAL_CACHE } : {}),
    ...(process.env.LOCALAPPDATA !== undefined ? { localAppData: process.env.LOCALAPPDATA } : {})
  });
  return new PinnedCache({
    git: createExecGitRunner(),
    cacheDir,
    toolRoot: TOOL_ROOT,
    // Every local repo in the corpus is protected, not only the selected
    // cases, so no cache layout can overlap any source repo.
    localRepos: cases.filter((c) => isLocalPath(c.repo)).map((c) => c.repo)
  });
}

/** Read-only: HEAD + dirty flag of this tool repo. */
async function toolInfo(): Promise<ToolInfo> {
  const git = createExecGitRunner();
  try {
    const commit = (
      await git.run(['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: TOOL_ROOT, timeoutMs: GIT_TIMEOUT_MS })
    ).trim();
    const status = await git.run(['--no-optional-locks', 'status', '--porcelain'], {
      cwd: TOOL_ROOT,
      timeoutMs: GIT_TIMEOUT_MS
    });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

function printTruth(c: LoadedCase, phases: PhaseTruth[]): void {
  for (const p of phases) {
    out(`\n## ${c.id} · phase ${p.phaseId}  (${p.from.slice(0, 8)}..${p.to.slice(0, 8)})`);
    out(`kept ${p.truth.kept.length} · dropped ${p.truth.dropped.length} · added ${p.truth.addedCount} · out of scope ${p.truth.outOfScope.length}`);
    out('\n| kept kind | status | path |\n|---|---|---|');
    for (const k of p.truth.kept) {
      out(`| ${k.kind} | ${k.status} | ${k.path}${k.newPath !== undefined ? ` → ${k.newPath}` : ''} |`);
    }
    out('\n| dropped reason | status | path |\n|---|---|---|');
    for (const d of p.truth.dropped) out(`| ${d.reason} | ${d.status} | ${d.path} |`);
    if (p.truth.outOfScope.length > 0) out(`\nout of scope:\n  ${p.truth.outOfScope.join('\n  ')}`);
    for (const dd of p.dependencyDiff) {
      out(`\npackage.json dependency diff (${dd.projectDir}):`);
      if (dd.changes === null) out('  (no package.json at either commit)');
      else if (dd.changes.length === 0) out('  (no dependency changes)');
      else for (const ch of dd.changes) out(`  ${ch.field} ${ch.name}: ${ch.from ?? '(none)'} → ${ch.to ?? '(removed)'}`);
    }
  }
}

async function readResultFile(p: string): Promise<ResultFile> {
  const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as ResultFile;
  if (parsed.schemaVersion !== RESULT_SCHEMA_VERSION) {
    throw new ValidationFailure(`${p}: schemaVersion ${String(parsed.schemaVersion)} is not ${RESULT_SCHEMA_VERSION}`);
  }
  return parsed;
}

async function execute(cmd: ParsedCommand): Promise<number> {
  switch (cmd.command) {
    case 'help':
      out(HELP_TEXT);
      return 0;

    case 'validate': {
      const cases = await loadValidCorpus(cmd);
      out(summarise(cases));
      return 0;
    }

    case 'truth': {
      const all = await loadValidCorpus(cmd);
      const c = all.find((x) => x.id === cmd.caseId);
      if (c === undefined) throw new UsageError(`unknown case "${cmd.caseId}"`);
      if (cmd.phase !== undefined && !c.phases.some((p) => p.id === cmd.phase)) {
        throw new UsageError(`case "${c.id}" has no phase "${cmd.phase}"`);
      }
      const cache = makeCache(all, cmd.cacheDir);
      const dir = await cache.prepare(c, { offline: cmd.offline });
      const phases = await cache.truthForPhases(c, dir);
      printTruth(c, cmd.phase === undefined ? phases : phases.filter((p) => p.phaseId === cmd.phase));
      return 0;
    }

    case 'run': {
      const all = await loadValidCorpus(cmd);
      let selected = all;
      if (cmd.cases !== undefined) {
        const unknown = cmd.cases.filter((id) => !all.some((c) => c.id === id));
        if (unknown.length > 0) throw new UsageError(`unknown case id(s): ${unknown.join(', ')}`);
        selected = all.filter((c) => (cmd.cases as string[]).includes(c.id));
      }
      if (selected.length === 0) throw new UsageError('no cases to run');
      const cache = makeCache(all, cmd.cacheDir);
      const outcome = await runEval({
        cases: selected,
        label: cmd.label,
        predictor: cmd.predictor,
        tool: await toolInfo(),
        resultsDir: RESULTS_DIR,
        now: new Date(),
        deps: {
          prepare: (c) => cache.prepare(c, { offline: cmd.offline }),
          truth: async (c, dir) =>
            (await cache.truthForPhases(c, dir)).map((p) => ({ phaseId: p.phaseId, truth: p.truth })),
          predict: (c, dir) => predictV1(c, dir),
          log: out
        }
      });
      for (const w of outcome.written) out(`wrote ${path.relative(TOOL_ROOT, w)}`);
      return outcome.exitCode;
    }

    case 'score-findings': {
      const resultsPath = path.resolve(cmd.resultsPath);
      const results = await readResultFile(resultsPath);
      const corpus = await loadValidCorpus(cmd);
      const withFindings = results.cases
        .filter((r) => r.status === 'ok')
        .map((r) => ({ r, c: corpus.find((c) => c.id === r.id) }))
        .filter((x): x is { r: (typeof x)['r']; c: LoadedCase } => (x.c?.goldenFindings ?? []).length > 0);
      if (withFindings.length === 0) throw new UsageError(`${resultsPath}: no ok case has golden findings`);
      const sheetPath = findingsSheetPath(resultsPath);
      const sheet = await fs.readFile(sheetPath, 'utf8');
      const verdicts = parseFindingsSheet(
        sheet,
        withFindings.map(({ c }) => ({ caseId: c.id, findingIds: (c.goldenFindings ?? []).map((f) => f.id) }))
      );
      const scoredAt = new Date().toISOString();
      for (const { r, c } of withFindings) {
        r.findings = scoreFindings(c.goldenFindings ?? [], verdicts.get(c.id) ?? new Map(), scoredAt);
        const y = r.findings.expectedYes;
        out(`${r.id}: expectedYes recall ${y.recall === null ? 'n/a' : y.recall.toFixed(3)} (n=${y.n}, unscored ${r.findings.unscored}${r.findings.unverifiedGoldenSet ? ', UNVERIFIED golden set' : ''})`);
      }
      await atomicWriteJson(resultsPath, results);
      out(`updated ${resultsPath}`);
      return 0;
    }

    case 'compare': {
      const a = await readResultFile(path.resolve(cmd.a));
      const b = await readResultFile(path.resolve(cmd.b));
      out(compareResults(a, b));
      return 0;
    }

    default: {
      const never: never = cmd;
      throw new UsageError(`unhandled command ${JSON.stringify(never)}`);
    }
  }
}

async function main(): Promise<void> {
  let code: number;
  try {
    code = await execute(parseArgs(process.argv.slice(2)));
  } catch (e) {
    if (
      e instanceof UsageError ||
      e instanceof ValidationFailure ||
      e instanceof LabelCollisionError ||
      e instanceof CompareError ||
      e instanceof FindingsSheetError
    ) {
      err(`eval: ${e.message}`);
      if (e instanceof UsageError) err('Run `npm run eval -- --help` for usage.');
      code = 1;
    } else {
      err(`eval: unexpected error: ${(e as Error).stack ?? String(e)}`);
      code = 1;
    }
  }
  process.exitCode = code;
}

void main();
