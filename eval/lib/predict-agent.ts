/**
 * `run --predictor v2-agent` (V2_STAGE4_SPEC 4a.14): the [D] agent loop on
 * every case phase, measured against the commit truth.
 *
 * Per phase and projectDir (one run each; a case with two projectDirs makes
 * two runs per phase, costs summed):
 * - the graph is built where `predict-graph.ts` puts it (`<cache>/_graph/…`,
 *   outside the clone; full build, trivial lock — the eval is the only writer);
 * - the [D] agent is seeded with ALL phase packages (`to: null` = removal,
 *   `from: null` = addition, both stated in the prompt);
 * - `workspaceRoot` = the clone's projectDir (read-only, never installed);
 * - predicted set (Stage 5a.7, proposed D29) = the report's `impactedFiles`
 *   full set: the graph base set of ALL phase packages ∪ agent-added files −
 *   exclusions backed by a `read_file` in the same run, prefixed with the
 *   projectDir. A run that does not submit predicts the base set (its
 *   deterministic-partial envelope carries it), like the app.
 * - subset = the agent's own pick (`confirmed ∪ added`, = `filesToModify`),
 *   scored separately as `agent.subset` / `v2-agent:subset`.
 *   Dropped paths are counted as `hallucinatedPaths` (reported, not scored).
 * - run records go to `<cache>/_runs/<label>/<caseId>-<phaseId>[-<dir>].json`
 *   (the cache is outside the repo, so private cases never reach a tracked file).
 *
 * The model is injected: a scripted model in 4a (`--mock-script`), the real
 * client only in 4c behind the spend gate.
 */
import path from 'path';
// Relative imports on purpose (not `@/…`): vite-node has no alias (see predict-v1.ts, R1).
import { buildGraph, type GraphLock } from '../../src/core/graph/build';
import { openGraphReader } from '../../src/core/graph/store';
import { ScriptedAgentModel, type AgentModel } from '../../src/core/agent/model';
import type { AgentBudgets, SpendGate } from '../../src/core/agent/loop';
import type { IntelContext } from '../../src/core/agent/types';
import type { Playbook } from '../../src/core/agent/playbooks';
import { runAgentUpdateReport } from '../../src/lib/llm/agentReportService';
import { atomicWriteJson } from '../../src/lib/storage/atomic';
import type { LlmEffort } from '../../src/lib/llm/effort';
import { graphDbPath, prefixed, projectDirSlug } from './predict-graph';
import type { CasePrediction, CorpusCase, CorpusPhase, PhaseAgentInfo, PhaseImpactInfo } from './types';

const trivialLock: GraphLock = (_key, fn) => fn();

export type AgentBudgetKind = 'update' | 'deep';

/** Eval run budgets (spec 4c.6): bigger than the app's [D] default, `maxUsd` set per run by the caller. */
export const EVAL_AGENT_BUDGETS: Readonly<Record<AgentBudgetKind, AgentBudgets>> = Object.freeze({
  update: { maxToolCalls: 25, maxInputTokens: 800_000, maxOutputTokens: 24_000, maxWallMs: 300_000, maxUsd: 1, perTurnMaxTokens: 8_000 },
  deep: { maxToolCalls: 40, maxInputTokens: 1_000_000, maxOutputTokens: 40_000, maxWallMs: 300_000, maxUsd: 2, perTurnMaxTokens: 16_000 }
});

export interface AgentPredictOptions {
  cacheDir: string;
  label: string;
  /** Returns the model for one run (a fresh scripted model per run in 4a). */
  modelFor(caseId: string, phaseId: string, projectDir: string): AgentModel;
  modelId: string;
  effort: LlmEffort;
  budgets: AgentBudgets;
  playbooks: 'on' | 'off';
  loadedPlaybooks?: readonly Playbook[];
  /** Registry access for api_diff / peer_requirements; default none (no network). */
  intel?: IntelContext;
  gate?: SpendGate;
  build?: typeof buildGraph;
}

const STATUS_RANK: Readonly<Record<string, number>> = { submitted: 0, 'no-submit': 1, 'budget-exhausted': 2, cancelled: 3, error: 4 };

function emptyImpact(): PhaseImpactInfo {
  return { base: 0, confirmed: 0, added: 0, excluded: 0, rejectedExclusions: 0, excludedTruePositives: 0 };
}

function emptyInfo(): PhaseAgentInfo {
  return { status: 'submitted', runs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, hallucinatedPaths: 0, durationMs: 0, impact: emptyImpact() };
}

function addTo(map: Map<string, string[]>, phaseId: string, paths: Iterable<string>): void {
  map.set(phaseId, [...new Set([...(map.get(phaseId) ?? []), ...paths])].sort());
}

export function runRecordPath(cacheDir: string, label: string, caseId: string, phaseId: string, projectDir: string, multiDir: boolean): string {
  const suffix = multiDir ? `-${projectDirSlug(projectDir)}` : '';
  return path.join(cacheDir, '_runs', label, `${caseId}-${phaseId}${suffix}.json`);
}

/** The package the [D] report is "about": the first one with both versions, else the first. */
function primaryOf(phase: CorpusPhase): CorpusPhase['packages'][number] {
  return phase.packages.find((p) => p.from !== null && p.to !== null) ?? phase.packages[0]!;
}

