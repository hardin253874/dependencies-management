/**
 * View [D] Update Report produced by the bounded agent loop (V2_STAGE4_SPEC 4a.9).
 *
 * Deterministic-skeleton-first, same output schema and terminal tool as v1
 * (`UPDATE_REPORT_TOOL_SCHEMA`, `submit_update_report`):
 *   1. Seed = resolver check, co-upgrade candidates, graph summary, who uses
 *      the package (by via/category), the api_diff summary when available, and
 *      the instructions. System = shared prompt + agent addendum (stable bytes).
 *   2. Run the loop (`executeAgentRun`).
 *   3. submitted → the v1 output rules are applied by running the v1 service
 *      (`runUpdateReport`, imported unchanged) against a client that replays
 *      the agent's submitted tool input; then `filesToModify` is normalized and
 *      filtered to the graph file set (dropped paths counted on the run).
 *   4. anything else (budget-exhausted, no-submit, cancelled, error) →
 *      `deterministic-partial`: the v1 skeleton plus the graph's direct users,
 *      the run record still written by the caller, the error logged at warn.
 *
 * Cache key = computeCacheKey(system, seed + playbook + graph builtAt +
 * AGENT_PROMPT_VERSION + budgets, terminal tool, model).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { buildDeterministicSkeleton, runUpdateReport } from './reportService';
import { UPDATE_REPORT_TOOL_SCHEMA, type UpdateReportPromptInput, type UpdateReportToolOutput } from './prompts/update-report';
import { AGENT_PROMPT_VERSION, AGENT_SYSTEM_PROMPT, renderAgentUpdateSeed, type AgentSeedPackage } from './prompts/agent-update-report';
import { canonicalJsonStringify, computeCacheKey } from './cacheKey';
import { LLMError, type LLMClient, type LlmCallResult, type ToolSchema } from './client';
import { VIEW_EFFORT, type LlmEffort } from './effort';
import { getLogger } from '../logger';
import { executeAgentRun } from '../agent/agentRun';
import type { AgentRunRecord } from '../agent/runStore';
import type { AgentBudgets, AgentEvent, AgentRunResult, SpendGate } from '../../core/agent/loop';
import type { AgentModel } from '../../core/agent/model';
import { createReadToolRegistry } from '../../core/agent/tools';
import { apiDiffSeedLines, filterToGraphFiles, graphSummaryLines, usageLines } from '../../core/agent/seedFacts';
import { playbookBlock, type Playbook, matchPlaybooks } from '../../core/agent/playbooks';
import { computeApiDiff, type ApiDiffResult } from '../../core/intel/apiDiff';
import type { IntelContext, TerminalToolDef } from '../../core/agent/types';
import { completedBuildAt, type GraphDriver } from '../../core/graph/store';
import { filesUsingPackage } from '../../core/graph/query';
import type { AgentRunSummary, ResolverCheckBlock, UpdateReportDetail, WritableDataSource } from '../api-types';

/** Graph users put into the deterministic-partial skeleton. */
const SKELETON_GRAPH_FILES = 50;

export interface AgentReportCommonInput {
  agent: AgentModel;
  modelId: string;
  effort?: LlmEffort;
  budgets: AgentBudgets;
  graph: GraphDriver;
  workspaceRoot: string;
  intel: IntelContext;
  /** Loaded playbooks; matching ones are appended after the seed (4a.11). */
  playbooks?: readonly Playbook[];
  playbookMode?: 'on' | 'off';
  signal?: AbortSignal;
  gate?: SpendGate;
  onEvent?: (e: AgentEvent) => void;
  logContext?: Record<string, string>;
}

export interface RunAgentUpdateReportInput extends AgentReportCommonInput {
  promptInput: UpdateReportPromptInput;
  resolverBlock: ResolverCheckBlock;
  fromVersion: string;
  toVersion: string;
  candidateSources?: Record<string, ReadonlyArray<string>>;
  /** Eval: every package of the phase (first = the reported one). Default: just `promptInput.dep`. */
  packages?: AgentSeedPackage[];
  /** Precomputed api_diff for the seed; undefined = compute when the registry is available. */
  apiDiff?: ApiDiffResult | null;
}

