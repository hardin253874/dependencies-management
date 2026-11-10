/**
 * `run --predictor v1-ai` (V2_STAGE4_SPEC 4a.15, proposed D26): the real-LLM
 * v1 [D] baseline in the same harness. Mock-tested in 4a, run for real in 4c.
 *
 * Per phase, the ELIGIBLE packages are the phase packages with both `from`
 * and `to` set and `from !== to`, in case order, at most 3 (v1 cannot report a
 * removal or an addition). For each: v1 `runUpdateReport` (imported
 * unchanged) with `promptInput` built exactly as the v1 route builds it —
 * affected files from the v1 `scanCode` output (`buildAffectedFiles`),
 * `resolverCheck: null` (eval clones are never installed), `releaseNotesBetween:
 * null` (as v1), v1 budgets/effort. Predicted set = union of the reports'
 * `filesToModify` paths (prefixed with the projectDir), filtered to files the
 * graph knows (same rule as v2-agent; the rest are `hallucinatedPaths`). A
 * phase with no eligible package is `skipped` (`no-eligible-package`) and
 * excluded from aggregates. A deterministic-partial report predicts nothing.
 */
import path from 'path';
// Relative imports on purpose (not `@/…`): vite-node has no alias (see predict-v1.ts, R1).
import { scanCode, type CodeScanResult } from '../../src/lib/scanners/code';
import { runUpdateReport } from '../../src/lib/llm/reportService';
import { buildAffectedFiles } from '../../src/lib/llm/prompts/update-report';
import type { LLMClient } from '../../src/lib/llm/client';
import { buildGraph, type GraphLock } from '../../src/core/graph/build';
import { openGraphReader } from '../../src/core/graph/store';
import { filterToGraphFiles } from '../../src/core/agent/seedFacts';
import { graphDbPath, prefixed } from './predict-graph';
import type { CasePrediction, CorpusCase, CorpusPhase, PackageChange, PhaseAgentInfo } from './types';

export const V1_AI_MAX_PACKAGES = 3;
export const NO_ELIGIBLE_PACKAGE = 'no-eligible-package';
const trivialLock: GraphLock = (_key, fn) => fn();

export type ScanFn = (opts: { projectRoot: string }) => Promise<CodeScanResult>;

export function eligiblePackages(phase: Pick<CorpusPhase, 'packages'>): PackageChange[] {
  return phase.packages.filter((p) => p.from !== null && p.to !== null && p.from !== p.to).slice(0, V1_AI_MAX_PACKAGES);
}

export interface V1AiPredictOptions {
  cacheDir: string;
  client: LLMClient;
  model: string;
  scan?: ScanFn;
  build?: typeof buildGraph;
}

export async function predictV1Ai(
  c: Pick<CorpusCase, 'id' | 'projectDirs' | 'phases'>,
  cloneDir: string,
  opts: V1AiPredictOptions
): Promise<CasePrediction> {
  const started = Date.now();
  const scan = opts.scan ?? scanCode;
  const byPhase = new Map<string, string[]>();
  const agentByPhase = new Map<string, PhaseAgentInfo>();
  const skippedPhases = new Map<string, string>();
  let filesScanned = 0;
  let costUsd = 0;

  for (const phase of c.phases) if (eligiblePackages(phase).length === 0) skippedPhases.set(phase.id, NO_ELIGIBLE_PACKAGE);

  for (const projectDir of c.projectDirs) {
    const projectRoot = path.join(cloneDir, projectDir);
    const scanned = await scan({ projectRoot });
    filesScanned += scanned.totalFilesScanned;
    const dbPath = graphDbPath(opts.cacheDir, c.id, projectDir);
    await (opts.build ?? buildGraph)({ projectRoot, dbPath, mode: 'full', lock: trivialLock });
    const graph = openGraphReader(dbPath);
    try {
      for (const phase of c.phases) {
        const eligible = eligiblePackages(phase);
        if (eligible.length === 0) continue;
        const predicted = new Set(byPhase.get(phase.id) ?? []);
        const info = agentByPhase.get(phase.id) ?? { status: 'submitted', runs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, hallucinatedPaths: 0, durationMs: 0 };
        for (const pkg of eligible) {
          const t0 = Date.now();
          const affectedFiles = buildAffectedFiles(
            (scanned.imports.get(pkg.name) ?? []).map((s) => ({ path: s.path, importStatements: s.importStatements, importCount: s.importStatements.length }))
          );
          const run = await runUpdateReport(opts.client, {
            model: opts.model,
            resolverBlock: { kind: 'disabled', reason: 'failure', failureMessage: 'eval clones are never installed' },
            fromVersion: pkg.from!,
            toVersion: pkg.to!,
            promptInput: {
              dep: { name: pkg.name, fromVersion: pkg.from!, toVersion: pkg.to!, releaseNotesBetween: null },
              resolverCheck: null,
              candidateCoUpgrades: [],
              affectedFiles
            }
          });
          info.runs += 1;
          info.durationMs += Date.now() - t0;
          if (run.source === 'deterministic-partial') {
            info.status = 'error';
            continue;
          }
          const { kept, dropped } = filterToGraphFiles(run.detail.filesToModify, graph, projectRoot);
          for (const f of kept) predicted.add(prefixed(projectDir, f.path));
          info.hallucinatedPaths += dropped.length;
          const cost = run.detail.cost;
          if (cost !== undefined) {
            info.inputTokens += cost.inputTokens + (cost.cacheCreationInputTokens ?? 0);
            info.outputTokens += cost.outputTokens;
            info.cacheReadTokens += cost.cacheReadInputTokens ?? 0;
            info.costUsd = round6(info.costUsd + cost.costEstimateUsd);
            costUsd += cost.costEstimateUsd;
          }
        }
        byPhase.set(phase.id, [...predicted].sort());
        agentByPhase.set(phase.id, info);
      }
    } finally {
      graph.close();
    }
  }
  return { filesScanned, durationMs: Date.now() - started, byPhase, costUsd: round6(costUsd), agentByPhase, skippedPhases };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
