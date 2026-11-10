/**
 * Bounded L2 agent loop (V2_STAGE4_SPEC 4a.7, design §3, D7 read-only).
 *
 * The model explores with read-only tools and finishes by calling the
 * terminal tool (`submit_update_report` / `submit_deep_report`), whose input
 * is the run's output. Hard budgets per run: tool calls, cumulative input
 * tokens (uncached + cache read + cache write), cumulative output tokens, wall
 * time and USD (from API-reported usage).
 *
 * "No run exceeds its budget" is enforced BEFORE each request: the loop
 * projects the request's worst case and does not send it if it could pass a
 * budget. Projection (documented in `src/core/agent/README.md`):
 *   - input tokens ≤ ceil(utf8Bytes(system + tools + messages) / 2);
 *   - the prefix sent last turn is priced at cache-read only once the API has
 *     reported caching for this run, the rest at the 5-minute cache-WRITE
 *     price (≥ the uncached price, so a miss never makes the bound too low);
 *   - output = this request's `max_tokens`.
 * A normal turn is sent only when it AND a same-size final turn both fit, so
 * there is always room for the "submit now" turn; output keeps a reserve of
 * min(perTurnMaxTokens, maxOutputTokens / 4) for it.
 *
 * Final turn: when a budget is reached the loop appends "Budget reached. Call
 * `<submit>` now…" to the pending user message with the tool list unchanged
 * (the cached prefix stays valid; forced tool_choice is a 400 on current
 * models). Other tool calls then get `is_error: budget exhausted` and exactly
 * one more turn is allowed. No module-scoped state: everything lives in the call.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { LLMError, type LlmErrorCode } from '../../lib/llm/client';
import type { LlmEffort } from '../../lib/llm/effort';
import type { TokenUsage } from '../../lib/llm/cost';
import type { AgentModel, AgentTurnRequest } from './model';
import { toAnthropicTools, type ToolRegistry } from './registry';
import { validateInput } from './schema';
import type { TerminalToolDef, ToolContext } from './types';

export interface AgentBudgets {
  maxToolCalls: number;
  /** Cumulative input + cache-read + cache-write tokens over all turns. */
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallMs: number;
  maxUsd: number;
  /** Per-request `max_tokens` ceiling. */
  perTurnMaxTokens: number;
}

/** Below this a request cannot produce a useful report; the loop stops instead. */
export const MIN_TURN_OUTPUT_TOKENS = 1_024;
export const WALL_FINAL_FRACTION = 0.8;
export const INPUT_SUMMARY_MAX_CHARS = 300;

export type AgentRunStatus = 'submitted' | 'budget-exhausted' | 'no-submit' | 'cancelled' | 'error';

export type BudgetName = 'tool-calls' | 'input-tokens' | 'output-tokens' | 'usd' | 'wall-time';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  requests: number;
  toolCalls: number;
}

export interface TraceCall {
  turn: number;
  tool: string;
  inputSummary: string;
  durationMs: number;
  resultBytes: number;
  truncated: boolean;
  isError: boolean;
}

export interface TraceTurn {
  turn: number;
  stopReason: string | null;
  usage: Required<TokenUsage>;
  costUsd: number;
  final: boolean;
}

export interface AgentTrace {
  calls: TraceCall[];
  turns: TraceTurn[];
}

export interface StopDetail {
  reason: BudgetName | 'submitted' | 'no-submit' | 'cancelled' | 'llm-error' | 'spend-cap' | 'truncated' | 'refusal';
  message: string;
  code?: LlmErrorCode | 'SPEND_CAP';
}

export interface AgentRunResult<T = unknown> {
  status: AgentRunStatus;
  output?: T;
  trace: AgentTrace;
  usage: AgentUsage;
  costUsd: number;
  stopDetail: StopDetail;
  /** Final turn was entered because of this budget (null when never entered). */
  finalTurnReason: BudgetName | null;
}

export interface RequestEstimate {
  model: string;
  inputTokensUpperBound: number;
  maxTokens: number;
  projectedUsd: number;
  request: AgentTurnRequest;
}

