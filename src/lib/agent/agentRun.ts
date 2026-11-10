/**
 * App-side wrapper around the core agent loop (V2_STAGE4_SPEC 4a.7–4a.10):
 * wires pricing, logs every tool call (scope `agent`), and builds the run
 * record. Shared by the [D] and [D-Deep] agent services and the eval.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent, type AgentBudgets, type AgentEvent, type AgentRunResult, type SpendGate } from '../../core/agent/loop';
import type { AgentModel } from '../../core/agent/model';
import type { ToolRegistry } from '../../core/agent/registry';
import type { IntelContext, TerminalToolDef } from '../../core/agent/types';
import { DEFAULT_TOOL_LIMITS } from '../../core/agent/types';
import { completedBuildAt, type GraphDriver } from '../../core/graph/store';
import { costEstimateUsd } from '../llm/cost';
import type { LlmEffort } from '../llm/effort';
import { getLogger } from '../logger';
import { newRunId, type AgentRunRecord, type RunView } from './runStore';

export interface ExecuteAgentRunInput {
  view: RunView;
  dep: string;
  from: string | null;
  to: string | null;
  model: AgentModel;
  modelId: string;
  effort: LlmEffort;
  budgets: AgentBudgets;
  registry: ToolRegistry;
  terminal: TerminalToolDef;
  system: string;
  seedMessages: Anthropic.MessageParam[];
  graph: GraphDriver;
  workspaceRoot: string;
  intel: IntelContext;
  signal?: AbortSignal;
  gate?: SpendGate;
  onEvent?: (e: AgentEvent) => void;
  /** Log context (slug or eval case); never a secret. */
  logContext?: Record<string, string>;
}

export interface ExecutedAgentRun<T> {
  result: AgentRunResult<T>;
  record: AgentRunRecord;
}

export async function executeAgentRun<T>(input: ExecuteAgentRunInput): Promise<ExecutedAgentRun<T>> {
  const runId = newRunId();
  const startedAt = new Date();
  const log = (await getLogger()).child({ scope: 'agent', runId, view: input.view, dep: input.dep, ...input.logContext });
  log.info({ model: input.modelId, effort: input.effort, budgets: input.budgets }, `agent run start — ${input.dep} ${input.from ?? '∅'} → ${input.to ?? '∅'}`);
  const result = await runAgent<T>({
    model: input.model,
    modelId: input.modelId,
    effort: input.effort,
    registry: input.registry,
    terminal: input.terminal,
    system: input.system,
    seedMessages: input.seedMessages,
    budgets: input.budgets,
    ctx: { workspaceRoot: input.workspaceRoot, graph: input.graph, intel: input.intel, limits: { ...DEFAULT_TOOL_LIMITS } },
    pricing: costEstimateUsd,
    gate: input.gate,
    signal: input.signal,
    onEvent: (e) => {
      if (e.type === 'tool') {
        log.info({ tool: e.tool, durationMs: e.durationMs, resultBytes: e.resultBytes, truncated: e.truncated, isError: e.isError, turn: e.turn }, `agent tool ${e.tool}`);
      } else if (e.type === 'final-turn') {
        log.info({ reason: e.reason, turn: e.turn }, `agent final turn (${e.reason})`);
      }
      input.onEvent?.(e);
    }
  });
  const durationMs = Date.now() - startedAt.getTime();
  log.info(
    { status: result.status, stop: result.stopDetail.reason, code: result.stopDetail.code ?? null, toolCalls: result.usage.toolCalls, requests: result.usage.requests, costUsd: result.costUsd, durationMs },
    `agent run ${result.status} — ${result.usage.toolCalls} tool calls, $${result.costUsd.toFixed(4)}`
  );
  const record: AgentRunRecord = {
    runId,
    trigger: 'user',
    view: input.view,
    dep: input.dep,
    from: input.from,
    to: input.to,
    model: input.modelId,
    effort: input.effort,
    budgets: input.budgets,
    status: result.status,
    stopDetail: result.stopDetail,
    finalTurnReason: result.finalTurnReason,
    startedAt: startedAt.toISOString(),
    durationMs,
    usage: result.usage,
    costUsd: result.costUsd,
    trace: result.trace,
    graphBuiltAt: completedBuildAt(input.graph),
    resultRef: null,
    droppedPaths: 0
  };
  return { result, record };
}