export async function predictV2Agent(
  c: Pick<CorpusCase, 'id' | 'projectDirs' | 'phases'>,
  cloneDir: string,
  opts: AgentPredictOptions
): Promise<CasePrediction> {
  const started = Date.now();
  let filesScanned = 0;
  let costUsd = 0;
  const byPhase = new Map<string, string[]>();
  const subsetByPhase = new Map<string, string[]>();
  const excludedByPhase = new Map<string, string[]>();
  const agentByPhase = new Map<string, PhaseAgentInfo>();
  const multiDir = c.projectDirs.length > 1;

  for (const projectDir of c.projectDirs) {
    const projectRoot = path.join(cloneDir, projectDir);
    const dbPath = graphDbPath(opts.cacheDir, c.id, projectDir);
    const built = await (opts.build ?? buildGraph)({ projectRoot, dbPath, mode: 'full', lock: trivialLock });
    filesScanned += built.files;
    const graph = openGraphReader(dbPath);
    try {
      for (const phase of c.phases) {
        const primary = primaryOf(phase);
        const run = await runAgentUpdateReport({
          agent: opts.modelFor(c.id, phase.id, projectDir),
          modelId: opts.modelId,
          effort: opts.effort,
          budgets: opts.budgets,
          graph,
          workspaceRoot: projectRoot,
          intel: opts.intel ?? { apiDiffCacheDir: path.join(opts.cacheDir, '_apidiff') },
          playbooks: opts.loadedPlaybooks ?? [],
          playbookMode: opts.playbooks,
          gate: opts.gate,
          logContext: { eval: opts.label },
          promptInput: {
            dep: { name: primary.name, fromVersion: primary.from ?? 'none', toVersion: primary.to ?? 'removed', releaseNotesBetween: null },
            resolverCheck: null,
            candidateCoUpgrades: [],
            affectedFiles: []
          },
          resolverBlock: { kind: 'disabled', reason: 'failure', failureMessage: 'eval clones are never installed' },
          fromVersion: primary.from ?? 'none',
          toVersion: primary.to ?? 'removed',
          packages: phase.packages.map((p) => ({ name: p.name, from: p.from, to: p.to }))
        });
        const record = run.record;
        await atomicWriteJson(runRecordPath(opts.cacheDir, opts.label, c.id, phase.id, projectDir, multiDir), record);

        // Submitted or not, the detail carries impactedFiles (partial = base set only).
        const rows = run.detail.impactedFiles ?? [];
        const at = (keep: (r: (typeof rows)[number]) => boolean) => rows.filter(keep).map((r) => prefixed(projectDir, r.path));
        addTo(byPhase, phase.id, at((r) => r.agent !== 'excluded'));
        addTo(subsetByPhase, phase.id, at((r) => r.agent === 'confirmed' || r.agent === 'added'));
        addTo(excludedByPhase, phase.id, at((r) => r.agent === 'excluded'));

        const info = agentByPhase.get(phase.id) ?? emptyInfo();
        info.runs += 1;
        if ((STATUS_RANK[record.status] ?? 9) > (STATUS_RANK[info.status] ?? 0)) info.status = record.status;
        info.toolCalls += record.usage.toolCalls;
        info.inputTokens += record.usage.inputTokens + record.usage.cacheCreationInputTokens;
        info.outputTokens += record.usage.outputTokens;
        info.cacheReadTokens += record.usage.cacheReadInputTokens;
        info.costUsd = round6(info.costUsd + record.costUsd);
        info.hallucinatedPaths += run.droppedPaths.length;
        info.durationMs += record.durationMs;
        const sum = run.detail.impactSummary;
        if (sum !== undefined) {
          const imp = info.impact ?? emptyImpact();
          imp.base += sum.base;
          imp.confirmed += sum.confirmed;
          imp.added += sum.added;
          imp.excluded += sum.excluded;
          imp.rejectedExclusions += sum.rejectedExclusions;
          info.impact = imp;
        }
        agentByPhase.set(phase.id, info);
        costUsd += record.costUsd;
      }
    } finally {
      graph.close();
    }
  }
  return { filesScanned, durationMs: Date.now() - started, byPhase, subsetByPhase, excludedByPhase, costUsd: round6(costUsd), agentByPhase };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * `--mock-script <file>` (Stage 4a): either one `AgentScriptFile` (`{ turns }`,
 * replayed for every run) or a map `{ "<caseId>/<phaseId>": turns, "*": turns }`.
 * Every run gets a fresh `ScriptedAgentModel`.
 */
export type MockScriptSource = { turns: ScriptStepJson[] } | Record<string, ScriptStepJson[]>;
type ScriptStepJson = Exclude<ConstructorParameters<typeof ScriptedAgentModel>[0][number], (...args: never[]) => unknown>;

export function scriptedModelFactory(source: MockScriptSource): AgentPredictOptions['modelFor'] {
  return (caseId, phaseId) => {
    const turns = Array.isArray((source as { turns?: unknown }).turns)
      ? (source as { turns: ScriptStepJson[] }).turns
      : ((source as Record<string, ScriptStepJson[]>)[`${caseId}/${phaseId}`] ?? (source as Record<string, ScriptStepJson[]>)['*']);
    if (turns === undefined) throw new Error(`--mock-script has no turns for ${caseId}/${phaseId} (and no "*" entry)`);
    return new ScriptedAgentModel(turns);
  };
}