/** 4c spend gate seam: may refuse a request before it is sent, and settles from API usage after. */
export interface SpendGate {
  beforeRequest(estimate: RequestEstimate): Promise<{ allowed: boolean; reason?: string }> | { allowed: boolean; reason?: string };
  afterResponse(r: { model: string; usage: Required<TokenUsage> }): Promise<void> | void;
}

export type AgentEvent =
  | { type: 'turn'; turn: number; toolCalls: number; maxToolCalls: number; final: boolean }
  | { type: 'tool'; turn: number; tool: string; durationMs: number; resultBytes: number; truncated: boolean; isError: boolean }
  | { type: 'final-turn'; turn: number; reason: BudgetName };

export interface RunAgentOptions {
  model: AgentModel;
  modelId: string;
  effort: LlmEffort;
  registry: ToolRegistry;
  terminal: TerminalToolDef;
  system: string;
  seedMessages: readonly Anthropic.MessageParam[];
  budgets: AgentBudgets;
  /** Tool context without the signal (the loop supplies its own combined signal). */
  ctx: Omit<ToolContext, 'signal'>;
  /** Cost of one usage record in USD (inject `costEstimateUsd` from `lib/llm/cost.ts`). */
  pricing: (model: string, usage: TokenUsage) => number;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  gate?: SpendGate;
  now?: () => number;
}

export function budgetNudge(submitTool: string): string {
  return `Budget reached. Call \`${submitTool}\` now with what you have. Do not call any other tool.`;
}

export function noSubmitNudge(submitTool: string): string {
  return `You did not call \`${submitTool}\`. Finish now by calling \`${submitTool}\` with your findings.`;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function requestTokenUpperBound(system: string, tools: readonly Anthropic.Tool[], messages: readonly Anthropic.MessageParam[]): number {
  return Math.ceil((bytes(system) + bytes(JSON.stringify(tools)) + bytes(JSON.stringify(messages))) / 2);
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, requests: 0, toolCalls: 0 };
}

function inputTotal(u: AgentUsage): number {
  return u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
}

function summarize(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? 'null';
  } catch {
    s = '<unserializable>';
  }
  return s.length <= INPUT_SUMMARY_MAX_CHARS ? s : `${s.slice(0, INPUT_SUMMARY_MAX_CHARS - 1)}…`;
}

/** Appends a text block to the pending (last, user) message without mutating the caller's objects. */
function appendUserText(messages: Anthropic.MessageParam[], text: string): void {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'user') {
    messages.push({ role: 'user', content: [{ type: 'text', text }] });
    return;
  }
  const content: Anthropic.ContentBlockParam[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
  content.push({ type: 'text', text });
  messages[messages.length - 1] = { role: 'user', content };
}