export interface AgentUpdateReportRun {
  cacheKey: string;
  detail: UpdateReportDetail;
  source: WritableDataSource;
  llmError?: LLMError;
  record: AgentRunRecord;
  /** Normalized filesToModify paths dropped because they are not graph files. */
  droppedPaths: string[];
  seedPrompt: string;
}

export const UPDATE_REPORT_TERMINAL: TerminalToolDef = {
  name: UPDATE_REPORT_TOOL_SCHEMA.name,
  description: UPDATE_REPORT_TOOL_SCHEMA.description,
  inputSchema: UPDATE_REPORT_TOOL_SCHEMA.inputSchema
};

export function resolverLines(promptInput: { resolverCheck: UpdateReportPromptInput['resolverCheck'] }): string[] {
  const r = promptInput.resolverCheck;
  if (r === null) return ['resolver check unavailable (disabled, yarn project, or it failed)'];
  return [
    `would resolve cleanly: ${r.wouldResolve}`,
    `required --legacy-peer-deps: ${r.legacyPeerDepsUsed}`,
    ...r.conflicts.map((c) => `conflict: ${c.package}: ${c.reason}`)
  ];
}

export function coUpgradeLines(promptInput: Pick<UpdateReportPromptInput, 'candidateCoUpgrades' | 'dep'>): string[] {
  return promptInput.candidateCoUpgrades.map(
    (c) => `${c.name}@${c.currentVersion ?? 'unknown'}${c.declaredPeerDepRange !== null ? ` (declares peer ${promptInput.dep.name} ${c.declaredPeerDepRange})` : ''}`
  );
}

export async function seedApiDiff(intel: IntelContext, pkg: string, from: string | null, to: string | null, signal?: AbortSignal): Promise<ApiDiffResult | null> {
  if (from === null || to === null || from === to || intel.fetchPackument === undefined || intel.fetchTarball === undefined) return null;
  try {
    return await computeApiDiff(intel, pkg, from, to, signal);
  } catch (err) {
    const log = await getLogger();
    log.warn({ pkg, from, to, err: (err as Error).message }, 'api_diff for the agent seed failed; seeding without it');
    return null;
  }
}

/** Seed user message: the seed text, then (playbooks on) one block with the matching playbooks. */
export function seedMessage(seed: string, input: AgentReportCommonInput, packages: readonly AgentSeedPackage[]): { messages: Anthropic.MessageParam[]; playbookText: string | null } {
  const playbookText = (input.playbookMode ?? 'on') === 'on' ? playbookBlock(matchPlaybooks(input.playbooks ?? [], packages)) : null;
  const content: Anthropic.TextBlockParam[] = [{ type: 'text', text: seed }];
  if (playbookText !== null) content.push({ type: 'text', text: playbookText });
  return { messages: [{ role: 'user', content }], playbookText };
}

export function agentCacheKey(opts: { system: string; seed: string; playbookText: string | null; tool: ToolSchema; model: string; graph: GraphDriver; budgets: AgentBudgets }): string {
  const suffix = canonicalJsonStringify({ graphBuiltAt: completedBuildAt(opts.graph), agentPromptVersion: AGENT_PROMPT_VERSION, budgets: opts.budgets });
  return computeCacheKey({
    systemPrompt: opts.system,
    userPrompt: `${opts.seed}\n${opts.playbookText ?? ''}\n${suffix}`,
    tool: opts.tool,
    model: opts.model
  });
}

/** An LLMClient that returns an already-produced tool output (so the v1 services apply their output rules unchanged). */
export function replayClient(output: unknown, result: AgentRunResult, model: string): LLMClient {
  return {
    provider: 'anthropic',
    async call<T>(): Promise<LlmCallResult<T>> {
      return {
        output: output as T,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadInputTokens: result.usage.cacheReadInputTokens,
        cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
        model,
        provider: 'anthropic',
        costEstimateUsd: result.costUsd
      };
    }
  };
}

export function agentRunSummary(record: AgentRunRecord): AgentRunSummary {
  return {
    runId: record.runId,
    status: record.status,
    toolCalls: record.usage.toolCalls,
    costUsd: record.costUsd,
    stopReason: record.stopDetail.reason,
    droppedPaths: record.droppedPaths,
    calls: record.trace.calls
  };
}

