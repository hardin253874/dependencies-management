/**
 * Job-side wiring of the agent report services (V2_STAGE4_SPEC 4a.12), used
 * by the [D] and [D-Deep] refresh routes when `llm.reportEngine` is `agent`.
 * The run's model is `llm.agentModel` (D32, default Sonnet 5.5) unless the
 * router (D28, off by default) picks one.
 *
 * Per run: refresh the code graph (cached, incremental), open a dedicated
 * read handle for the run (the shared reader cache must not be held across
 * awaits), build the registry intel, resolve budgets from `_config.json`, run
 * the service, then write the run record pointing at the report envelope the
 * route writes. The handle is closed in `finally`.
 */
import path from 'path';
import { openGraphReader } from '@/core/graph/store';
import { loadPlaybookDir } from '@/core/agent/playbooks';
import { resolveBudgets } from '@/core/agent/budgets';
import type { AgentEvent } from '@/core/agent/loop';
import { refreshProjectGraph } from '../graph/graphService';
import { getGraphReader } from '../graph/readerCache';
import { agentRepoRoot, getLibraryRoot, graphDbPath } from '../paths';
import { costEstimateUsd } from '../llm/cost';
import { resolveModel, withLlmLimit } from '../llm/factory';
import { buildRouterFacts, graphFileCountOf } from '../judge/routerFacts';
import { judgeContextFor } from '../judge/factory';
import { applyJevRenames } from '../judge/apply';
import type { ApiDiffResult } from '@/core/intel/apiDiff';
import type { RouterDecision } from '@/core/llm/router';
import { runAgentUpdateReport, seedApiDiff, UPDATE_REPORT_TERMINAL, type RunAgentUpdateReportInput, type AgentUpdateReportRun } from '../llm/agentReportService';
import { runAgentDeepReport, DEEP_REPORT_TERMINAL, type RunAgentDeepReportInput, type AgentDeepReportRun } from '../llm/agentDeepReportService';
import { estimateAgentRun } from '../llm/agentEstimate';
import { AGENT_SYSTEM_PROMPT } from '../llm/prompts/agent-update-report';
import { toAnthropicTools } from '@/core/agent/registry';
import { createReadToolRegistry } from '@/core/agent/tools';
import type { DeepReportEstimateResponse } from '../api-types';
import type { AppConfig } from '../storage/config';
import type { JobProgress } from '../jobs/types';
import { runIntel } from './intel';
import { getAgentModel } from './factory';
import { writeRunRecord, type AgentRunRecord } from './runStore';

export interface AgentJobContext {
  slug: string;
  projectRoot: string;
  config: AppConfig;
  report: (p: JobProgress) => void;
  signal: AbortSignal;
}

type AgentServiceFields = 'agent' | 'modelId' | 'budgets' | 'graph' | 'workspaceRoot' | 'intel' | 'playbooks' | 'playbookMode' | 'signal' | 'onEvent' | 'logContext';

export function playbooksDir(): string {
  return path.join(agentRepoRoot(), 'playbooks');
}

function progressFor(ctx: AgentJobContext, maxToolCalls: number): (e: AgentEvent) => void {
  return (e) => {
    if (e.type === 'turn') {
      ctx.report({ current: Math.min(e.toolCalls, maxToolCalls), total: maxToolCalls, label: `agent: turn ${e.turn}${e.final ? ' (final)' : ''}, ${e.toolCalls}/${maxToolCalls} tool calls`, phase: 'ai' });
    } else if (e.type === 'tool') {
      ctx.report({ current: 0, total: maxToolCalls, label: `agent: ${e.tool}`, phase: 'ai' });
    }
  };
}

async function withRunGraph<T>(ctx: AgentJobContext, fn: (graph: ReturnType<typeof openGraphReader>) => Promise<T>): Promise<T> {
  await refreshProjectGraph({ slug: ctx.slug, projectRoot: ctx.projectRoot, report: ctx.report, signal: ctx.signal });
  const graph = openGraphReader(graphDbPath(ctx.slug));
  try {
    return await fn(graph);
  } finally {
    graph.close();
  }
}

/**
 * v2 Stage 5b.8: routes the model once per job (graph open, before the run);
 * budgets derive from the routed model. Router off → the configured model and
 * no `routing` field (envelopes and requests as before).
 */
