/**
 * `npm run eval -- <command>` entry point: dispatch + I/O only; the logic
 * lives in eval/lib/*. No HTTP server, no UI. The AI predictors (v2-agent,
 * v1-ai) run against mocks (`--mock-script` / `--mock-llm`) or, with
 * `--real` (Stage 4c), against the real API: public cases only, every
 * request through the spend ledger (eval/lib/real.ts).
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
import { readDeclaredPackages, runGraphEval } from './lib/graph-score';
import { loadOrBuildCaseTruth } from './lib/graph-truth';
import { graphForCase, predictV2Graph } from './lib/predict-graph';
import { predictV1 } from './lib/predict-v1';
import { EVAL_AGENT_BUDGETS, predictV2Agent, scriptedModelFactory, type MockScriptSource } from './lib/predict-agent';
import { predictV1Ai } from './lib/predict-v1-ai';
import { loadPlaybookDir } from '../src/core/agent/playbooks';
import { MockLLMClient } from '../src/lib/llm/mock';
import type { AiRunOptions } from './lib/args';
import { assertPublicCases, loadPrivateIds, MissingApiKeyError, PrivateCaseError, startRealSession, type RealSession } from './lib/real';
import { defaultLedgerPath, LedgerLockError } from '../src/core/spend/ledger';
import type { CasePrediction } from './lib/types';
import { findingsSheetPath, LabelCollisionError, runEval } from './lib/results';
import { RESULT_SCHEMA_VERSION, type LoadedCase, type ResultFile, type ToolInfo } from './lib/types';

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(EVAL_DIR, '..');
const DEFAULT_CASES_DIR = path.join(EVAL_DIR, 'corpus', 'cases');
const DEFAULT_LOCAL_FILE = path.join(EVAL_DIR, 'corpus.local.json');
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

/** Picks the `run` predictor; the AI ones get their (mock) model here. */
async function predictorFor(
  predictor: string,
  ai: AiRunOptions | undefined,
  cacheDir: string,
  label: string,
  session?: RealSession
): Promise<(c: LoadedCase, dir: string) => Promise<CasePrediction>> {
  if (predictor === 'v2-graph') return (c, dir) => predictV2Graph(c, dir, cacheDir);
  if (ai?.real === true) {
    if (session === undefined) throw new UsageError('--real needs a spend session');
    const notAfterCap = () => {
      if (session.stopped()) throw new Error('not run: the spend gate refused an earlier request (cap reached)');
    };
    if (predictor === 'v2-agent') {
      const playbooks = ai.playbooks === 'on' ? await loadPlaybookDir(path.join(TOOL_ROOT, 'playbooks')) : [];
      return (c, dir) => {
        notAfterCap();
        const rc = session.clientFor(c);
        return predictV2Agent(c, dir, {
          cacheDir,
          label,
          modelFor: () => rc.agentModel,
          gate: rc.agentGate,
          modelId: ai.model,
          effort: ai.effort,
          budgets: { ...EVAL_AGENT_BUDGETS[ai.budget] },
          playbooks: ai.playbooks,
          loadedPlaybooks: playbooks
        });
      };
    }
    if (predictor === 'v1-ai') {
      return (c, dir) => {
        notAfterCap();
        return predictV1Ai(c, dir, { cacheDir, client: session.clientFor(c).llm, model: ai.model });
      };
    }
  }
  if (predictor === 'v2-agent' && ai?.mockScript !== undefined) {
    const source = JSON.parse(await fs.readFile(path.resolve(ai.mockScript), 'utf8')) as MockScriptSource;
    const playbooks = ai.playbooks === 'on' ? await loadPlaybookDir(path.join(TOOL_ROOT, 'playbooks')) : [];
    return (c, dir) =>
      predictV2Agent(c, dir, {
        cacheDir,
        label,
        modelFor: scriptedModelFactory(source),
        modelId: ai.model,
        effort: ai.effort,
        budgets: { ...EVAL_AGENT_BUDGETS[ai.budget] },
        playbooks: ai.playbooks,
        loadedPlaybooks: playbooks
      });
  }
  if (predictor === 'v1-ai' && ai?.mock === true) {
    const client = new MockLLMClient({ fixtureDir: path.join(TOOL_ROOT, 'test-fixtures', 'llm') });
    return (c, dir) => predictV1Ai(c, dir, { cacheDir, client, model: ai.model });
  }
  if (predictor === 'v1-code-scan') return (c, dir) => predictV1(c, dir);
  // parseArgs already refuses AI predictors without a mock or --real; this is the safety net.
  throw new UsageError(`--predictor ${predictor} needs a mock or --real`);
}

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