export function runFailureError(result: AgentRunResult): LLMError {
  const code = result.stopDetail.code;
  if (code !== undefined && code !== 'SPEND_CAP') return new LLMError(code, result.stopDetail.message);
  if (result.status === 'cancelled') return new LLMError('LLM_CANCELLED', result.stopDetail.message);
  return new LLMError('LLM_TOOL_USE_MISSING', `agent run ${result.status}: ${result.stopDetail.message}`);
}

export async function runAgentUpdateReport(input: RunAgentUpdateReportInput): Promise<AgentUpdateReportRun> {
  const dep = input.promptInput.dep;
  const packages = input.packages ?? [{ name: dep.name, from: dep.fromVersion, to: dep.toVersion }];
  const primary = packages[0]!;
  const apiDiff = input.apiDiff !== undefined ? input.apiDiff : await seedApiDiff(input.intel, primary.name, primary.from, primary.to, input.signal);
  const seed = renderAgentUpdateSeed({
    packages,
    resolverLines: resolverLines(input.promptInput),
    coUpgradeLines: coUpgradeLines(input.promptInput),
    graphSummaryLines: graphSummaryLines(input.graph),
    usageLines: usageLines(input.graph, packages.map((p) => p.name)),
    apiDiffLines: apiDiffSeedLines(apiDiff),
    maxToolCalls: input.budgets.maxToolCalls,
    submitTool: UPDATE_REPORT_TERMINAL.name
  });
  const { messages, playbookText } = seedMessage(seed, input, packages);
  const cacheKey = agentCacheKey({ system: AGENT_SYSTEM_PROMPT, seed, playbookText, tool: UPDATE_REPORT_TOOL_SCHEMA, model: input.modelId, graph: input.graph, budgets: input.budgets });

  const { result, record } = await executeAgentRun<UpdateReportToolOutput>({
    view: 'update-report',
    dep: primary.name,
    from: primary.from,
    to: primary.to,
    model: input.agent,
    modelId: input.modelId,
    effort: input.effort ?? VIEW_EFFORT.updateReport,
    budgets: input.budgets,
    registry: createReadToolRegistry(),
    terminal: UPDATE_REPORT_TERMINAL,
    system: AGENT_SYSTEM_PROMPT,
    seedMessages: messages,
    graph: input.graph,
    workspaceRoot: input.workspaceRoot,
    intel: input.intel,
    signal: input.signal,
    gate: input.gate,
    onEvent: input.onEvent,
    logContext: input.logContext
  });

  const v1Input = {
    promptInput: input.promptInput,
    model: input.modelId,
    resolverBlock: input.resolverBlock,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    candidateSources: input.candidateSources
  };

  if (result.status === 'submitted' && result.output !== undefined) {
    const v1 = await runUpdateReport(replayClient(result.output, result, input.modelId), v1Input);
    const { kept, dropped } = filterToGraphFiles(v1.detail.filesToModify, input.graph, input.workspaceRoot);
    record.droppedPaths = dropped.length;
    const detail: UpdateReportDetail = {
      ...v1.detail,
      filesToModify: kept,
      cost: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadInputTokens: result.usage.cacheReadInputTokens,
        cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
        model: input.modelId,
        costEstimateUsd: result.costUsd
      },
      agentRun: agentRunSummary(record)
    };
    return { cacheKey, detail, source: `anthropic:${input.modelId}`, record, droppedPaths: dropped, seedPrompt: seed };
  }

  const llmError = runFailureError(result);
  const log = await getLogger();
  log.warn({ err: llmError.message, code: llmError.code, status: result.status, runId: record.runId }, 'Agent update report did not submit; deterministic-partial');
  const skeleton = buildDeterministicSkeleton(v1Input);
  const graphUsers = filesUsingPackage(input.graph, primary.name, { wrapperDepth: 0 }).slice(0, SKELETON_GRAPH_FILES);
  const detail: UpdateReportDetail = {
    ...skeleton,
    filesToModify: graphUsers.map((h) => ({
      path: h.path,
      brief: `Uses ${primary.name} (${h.via}, from the code graph; not analysed — the agent run ended with "${result.status}").`,
      estimatedChangeSize: 'small'
    })),
    agentRun: agentRunSummary(record)
  };
  return { cacheKey, detail, source: 'deterministic-partial', llmError, record, droppedPaths: [], seedPrompt: seed };
}
