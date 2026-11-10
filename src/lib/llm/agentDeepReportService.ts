/**
 * View [D-Deep] Deep Report produced by the bounded agent loop
 * (V2_STAGE4_SPEC 4a.10). Same pattern as `agentReportService.ts`: v1 deep
 * schema and terminal tool (`DEEP_UPDATE_REPORT_TOOL_SCHEMA`), [D-Deep]
 * budgets, effort `VIEW_EFFORT.deepReport`, v1 output rules applied by the
 * unchanged `runDeepUpdateReport` over a replay client, deterministic-partial
 * skeleton on any non-submitted run. `deepReportService.ts` is untouched.
 */
import { runDeepUpdateReport, buildDeepDeterministicSkeleton, type RunDeepUpdateReportInput } from './deepReportService';
import { DEEP_UPDATE_REPORT_TOOL_SCHEMA, type DeepUpdateReportToolOutput } from './prompts/deep-update-report';
import { AGENT_SYSTEM_PROMPT } from './prompts/agent-update-report';
import { renderAgentDeepSeed } from './prompts/agent-deep-report';
import { VIEW_EFFORT } from './effort';
import { LLMError } from './client';
import { getLogger } from '../logger';
import { executeAgentRun } from '../agent/agentRun';
import type { AgentRunRecord } from '../agent/runStore';
import { agentCacheKey, agentRunSummary, replayClient, runFailureError, seedApiDiff, seedMessage, type AgentReportCommonInput } from './agentReportService';
import { createReadToolRegistry } from '../../core/agent/tools';
import { apiDiffSeedLines, graphSummaryLines, usageLines } from '../../core/agent/seedFacts';
import type { ApiDiffResult } from '../../core/intel/apiDiff';
import type { TerminalToolDef } from '../../core/agent/types';
import type { DeepUpdateReportDetail, WritableDataSource } from '../api-types';

export type RunAgentDeepReportInput = AgentReportCommonInput &
  Omit<RunDeepUpdateReportInput, 'model' | 'onPhase' | 'signal' | 'maxInputTokens' | 'maxOutputTokens'> & {
    apiDiff?: ApiDiffResult | null;
  };

export interface AgentDeepReportRun {
  cacheKey: string;
  detail: DeepUpdateReportDetail;
  source: WritableDataSource;
  llmError?: LLMError;
  record: AgentRunRecord;
  seedPrompt: string;
}

export const DEEP_REPORT_TERMINAL: TerminalToolDef = {
  name: DEEP_UPDATE_REPORT_TOOL_SCHEMA.name,
  description: DEEP_UPDATE_REPORT_TOOL_SCHEMA.description,
  inputSchema: DEEP_UPDATE_REPORT_TOOL_SCHEMA.inputSchema
};

export async function runAgentDeepReport(input: RunAgentDeepReportInput): Promise<AgentDeepReportRun> {
  const dep = input.promptInput.dep;
  const packages = [{ name: dep.name, from: dep.fromVersion, to: dep.toVersion }];
  const apiDiff = input.apiDiff !== undefined ? input.apiDiff : await seedApiDiff(input.intel, dep.name, dep.fromVersion, dep.toVersion, input.signal);
  const seed = renderAgentDeepSeed({
    promptInput: input.promptInput,
    graphSummaryLines: graphSummaryLines(input.graph),
    usageLines: usageLines(input.graph, [dep.name]),
    apiDiffLines: apiDiffSeedLines(apiDiff),
    maxToolCalls: input.budgets.maxToolCalls,
    submitTool: DEEP_REPORT_TERMINAL.name
  });
  const { messages, playbookText } = seedMessage(seed, input, packages);
  const cacheKey = agentCacheKey({ system: AGENT_SYSTEM_PROMPT, seed, playbookText, tool: DEEP_UPDATE_REPORT_TOOL_SCHEMA, model: input.modelId, graph: input.graph, budgets: input.budgets });

  const { result, record } = await executeAgentRun<DeepUpdateReportToolOutput>({
    view: 'deep-report',
    dep: dep.name,
    from: dep.fromVersion,
    to: dep.toVersion,
    model: input.agent,
    modelId: input.modelId,
    effort: input.effort ?? VIEW_EFFORT.deepReport,
    budgets: input.budgets,
    registry: createReadToolRegistry(),
    terminal: DEEP_REPORT_TERMINAL,
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

  const v1Input: RunDeepUpdateReportInput = {
    promptInput: input.promptInput,
    model: input.modelId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    lockfileStateHashShort: input.lockfileStateHashShort,
    resolverBlock: input.resolverBlock,
    coUpgradeDeps: input.coUpgradeDeps,
    lockfileSummary: input.lockfileSummary,
    transitiveDelta: input.transitiveDelta,
    cveDelta: input.cveDelta
  };

  if (result.status === 'submitted' && result.output !== undefined) {
    const v1 = await runDeepUpdateReport(replayClient(result.output, result, input.modelId), v1Input);
    const detail: DeepUpdateReportDetail = {
      ...v1.detail,
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
    return { cacheKey, detail, source: `anthropic:${input.modelId}`, record, seedPrompt: seed };
  }

  const llmError = runFailureError(result);
  const log = await getLogger();
  log.warn({ err: llmError.message, code: llmError.code, status: result.status, runId: record.runId }, 'Agent deep report did not submit; deterministic-partial');
  const detail: DeepUpdateReportDetail = { ...buildDeepDeterministicSkeleton(v1Input), agentRun: agentRunSummary(record) };
  return { cacheKey, detail, source: 'deterministic-partial', llmError, record, seedPrompt: seed };
}