async function routeJob(ctx: AgentJobContext, graph: ReturnType<typeof openGraphReader>, view: 'agent' | 'deep-report', dep: { name: string; fromVersion: string; toVersion: string }): Promise<RouterDecision | null> {
  if (!ctx.config.judge.router) return null;
  const facts = await buildRouterFacts({ view, slug: ctx.slug, name: dep.name, from: dep.fromVersion, to: dep.toVersion, graphFileCount: graphFileCountOf(graph, [dep.name]), configuredModel: ctx.config.llm.agentModel });
  return resolveModel({ facts, slug: ctx.slug, config: ctx.config, allowJudge: true, signal: ctx.signal });
}

/** J4 (5b.13): with the flag on, the seed's api_diff gets Jev rename candidates; off → undefined (the service computes it as before). */
async function jevSeedApiDiff(ctx: AgentJobContext, dep: { name: string; fromVersion: string; toVersion: string }): Promise<ApiDiffResult | null | undefined> {
  const j4 = await judgeContextFor(ctx.slug, ctx.config, 'J4', ctx.signal);
  if (j4 === null) return undefined;
  const diff = await seedApiDiff(runIntel(ctx.projectRoot), dep.name, dep.fromVersion, dep.toVersion, ctx.signal);
  return applyJevRenames(j4, diff);
}

function withRouting<T extends { detail: object; record: object }>(run: T, routing: RouterDecision | null): T {
  if (routing === null) return run;
  return { ...run, detail: { ...run.detail, routing }, record: { ...run.record, routing } };
}

export async function runAgentUpdateReportJob(
  ctx: AgentJobContext,
  input: Omit<RunAgentUpdateReportInput, AgentServiceFields>
): Promise<AgentUpdateReportRun> {
  return withRunGraph(ctx, async (graph) => {
    const routing = await routeJob(ctx, graph, 'agent', input.promptInput.dep);
    const modelId = routing?.model ?? ctx.config.llm.agentModel;
    const budgets = resolveBudgets(ctx.config.agentBudgets.updateReport, modelId, costEstimateUsd);
    const apiDiff = await jevSeedApiDiff(ctx, input.promptInput.dep);
    const run = await withLlmLimit(ctx.config.llm.provider, async () =>
      runAgentUpdateReport({
        ...input,
        ...(apiDiff !== undefined ? { apiDiff } : {}),
        agent: await getAgentModel('update-report'),
        modelId,
        budgets,
        graph,
        workspaceRoot: ctx.projectRoot,
        intel: runIntel(ctx.projectRoot),
        playbooks: await loadPlaybookDir(playbooksDir()),
        playbookMode: 'on',
        signal: ctx.signal,
        onEvent: progressFor(ctx, budgets.maxToolCalls),
        logContext: { slug: ctx.slug }
      })
    );
    return withRouting(run, routing);
  });
}

export async function runAgentDeepReportJob(
  ctx: AgentJobContext,
  input: Omit<RunAgentDeepReportInput, AgentServiceFields>
): Promise<AgentDeepReportRun> {
  return withRunGraph(ctx, async (graph) => {
    const routing = await routeJob(ctx, graph, 'deep-report', input.promptInput.dep);
    const modelId = routing?.model ?? ctx.config.llm.agentModel;
    const budgets = resolveBudgets(ctx.config.agentBudgets.deepReport, modelId, costEstimateUsd);
    const apiDiff = await jevSeedApiDiff(ctx, input.promptInput.dep);
    const run = await withLlmLimit(ctx.config.llm.provider, async () =>
      runAgentDeepReport({
        ...input,
        ...(apiDiff !== undefined ? { apiDiff } : {}),
        agent: await getAgentModel('deep-report'),
        modelId,
        budgets,
        graph,
        workspaceRoot: ctx.projectRoot,
        intel: runIntel(ctx.projectRoot),
        playbooks: await loadPlaybookDir(playbooksDir()),
        playbookMode: 'on',
        signal: ctx.signal,
        onEvent: progressFor(ctx, budgets.maxToolCalls),
        logContext: { slug: ctx.slug }
      })
    );
    return withRouting(run, routing);
  });
}

