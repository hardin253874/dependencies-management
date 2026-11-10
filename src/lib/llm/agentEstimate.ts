/**
 * Pre-run cost estimate for agent runs (V2_STAGE4_SPEC 4a.12), shown in the
 * confirm modal before every [D] / [D-Deep] Generate.
 *
 * - `maxUsd` is the run's USD budget: the loop never sends a request that
 *   could pass it, so it is a hard ceiling, not a guess.
 * - `expectedUsd` is a documented heuristic for a typical run:
 *     turns   = round(0.6 × maxToolCalls) exploration turns + 1 submit turn
 *     prefix  = (system + tools + seed bytes) / 4 tokens, written to the cache once
 *     growth  = 1.5 KB tool result per turn (≈ 400 tokens) + 150 output tokens of tool call,
 *               each new tail written to the cache once and read back on every later turn
 *     output  = 150 tokens per exploration turn + 3,000 for the submit turn
 *   priced with `cost.ts`. Real runs vary with the model's choices.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentBudgets } from '../../core/agent/loop';
import { costEstimateUsd } from './cost';

export const EXPECTED_TOOL_CALL_FRACTION = 0.6;
export const EXPECTED_RESULT_BYTES = 1_536;
export const EXPECTED_TOOL_CALL_OUTPUT_TOKENS = 150;
export const EXPECTED_SUBMIT_OUTPUT_TOKENS = 3_000;
const BYTES_PER_TOKEN = 4;

export interface AgentRunEstimate {
  expectedUsd: number;
  maxUsd: number;
  expectedInputTokens: number;
  expectedOutputTokens: number;
  budgets: AgentBudgets;
}

export function estimateAgentRun(opts: {
  model: string;
  budgets: AgentBudgets;
  seedPromptBytes: number;
  systemBytes: number;
  tools: readonly Anthropic.Tool[];
}): AgentRunEstimate {
  const turns = Math.max(1, Math.round(EXPECTED_TOOL_CALL_FRACTION * opts.budgets.maxToolCalls)) + 1;
  const prefix = Math.ceil((opts.systemBytes + Buffer.byteLength(JSON.stringify(opts.tools), 'utf8') + opts.seedPromptBytes) / BYTES_PER_TOKEN);
  const growth = Math.ceil(EXPECTED_RESULT_BYTES / BYTES_PER_TOKEN) + EXPECTED_TOOL_CALL_OUTPUT_TOKENS;
  let cacheWrite = prefix;
  let cacheRead = 0;
  let output = 0;
  for (let t = 1; t <= turns; t += 1) {
    if (t > 1) {
      cacheRead += prefix + (t - 2) * growth;
      cacheWrite += growth;
    }
    output += t === turns ? EXPECTED_SUBMIT_OUTPUT_TOKENS : EXPECTED_TOOL_CALL_OUTPUT_TOKENS;
  }
  const expectedUsd = costEstimateUsd(opts.model, { inputTokens: 0, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, outputTokens: output });
  return {
    expectedUsd: Math.min(expectedUsd, opts.budgets.maxUsd),
    maxUsd: opts.budgets.maxUsd,
    expectedInputTokens: cacheRead + cacheWrite,
    expectedOutputTokens: output,
    budgets: opts.budgets
  };
}
