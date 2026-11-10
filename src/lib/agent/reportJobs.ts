/**
 * Job-side wiring of the agent report services (V2_STAGE4_SPEC 4a.12), used
 * by the [D] and [D-Deep] refresh routes when `llm.reportEngine` is `agent`.
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
import { agentRepoRoot, getLibraryRoot, graphDbPath } from '../paths';
import { costEstimateUsd } from '../llm/cost';
import { withLlmLimit } from '../llm/factory';
import { runAgentUpdateReport, UPDATE_REPORT_TERMINAL, type RunAgentUpdateReportInput, type AgentUpdateReportRun } from '../llm/agentReportService';
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

export async function runAgentUpdateReportJob(
  ctx: AgentJobContext,
  input: Omit<RunAgentUpdateReportInput, AgentServiceFields>
): Promise<AgentUpdateReportRun> {
  const modelId = ctx.config.llm.model;
  const budgets = resolveBudgets(ctx.config.agentBudgets.updateReport, modelId, costEstimateUsd);
  return withRunGraph(ctx, async (graph) =>
    withLlmLimit(ctx.config.llm.provider, async () =>
      runAgentUpdateReport({
        ...input,
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
    )
  );
}

export async function runAgentDeepReportJob(
  ctx: AgentJobContext,
  input: Omit<RunAgentDeepReportInput, AgentServiceFields>
): Promise<AgentDeepReportRun> {
  const modelId = ctx.config.llm.model;
  const budgets = resolveBudgets(ctx.config.agentBudgets.deepReport, modelId, costEstimateUsd);
  return withRunGraph(ctx, async (graph) =>
    withLlmLimit(ctx.config.llm.provider, async () =>
      runAgentDeepReport({
        ...input,
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
    )
  );
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
}): DeepReportEstimateResponse {
  const modelId = opts.config.llm.model;
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
    budgets
  };
}