/** Writes the run record with `resultRef` = the report envelope path relative to the library root (POSIX). */
export async function persistRunRecord(slug: string, record: AgentRunRecord, reportFile: string): Promise<void> {
  const resultRef = path.relative(getLibraryRoot(), reportFile).split(path.sep).join('/');
  await writeRunRecord(slug, { ...record, resultRef });
}

/** Typical [D] seed size (graph facts + resolver + co-upgrades), used before a run when the real seed is unknown. */
export const UPDATE_SEED_BYTES_ESTIMATE = 6_000;

/**
 * The confirm-modal estimate for an agent run (V2_STAGE4_SPEC 4a.12):
 * `estimatedCostUsd` = the expected cost, `maxUsd` = the hard budget.
 */
export function agentRunEstimateResponse(opts: {
  view: 'update-report' | 'deep-report';
  config: AppConfig;
  seedPromptBytes: number;
  totalPackages: number;
  /** v2 Stage 5b.8: rules-only routing from the GET (absent when the router is off). */
  routing?: RouterDecision | null;
}): DeepReportEstimateResponse {
  const modelId = opts.routing?.model ?? opts.config.llm.agentModel;
  const settings = opts.view === 'update-report' ? opts.config.agentBudgets.updateReport : opts.config.agentBudgets.deepReport;
  const budgets = resolveBudgets(settings, modelId, costEstimateUsd);
  const terminal = opts.view === 'update-report' ? UPDATE_REPORT_TERMINAL : DEEP_REPORT_TERMINAL;
  const est = estimateAgentRun({
    model: modelId,
    budgets,
    seedPromptBytes: opts.seedPromptBytes,
    systemBytes: Buffer.byteLength(AGENT_SYSTEM_PROMPT, 'utf8'),
    tools: toAnthropicTools(createReadToolRegistry(), [terminal])
  });
  return {
    estimatedInputTokens: est.expectedInputTokens,
    estimatedOutputTokens: est.expectedOutputTokens,
    estimatedCostUsd: est.expectedUsd,
    provider: opts.config.llm.provider,
    model: modelId,
    totalPackages: opts.totalPackages,
    engine: 'agent',
    maxUsd: est.maxUsd,
    budgets,
    ...(opts.routing !== undefined && opts.routing !== null ? { routing: opts.routing } : {})
  };
}

/**
 * The model a view runs on when the router does not pick one (D32): the agent
 * engine's [D] (`agent`) and [D-Deep] (`deep-report`, routed only on the agent
 * engine) use `llm.agentModel`; v1 [D] and [E] file review use `llm.model`.
 */
export function configuredModelFor(view: 'agent' | 'deep-report' | 'file-review' | 'update-report', config: AppConfig): string {
  return view === 'agent' || view === 'deep-report' ? config.llm.agentModel : config.llm.model;
}

/**
 * Routing for a view without its own graph handle (5b.8): cost-estimate GETs
 * (`allowJudge` false: rules only, never Jev) and the v1 [D] / [E] jobs
 * (`allowJudge` true). Never builds the graph: a built graph's cached reader
 * is used synchronously; none → 0 files. Router off → null (as before).
 */
export async function estimateRouting(opts: {
  view: 'agent' | 'deep-report' | 'file-review' | 'update-report';
  slug: string;
  name: string;
  from: string;
  to: string;
  config: AppConfig;
  /** Only a user-triggered job passes true; a GET never does. */
  allowJudge?: boolean;
  signal?: AbortSignal;
}): Promise<RouterDecision | null> {
  if (!opts.config.judge.router) return null;
  let graphFileCount = 0;
  try {
    graphFileCount = graphFileCountOf(getGraphReader(opts.slug), [opts.name]);
  } catch {
    graphFileCount = 0;
  }
  const facts = await buildRouterFacts({ view: opts.view, slug: opts.slug, name: opts.name, from: opts.from, to: opts.to, graphFileCount, configuredModel: configuredModelFor(opts.view, opts.config) });
  return resolveModel({ facts, slug: opts.slug, config: opts.config, allowJudge: opts.allowJudge === true, ...(opts.signal !== undefined ? { signal: opts.signal } : {}) });
}