export async function runAgent<T = unknown>(opts: RunAgentOptions): Promise<AgentRunResult<T>> {
  const now = opts.now ?? Date.now;
  const { budgets, terminal } = opts;
  const tools = toAnthropicTools(opts.registry, [terminal]);
  const messages: Anthropic.MessageParam[] = [...opts.seedMessages];
  const usage = emptyUsage();
  const trace: AgentTrace = { calls: [], turns: [] };
  let costUsd = 0;
  let turn = 0;
  let finalMode = false;
  let finalTurnReason: BudgetName | null = null;
  let finalTurnsSent = 0;
  let noSubmitNudged = false;
  let prevRequestTokens = 0;
  let cachingSeen = false;
  const outputReserve = Math.min(budgets.perTurnMaxTokens, Math.floor(budgets.maxOutputTokens / 4));

  const startedAt = now();
  const wall = new AbortController();
  const timer = setTimeout(() => wall.abort(), Math.max(0, budgets.maxWallMs));
  const signal = opts.signal === undefined ? wall.signal : AbortSignal.any([opts.signal, wall.signal]);
  const ctx: ToolContext = { ...opts.ctx, signal };

  const finish = (status: AgentRunStatus, stopDetail: StopDetail, output?: T): AgentRunResult<T> => ({
    status,
    ...(output !== undefined ? { output } : {}),
    trace,
    usage: { ...usage },
    costUsd: round6(costUsd),
    stopDetail,
    finalTurnReason
  });
  const cancelledOrWall = (): AgentRunResult<T> | null => {
    if (opts.signal?.aborted === true) return finish('cancelled', { reason: 'cancelled', message: 'Run cancelled.' });
    if (wall.signal.aborted) return finish('budget-exhausted', { reason: 'wall-time', message: `Wall-time budget of ${budgets.maxWallMs} ms reached.` });
    return null;
  };
  const enterFinal = (reason: BudgetName) => {
    if (finalMode) return;
    finalMode = true;
    finalTurnReason = reason;
    appendUserText(messages, budgetNudge(terminal.name));
    opts.onEvent?.({ type: 'final-turn', turn: turn + 1, reason });
  };
  const exhausted = (reason: BudgetName): AgentRunResult<T> =>
    finish('budget-exhausted', { reason, message: `Budget "${reason}" reached before ${terminal.name} was called.` });

  try {
    for (;;) {
      const stopped = cancelledOrWall();
      if (stopped !== null) return stopped;
      if (finalMode && finalTurnsSent >= 2) return exhausted(finalTurnReason ?? 'tool-calls');
      if (!finalMode && usage.toolCalls >= budgets.maxToolCalls) enterFinal('tool-calls');
      if (!finalMode && now() - startedAt >= budgets.maxWallMs * WALL_FINAL_FRACTION) enterFinal('wall-time');

      // ---- projection + budget decision (before anything is sent)
      let decided = false;
      let request: AgentTurnRequest | null = null;
      let estimate: RequestEstimate | null = null;
      while (!decided) {
        const remainingOut = budgets.maxOutputTokens - usage.outputTokens;
        const maxTokens = Math.min(budgets.perTurnMaxTokens, finalMode ? remainingOut : remainingOut - outputReserve);
        const tokens = requestTokenUpperBound(opts.system, tools, messages);
        const prefix = cachingSeen ? Math.min(prevRequestTokens, tokens) : 0;
        const projectedUsd = opts.pricing(opts.modelId, {
          inputTokens: 0,
          cacheReadInputTokens: prefix,
          cacheCreationInputTokens: tokens - prefix,
          outputTokens: Math.max(0, maxTokens)
        });
        const factor = finalMode ? 1 : 2;
        const over: BudgetName | null =
          maxTokens < MIN_TURN_OUTPUT_TOKENS
            ? 'output-tokens'
            : inputTotal(usage) + factor * tokens > budgets.maxInputTokens
              ? 'input-tokens'
              : costUsd + factor * projectedUsd > budgets.maxUsd
                ? 'usd'
                : null;
        if (over === null) {
          request = { model: opts.modelId, system: opts.system, tools, messages: [...messages], maxTokens, effort: opts.effort, signal };
          estimate = { model: opts.modelId, inputTokensUpperBound: tokens, maxTokens, projectedUsd, request };
          decided = true;
        } else if (!finalMode) {
          enterFinal(over);
        } else {
          return exhausted(over);
        }
      }

      if (opts.gate !== undefined) {
        let verdict: { allowed: boolean; reason?: string };
        try {
          verdict = await opts.gate.beforeRequest(estimate!);
        } catch (err) {
          verdict = { allowed: false, reason: err instanceof Error ? err.message : String(err) };
        }
        if (!verdict.allowed) {
          return finish('error', { reason: 'spend-cap', message: verdict.reason ?? 'Spend gate refused the request.', code: 'SPEND_CAP' });
        }
      }

      // ---- send
      turn += 1;
      if (finalMode) finalTurnsSent += 1;
      opts.onEvent?.({ type: 'turn', turn, toolCalls: usage.toolCalls, maxToolCalls: budgets.maxToolCalls, final: finalMode });
      let response;
      try {
        response = await opts.model.turn(request!);
      } catch (err) {
        const stop = cancelledOrWall();
        if (stop !== null) return stop;
        const e = err instanceof LLMError ? err : new LLMError('LLM_INVALID_RESPONSE', err instanceof Error ? err.message : String(err));
        if (e.code === 'LLM_CANCELLED') return finish('cancelled', { reason: 'cancelled', message: 'Run cancelled.' });
        return finish('error', { reason: 'llm-error', message: e.message, code: e.code });
      }

      // ---- account (API-reported usage)
      const u = response.usage;
      usage.requests += 1;
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.cacheReadInputTokens += u.cacheReadInputTokens;
      usage.cacheCreationInputTokens += u.cacheCreationInputTokens;
      const turnCost = opts.pricing(response.model || opts.modelId, u);
      costUsd += turnCost;
      if (u.cacheReadInputTokens + u.cacheCreationInputTokens > 0) cachingSeen = true;
      prevRequestTokens = estimate!.inputTokensUpperBound;
      trace.turns.push({ turn, stopReason: response.stopReason, usage: { ...u }, costUsd: turnCost, final: finalMode });
      if (opts.gate !== undefined) await opts.gate.afterResponse({ model: response.model || opts.modelId, usage: { ...u } });

      if (response.stopReason === 'refusal') return finish('error', { reason: 'refusal', message: 'The model declined the request (stop_reason: refusal).', code: 'LLM_REFUSAL' });
      if (response.stopReason === 'model_context_window_exceeded') {
        return finish('error', { reason: 'truncated', message: 'Context window exceeded (stop_reason: model_context_window_exceeded).', code: 'LLM_TRUNCATED' });
      }

      messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });
      const toolUses = response.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');

      // ---- terminal tool
      const submits = toolUses.filter((t) => t.name === terminal.name);
      if (submits.length > 0 && response.stopReason === 'max_tokens') {
        return finish('error', { reason: 'truncated', message: `${terminal.name} was cut off at max_tokens.`, code: 'LLM_TRUNCATED' });
      }
      for (const s of submits) {
        if (validateInput(terminal.inputSchema, s.input) === null) {
          return finish('submitted', { reason: 'submitted', message: `${terminal.name} called.` }, s.input as T);
        }
      }

      if (toolUses.length === 0) {
        if (finalMode) {
          appendUserText(messages, budgetNudge(terminal.name));
          continue;
        }
        if (noSubmitNudged) return finish('no-submit', { reason: 'no-submit', message: `The model ended without calling ${terminal.name}.` });
        noSubmitNudged = true;
        messages.push({ role: 'user', content: [{ type: 'text', text: noSubmitNudge(terminal.name) }] });
        continue;
      }

      // ---- execute tool calls in order; all results go back in ONE user message
      const results: Anthropic.ToolResultBlockParam[] = [];
      let hitToolLimit = false;
      for (const block of toolUses) {
        const stop = cancelledOrWall();
        if (stop !== null) return stop;
        if (block.name === terminal.name) {
          const problem = validateInput(terminal.inputSchema, block.input) ?? 'invalid input';
          const content = `Invalid input for ${terminal.name}: ${problem}. Fix it and call ${terminal.name} again.`;
          results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: true });
          // Counts as a tool call while under the limit; past it the model still gets the message (it is in its final turn anyway).
          if (usage.toolCalls < budgets.maxToolCalls) {
            usage.toolCalls += 1;
            trace.calls.push({ turn, tool: block.name, inputSummary: summarize(block.input), durationMs: 0, resultBytes: bytes(content), truncated: false, isError: true });
          }
          continue;
        }
        if (finalMode || usage.toolCalls >= budgets.maxToolCalls) {
          if (!finalMode) hitToolLimit = true;
          results.push({ type: 'tool_result', tool_use_id: block.id, content: `budget exhausted: call ${terminal.name} now`, is_error: true });
          continue;
        }
        const t0 = now();
        const r = await opts.registry.call(block.name, block.input, ctx);
        const durationMs = Math.max(0, now() - t0);
        usage.toolCalls += 1;
        results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        const entry: TraceCall = {
          turn,
          tool: block.name,
          inputSummary: summarize(block.input),
          durationMs,
          resultBytes: bytes(r.content),
          truncated: r.truncated,
          isError: r.isError
        };
        trace.calls.push(entry);
        opts.onEvent?.({ type: 'tool', ...entry });
      }
      const stop = cancelledOrWall();
      if (stop !== null) return stop;
      messages.push({ role: 'user', content: results });
      if (hitToolLimit) enterFinal('tool-calls');
    }
  } finally {
    clearTimeout(timer);
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