function makeCache(cases: readonly LoadedCase[], cacheDirFlag: string | undefined, offline: boolean): PinnedCache {
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
    localRepos: cases.filter((c) => isLocalPath(c.repo)).map((c) => c.repo),
    offline
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

function selectCases(all: LoadedCase[], ids: string[] | undefined): LoadedCase[] {
  let selected = all;
  if (ids !== undefined) {
    const unknown = ids.filter((id) => !all.some((c) => c.id === id));
    if (unknown.length > 0) throw new UsageError(`unknown case id(s): ${unknown.join(', ')}`);
    selected = all.filter((c) => ids.includes(c.id));
  }
  if (selected.length === 0) throw new UsageError('no cases to run');
  return selected;
}

async function readResultFile(p: string): Promise<ResultFile> {
  const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as ResultFile;
  if ((parsed as { kind?: unknown }).kind === 'graph-usage') {
    throw new ValidationFailure(`${p} is a graph-usage result (\`eval -- graph\`), not a \`run\` result`);
  }
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
      const cache = makeCache(all, cmd.cacheDir, cmd.offline);
      const dir = await cache.prepare(c, { offline: cmd.offline });
      const phases = await cache.truthForPhases(c, dir);
      printTruth(c, cmd.phase === undefined ? phases : phases.filter((p) => p.phaseId === cmd.phase));
      return 0;
    }

    case 'run': {
      const all = await loadValidCorpus(cmd);
      const selected = selectCases(all, cmd.cases);
      let session: RealSession | undefined;
      if (cmd.ai?.real === true) {
        // Privacy first (4c.2): before the key, the ledger or any network call.
        const privateIds = new Set([...(await loadPrivateIds(DEFAULT_LOCAL_FILE)), ...all.filter((c) => c.visibility === 'private').map((c) => c.id)]);
        try {
          assertPublicCases(selected, privateIds);
        } catch (e) {
          if (e instanceof PrivateCaseError) throw new UsageError(`${e.message} Pass --cases with public case ids.`);
          throw e;
        }
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData === undefined || localAppData === '') throw new UsageError('--real needs %LOCALAPPDATA% for the spend ledger');
        session = await startRealSession({
          cases: selected,
          privateIds,
          envFile: path.join(TOOL_ROOT, '.env'),
          ledgerPath: defaultLedgerPath(localAppData),
          step: `${cmd.predictor}:${cmd.label}`,
          ...(cmd.ai.stopAtUsd !== undefined ? { ceilingUsd: cmd.ai.stopAtUsd } : {}),
          log: out
        });
      }
      try {
        const cache = makeCache(all, cmd.cacheDir, cmd.offline);
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
            predict: await predictorFor(cmd.predictor, cmd.ai, cache.cacheDir, cmd.label, session),
            log: out
          },
          ...(session !== undefined ? { spend: session.spendInfo } : {})
        });
        for (const w of outcome.written) out(`wrote ${path.relative(TOOL_ROOT, w)}`);
        return outcome.exitCode;
      } finally {
        await session?.close();
      }
    }

    case 'graph': {
      const all = await loadValidCorpus(cmd);
      const selected = selectCases(all, cmd.cases);
      const cache = makeCache(all, cmd.cacheDir, cmd.offline);
      const outcome = await runGraphEval({
        cases: selected,
        label: cmd.label,
        packages: cmd.packages,
        tool: await toolInfo(),
        resultsDir: RESULTS_DIR,
        now: new Date(),
        deps: {
          prepare: (c) => cache.prepare(c, { offline: cmd.offline }),
          truth: (c, dir) =>
            loadOrBuildCaseTruth({
              cacheDir: cache.cacheDir,
              cloneDir: dir,
              caseId: c.id,
              baseCommit: c.baseCommit,
              projectDirs: c.projectDirs,
              refresh: cmd.refreshTruth
            }),
          graph: (c, dir, packagesFor) =>
            graphForCase({ cacheDir: cache.cacheDir, cloneDir: dir, caseId: c.id, projectDirs: c.projectDirs, packagesFor }),
          declared: readDeclaredPackages,
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
      e instanceof FindingsSheetError ||
      e instanceof MissingApiKeyError ||
      e instanceof PrivateCaseError ||
      e instanceof LedgerLockError
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
